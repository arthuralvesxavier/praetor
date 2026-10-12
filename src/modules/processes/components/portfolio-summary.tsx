import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { coverageStatement, liquidatedCoverage } from "@/modules/dashboard/portfolio";
import type { ProcessListSummary } from "../service";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Cell({
  label,
  value,
  note,
  noteTitle,
  href,
  className,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  noteTitle?: string;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <span className="mt-0.5 block text-lg leading-7 font-semibold tracking-tight text-slate-900 tabular-nums">{value}</span>
      {note ? (
        <span className="block text-xs text-muted-foreground" title={noteTitle}>
          {note}
        </span>
      ) : null}
    </>
  );
  const base = "min-w-0 bg-surface px-4 py-2.5";
  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          base,
          "group block transition-colors hover:bg-primary-50/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={cn(base, className)}>{body}</div>;
}

function MutedValue({ children }: { children: ReactNode }) {
  return <span className="text-base font-medium text-muted-foreground">{children}</span>;
}

export type PortfolioSummaryProps = {
  summary: ProcessListSummary;
  /** Link to the processes pending a check (`verificar=1`); omitted when that filter is already applied. */
  verificationHref?: string;
};

/**
 * Compact totals of the filtered portfolio: unique CNJ numbers, the valor da
 * causa sum and the valor apurado sum side by side (two separate figures, never
 * added together; a process without valor apurado is "não apurado", never zero)
 * and the processes pending a check.
 */
export function PortfolioSummary({ summary, verificationHref }: PortfolioSummaryProps) {
  const liquidated = liquidatedCoverage(summary);
  const empty = summary.count === 0;
  const claimValue = empty ? (
    <MutedValue>Sem processos</MutedValue>
  ) : summary.claimUnknown >= summary.count ? (
    <MutedValue>Sem valor informado</MutedValue>
  ) : (
    formatMoneyCents(summary.claimCents)
  );
  const liquidatedValue = empty ? (
    <MutedValue>Sem processos</MutedValue>
  ) : liquidated.assessed === 0 ? (
    <MutedValue>Sem valor apurado</MutedValue>
  ) : (
    formatMoneyCents(summary.liquidatedCents)
  );
  const coverageTitle =
    summary.liquidatedUnknown > 0
      ? `${capitalize(coverageStatement(liquidated))}; ${pluralize(summary.liquidatedUnknown, "não apurado", "não apurados")} não ${
          summary.liquidatedUnknown === 1 ? "entra" : "entram"
        } como zero.`
      : undefined;

  return (
    <section
      aria-label="Totais do recorte filtrado"
      className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-xs lg:grid-cols-4"
    >
      <Cell
        label="Processos (CNJ únicos)"
        value={formatNumber(summary.count)}
        note="Instâncias contam uma vez"
        noteTitle="Instâncias do mesmo número CNJ contam uma vez."
        className="order-1"
      />
      <Cell
        label="Valor da causa (soma)"
        value={claimValue}
        note={
          empty
            ? undefined
            : summary.claimUnknown > 0
              ? pluralize(summary.claimUnknown, "sem valor informado", "sem valor informado")
              : "Todos com valor informado"
        }
        className="order-3 lg:order-2"
      />
      <Cell
        label="Valor apurado (soma)"
        value={liquidatedValue}
        note={
          empty
            ? undefined
            : summary.liquidatedUnknown > 0
              ? pluralize(summary.liquidatedUnknown, "não apurado", "não apurados")
              : "Todos com valor apurado"
        }
        noteTitle={coverageTitle}
        className="order-4 lg:order-3"
      />
      <Cell
        label="Pendentes de conferência"
        value={
          <span className={cn("inline-flex items-center gap-1", summary.needsVerification > 0 && "text-amber-700")}>
            {formatNumber(summary.needsVerification)}
            {verificationHref && summary.needsVerification > 0 ? (
              <ChevronRight aria-hidden="true" className="size-4 text-primary-600 group-hover:text-primary" />
            ) : null}
          </span>
        }
        note={summary.needsVerification > 0 ? (verificationHref ? "Ver os processos" : "Filtro aplicado") : "Nenhum processo"}
        href={verificationHref && summary.needsVerification > 0 ? verificationHref : undefined}
        className="order-2 lg:order-4"
      />
    </section>
  );
}
