/**
 * Regressions:
 * - "Daily digest hearing count is silently capped at 50": the digest uses
 *   `countUpcomingHearings` (same scope as the list, no cap).
 * - "Hearing reminder e-mail is re-sent every time a user resolves the
 *   hearing_upcoming alert": "already reminded" comes from the e-mail table
 *   (with the real, simulated, e-mail service), so resolving the alert does
 *   not resend; a hearing corrected after its reminder, a rescheduled hearing
 *   (new hearing) and a failed generation get a new reminder.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysISO, todayISO } from "@/lib/format";
import { mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import { resolveAlert } from "@/modules/alerts/service";
import { buildDailyDigestData } from "@/modules/emails/service";
import { runHearingAlertsRoutine } from "@/modules/hearings/routines";
import {
  countUpcomingHearings,
  createHearing,
  listUpcomingHearings,
  setHearingStatus,
  updateHearing,
} from "@/modules/hearings/service";
import { alerts, emailMessages, hearings } from "@/server/db/schema";
import type { RoutineContext } from "@/server/jobs/routines";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
const ids: Record<string, string> = {};
const today = todayISO();
const inDays = (n: number) => addDaysISO(today, n);
const DIGEST_HEARINGS = 55;

function rc(): RoutineContext {
  return { organizationId: f.orgA, isDemo: false, settings: mergeOrganizationSettings(null), config: {}, today };
}

async function reminders(hearingId: string): Promise<number> {
  const [row] = await f.db
    .select({ n: count() })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.organizationId, f.orgA),
        eq(emailMessages.template, "hearing_reminder"),
        eq(emailMessages.entityId, hearingId),
      ),
    );
  return row.n;
}

async function openAlertId(hearingId: string): Promise<string | undefined> {
  const [row] = await f.db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.organizationId, f.orgA), eq(alerts.entityId, hearingId), isNull(alerts.resolvedAt)));
  return row?.id;
}

beforeAll(async () => {
  f = await setupFixture("fix-hear-digest");
  const { admin, lawyer } = f.ctx;

  // Digest: many hearings of a process the SP lawyer sees, without responsible (no reminders).
  ids.digestProcess = await makeProcess(admin, { title: "Processo com pauta cheia (fictício)", unitId: f.unitSp });
  for (let i = 0; i < DIGEST_HEARINGS; i++) {
    const hour = String(8 + (i % 10)).padStart(2, "0");
    await createHearing(admin, {
      processId: ids.digestProcess,
      kind: "instruction",
      mode: "virtual",
      date: inDays(1 + (i % 5)),
      time: `${hour}:${String(i % 60).padStart(2, "0")}`,
    });
  }
  // Out of the 7-day digest window.
  await createHearing(admin, { processId: ids.digestProcess, kind: "instruction", mode: "virtual", date: inDays(20), time: "10:00" });

  // Reminders: one hearing with a responsible person.
  ids.reminderProcess = await makeProcess(admin, { title: "Processo do lembrete (fictício)", unitId: f.unitSp });
  ids.hearing = (
    await createHearing(admin, {
      processId: ids.reminderProcess,
      kind: "initial",
      mode: "in_person",
      date: inDays(3),
      time: "14:00",
      location: "Vara fictícia",
      responsibleId: lawyer.userId,
    })
  ).id;
}, 300_000);

afterAll(async () => {
  await f?.teardown();
});

describe("daily digest: hearing count", () => {
  it("reports the real number of upcoming hearings, above the 50-item list cap", async () => {
    const { lawyer } = f.ctx;
    expect(await countUpcomingHearings(lawyer, 7)).toBe(DIGEST_HEARINGS + 1);
    expect(await listUpcomingHearings(lawyer, { days: 7, limit: 500 })).toHaveLength(50);
    const digest = await buildDailyDigestData(lawyer);
    expect(digest.items.find((i) => i.label === "Audiências nos próximos 7 dias")?.count).toBe(DIGEST_HEARINGS + 1);
    // Same scope as the list: the RE lawyer does not see the SP processes.
    expect(await countUpcomingHearings(f.ctx.lawyerRe, 7)).toBe(0);
  });
});

describe("hearing reminder e-mails", () => {
  it("sends one reminder; resolving the alert and rerunning does not send another", async () => {
    await runHearingAlertsRoutine(rc());
    expect(await reminders(ids.hearing)).toBe(1);

    const alertId = await openAlertId(ids.hearing);
    expect(alertId).toBeDefined();
    await resolveAlert(f.ctx.lawyer, alertId!);
    expect(await openAlertId(ids.hearing)).toBeUndefined();

    await runHearingAlertsRoutine(rc());
    // The alert reopens (existing convention), the reminder is not repeated.
    expect(await openAlertId(ids.hearing)).toBeDefined();
    expect(await reminders(ids.hearing)).toBe(1);
    await runHearingAlertsRoutine(rc());
    expect(await reminders(ids.hearing)).toBe(1);
  });

  it("a failed generation is retried on the next run", async () => {
    await f.db
      .update(emailMessages)
      .set({ status: "failed" })
      .where(and(eq(emailMessages.organizationId, f.orgA), eq(emailMessages.entityId, ids.hearing)));
    await runHearingAlertsRoutine(rc());
    expect(await reminders(ids.hearing)).toBe(2);
    await runHearingAlertsRoutine(rc());
    expect(await reminders(ids.hearing)).toBe(2);
  });

  it("a hearing corrected after its reminder gets a new one", async () => {
    // Make the previous reminders clearly older than the correction.
    await f.db
      .update(emailMessages)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(and(eq(emailMessages.organizationId, f.orgA), eq(emailMessages.entityId, ids.hearing)));
    await updateHearing(f.ctx.admin, ids.hearing, {
      kind: "initial",
      mode: "in_person",
      date: inDays(4),
      time: "15:30",
      location: "Vara fictícia",
      responsibleId: f.ctx.lawyer.userId,
    });
    await runHearingAlertsRoutine(rc());
    expect(await reminders(ids.hearing)).toBe(3);
    await runHearingAlertsRoutine(rc());
    expect(await reminders(ids.hearing)).toBe(3);
  });

  it("a rescheduled hearing (new hearing) is reminded again", async () => {
    await setHearingStatus(f.ctx.admin, ids.hearing, {
      status: "rescheduled",
      date: inDays(6),
      time: "09:00",
      mode: "in_person",
      location: "Vara fictícia",
      reason: "Redesignada (fictício).",
    });
    const [next] = await f.db
      .select({ id: hearings.id })
      .from(hearings)
      .where(and(eq(hearings.processId, ids.reminderProcess), eq(hearings.status, "scheduled")));
    expect(next.id).not.toBe(ids.hearing);
    await runHearingAlertsRoutine(rc());
    expect(await reminders(next.id)).toBe(1);
    expect(await reminders(ids.hearing)).toBe(3);
  });
});
