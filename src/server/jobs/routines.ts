import { and, count, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AlertType, RoutineType } from "@/domain/enums";
import { addDaysISO, daysUntil, formatDate, todayISO } from "@/lib/format";
import { systemContext } from "@/server/auth/context";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  aiAnalyses,
  contractObligations,
  contracts,
  deadlines,
  documents,
  legalProcesses,
  occurrences,
  scheduledRoutines,
} from "@/server/db/schema";
import { BudgetExceededError, AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { resolveStaleAlerts, upsertAlert } from "@/modules/alerts/service";
import { listStaleAnalysesForRefresh, requestAnalysis } from "@/modules/analyses/service";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { runMonthlySnapshotRoutine, runPortfolioAlertsRoutine } from "@/modules/contingency/routines";
import { runHearingAlertsRoutine } from "@/modules/hearings/routines";
import type { OrganizationSettings } from "@/server/db/schema";
import { safeErrorMessage } from "./queue";

/**
 * Scheduled routines (interval based, per organization). The worker enqueues a
 * `routine.run` job when `next_run_at` is due; `runRoutine` executes it with
 * the organization's system context. Routines create/resolve alerts and record
 * a pt-BR summary in `last_status`. Nothing is deleted automatically.
 */

export const DEFAULT_ROUTINES: { type: RoutineType; intervalMinutes: number; config: Record<string, unknown> }[] = [
  { type: "deadline_alerts", intervalMinutes: 60, config: {} },
  { type: "contract_expiration_alerts", intervalMinutes: 360, config: {} },
  { type: "stale_analysis_refresh", intervalMinutes: 1440, config: { autoRefresh: false, maxPerRun: 5 } },
  { type: "retention_review", intervalMinutes: 10080, config: {} },
  { type: "hearing_alerts", intervalMinutes: 60, config: {} },
  { type: "portfolio_alerts", intervalMinutes: 360, config: {} },
  { type: "monthly_snapshot", intervalMinutes: 1440, config: {} },
];

export async function ensureDefaultRoutines(organizationId: string, db: DbOrTx = getDb()): Promise<void> {
  await db
    .insert(scheduledRoutines)
    .values(DEFAULT_ROUTINES.map((r) => ({ organizationId, type: r.type, intervalMinutes: r.intervalMinutes, config: r.config })))
    .onConflictDoNothing({ target: [scheduledRoutines.organizationId, scheduledRoutines.type] });
}

export type RoutineContext = {
  organizationId: string;
  isDemo: boolean;
  settings: OrganizationSettings;
  config: Record<string, unknown>;
  today: string;
};

/** Executes one routine. Returns the pt-BR summary stored in `last_status`. */
export async function runRoutine(routineId: string): Promise<{ status: string } | null> {
  if (!z.uuid().safeParse(routineId).success) return null;
  const db = getDb();
  const [routine] = await db.select().from(scheduledRoutines).where(eq(scheduledRoutines.id, routineId));
  if (!routine || !routine.enabled) return null;

  try {
    const org = await loadOrganization(routine.organizationId);
    const rc: RoutineContext = {
      organizationId: routine.organizationId,
      isDemo: org.isDemo,
      settings: org.settings,
      config: routine.config ?? {},
      today: todayISO(),
    };
    const status = await ROUTINES[routine.type](rc);
    await db
      .update(scheduledRoutines)
      .set({ lastRunAt: new Date(), lastStatus: status.slice(0, 1000), lastError: null })
      .where(eq(scheduledRoutines.id, routine.id));
    logger.info("routine_completed", { routineId: routine.id, type: routine.type });
    return { status };
  } catch (err) {
    await db
      .update(scheduledRoutines)
      .set({ lastRunAt: new Date(), lastStatus: "Falhou", lastError: safeErrorMessage(err).slice(0, 500) })
      .where(eq(scheduledRoutines.id, routine.id));
    throw err;
  }
}

const ROUTINES: Record<RoutineType, (rc: RoutineContext) => Promise<string>> = {
  deadline_alerts: runDeadlineAlerts,
  contract_expiration_alerts: runContractExpirationAlerts,
  stale_analysis_refresh: runStaleAnalysisRefresh,
  retention_review: runRetentionReview,
  hearing_alerts: runHearingAlertsRoutine,
  portfolio_alerts: runPortfolioAlertsRoutine,
  monthly_snapshot: runMonthlySnapshotRoutine,
};

function clipTitle(t: string, max = 140): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function relativeDays(iso: string, today: string): string {
  const d = daysUntil(iso, today);
  if (d === 0) return "hoje";
  if (d === 1) return "amanhã";
  if (d > 1) return `em ${d} dias`;
  return d === -1 ? "há 1 dia" : `há ${-d} dias`;
}

// ---------------------------------------------------------------------------
// deadline_alerts
// ---------------------------------------------------------------------------

const DEADLINE_ALERT_TYPES: AlertType[] = ["deadline_overdue", "deadline_upcoming", "deadline_pending_validation"];

async function runDeadlineAlerts(rc: RoutineContext): Promise<string> {
  const db = getDb();
  const limit = addDaysISO(rc.today, Math.max(0, rc.settings.alerts.upcomingDeadlineDays));
  const base = and(eq(deadlines.organizationId, rc.organizationId), isNull(deadlines.deletedAt), eq(deadlines.status, "open"));

  const due = await db
    .select({ id: deadlines.id, title: deadlines.title, dueDate: deadlines.dueDate })
    .from(deadlines)
    .where(and(base, inArray(deadlines.validationStatus, ["not_required", "validated"]), lte(deadlines.dueDate, limit)));
  const pending = await db
    .select({ id: deadlines.id, title: deadlines.title, dueDate: deadlines.dueDate })
    .from(deadlines)
    .where(and(base, eq(deadlines.validationStatus, "pending_validation")));

  const keep: string[] = [];
  let overdue = 0;
  let upcoming = 0;
  for (const d of due) {
    const title = clipTitle(d.title);
    if (d.dueDate < rc.today) {
      overdue++;
      const key = `deadline_overdue:${d.id}`;
      keep.push(key);
      await upsertAlert({
        organizationId: rc.organizationId,
        type: "deadline_overdue",
        severity: "critical",
        title: `Prazo vencido: ${title}`,
        message: `O prazo "${title}" venceu em ${formatDate(d.dueDate)} (${relativeDays(d.dueDate, rc.today)}) e continua em aberto.`,
        entityType: "deadline",
        entityId: d.id,
        dedupeKey: key,
      });
    } else {
      upcoming++;
      const key = `deadline_upcoming:${d.id}`;
      keep.push(key);
      await upsertAlert({
        organizationId: rc.organizationId,
        type: "deadline_upcoming",
        severity: "warning",
        title: `Prazo próximo: ${title}`,
        message: `O prazo "${title}" vence em ${formatDate(d.dueDate)} (${relativeDays(d.dueDate, rc.today)}).`,
        entityType: "deadline",
        entityId: d.id,
        dedupeKey: key,
      });
    }
  }
  for (const d of pending) {
    const title = clipTitle(d.title);
    const key = `deadline_pending_validation:${d.id}`;
    keep.push(key);
    await upsertAlert({
      organizationId: rc.organizationId,
      type: "deadline_pending_validation",
      severity: "info",
      title: `Prazo sugerido pela IA aguardando validação: ${title}`,
      message:
        `A data ${formatDate(d.dueDate)} foi sugerida a partir de uma análise de IA e só passará a contar como prazo ` +
        "depois de validada por uma pessoa com permissão.",
      entityType: "deadline",
      entityId: d.id,
      dedupeKey: key,
    });
  }
  const resolved = await resolveStaleAlerts(rc.organizationId, DEADLINE_ALERT_TYPES, keep);
  return (
    `${overdue} prazo(s) vencido(s), ${upcoming} prazo(s) próximo(s) e ${pending.length} aguardando validação; ` +
    `${resolved} alerta(s) encerrado(s) automaticamente.`
  );
}

// ---------------------------------------------------------------------------
// contract_expiration_alerts
// ---------------------------------------------------------------------------

const CONTRACT_ALERT_TYPES: AlertType[] = ["contract_expiring", "obligation_due"];

async function runContractExpirationAlerts(rc: RoutineContext): Promise<string> {
  const db = getDb();
  const windowEnd = addDaysISO(rc.today, Math.max(0, rc.settings.alerts.contractExpirationDays));
  const keep: string[] = [];

  const active = await db
    .select({
      id: contracts.id,
      title: contracts.title,
      counterparty: contracts.counterparty,
      endDate: contracts.endDate,
      renewalType: contracts.renewalType,
      renewalNoticeDays: contracts.renewalNoticeDays,
    })
    .from(contracts)
    .where(
      and(
        eq(contracts.organizationId, rc.organizationId),
        isNull(contracts.deletedAt),
        eq(contracts.status, "active"),
        isNotNull(contracts.endDate),
      ),
    );

  let expiring = 0;
  for (const c of active) {
    const endDate = c.endDate!;
    const notice = c.renewalNoticeDays && c.renewalNoticeDays > 0 ? addDaysISO(endDate, -c.renewalNoticeDays) : null;
    const keyDate = notice && notice < endDate ? notice : endDate;
    if (keyDate > windowEnd) continue;
    expiring++;
    const title = clipTitle(c.title);
    let severity: "warning" | "critical" = "warning";
    let message: string;
    if (endDate < rc.today) {
      severity = "critical";
      message = `A vigência do contrato "${title}" (${c.counterparty}) terminou em ${formatDate(endDate)}, mas o contrato continua marcado como vigente.`;
    } else if (notice && notice <= rc.today) {
      severity = "critical";
      message =
        `O prazo de aviso de ${c.renewalNoticeDays} dia(s) para renovação ou rescisão do contrato "${title}" ` +
        `(${c.counterparty}) foi atingido em ${formatDate(notice)}; a vigência termina em ${formatDate(endDate)}.`;
    } else if (notice) {
      message =
        `O contrato "${title}" (${c.counterparty}) termina em ${formatDate(endDate)}. A data-limite para aviso de ` +
        `renovação ou rescisão é ${formatDate(notice)} (${relativeDays(notice, rc.today)}).`;
    } else {
      message = `O contrato "${title}" (${c.counterparty}) termina em ${formatDate(endDate)} (${relativeDays(endDate, rc.today)}).`;
    }
    if (c.renewalType === "automatic") message += " Atenção: o contrato prevê renovação automática.";
    const key = `contract_expiring:${c.id}`;
    keep.push(key);
    await upsertAlert({
      organizationId: rc.organizationId,
      type: "contract_expiring",
      severity,
      title: `Contrato próximo do vencimento: ${title}`,
      message,
      entityType: "contract",
      entityId: c.id,
      dedupeKey: key,
    });
  }

  const obligations = await db
    .select({
      id: contractObligations.id,
      description: contractObligations.description,
      dueDate: contractObligations.dueDate,
      contractId: contractObligations.contractId,
      contractTitle: contracts.title,
    })
    .from(contractObligations)
    .innerJoin(contracts, eq(contracts.id, contractObligations.contractId))
    .where(
      and(
        eq(contractObligations.organizationId, rc.organizationId),
        eq(contracts.organizationId, rc.organizationId),
        isNull(contracts.deletedAt),
        inArray(contracts.status, ["active", "under_review", "draft"]),
        inArray(contractObligations.status, ["pending", "overdue"]),
        isNotNull(contractObligations.dueDate),
        lte(contractObligations.dueDate, windowEnd),
      ),
    );
  for (const o of obligations) {
    const due = o.dueDate!;
    const desc = clipTitle(o.description, 160);
    const key = `obligation_due:${o.id}`;
    keep.push(key);
    const late = due < rc.today;
    await upsertAlert({
      organizationId: rc.organizationId,
      type: "obligation_due",
      severity: late ? "critical" : "warning",
      title: late ? `Obrigação contratual em atraso: ${clipTitle(o.contractTitle)}` : `Obrigação contratual próxima: ${clipTitle(o.contractTitle)}`,
      message: `"${desc}" — vencimento em ${formatDate(due)} (${relativeDays(due, rc.today)}).`,
      entityType: "contract",
      entityId: o.contractId,
      dedupeKey: key,
    });
  }

  const resolved = await resolveStaleAlerts(rc.organizationId, CONTRACT_ALERT_TYPES, keep);
  return (
    `${expiring} contrato(s) próximo(s) do vencimento e ${obligations.length} obrigação(ões) com vencimento na janela; ` +
    `${resolved} alerta(s) encerrado(s) automaticamente.`
  );
}

// ---------------------------------------------------------------------------
// stale_analysis_refresh
// ---------------------------------------------------------------------------

async function runStaleAnalysisRefresh(rc: RoutineContext): Promise<string> {
  const db = getDb();
  const [{ total }] = await db
    .select({ total: count() })
    .from(aiAnalyses)
    .where(and(eq(aiAnalyses.organizationId, rc.organizationId), eq(aiAnalyses.status, "succeeded"), eq(aiAnalyses.isStale, true)));
  const staleCount = Number(total);
  const autoRefresh = rc.config.autoRefresh === true;
  if (!autoRefresh) {
    return `${staleCount} análise(s) desatualizada(s). Reanálise automática desativada.`;
  }
  const maxPerRun = Math.max(1, Math.min(50, Number(rc.config.maxPerRun) || 5));
  const candidates = await listStaleAnalysesForRefresh(rc.organizationId, maxPerRun);
  const sys = systemContext(rc.organizationId, rc.isDemo);
  let requested = 0;
  let skipped = 0;
  let budgetStop = false;
  for (const a of candidates) {
    try {
      const r = await requestAnalysis(sys, {
        type: a.type,
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        trigger: "scheduled",
      });
      if (!r.reused) requested++;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetStop = true;
        break;
      }
      if (err instanceof AppError) {
        skipped++;
        continue;
      }
      throw err;
    }
  }
  return (
    `${staleCount} análise(s) desatualizada(s); ${requested} reanálise(s) solicitada(s)` +
    (skipped ? `; ${skipped} ignorada(s) (registro indisponível)` : "") +
    (budgetStop ? "; execução interrompida: limite mensal de uso de IA atingido." : ".")
  );
}

