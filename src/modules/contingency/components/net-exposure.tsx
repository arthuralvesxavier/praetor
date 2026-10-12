import { Scale } from "lucide-react";
import { formatBp } from "@/domain/contingency";
import { GUARANTEE_KIND_LABELS } from "@/domain/enums";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NOT_ASSESSED } from "../labels";
import { EstimateBadge } from "./badges";
import type { ExposureBreakdown } from "./exposure-breakdown";

/**
 * "Exposição líquida" of a process (P1.8): valor apurado in force − linked
 * guarantees (never negative), with the list of what was deducted. Without an
 * apurado value the net exposure is "Não apurado" and the estimated exposure
 * (valor da causa × % − guarantees) is shown apart, labeled "Estimado".
 * Presentational, no hooks: rendered by the Valores tab and the overview card.
 */
export function NetExposurePanel({
  breakdown: b,
  compact = false,
  headingId,
}: {
  breakdown: ExposureBreakdown;
  /** Overview card: smaller number and spacing. */
  compact?: boolean;
  headingId: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn("rounded-lg border border-primary-200 bg-primary-50/40", compact ? "p-3" : "p-4 shadow-xs")}
    >
      <h3 id={headingId} className="flex items-center gap-2 text-xs font-semibold tracking-wide text-primary-800 uppercase">
        <Scale aria-hidden="true" className="size-3.5" />
        Exposição líquida
      </h3>
      {b.net ? (
        <>
          <p className={cn("mt-1 font-semibold text-slate-900 tabular-nums", compact ? "text-2xl" : "text-3xl")}>
            {formatMoneyCents(b.net.exposureCents)}
          </p>
          <p className="mt-1 text-sm text-slate-700">
            Valor apurado vigente {formatMoneyCents(b.net.liquidatedCents)}
            {b.net.liquidatedBaseDate ? ` (data-base ${formatDate(b.net.liquidatedBaseDate)})` : ""} − garantias vinculadas{" "}
            {formatMoneyCents(b.net.guaranteesCents)} = {formatMoneyCents(b.net.exposureCents)}
          </p>
          {b.net.guaranteesExceedCents > 0 ? (
            <p className="mt-1 text-xs text-slate-600">
              As garantias vinculadas superam o valor apurado em {formatMoneyCents(b.net.guaranteesExceedCents)}: a exposição
              líquida fica em {formatMoneyCents(0)}, nunca negativa.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className={cn("mt-1 font-semibold text-muted-foreground italic", compact ? "text-xl" : "text-2xl")}>{NOT_ASSESSED}</p>
          <p className="mt-1 text-sm text-slate-700">
            Sem valor apurado em vigor, a exposição líquida não é calculada (não apurado não significa zero). O valor da causa
            não é somado ao valor apurado.
          </p>
        </>
      )}

      <Deductions b={b} compact={compact} />

      {b.net ? null : <EstimatedExposure b={b} compact={compact} />}
    </section>
  );
}

function Deductions({ b, compact }: { b: ExposureBreakdown; compact: boolean }) {
  if (b.deductions.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">Nenhuma garantia vinculada: nada foi abatido.</p>;
  }
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-slate-700">{b.net ? "O que foi abatido" : "Garantias vinculadas que abatem a exposição"}</p>
      <ul className={cn("mt-1 divide-y divide-border rounded-md border border-border bg-surface text-sm", compact && "text-xs")}>
        {b.deductions.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-1.5">
            <span className="text-slate-800">
              {GUARANTEE_KIND_LABELS[d.kind]}
              <span className="ml-2 text-xs text-muted-foreground">
                {d.depositedAt ? `depósito em ${formatDate(d.depositedAt)}` : "sem data de depósito informada"}
              </span>
            </span>
            <span className="font-medium text-slate-900 tabular-nums">{formatMoneyCents(d.amountCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EstimatedExposure({ b, compact }: { b: ExposureBreakdown; compact: boolean }) {
  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2">
      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-900">
        Exposição estimada
        <EstimateBadge label="Estimado" />
      </p>
      {b.estimate ? (
        <>
          <p className={cn("mt-1 font-semibold text-slate-900 tabular-nums", compact ? "text-base" : "text-lg")}>
            {formatMoneyCents(b.estimate.exposureCents)}
          </p>
          <p className="mt-0.5 text-xs text-slate-700">
            Valor da causa {formatMoneyCents(b.estimate.claimCents)} × {formatBp(b.estimate.percentageBp)} ={" "}
            {formatMoneyCents(b.estimate.weightedCents)} − garantias vinculadas {formatMoneyCents(b.estimate.guaranteesCents)}.
            Estimativa: não é valor apurado e não se soma a ele.
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs text-slate-700">
          Não calculada: {estimateMissingText(b.estimateMissing)}.
        </p>
      )}
    </div>
  );
}

function estimateMissingText(m: ExposureBreakdown["estimateMissing"]): string {
  if (m?.claim && m.classification) return "sem valor da causa e sem classificação de risco";
  if (m?.claim) return "sem valor da causa";
  return "sem classificação de risco";
}
