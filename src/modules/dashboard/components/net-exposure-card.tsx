import { ChevronDown, Scale } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { GUARANTEE_KIND_LABELS } from "@/domain/enums";
import { formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { processTabUrl } from "@/modules/processes/tabs";
import { coverageStatement, type NetExposureSummary } from "../portfolio";

const money = (cents: number) => formatMoneyCents(cents);

/**
 * P1.8 at the top of the portfolio block: "Exposição líquida" of the active portfolio in
 * scope = valor apurado vigente − garantias vinculadas, per process and never negative,
 * with its coverage, and an expandable detail of what was deducted (by guarantee kind and
 * the processes with the largest deductions). The estimated exposure of the processes
 * without a valor apurado is shown apart, labeled "Estimado", and is never added to it.
 * Without any valor apurado the net exposure reads "Não apurado" (never R$ 0).
 */
export function NetExposureCard({ summary: s, headingId = "exposicao-liquida" }: { summary: NetExposureSummary; headingId?: string }) {
  const assessed = s.coverage.assessed > 0;
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-primary-200 bg-primary-50/40 p-4 shadow-xs sm:p-5">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)]">
        <div className="min-w-0">
          <h3 id={headingId} className="flex items-center gap-2 text-xs font-semibold tracking-wide text-primary-800 uppercase">
            <Scale aria-hidden="true" className="size-3.5" />
            Exposição líquida da carteira
          </h3>
          {assessed ? (
            <>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums sm:text-3xl">
                {money(s.exposureCents)}
              </p>
              <p className="mt-1 text-sm text-slate-700">
                Valor apurado vigente <span className="tabular-nums">{money(s.liquidatedCents)}</span> − garantias vinculadas
                abatidas <span className="tabular-nums">{money(s.deductedCents)}</span> ={" "}
                <span className="tabular-nums">{money(s.exposureCents)}</span>.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Calculada sobre o {coverageStatement(s.coverage)}, processo a processo e nunca negativa. Não apurado não entra
                como zero e o valor da causa não é somado ao valor apurado.
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold text-muted-foreground italic">Não apurado</p>
              <p className="mt-1 text-sm text-slate-700">
                {s.coverage.total === 0
                  ? "Nenhum processo na carteira ativa com os filtros selecionados."
                  : `Nenhum dos ${pluralize(s.coverage.total, "processo", "processos")} tem valor apurado: a exposição líquida não é calculada (não apurado não significa zero).`}
              </p>
            </>
          )}
        </div>
        <EstimatedExposure s={s} />
      </div>
      {assessed ? <Deductions s={s} /> : null}
    </section>
  );
}

function EstimatedExposure({ s }: { s: NetExposureSummary }) {
  const e = s.estimate;
  return (
    <div className="min-w-0 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-900">
        Exposição estimada
        <Badge tone="warning" className="px-1.5 py-0 text-[11px] leading-4">
          Estimado
        </Badge>
      </p>
      {e.processes > 0 ? (
        <>
          <p className="mt-1 text-lg font-semibold text-slate-900 tabular-nums">{money(e.exposureCents)}</p>
          <p className="mt-0.5 text-xs text-slate-700">
            {pluralize(e.processes, "processo", "processos")} sem valor apurado: valor da causa × % de risco − garantias
            vinculadas{e.guaranteesCents > 0 ? ` (${money(e.guaranteesCents)} em garantias)` : ""}. É uma estimativa e não se
            soma à exposição líquida.
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          {s.coverage.total > 0 && s.coverage.assessed === s.coverage.total
            ? "Sem estimativa: todos os processos têm valor apurado."
            : "Não informado: nenhum processo sem valor apurado tem valor da causa e classificação de risco."}
        </p>
      )}
      {e.noBasis > 0 ? (
        <p className="mt-1 text-xs text-slate-700">
          {pluralize(e.noBasis, "processo", "processos")} sem base de cálculo (sem valor apurado e sem valor da causa ou
          classificação de risco).
        </p>
      ) : null}
    </div>
  );
}

