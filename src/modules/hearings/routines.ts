import { and, eq, inArray, isNull } from "drizzle-orm";
import { HEARING_KIND_LABELS, HEARING_MODE_LABELS } from "@/domain/enums";
import { addDaysISO, daysUntil, formatDate, todayISO } from "@/lib/format";
import { systemContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { alerts } from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import type { RoutineContext } from "@/server/jobs/routines";
import { resolveStaleAlerts, upsertAlert } from "@/modules/alerts/service";
import { hearingAlertKey, listScheduledHearingsForAlerts } from "./service";
import { endOfZonedDayExclusive, formatTime } from "./time";

/**
 * `hearing_alerts` routine body (wired in src/server/jobs/routines.ts).
 *
 * - One open `hearing_upcoming` alert per scheduled hearing within
 *   `settings.alerts.upcomingHearingDays` (entity `hearing`, dedupe key
 *   `hearing_upcoming:<id>`); today/tomorrow → critical, otherwise warning.
 * - Alerts of hearings that were held, cancelled, rescheduled, deleted or whose
 *   date has passed are resolved.
 * - When an alert is NEWLY created and the hearing has a responsible person, a
 *   SIMULATED reminder e-mail (template `hearing_reminder`) is generated. E-mail
 *   failures never fail the routine.
 */
export async function runHearingAlertsRoutine(rc: RoutineContext): Promise<string> {
  const db = getDb();
  const now = new Date();
  const today = rc.today || todayISO(now);
  const windowDays = Math.max(0, Math.min(365, Math.floor(rc.settings.alerts.upcomingHearingDays ?? 10)));
  const until = endOfZonedDayExclusive(addDaysISO(today, windowDays));

  const upcoming = await listScheduledHearingsForAlerts(rc.organizationId, now, until);
  const keys = upcoming.map((h) => hearingAlertKey(h.id));

  // Which of them already have an open alert (to send the reminder only once).
  const existing = keys.length
    ? await db
        .select({ key: alerts.dedupeKey })
        .from(alerts)
        .where(and(eq(alerts.organizationId, rc.organizationId), isNull(alerts.resolvedAt), inArray(alerts.dedupeKey, keys)))
    : [];
  const alreadyOpen = new Set(existing.map((r) => r.key));

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
      title: clip(`Audiência ${relative}: ${h.processNumber} — ${when}`, 300),
      message: clip(`${kind} (${mode}) em ${when} no processo ${h.processNumber} — ${h.processTitle}.${where}${who}`, 2000),
      entityType: "hearing",
      entityId: h.id,
      dedupeKey: key,
    });
    if (!alreadyOpen.has(key) && h.responsibleId && h.responsibleActive) toNotify.push(h);
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
          linkPath: `/processos/${h.processId}?aba=audiencias`,
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
