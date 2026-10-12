import type { ReactNode } from "react";
import { CORRECTION_INDEX_LABELS } from "@/domain/enums";
import { formatDate, formatMoneyCents, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatMonth, formatMonthRanges, unavailableMessage, type UpdatedValue } from "../math";
import type { ValuationUpdate } from "../types";

/**
 * Original value and UPDATED value of a valuation, side by side (P1.7). Pure
 * presentational components (no hooks): usable in server and client
 * components. The updated value comes from `getValuationUpdates` (computed on
 * read, never stored) and is never added to the valor da causa.
 */

const FACTOR_FORMAT = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 6, maximumFractionDigits: 6 });

/** "R$ 10.000,00" + "Valor original (data-base 15/03/2024)". */
export function ValuationOriginalValue({
  amountCents,
  baseDate,
  struck = false,
  className,
}: {
  amountCents: number;
  baseDate: string;
  /** Rejected values are shown struck through. */
  struck?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("text-right", className)}>
      <span className={cn("block whitespace-nowrap tabular-nums", struck && "line-through")}>{formatMoneyCents(amountCents)}</span>
      <span className="block text-xs whitespace-nowrap text-muted-foreground">{`Valor original (data-base ${formatDate(baseDate)})`}</span>
    </div>
  );
}

function Caption({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" }) {
  return (
    <span className={cn("mt-0.5 block text-xs", tone === "warning" ? "text-amber-800" : "text-muted-foreground")}>{children}</span>
  );
}

/** Text that labels an updated value: "Valor atualizado por IPCA-E até 09/2026". */
export function updatedValueLabel(indexLabel: string, result: Pick<UpdatedValue, "status" | "throughMonth">): string {
  if (result.status === "updated") return `Valor atualizado por ${indexLabel} até ${formatMonth(result.throughMonth)}`;
  if (result.status === "no_months") return `Valor atualizado por ${indexLabel}: sem mês completo após a data-base`;
  if (result.status === "not_corrected") return "Sem atualização (índice: nenhum)";
  if (result.status === "no_index") return "Sem índice informado";
  return `${indexLabel}: atualização indisponível`;
}

/**
 * Updated value cell. `update` undefined = valuation not visible / not loaded.
 * `compact` (dense tables such as the review queue) keeps the value, the index
 * label and the warnings, without the explanatory captions.
 */
export function ValuationUpdatedValue({
  update,
  compact = false,
  className,
}: {
  update: ValuationUpdate | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!update) return <span className={cn("text-xs text-muted-foreground", className)}>Não calculado</span>;
  if (update.status === "rejected") {
    return <span className={cn("text-xs text-muted-foreground", className)}>Não se aplica (valor rejeitado)</span>;
  }
  const r = update.updated;
  const indexLabel = update.correctionIndex ? CORRECTION_INDEX_LABELS[update.correctionIndex] : "";

  if (r.status === "no_index") {
    return (
      <div className={cn("text-right", className)}>
        <span className="block text-sm text-muted-foreground">Sem índice informado</span>
        {compact ? null : <Caption>Valor registrado antes da escolha do índice de atualização.</Caption>}
      </div>
    );
  }
  if (r.status === "unavailable") {
    return (
      <div className={cn("text-right", className)}>
        <span className="block text-sm font-medium text-amber-900">Indisponível</span>
        <Caption tone="warning">{`${indexLabel}: ${unavailableMessage(r)}`}</Caption>
      </div>
    );
  }
  return (
    <div className={cn("text-right", className)}>
      <span className="block whitespace-nowrap tabular-nums">
        {r.cents === null ? <span className="text-muted-foreground">Não calculado</span> : formatMoneyCents(r.cents)}
      </span>
      <Caption>{updatedValueLabel(indexLabel, r)}</Caption>
      {r.status === "not_corrected" && !compact ? (
        <Caption>Índice gravado no registro do valor (padrão da organização naquele momento ou escolha de quem registrou).</Caption>
      ) : null}
      {r.status === "updated" && r.factor !== null && !compact ? (
        <Caption>{`Fator ${FACTOR_FORMAT.format(r.factor)} em ${pluralize(r.monthsApplied, "mês", "meses")}`}</Caption>
      ) : null}
      {r.status === "updated" && r.pendingMonths.length > 0 ? (
        <Caption tone="warning">
          {`Sem taxa coletada para ${formatMonthRanges(r.pendingMonths)} (aguardando publicação ou coleta).`}
        </Caption>
      ) : null}
    </div>
  );
}