// ---------------------------------------------------------------------------
// retention_review (report only — never deletes)
// ---------------------------------------------------------------------------

async function runRetentionReview(rc: RoutineContext): Promise<string> {
  const db = getDb();
  const days = Math.max(0, rc.settings.retention.closedRecordRetentionDays);
  const cutoffDate = addDaysISO(rc.today, -days);
  const cutoffTs = new Date(Date.now() - days * 86_400_000);

  const [p] = await db
    .select({ n: count() })
    .from(legalProcesses)
    .where(
      and(
        eq(legalProcesses.organizationId, rc.organizationId),
        isNull(legalProcesses.deletedAt),
        eq(legalProcesses.legalHold, false),
        inArray(legalProcesses.status, ["closed", "archived"]),
        or(
          and(isNotNull(legalProcesses.closedAt), lt(legalProcesses.closedAt, cutoffDate)),
          and(isNull(legalProcesses.closedAt), lt(legalProcesses.updatedAt, cutoffTs)),
        ),
      ),
    );
  const [o] = await db
    .select({ n: count() })
    .from(occurrences)
    .where(
      and(
        eq(occurrences.organizationId, rc.organizationId),
        isNull(occurrences.deletedAt),
        eq(occurrences.legalHold, false),
        eq(occurrences.status, "resolved"),
        or(
          and(isNotNull(occurrences.resolvedAt), lt(occurrences.resolvedAt, cutoffTs)),
          and(isNull(occurrences.resolvedAt), lt(occurrences.updatedAt, cutoffTs)),
        ),
      ),
    );
  const [d] = await db
    .select({ n: count() })
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, rc.organizationId),
        isNull(documents.deletedAt),
        eq(documents.legalHold, false),
        isNotNull(documents.retentionUntil),
        lt(documents.retentionUntil, rc.today),
      ),
    );
  return (
    `Elegíveis para revisão de exclusão: ${Number(p.n)} processo(s), ${Number(o.n)} ocorrência(s) e ` +
    `${Number(d.n)} documento(s). Nenhum registro foi excluído automaticamente.`
  );
}

// ---------------------------------------------------------------------------
// Scheduling (used by the worker loop)
// ---------------------------------------------------------------------------

/**
 * Claims due routines (advancing `next_run_at` atomically so concurrent
 * workers do not double-schedule) and returns them for enqueueing.
 */
export async function claimDueRoutines(
  db: DbOrTx = getDb(),
): Promise<{ id: string; organizationId: string; type: RoutineType }[]> {
  const due = db
    .select({ id: scheduledRoutines.id })
    .from(scheduledRoutines)
    .where(and(eq(scheduledRoutines.enabled, true), lte(scheduledRoutines.nextRunAt, sql`now()`)))
    .limit(50)
    .for("update", { skipLocked: true });
  return db
    .update(scheduledRoutines)
    .set({ nextRunAt: sql`now() + (${scheduledRoutines.intervalMinutes} * interval '1 minute')` })
    .where(and(inArray(scheduledRoutines.id, due), gte(scheduledRoutines.intervalMinutes, 1)))
    .returning({ id: scheduledRoutines.id, organizationId: scheduledRoutines.organizationId, type: scheduledRoutines.type });
}
