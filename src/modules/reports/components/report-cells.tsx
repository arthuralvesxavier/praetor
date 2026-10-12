import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableHead } from "@/components/ui/table";
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
  className,
}: {
  cents: number;
  count: number;
  unknown: number;
  unknownLabel: string;
  unknownSingular: string;
  unknownPlural: string;
  className?: string;
}) {
  const allUnknown = count > 0 && unknown >= count;
  return (
    <NumCell className={className}>
      {count === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : allUnknown ? (
        <span className="text-muted-foreground">{unknownLabel}</span>
      ) : (
        formatMoneyCents(cents)
      )}
      {!allUnknown && unknown > 0 ? (
        <span className="block text-xs font-normal text-muted-foreground">
          + {pluralize(unknown, unknownSingular, unknownPlural)}
        </span>
      ) : null}
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

/** Estimated money (RN-07): shown with an explicit text marker, never by color alone. */
export function EstimateMoneyCell({ cents, className }: { cents: number; className?: string }) {
  return (
    <NumCell className={cn(cents > 0 ? "text-amber-900" : undefined, className)}>
      {cents > 0 ? (
        <>
          {formatMoneyCents(cents)}
          <span className="sr-only"> (estimativa)</span>
        </>
      ) : (
        <span className="text-muted-foreground">{formatMoneyCents(0)}</span>
      )}
    </NumCell>
  );
}

export function EstimateBadge({ label = "Estimativa" }: { label?: string }) {
  return (
    <Badge tone="warning" title="Estimativa calculada sobre o valor da causa (sem valor liquidado) — RN-07">
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
