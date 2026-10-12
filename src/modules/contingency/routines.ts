import { and, asc, count, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { AlertType } from "@/domain/enums";
import { addDaysISO, daysUntil, formatDate, formatMoneyCents, toISODate } from "@/lib/format";
import { resolveStaleAlerts, upsertAlert } from "@/modules/alerts/service";
import { systemContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { legalProcesses, processGuarantees, processValuations, settlementInstallments, settlements } from "@/server/db/schema";
import type { RoutineContext } from "@/server/jobs/routines";
import { BINDING_SETTLEMENT_STATUSES, formatPeriod, periodOf } from "./rules";
import { generateSnapshot, getSnapshotStatus } from "./snapshot-service";

/**
 * Routine bodies owned by the contingency module (wired in src/server/jobs/routines.ts).
 * Alert entity conventions: docs/dev/MODULE_CONTRACTS.md ("Alert producers").
 */

const PORTFOLIO_ALERT_TYPES: AlertType[] = [
  "settlement_installment_due",
  "valuation_pending_review",
  "enforcement_without_value",
  "guarantee_idle",
  "process_needs_verification",
];

function clip(t: string, max = 140): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function relative(iso: string, today: string): string {
  const d = daysUntil(iso, today);
  if (d === 0) return "hoje";
  if (d === 1) return "amanhã";
  if (d > 1) return `em ${d} dias`;
  return d === -1 ? "há 1 dia" : `há ${-d} dias`;
}

/** `portfolio_alerts`: settlement installments due, valuations pending review, enforcement without value, idle guarantees, processes needing verification. Returns the pt-BR summary. */
export async function runPortfolioAlertsRoutine(rc: RoutineContext): Promise<string> {
  const db = getDb();
  const org = rc.organizationId;
  const keep: string[] = [];
  const activeProcess = and(
    eq(legalProcesses.organizationId, org),
    isNull(legalProcesses.deletedAt),
    inArray(legalProcesses.status, ["active", "suspended"]),
  );

  // 1. Settlement installments due within the window (overdue included) — one alert per settlement.
  const windowEnd = addDaysISO(rc.today, Math.max(0, rc.settings.alerts.installmentDueDays));
  const due = await db
    .select({
      settlementId: settlements.id,
      installmentsCount: settlements.installmentsCount,
      processNumber: legalProcesses.number,
      number: settlementInstallments.number,
      dueDate: settlementInstallments.dueDate,
      amountCents: settlementInstallments.amountCents,
    })
    .from(settlementInstallments)
    .innerJoin(settlements, eq(settlements.id, settlementInstallments.settlementId))
    .innerJoin(legalProcesses, eq(legalProcesses.id, settlements.processId))
    .where(
      and(
        eq(settlementInstallments.organizationId, org),
        eq(settlements.organizationId, org),
        isNull(settlements.deletedAt),
        isNull(legalProcesses.deletedAt),
        inArray(settlements.status, [...BINDING_SETTLEMENT_STATUSES]),
        eq(settlementInstallments.status, "pending"),
        lte(settlementInstallments.dueDate, windowEnd),
      ),
    )
    .orderBy(asc(settlementInstallments.dueDate), asc(settlementInstallments.number));
  const bySettlement = new Map<string, typeof due>();
  for (const d of due) bySettlement.set(d.settlementId, [...(bySettlement.get(d.settlementId) ?? []), d]);
  for (const [settlementId, list] of bySettlement) {
    const first = list[0];
    const overdue = list.filter((i) => i.dueDate < rc.today).length;
    const key = `settlement_installment_due:${settlementId}`;
    keep.push(key);
    const of = first.installmentsCount ? ` de ${first.installmentsCount}` : "";
    const more = list.length > 1 ? ` Há ${list.length} parcela(s) a pagar na janela de ${rc.settings.alerts.installmentDueDays} dia(s).` : "";
    await upsertAlert({
      organizationId: org,
      type: "settlement_installment_due",
      severity: overdue > 0 ? "critical" : "warning",
      title: overdue > 0 ? `Parcela de acordo vencida: ${first.processNumber}` : `Parcela de acordo a vencer: ${first.processNumber}`,
      message:
        `Parcela ${first.number}${of} (${formatMoneyCents(first.amountCents)}) do acordo do processo ${first.processNumber} ` +
        `${first.dueDate < rc.today ? "venceu" : "vence"} em ${formatDate(first.dueDate)} (${relative(first.dueDate, rc.today)}).${more}`,
      entityType: "settlement",
      entityId: settlementId,
      dedupeKey: key,
    });
  }

  // 2. Valuations pending review — one alert per process.
  const pending = await db
    .select({
      processId: processValuations.processId,
      processNumber: legalProcesses.number,
      n: count(),
      oldest: sql<string>`min(${processValuations.createdAt})`,
    })
    .from(processValuations)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processValuations.processId))
    .where(and(eq(processValuations.organizationId, org), eq(processValuations.status, "proposed"), isNull(legalProcesses.deletedAt)))
    .groupBy(processValuations.processId, legalProcesses.number);
  for (const p of pending) {
    const key = `valuation_pending_review:${p.processId}`;
    keep.push(key);
    const n = Number(p.n);
    await upsertAlert({
      organizationId: org,
      type: "valuation_pending_review",
      severity: "info",
      title: `Valor aguardando conferência: ${p.processNumber}`,
      message:
        `${n} valor(es) proposto(s) no processo ${p.processNumber} aguardam conferência humana na fila de revisão. ` +
        "Valores propostos não entram nos totais oficiais até serem aprovados (RN-11).",
      entityType: "legal_process",
      entityId: p.processId,
      dedupeKey: key,
    });
  }

  // 3. Enforcement / liquidation without an assessed value.
  const enforcement = await db
    .select({ id: legalProcesses.id, number: legalProcesses.number, phase: legalProcesses.phase })
    .from(legalProcesses)
    .where(
      and(
        activeProcess,
        inArray(legalProcesses.phase, ["enforcement", "liquidation"]),
        isNull(legalProcesses.liquidatedAmountCents),
      ),
    );
  for (const p of enforcement) {
    const key = `enforcement_without_value:${p.id}`;
    keep.push(key);
    await upsertAlert({
      organizationId: org,
      type: "enforcement_without_value",
      severity: "warning",
      title: `Execução sem valor apurado: ${p.number}`,
      message:
        `O processo ${p.number} está em fase de ${p.phase === "liquidation" ? "liquidação" : "execução"} sem valor liquidado oficial. ` +
        "Registre o valor apurado (ou proponha para conferência) para que exposição e provisão deixem de ser estimadas.",
      entityType: "legal_process",
      entityId: p.id,
      dedupeKey: key,
    });
  }

  // 4. Idle guarantees (linked, without change for more than N days).
  const idleDays = Math.max(1, rc.settings.contingency.idleGuaranteeDays);
  const cutoff = addDaysISO(rc.today, -idleDays);
  const guarantees = await db
    .select({
      id: processGuarantees.id,
      amountCents: processGuarantees.amountCents,
      depositedAt: processGuarantees.depositedAt,
      statusChangedAt: processGuarantees.statusChangedAt,
      createdAt: processGuarantees.createdAt,
      processNumber: legalProcesses.number,
    })
    .from(processGuarantees)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processGuarantees.processId))
    .where(
      and(
        eq(processGuarantees.organizationId, org),
        eq(processGuarantees.status, "linked"),
        isNull(processGuarantees.deletedAt),
        isNull(legalProcesses.deletedAt),
      ),
    );
  let idle = 0;
  for (const g of guarantees) {
    const since = g.statusChangedAt ?? g.depositedAt ?? toISODate(g.createdAt);
    if (since > cutoff) continue;
    idle++;
    const key = `guarantee_idle:${g.id}`;
    keep.push(key);
    await upsertAlert({
      organizationId: org,
      type: "guarantee_idle",
      severity: "info",
      title: `Garantia parada: ${g.processNumber}`,
      message:
        `A garantia de ${formatMoneyCents(g.amountCents)} do processo ${g.processNumber} está vinculada desde ${formatDate(since)} ` +
        `sem movimentação há mais de ${idleDays} dias. Verifique se pode ser levantada, liberada ou substituída.`,
      entityType: "guarantee",
      entityId: g.id,
      dedupeKey: key,
    });
  }

  // 5. Processes flagged for verification.
  const verification = await db
    .select({ id: legalProcesses.id, number: legalProcesses.number, note: legalProcesses.verificationNote })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.organizationId, org), isNull(legalProcesses.deletedAt), eq(legalProcesses.needsVerification, true)));
  for (const p of verification) {
    const key = `process_needs_verification:${p.id}`;
    keep.push(key);
    await upsertAlert({
      organizationId: org,
      type: "process_needs_verification",
      severity: "warning",
      title: `Processo marcado para verificação: ${p.number}`,
      message: p.note
        ? `Motivo registrado: ${clip(p.note, 300)}`
        : `O processo ${p.number} foi marcado para conferência (divergência ou indicação da fonte).`,
      entityType: "legal_process",
      entityId: p.id,
      dedupeKey: key,
    });
  }

  const resolved = await resolveStaleAlerts(org, PORTFOLIO_ALERT_TYPES, keep);
  return (
    `${bySettlement.size} acordo(s) com parcela na janela, ${pending.length} processo(s) com valor aguardando conferência, ` +
    `${enforcement.length} execução(ões) sem valor apurado, ${idle} garantia(s) parada(s) e ` +
    `${verification.length} processo(s) para verificação; ${resolved} alerta(s) encerrado(s) automaticamente.`
  );
}

/** `monthly_snapshot`: (re)generates the PREVIEW of the current month; never touches closed periods. Returns the pt-BR summary. */
export async function runMonthlySnapshotRoutine(rc: RoutineContext): Promise<string> {
  const period = periodOf(rc.today);
  const status = await getSnapshotStatus(rc.organizationId, period);
  if (status === "closed") return `Competência ${formatPeriod(period)} já fechada; nada foi recalculado.`;
  const result = await generateSnapshot(systemContext(rc.organizationId, rc.isDemo), period);
  const t = result.metrics.totals;
  return (
    `Prévia da competência ${formatPeriod(period)} ${status ? "atualizada" : "gerada"}: ${result.itemCount} processo(s), ` +
    `provisão ${formatMoneyCents(t.provisionCents)} + estimativa ${formatMoneyCents(t.provisionEstimateCents)}.`
  );
}
