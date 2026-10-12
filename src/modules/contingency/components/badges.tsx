import { Calculator, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatBp } from "@/domain/contingency";
import {
  GUARANTEE_STATUS_LABELS,
  INSTALLMENT_STATUS_LABELS,
  LOSS_PROBABILITY_LABELS,
  SETTLEMENT_STATUS_LABELS,
  SNAPSHOT_STATUS_LABELS,
  VALUATION_STATUS_LABELS,
  type GuaranteeStatus,
  type InstallmentStatus,
  type LossProbability,
  type SettlementStatus,
  type SnapshotStatus,
  type ValuationStatus,
} from "@/domain/enums";
import { formatMoneyCents } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  GUARANTEE_STATUS_TONES,
  INSTALLMENT_STATUS_TONES,
  LOSS_PROBABILITY_TONES,
  NOT_ASSESSED,
  SETTLEMENT_STATUS_TONES,
  SNAPSHOT_STATUS_SHORT,
  SNAPSHOT_STATUS_TONES,
  VALUATION_STATUS_SHORT,
  VALUATION_STATUS_TONES,
} from "../labels";

/** Presentational helpers of the contingency module (no hooks: usable in server and client components). */

export function ValuationStatusBadge({ status }: { status: ValuationStatus }) {
  return (
    <span title={VALUATION_STATUS_LABELS[status]}>
      <StatusBadge label={VALUATION_STATUS_SHORT[status]} tone={VALUATION_STATUS_TONES[status]} />
    </span>
  );
}

export function GuaranteeStatusBadge({ status }: { status: GuaranteeStatus }) {
  return <StatusBadge label={GUARANTEE_STATUS_LABELS[status]} tone={GUARANTEE_STATUS_TONES[status]} />;
}

export function SettlementStatusBadge({ status }: { status: SettlementStatus }) {
  return <StatusBadge label={SETTLEMENT_STATUS_LABELS[status]} tone={SETTLEMENT_STATUS_TONES[status]} />;
}

export function InstallmentStatusBadge({ status, overdue }: { status: InstallmentStatus; overdue?: boolean }) {
  if (status === "pending" && overdue) return <StatusBadge label="Vencida" tone="danger" />;
  return <StatusBadge label={INSTALLMENT_STATUS_LABELS[status]} tone={INSTALLMENT_STATUS_TONES[status]} />;
}

export function SnapshotStatusBadge({ status, long = false }: { status: SnapshotStatus; long?: boolean }) {
  return (
    <Badge tone={SNAPSHOT_STATUS_TONES[status]} dot icon={status === "closed" ? <Lock /> : undefined}>
      {long ? SNAPSHOT_STATUS_LABELS[status] : SNAPSHOT_STATUS_SHORT[status]}
    </Badge>
  );
}

/** Loss probability + percentage; null → "Não classificado". */
export function ClassificationBadge({
  classification,
  percentageBp,
}: {
  classification: LossProbability | null;
  percentageBp?: number | null;
}) {
  if (!classification) return <StatusBadge label="Não classificado" tone="neutral" />;
  const pct = percentageBp !== null && percentageBp !== undefined ? ` · ${formatBp(percentageBp)}` : "";
  return <StatusBadge label={`${LOSS_PROBABILITY_LABELS[classification]}${pct}`} tone={LOSS_PROBABILITY_TONES[classification]} />;
}

/** RN-07: every estimated amount carries this badge. */
export function EstimateBadge({ className, label = "Estimativa" }: { className?: string; label?: string }) {
  return (
    <Badge tone="warning" icon={<Calculator />} className={className} title="Sem valor liquidado: base = valor da causa ponderado pelo risco">
      {label}
    </Badge>
  );
}

/** Money with a pt-BR fallback for null values (RN-03: null is not zero). */
export function Money({
  cents,
  fallback = NOT_ASSESSED,
  className,
}: {
  cents: number | null | undefined;
  fallback?: string;
  className?: string;
}) {
  if (cents === null || cents === undefined) {
    return <span className={cn("text-muted-foreground italic", className)}>{fallback}</span>;
  }
  return <span className={cn("tabular-nums", className)}>{formatMoneyCents(cents)}</span>;
}

/** Signed variation ("+ R$ 1.000,00" / "− R$ 500,00"), with text so color is not the only signal. */
export function Delta({ cents, className }: { cents: number; className?: string }) {
  if (cents === 0) return <span className={cn("text-muted-foreground tabular-nums", className)}>sem variação</span>;
  const up = cents > 0;
  return (
    <span className={cn("tabular-nums", up ? "text-red-800" : "text-emerald-800", className)}>
      {up ? "+ " : "− "}
      {formatMoneyCents(Math.abs(cents))}
      <span className="sr-only">{up ? " (aumento)" : " (redução)"}</span>
    </span>
  );
}
