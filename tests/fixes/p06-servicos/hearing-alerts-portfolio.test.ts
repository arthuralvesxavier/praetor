/**
 * P0.6 (deferred 18, decided by the integrator): hearing alerts and the simulated
 * reminder e-mails only cover processes in the active portfolio (status active or
 * suspended). A process that leaves it (archived or closed) keeps its scheduled
 * hearings on record, but their open alerts are resolved and no reminder is sent;
 * a reactivated process is alerted again (without a second reminder).
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysISO, todayISO } from "@/lib/format";
import { mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import { runHearingAlertsRoutine } from "@/modules/hearings/routines";
import { createHearing, listScheduledHearingsForAlerts } from "@/modules/hearings/service";
import { closeProcess, reactivateProcess } from "@/modules/processes/service";
import { alerts, emailMessages, legalProcesses } from "@/server/db/schema";
import type { RoutineContext } from "@/server/jobs/routines";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
const ids: Record<string, string> = {};
const today = todayISO();
const inDays = (n: number) => addDaysISO(today, n);

function rc(): RoutineContext {
  return { organizationId: f.orgA, isDemo: false, settings: mergeOrganizationSettings(null), config: {}, today };
}

async function reminders(hearingId: string): Promise<number> {
  const [row] = await f.db
    .select({ n: count() })
    .from(emailMessages)
    .where(and(eq(emailMessages.organizationId, f.orgA), eq(emailMessages.template, "hearing_reminder"), eq(emailMessages.entityId, hearingId)));
  return row.n;
}

async function openAlert(hearingId: string) {
  const [row] = await f.db
    .select({ id: alerts.id, title: alerts.title, message: alerts.message })
    .from(alerts)
    .where(and(eq(alerts.organizationId, f.orgA), eq(alerts.type, "hearing_upcoming"), eq(alerts.entityId, hearingId), isNull(alerts.resolvedAt)));
  return row;
}

async function hearingFor(title: string): Promise<{ processId: string; hearingId: string }> {
  const { admin, lawyer } = f.ctx;
  const processId = await makeProcess(admin, { title, unitId: f.unitSp });
  const { id } = await createHearing(admin, {
    processId,
    kind: "instruction",
    mode: "virtual",
    date: inDays(3),
    time: "10:00",
    responsibleId: lawyer.userId,
  });
  return { processId, hearingId: id };
}

beforeAll(async () => {
  f = await setupFixture("p06-hear");
  ({ processId: ids.active, hearingId: ids.hActive } = await hearingFor("Processo ativo (fictício)"));
  ({ processId: ids.suspended, hearingId: ids.hSuspended } = await hearingFor("Processo suspenso (fictício)"));
  ({ processId: ids.archived, hearingId: ids.hArchived } = await hearingFor("Processo arquivado (fictício)"));
  ({ processId: ids.closing, hearingId: ids.hClosing } = await hearingFor("Processo que sai da carteira (fictício)"));
  await f.db.update(legalProcesses).set({ status: "suspended" }).where(eq(legalProcesses.id, ids.suspended));
  await f.db.update(legalProcesses).set({ status: "archived" }).where(eq(legalProcesses.id, ids.archived));
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

describe("hearing alerts follow the active portfolio", () => {
  it("alerts and reminds only hearings of active or suspended processes", async () => {
    const listed = await listScheduledHearingsForAlerts(f.orgA, new Date(), new Date(Date.now() + 30 * 86_400_000));
    expect(listed.map((h) => h.id).sort()).toEqual([ids.hActive, ids.hSuspended, ids.hClosing].sort());

    const summary = await runHearingAlertsRoutine(rc());
    expect(summary).toContain("3 audiência(s)");
    expect(await openAlert(ids.hActive)).toBeDefined();
    expect(await openAlert(ids.hSuspended)).toBeDefined();
    expect(await openAlert(ids.hArchived)).toBeUndefined();
    expect(await reminders(ids.hActive)).toBe(1);
    expect(await reminders(ids.hArchived)).toBe(0);

    // pt-BR alert text without em dash.
    const a = await openAlert(ids.hActive);
    expect(`${a!.title} ${a!.message}`).not.toMatch(/[—–]/);
    expect(a!.message).toContain("(Processo ativo (fictício))");
  });

  it("resolves the open alert of a process that left the portfolio and does not remind it", async () => {
    expect(await openAlert(ids.hClosing)).toBeDefined();
    expect(await reminders(ids.hClosing)).toBe(1);
    await closeProcess(f.ctx.admin, ids.closing, { closureReason: "dismissed" });

    const summary = await runHearingAlertsRoutine(rc());
    expect(summary).toContain("2 audiência(s)");
    expect(summary).toContain("1 alerta(s) encerrado(s)");
    expect(await openAlert(ids.hClosing)).toBeUndefined();
    expect(await openAlert(ids.hActive)).toBeDefined();
    expect(await reminders(ids.hClosing)).toBe(1);
  });

  it("a reactivated process is alerted again, without a second reminder", async () => {
    await reactivateProcess(f.ctx.admin, ids.closing);
    await runHearingAlertsRoutine(rc());
    expect(await openAlert(ids.hClosing)).toBeDefined();
    expect(await reminders(ids.hClosing)).toBe(1);
  });
});
