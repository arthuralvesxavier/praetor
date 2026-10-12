import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { HEARING_KIND_LABELS, HEARING_MODE_LABELS } from "@/domain/enums";
import { addDaysISO, daysUntil, formatDate, todayISO } from "@/lib/format";
import { systemContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { emailMessages, hearings } from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import type { RoutineContext } from "@/server/jobs/routines";
import { resolveStaleAlerts, upsertAlert } from "@/modules/alerts/service";
import { PROCESS_SECTION_IDS, processTabUrl } from "@/modules/processes/tabs";
import { hearingAlertKey, listScheduledHearingsForAlerts } from "./service";
import { endOfZonedDayExclusive, formatTime } from "./time";

/**
 * `hearing_alerts` routine body (wired in src/server/jobs/routines.ts).
 *
 * - One open `hearing_upcoming` alert per scheduled hearing within
 *   `settings.alerts.upcomingHearingDays` (entity `hearing`, dedupe key
 *   `hearing_upcoming:<id>`); today/tomorrow → critical, otherwise warning.
 *   Only hearings of processes in the active portfolio (status active or
 *   suspended) are alerted and reminded: an archived or closed process keeps
 *   its scheduled hearings on record, without alerts or reminder e-mails.
 * - Alerts of hearings that were held, cancelled, rescheduled, deleted or whose
 *   date has passed are resolved, and so are the alerts of hearings whose
 *   process left the active portfolio (archived or closed).
 * - A hearing with an active responsible person gets ONE SIMULATED reminder
 *   e-mail (template `hearing_reminder`). "Already reminded" is read from the
 *   e-mail table (a non-failed `hearing_reminder` about the hearing generated
 *   after its last change), not from the open alert: resolving the alert does
 *   not trigger a second reminder, a run that stopped before sending retries
 *   the missing ones, a failed generation is retried on the next run, and a
 *   hearing corrected after the reminder (date, place, responsible…) gets a new
 *   one with the current data. A rescheduled hearing is a new hearing (new id)
 *   and is reminded again. E-mail failures never fail the routine.
 */
export async function runHearingAlertsRoutine(rc: RoutineContext): Promise<string> {
  const db = getDb();
  const now = new Date();
  const today = rc.today || todayISO(now);
  const windowDays = Math.max(0, Math.min(365, Math.floor(rc.settings.alerts.upcomingHearingDays ?? 10)));
  const until = endOfZonedDayExclusive(addDaysISO(today, windowDays));

  const upcoming = await listScheduledHearingsForAlerts(rc.organizationId, now, until);
  const keys = upcoming.map((h) => hearingAlertKey(h.id));

  // Which of them were already reminded since their last change (see header).
  const hearingIds = upcoming.map((h) => h.id);
  const reminded = hearingIds.length
    ? await db
        .selectDistinct({ id: emailMessages.entityId })
        .from(emailMessages)
        .innerJoin(
          hearings,
          and(eq(hearings.id, emailMessages.entityId), eq(hearings.organizationId, rc.organizationId)),
        )
        .where(
          and(
            eq(emailMessages.organizationId, rc.organizationId),
            eq(emailMessages.template, "hearing_reminder"),
            eq(emailMessages.entityType, "hearing"),
            inArray(emailMessages.entityId, hearingIds),
            ne(emailMessages.status, "failed"),
            gte(emailMessages.createdAt, hearings.updatedAt),
          ),
        )
    : [];
  const alreadyReminded = new Set(reminded.map((r) => r.id));

  const toNotify: typeof upcoming = [];
  for (const h of upcoming) {
    const date = todayISO(h.scheduledAt);
    const days = daysUntil(date, today);
    const when = `${formatDate(h.scheduledAt)} às ${formatTime(h.scheduledAt)}`;
    const relative = days <= 0 ? "hoje" : days === 1 ? "amanhã" : `em ${days} dias`;
    const kind = HEARING_KIND_LABELS[h.kind];
    const mode = HEARING_MODE_LABELS[h.mode].toLowerCase();
    const where = h.location ? ` Local: ${h.location}.` : "";
    const who = h.responsibleName ? ` Responsável: ${h.responsibleName}.` : " Sem responsável definido.";
    const key = hearingAlertKey(h.id);
    await upsertAlert({
      organizationId: rc.organizationId,
      type: "hearing_upcoming",
      severity: days <= 1 ? "critical" : "warning",
      title: clip(`Audiência ${relative}: ${h.processNumber}, ${when}`, 300),
      message: clip(`${kind} (${mode}) em ${when} no processo ${h.processNumber} (${h.processTitle}).${where}${who}`, 2000),
      entityType: "hearing",
      entityId: h.id,
      dedupeKey: key,
    });
    if (!alreadyReminded.has(h.id) && h.responsibleId && h.responsibleActive) toNotify.push(h);
  }

  const resolved = await resolveStaleAlerts(rc.organizationId, ["hearing_upcoming"], keys);

  let emails = 0;
  let emailFailures = 0;
  if (toNotify.length) {
    const sctx = systemContext(rc.organizationId, rc.isDemo);
    let sendTemplatedEmail: (typeof import("@/modules/emails/service"))["sendTemplatedEmail"] | null = null;
    try {
      ({ sendTemplatedEmail } = await import("@/modules/emails/service"));
    } catch (err) {
      logger.warn("hearing_reminder_unavailable", { error: err instanceof Error ? err.name : "unknown" });
    }
    for (const h of toNotify) {
      if (!sendTemplatedEmail || !h.responsibleId) break;
      try {
        await sendTemplatedEmail(sctx, {
          template: "hearing_reminder",
          toUserId: h.responsibleId,
          data: {
            processNumber: h.processNumber,
            processTitle: h.processTitle,
            kindLabel: HEARING_KIND_LABELS[h.kind],
            modeLabel: HEARING_MODE_LABELS[h.mode],
            scheduledAt: h.scheduledAt.toISOString(),
            location: h.location,
          },
          linkPath: processTabUrl(h.processId, "prazos-e-audiencias", PROCESS_SECTION_IDS.hearings),
          processId: h.processId,
          entity: { type: "hearing", id: h.id },
        });
        emails++;
      } catch (err) {
        emailFailures++;
        // Never log subject/body/addresses: only the error class.
        logger.warn("hearing_reminder_failed", {
          hearingId: h.id,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }

  const parts = [
    `${upcoming.length} audiência(s) designada(s) nos próximos ${windowDays} dia(s)`,
    `${resolved} alerta(s) encerrado(s) automaticamente`,
  ];
  if (emails > 0) parts.push(`${emails} lembrete(s) por e-mail simulado`);
  if (emailFailures > 0) parts.push(`${emailFailures} lembrete(s) não gerado(s)`);
  return `${parts.join("; ")}.`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
