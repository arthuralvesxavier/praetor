import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableHead } from "@/components/ui/table";
import { exposureBasisCounts, type AmountBasisCounts, type MoneyBucket } from "@/domain/contingency";
import { formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Table cells for report money (RN-02 / RN-03 / RN-07): right-aligned tabular
 * numbers; unknown values are never shown as zero.
 */

export function NumHead({ children, className }: { children: ReactNode; className?: string }) {
  return <TableHead className={cn("text-right", className)}>{children}</TableHead>;
}

export function NumCell({ children, className }: { children: ReactNode; className?: string }) {
  return <TableCell className={cn("whitespace-nowrap text-right tabular-nums", className)}>{children}</TableCell>;
}

/**
 * Sum of the known values of a group plus how many are unknown.
 * Everything unknown -> the unknown label (e.g. "Não apurado"), never "R$ 0,00".
 */
export function MoneyGroupCell({
  cents,
  count,
  unknown,
  unknownLabel,
  unknownSingular,
  unknownPlural,
  showUnknownCount = true,
  footer,
  className,
}: {
  cents: number;
  count: number;
  unknown: number;
  unknownLabel: string;
  unknownSingular: string;
  unknownPlural: string;
  /** False when a neighbouring column already counts the unknown processes. */
  showUnknownCount?: boolean;
  /** Extra lines under the amount (e.g. the variation against the previous competência). */
  footer?: ReactNode;
  className?: string;
}) {
  const allUnknown = count > 0 && unknown >= count;
  return (
    <NumCell className={className}>
      {count === 0 ? (
        <span className="text-muted-foreground">Sem processos</span>
      ) : allUnknown ? (
        <span className="text-muted-foreground">{unknownLabel}</span>
      ) : (
        formatMoneyCents(cents)
      )}
      {showUnknownCount && !allUnknown && unknown > 0 ? (
        <span className="block text-xs font-normal text-muted-foreground">
          + {pluralize(unknown, unknownSingular, unknownPlural)}
        </span>
      ) : null}
      {footer}
    </NumCell>
  );
}

/** Single process value: null -> "Não apurado" / "Não informado" (RN-03). */
export function MoneyValueCell({
  cents,
  nullLabel,
  estimate = false,
  className,
}: {
  cents: number | null;
  nullLabel: string;
  estimate?: boolean;
  className?: string;
}) {
  return (
    <NumCell className={className}>
      {cents === null ? <span className="text-muted-foreground">{nullLabel}</span> : formatMoneyCents(cents)}
      {cents !== null && estimate ? (
        <span className="mt-0.5 block">
          <EstimateBadge />
        </span>
      ) : null}
    </NumCell>
  );
}

/**
 * Estimated money (RN-07): shown with an explicit text marker, never by color alone.
 * With `count` (processes whose amount is an estimate), a group without any estimate reads
 * "Sem estimativa" (or `emptyLabel`) instead of R$ 0, and a calculated zero stays a zero.
 * Without `count` (stored balances), a zero sum is shown muted as before.
 */
export function EstimateMoneyCell({
  cents,
  count,
  emptyLabel = "Sem estimativa",
  note,
  footer,
  className,
}: {
  cents: number;
  count?: number;
  emptyLabel?: string;
  note?: ReactNode;
  /** Extra lines under the amount and the note (e.g. the variation against the previous competência). */
  footer?: ReactNode;
  className?: string;
}) {
  const has = count === undefined ? cents > 0 : count > 0;
  return (
    <NumCell className={cn(has ? "text-amber-900" : undefined, className)}>
      {has ? (
        <>
          {formatMoneyCents(cents)}
          <span className="sr-only"> (estimativa)</span>
        </>
      ) : (
        <span className="text-muted-foreground">{count === undefined ? formatMoneyCents(0) : emptyLabel}</span>
      )}
      {note ? <span className="block text-xs font-normal text-muted-foreground">{note}</span> : null}
      {footer}
    </NumCell>
  );
}

/** Estimated exposure of a group, with how many processes have no basis at all (no valor apurado, no valor da causa or no risk). */
export function ExposureEstimateCell({ bucket, footer, className }: { bucket: MoneyBucket; footer?: ReactNode; className?: string }) {
  const basis = exposureBasisCounts(bucket);
  return (
    <EstimateMoneyCell
      cents={bucket.exposureEstimateCents}
      count={basis.estimate}
      note={basis.none > 0 ? pluralize(basis.none, "sem base de cálculo", "sem base de cálculo") : null}
      footer={footer}
      className={className}
    />
  );
}

/**
 * Provision on the valor apurado of a group. With the basis counts, a group where nothing
 * was calculated reads "Não apurada" (no valor apurado) or "Não calculada" (valor apurado
 * without a risk classification), never R$ 0 (RN-03).
 */
export function ProvisionAmountCell({
  cents,
  basis,
  liquidatedCount,
  emptyLabel,
  className,
}: {
  cents: number;
  basis?: AmountBasisCounts;
  /** Processes of the group with a valor apurado, when known. */
  liquidatedCount?: number;
  /** Text when nothing was calculated (default: "Não calculada" with valor apurado, "Não apurada" without). */
  emptyLabel?: string;
  className?: string;
}) {
  const calculated = basis ? basis.official > 0 : liquidatedCount === undefined || liquidatedCount > 0;
  const label = emptyLabel ?? (liquidatedCount !== undefined && liquidatedCount > 0 ? "Não calculada" : "Não apurada");
  return (
    <NumCell className={className}>{calculated ? formatMoneyCents(cents) : <span className="text-muted-foreground">{label}</span>}</NumCell>
  );
}

export function EstimateBadge({ label = "Estimativa" }: { label?: string }) {
  return (
    <Badge tone="warning" title="Estimativa calculada sobre o valor da causa (sem valor liquidado)">
      {label}
    </Badge>
  );
}

export function CountCell({ value, className }: { value: number; className?: string }) {
  return <NumCell className={className}>{formatNumber(value)}</NumCell>;
}

/** "+ 3" / "− 2" / "sem variação" for a money delta. */
export function DeltaMoney({ delta }: { delta: number }) {
  if (delta === 0) return <span className="text-muted-foreground">sem variação</span>;
  const sign = delta > 0 ? "+" : "−";
  return (
    <span className={delta > 0 ? "text-red-800" : "text-emerald-800"}>
      {sign} {formatMoneyCents(Math.abs(delta))}
      <span className="sr-only">{delta > 0 ? " (aumento)" : " (redução)"}</span>
    </span>
  );
}

/**
 * Variation of an amount against the previous competência: "antes <valor>" and the difference.
 * With `delta` null (no process or nothing calculated on one of the sides) the cell says so:
 * a difference against a zero that means "não apurado" would read null as zero (RN-03).
 */
export function VariationCell({
  previous,
  previousEmpty,
  delta,
  className,
}: {
  previous: number | null;
  /** Text after "antes" when the previous amount does not exist ("não apurada", "sem processos"). */
  previousEmpty: string;
  delta: number | null;
  className?: string;
}) {
  return (
    <NumCell className={className}>
      <VariationLines previous={previous} previousEmpty={previousEmpty} delta={delta} />
    </NumCell>
  );
}

/**
 * The lines of `VariationCell` without the cell, to go under an amount in the same cell
 * ("antes R$ X" and the difference, or "sem base de comparação"). `compact` sets the
 * difference in the small type of a secondary line.
 */
export function VariationLines({
  previous,
  previousEmpty,
  delta,
  compact = false,
}: {
  previous: number | null;
  previousEmpty: string;
  delta: number | null;
  compact?: boolean;
}) {
  return (
    <>
      <span className={cn("block text-xs font-normal text-muted-foreground", compact && "mt-1")}>
        antes {previous === null ? previousEmpty : formatMoneyCents(previous)}
      </span>
      <span className={cn("block", compact && "text-xs font-normal")}>
        {delta === null ? <span className="text-muted-foreground">sem base de comparação</span> : <DeltaMoney delta={delta} />}
      </span>
    </>
  );
}

export function DeltaCount({ delta }: { delta: number }) {
  if (delta === 0) return <span className="text-muted-foreground">=</span>;
  return (
    <span>
      {delta > 0 ? "+" : "−"}
      {formatNumber(Math.abs(delta))}
      <span className="sr-only">{delta > 0 ? " processos a mais" : " processos a menos"}</span>
    </span>
  );
}