function Deductions({ s }: { s: NetExposureSummary }) {
  if (s.withGuarantees === 0) {
    return (
      <p className="mt-4 text-xs text-muted-foreground">
        Nenhuma garantia vinculada aos processos com valor apurado: nada foi abatido.
      </p>
    );
  }
  const kindsTotal = s.byKind.reduce((n, k) => n + k.amountCents, 0);
  const kindsCount = s.byKind.reduce((n, k) => n + k.count, 0);
  const more = s.withGuarantees - s.top.length;
  return (
    <details className="group mt-4 rounded-md border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-800 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span>
          O que foi abatido: <span className="tabular-nums">{money(s.deductedCents)}</span>
          <span className="font-normal text-muted-foreground">
            {" "}
            em {pluralize(s.withGuarantees, "processo", "processos")}
          </span>
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-border px-3 py-3">
        <p className="text-xs text-slate-700">
          Garantias vinculadas aos processos com valor apurado: <span className="tabular-nums">{money(s.guaranteesCents)}</span>
          . Cada processo abate no máximo o seu próprio valor apurado.
          {s.excess.processes > 0
            ? ` Em ${pluralize(s.excess.processes, "processo", "processos")} as garantias superam o valor apurado: o excedente de ${money(s.excess.cents)} não é abatido de outros processos e a exposição ${s.excess.processes === 1 ? "desse processo fica" : "desses processos fica"} em ${money(0)}.`
            : ""}
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-slate-800">Por tipo de garantia</h4>
            <table className="mt-1 w-full text-left text-sm">
              <caption className="sr-only">Garantias vinculadas aos processos com valor apurado, por tipo</caption>
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-2 font-medium">
                    Tipo
                  </th>
                  <th scope="col" className="py-1.5 pr-2 text-right font-medium">
                    Garantias
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Valor vinculado
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.byKind.map((k) => (
                  <tr key={k.kind} className="border-b border-border/60 text-slate-800">
                    <th scope="row" className="py-1.5 pr-2 font-normal">
                      {GUARANTEE_KIND_LABELS[k.kind] ?? k.kind}
                    </th>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatNumber(k.count)}</td>
                    <td className="py-1.5 text-right whitespace-nowrap tabular-nums">{money(k.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-slate-900">
                  <th scope="row" className="py-1.5 pr-2 font-medium">
                    Total
                  </th>
                  <td className="py-1.5 pr-2 text-right font-medium tabular-nums">{formatNumber(kindsCount)}</td>
                  <td className="py-1.5 text-right font-medium whitespace-nowrap tabular-nums">{money(kindsTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-slate-800">Processos com maior abatimento</h4>
            <ol className="mt-1 divide-y divide-border/60" aria-label="Processos com maior abatimento">
              {s.top.map((t) => (
                <li
                  key={t.processId}
                  className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-1.5 tabular-nums sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  {/* Phones: number, values, deduction, exposure (stacked); from sm: two columns. */}
                  <Link
                    href={processTabUrl(t.processId, "valores-e-acordos")}
                    className="min-w-0 self-start text-sm font-medium [overflow-wrap:anywhere] text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {t.number}
                  </Link>
                  <span className="order-3 text-sm font-medium whitespace-nowrap text-slate-900 sm:order-none sm:text-right">
                    <span className="sr-only">abatido </span>− {money(t.deductedCents)}
                  </span>
                  <span className="order-2 min-w-0 text-xs text-muted-foreground sm:order-none">
                    apurado {money(t.liquidatedCents)} · garantias {money(t.guaranteesCents)}
                  </span>
                  <span className="order-4 text-xs whitespace-nowrap text-muted-foreground sm:order-none sm:text-right">
                    exposição {money(t.exposureCents)}
                  </span>
                </li>
              ))}
            </ol>
            {more > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                E mais {pluralize(more, "processo", "processos")} com garantias abatidas.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </details>
  );
}
