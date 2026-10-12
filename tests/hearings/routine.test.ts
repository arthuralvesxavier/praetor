import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { addDaysISO, todayISO } from "@/lib/format";
import { mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import { listAlerts } from "@/modules/alerts/service";
import { runHearingAlertsRoutine } from "@/modules/hearings/routines";
import { createHearing, setHearingStatus, updateHearing } from "@/modules/hearings/service";
import type { RoutineContext } from "@/server/jobs/routines";
import { alerts, emailMessages, hearings, organizations } from "@/server/db/schema";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

/**
 * The routine reads "already reminded" from `email_messages`, so the mock
 * stores a minimal simulated message (like the real service does).
 */
const sendTemplatedEmail = vi.fn<(...args: unknown[]) => Promise<{ emailId: string }>>(async (...args: unknown[]) => {
  const [ctx, input] = args as [
    { organizationId: string },
    { template: "hearing_reminder"; toUserId: string; processId: string; entity: { type: "hearing"; id: string } },
  ];
  const [row] = await fx.db
    .insert(emailMessages)
    .values({
      organizationId: ctx.organizationId,
      mode: "simulated",
      provider: "simulated",
      template: input.template,
      status: "simulated",
      toUserId: input.toUserId,
      toName: "Destinatário (fictício)",
      toAddress: "destinatario@example.com",
      fromName: "Praetor (simulação)",
      fromAddress: "nao-responda@example.com",
      subject: "[Simulação] Lembrete de audiência",
      bodyText: "Corpo fictício.",
      bodyHtml: "<p>Corpo fictício.</p>",
      entityType: input.entity.type,
      entityId: input.entity.id,
      processId: input.processId,
    })
    .returning({ id: emailMessages.id });
  return { emailId: row.id };
});
vi.mock("@/modules/emails/service", () => ({
  sendTemplatedEmail: (...args: unknown[]) => sendTemplatedEmail(...args),
}));

let fx: Fixture;
const ids: Record<string, string> = {};
const today = todayISO();
const inDays = (n: number) => addDaysISO(today, n);

function rc(organizationId: string, upcomingHearingDays = 10): RoutineContext {
  const settings = mergeOrganizationSettings(null);
  return {
    organizationId,
    isDemo: false,
    settings: { ...settings, alerts: { ...settings.alerts, upcomingHearingDays } },
    config: {},
    today,
  };
}

async function openHearingAlerts(orgId: string) {
  return fx.db
    .select()
    .from(alerts)
    .where(and(eq(alerts.organizationId, orgId), eq(alerts.type, "hearing_upcoming"), isNull(alerts.resolvedAt)));
}

function base(processId: string, date: string, time = "14:00") {
  return { processId, kind: "initial" as const, mode: "in_person" as const, date, time, location: "Vara fictícia" };
}

beforeAll(async () => {
  fx = await setupFixture("hrout");
  const { admin, lawyer } = fx.ctx;
  ids.pSp = await makeProcess(admin, { unitId: fx.unitSp, number: "2000002-22.2026.5.10.0002", title: "Processo SP (fictício)" });
  ids.pB = await makeProcess(fx.ctx.adminB, { title: "Processo B (fictício)" });
  ids.tomorrow = (await createHearing(admin, { ...base(ids.pSp, inDays(1)), responsibleId: lawyer.userId })).id;
  ids.inFive = (await createHearing(admin, { ...base(ids.pSp, inDays(5)), responsibleId: lawyer.userId })).id;
  ids.noResponsible = (await createHearing(admin, base(ids.pSp, inDays(6)))).id;
  ids.far = (await createHearing(admin, { ...base(ids.pSp, inDays(40)), responsibleId: lawyer.userId })).id;
  ids.orgB = (await createHearing(fx.ctx.adminB, base(ids.pB, inDays(2)))).id;
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

beforeEach(() => {
  sendTemplatedEmail.mockClear();
});

describe("runHearingAlertsRoutine", () => {
  it("creates one alert per hearing within the window, with severity by proximity", async () => {
    const summary = await runHearingAlertsRoutine(rc(fx.orgA));
    expect(summary).toContain("3 audiência(s)");
    const open = await openHearingAlerts(fx.orgA);
    const byEntity = new Map(open.map((a) => [a.entityId, a]));
    expect(byEntity.size).toBe(3);
    expect(byEntity.get(ids.tomorrow)?.severity).toBe("critical");
    expect(byEntity.get(ids.inFive)?.severity).toBe("warning");
    expect(byEntity.get(ids.tomorrow)?.entityType).toBe("hearing");
    expect(byEntity.get(ids.tomorrow)?.dedupeKey).toBe(`hearing_upcoming:${ids.tomorrow}`);
    expect(byEntity.get(ids.tomorrow)?.title).toContain("2000002-22.2026.5.10.0002");
    expect(byEntity.has(ids.far)).toBe(false);
    // Organization B is untouched by organization A's run.
    expect(await openHearingAlerts(fx.orgB)).toHaveLength(0);
  });

  it("sends the simulated reminder once per hearing with a responsible person", async () => {
    // First run happened in the previous test with the mock cleared afterwards: start again from a clean state.
    await fx.db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.organizationId, fx.orgA));
    await fx.db.delete(emailMessages).where(eq(emailMessages.organizationId, fx.orgA));
    sendTemplatedEmail.mockClear();
    await runHearingAlertsRoutine(rc(fx.orgA));
    expect(sendTemplatedEmail).toHaveBeenCalledTimes(2); // tomorrow + inFive (the third has no responsible)
    const [ctxArg, input] = sendTemplatedEmail.mock.calls[0] as [{ kind: string; organizationId: string }, Record<string, unknown>];
    expect(ctxArg.kind).toBe("system");
    expect(ctxArg.organizationId).toBe(fx.orgA);
    expect(input.template).toBe("hearing_reminder");
    expect(input.toUserId).toBe(fx.ctx.lawyer.userId);
    expect(input.linkPath).toBe(`/processos/${ids.pSp}?aba=prazos-e-audiencias#audiencias`);
    expect(input.entity).toEqual({ type: "hearing", id: expect.any(String) });

    sendTemplatedEmail.mockClear();
    const again = await runHearingAlertsRoutine(rc(fx.orgA));
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
    expect(again).not.toContain("lembrete");
    expect(await openHearingAlerts(fx.orgA)).toHaveLength(3);

    // Resolving the alerts reopens them on the next run (convention), but the reminder is not sent again.
    await fx.db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.organizationId, fx.orgA));
    const afterResolve = await runHearingAlertsRoutine(rc(fx.orgA));
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
    expect(afterResolve).not.toContain("lembrete");
    expect(await openHearingAlerts(fx.orgA)).toHaveLength(3);
  });

  it("never fails because of the e-mail", async () => {
    await fx.db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.organizationId, fx.orgA));
    await fx.db.delete(emailMessages).where(eq(emailMessages.organizationId, fx.orgA));
    sendTemplatedEmail.mockRejectedValueOnce(new Error("smtp down"));
    const summary = await runHearingAlertsRoutine(rc(fx.orgA));
    expect(summary).toContain("não gerado");
    expect(await openHearingAlerts(fx.orgA)).toHaveLength(3);
  });

  it("resolves alerts when the hearing is cancelled, moved out of the window or in the past", async () => {
    const { admin } = fx.ctx;
    // Cancel: resolved immediately by the service.
    await setHearingStatus(admin, ids.noResponsible, { status: "cancelled" });
    let open = await openHearingAlerts(fx.orgA);
    expect(open.map((a) => a.entityId)).not.toContain(ids.noResponsible);

    // Moved beyond the window: resolved on the next run.
    await updateHearing(admin, ids.inFive, {
      kind: "initial",
      mode: "in_person",
      date: inDays(30),
      time: "14:00",
      location: "Vara fictícia",
      responsibleId: fx.ctx.lawyer.userId,
    });
    // Date passed (simulated by moving the timestamp back).
    await fx.db
      .update(hearings)
      .set({ scheduledAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(hearings.id, ids.tomorrow));
    const summary = await runHearingAlertsRoutine(rc(fx.orgA));
    expect(summary).toContain("encerrado");
    open = await openHearingAlerts(fx.orgA);
    expect(open).toHaveLength(0);
  });

  it("uses the configured window", async () => {
    const summary = await runHearingAlertsRoutine(rc(fx.orgA, 45));
    expect(summary).toContain("45 dia(s)");
    const open = await openHearingAlerts(fx.orgA);
    expect(open.map((a) => a.entityId).sort()).toEqual([ids.far, ids.inFive].sort());
  });

  it("hearing alerts follow the visibility of the process and link to its tab", async () => {
    const forLawyer = await listAlerts(fx.ctx.lawyer, { limit: 50 });
    const hearingAlert = forLawyer.find((a) => a.entityId === ids.far);
    expect(hearingAlert?.href).toBe(`/processos/${ids.pSp}?aba=prazos-e-audiencias#audiencias`);
    expect(hearingAlert?.area).toBe("hearings");
    expect((await listAlerts(fx.ctx.lawyerRe, { limit: 50 })).some((a) => a.type === "hearing_upcoming")).toBe(false);
    expect((await listAlerts(fx.ctx.adminB, { limit: 50 })).some((a) => a.type === "hearing_upcoming")).toBe(false);
  });

  it("reads the window from organization settings (merged with defaults)", async () => {
    const [org] = await fx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, fx.orgB));
    const merged = mergeOrganizationSettings(org.settings);
    expect(merged.alerts.upcomingHearingDays).toBe(10);
    const summary = await runHearingAlertsRoutine({ organizationId: fx.orgB, isDemo: false, settings: merged, config: {}, today });
    expect(summary).toContain("1 audiência(s)");
    expect(await openHearingAlerts(fx.orgB)).toHaveLength(1);
  });
});
