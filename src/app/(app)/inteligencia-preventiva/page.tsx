import { ShieldCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { PROCESS_STATUS_LABELS } from "@/domain/enums";
import { formatDateTime, formatMoneyCents, formatNumber, formatPercent, pluralize } from "@/lib/format";
import { buildHref, hasAnyParam, idParam, param } from "@/lib/search-params";
import { PROCESS_STATUS_TONES } from "@/lib/tones";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";
import {
  BasisNote,
  ComputedBadge,
  DemoDocumentsBadge,
  GroupStatTable,
  IllustrativeBadge,
  IndicatorCard,
  SectionHeading,
  ShareBar,
} from "@/modules/preventive-intel/components/indicator-parts";
import { SuggestionCard } from "@/modules/preventive-intel/components/suggestion-card";
import { getPreventiveIntelligence, listPreventiveIntelFilterOptions } from "@/modules/preventive-intel/service";
import { CLOSURE_GROUP_LABELS, type PreventiveIntelFilters, type PreventiveIntelligence } from "@/modules/preventive-intel/types";

export const metadata: Metadata = { title: "Inteligência preventiva" };

const BASE_PATH = "/inteligencia-preventiva";

export default async function InteligenciaPreventivaPage(props: PageProps<"/inteligencia-preventiva">) {
  const ctx = await requirePageContext("preventive_intel:read");
  const sp = await props.searchParams;
  const options = await listPreventiveIntelFilterOptions(ctx);
  const courtParam = param(sp, "tribunal");
  const filters: PreventiveIntelFilters = {
    companyId: idParam(sp, "empresa"),
    court: courtParam && options.courts.includes(courtParam) ? courtParam : undefined,
  };

  let intel: PreventiveIntelligence | null = null;
  let error: string | null = null;
  try {
    intel = await getPreventiveIntelligence(ctx, filters);
  } catch (err) {
    if (err instanceof AppError && err.code === "validation") error = err.message;
    else throw err;
  }

  const canCreateOccurrence = can(ctx, "occurrence:write");
  const canCreateTasks = can(ctx, "task:write");

  return (
    <div className="space-y-8">
      <PageHeader
        title="Inteligência preventiva"
        description="Indicadores calculados a partir da carteira de processos, pedidos recorrentes das análises preliminares e sugestões ilustrativas de medidas preventivas."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Inteligência preventiva" }]}
        className="mb-0"
        actions={
          can(ctx, "occurrence:read") ? (
            <ButtonLink href="/preventivo?origem=inteligencia-preventiva" variant="outline">
              <ShieldCheck aria-hidden="true" />
              Ocorrências originadas daqui
            </ButtonLink>
          ) : null
        }
      />

      <FilterBar basePath={BASE_PATH} search={false} showClear={hasAnyParam(sp, ["empresa", "tribunal"])} className="mb-0">
        <FilterSelect
          name="empresa"
          label="Empresa"
          options={options.companies.map((c) => ({ value: c.id, label: c.name }))}
          defaultValue={filters.companyId}
          placeholder="Todas"
        />
        <FilterSelect
          name="tribunal"
          label="Tribunal"
          options={options.courts.map((c) => ({ value: c, label: c }))}
          defaultValue={filters.court}
          placeholder="Todos"
        />
      </FilterBar>

      {error ? (
        <Callout tone="danger" title="Não foi possível calcular os indicadores" role="alert">
          {error}
        </Callout>
      ) : null}

      {intel ? (
        <>
          <div className="rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm">
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
              <dt className="font-medium text-slate-600">Escopo</dt>
              <dd className="text-slate-900">{intel.scope.label}</dd>
              <dt className="font-medium text-slate-600">Filtros</dt>
              <dd className="text-slate-900">{intel.filterSummary}</dd>
              <dt className="font-medium text-slate-600">Calculado em</dt>
              <dd className="text-slate-900">
                {formatDateTime(intel.generatedAt)} — {pluralize(intel.totals.all, "processo", "processos")} (
                {formatNumber(intel.totals.active)} na carteira ativa, {formatNumber(intel.totals.closed)} encerrados)
              </dd>
            </dl>
          </div>

          {intel.totals.all === 0 ? (
            <EmptyState
              title="Nenhum processo para analisar"
              description={
                hasAnyParam(sp, ["empresa", "tribunal"])
                  ? "Não há processos visíveis com estes filtros."
                  : "Os indicadores aparecem quando houver processos visíveis para o seu perfil."
              }
            />
          ) : (
            <>
              <ComputedSection intel={intel} sp={sp} />
              <ClaimsSection intel={intel} />
              <SuggestionsSection
                intel={intel}
                filters={filters}
                canCreateOccurrence={canCreateOccurrence}
                canCreateTasks={canCreateTasks}
              />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 1 — calculado a partir da carteira
// ---------------------------------------------------------------------------

function ComputedSection({ intel, sp }: { intel: PreventiveIntelligence; sp: Awaited<PageProps<"/inteligencia-preventiva">["searchParams"]> }) {
  const pd = intel.phaseDistribution;
  const verifyHref = buildHref("/processos", {}, { verificar: 1, tribunal: param(sp, "tribunal"), empresa: idParam(sp, "empresa") });
  return (
    <section aria-labelledby="secao-calculado" className="space-y-4 border-l-4 border-primary-600 pl-4">
      <SectionHeading
        id="secao-calculado"
        badge={<ComputedBadge />}
        title="Indicadores da carteira"
        description="Calculados a partir dos processos visíveis para o seu perfil. Cada indicador mostra a fórmula usada e quantos processos foram considerados. Valor da causa e valor liquidado aparecem lado a lado e não são somados; valores não apurados não contam como zero."
      />

      <Card className="py-4">
        <CardHeader actions={<ComputedBadge />}>
          <CardTitle as="h3">Fatores de risco identificados</CardTitle>
        </CardHeader>
        <CardContent>
          {intel.riskFactors.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum sinal acima dos limiares de referência com os filtros atuais.</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {intel.riskFactors.map((f) => (
                <li key={f.key} className="flex gap-3 rounded-md border border-border p-3">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-700" />
                  <div className="min-w-0 text-sm">
                    <p className="font-semibold text-slate-900">
                      {f.title} <span className="font-normal text-slate-700">— {f.value}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{f.explanation}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
            Sinais calculados com limiares de referência fixos desta versão; não são previsão de resultado nem avaliação jurídica.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <IndicatorCard title="Recorrência por classe processual" basis={intel.classRecurrence.basis}>
          <GroupStatTable label="Processos por classe" header="Classe" rows={intel.classRecurrence.rows.slice(0, 10)} />
        </IndicatorCard>

        <IndicatorCard
          title="Distribuição por fase"
          basis={pd.basis}
          headline={
            <span className="text-base font-medium text-slate-700">
              Passivo materializado: <span className="font-semibold text-slate-900">{formatPercent(pd.materializedShare, 1)}</span>{" "}
              ({pluralize(pd.materializedCount, "processo", "processos")} em liquidação ou execução
              {pd.materializedCount > 0
                ? `; liquidado ${pd.materializedCount > pd.materializedLiquidatedUnknown ? formatMoneyCents(pd.materializedLiquidatedCents) : "não apurado"}${pd.materializedLiquidatedUnknown > 0 && pd.materializedCount > pd.materializedLiquidatedUnknown ? ` + ${formatNumber(pd.materializedLiquidatedUnknown)} não apurado(s)` : ""}`
                : ""}
              )
            </span>
          }
        >
          <GroupStatTable label="Processos ativos por fase" header="Fase" rows={pd.rows} />
        </IndicatorCard>
      </div>

      <IndicatorCard title="Concentração por tribunal, cidade e vara" basis={intel.concentration.basis}>
        <div className="grid gap-6 xl:grid-cols-3">
          <div>
            <h4 className="mb-1 text-sm font-semibold text-slate-800">Tribunal</h4>
            <GroupStatTable label="Concentração por tribunal" header="Tribunal" rows={intel.concentration.byCourt} showMoney={false} />
          </div>
          <div>
            <h4 className="mb-1 text-sm font-semibold text-slate-800">Cidade</h4>
            <GroupStatTable label="Concentração por cidade" header="Cidade" rows={intel.concentration.byCity} showMoney={false} />
          </div>
          <div>
            <h4 className="mb-1 text-sm font-semibold text-slate-800">Vara / órgão julgador</h4>
            <GroupStatTable
              label="Concentração por vara"
              header="Vara"
              rows={intel.concentration.byDivision}
              showMoney={false}
              emptyMessage="Nenhuma vara informada."
            />
          </div>
        </div>
        <div className="mt-4">
          <h4 className="mb-1 text-sm font-semibold text-slate-800">Valores por tribunal (dez maiores)</h4>
          <GroupStatTable label="Valores por tribunal" header="Tribunal" rows={intel.concentration.byCourt} />
        </div>
      </IndicatorCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <IndicatorCard title="Tendência de ajuizamento por ano" basis={intel.filingTrend.basis}>
          <YearBars rows={intel.filingTrend.rows} />
          {intel.filingTrend.withoutYear > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {pluralize(intel.filingTrend.withoutYear, "processo sem ano identificável", "processos sem ano identificável")} (número fora do
              padrão CNJ e sem data de distribuição).
            </p>
          ) : null}
        </IndicatorCard>

        <IndicatorCard title="Desfechos de encerramento" basis={intel.closureOutcomes.basis}>
          <div className="-mx-5">
            <Table aria-label="Desfechos de encerramento">
              <TableHeader>
                <TableRow>
                  <TableHead>Motivo</TableHead>
                  <TableHead>Grupo</TableHead>
                  <TableHead className="text-right">Processos</TableHead>
                  <TableHead>Participação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {intel.closureOutcomes.rows.length === 0 ? (
                  <TableEmpty colSpan={4} message="Nenhum processo encerrado." />
                ) : (
                  intel.closureOutcomes.rows.map((r) => (
                    <TableRow key={r.reason}>
                      <TableCell>{r.label}</TableCell>
                      <TableCell className="text-xs text-slate-700">{CLOSURE_GROUP_LABELS[r.group]}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.count)}</TableCell>
                      <TableCell>
                        <ShareBar share={r.share} label={r.label} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </IndicatorCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <IndicatorCard
          title="Reclamantes recorrentes"
          basis={intel.repeatPlaintiffs.basis}
          headline={pluralize(intel.repeatPlaintiffs.plaintiffCount, "parte autora", "partes autoras")}
        >
          <p className="text-sm text-slate-700">
            com mais de um processo ({pluralize(intel.repeatPlaintiffs.processCount, "processo envolvido", "processos envolvidos")}).
          </p>
          {intel.repeatPlaintiffs.names.length > 0 ? (
            <details className="mt-2 rounded-md border border-border px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium text-primary focus-visible:outline-2 focus-visible:outline-ring">
                Ver nomes ({formatNumber(intel.repeatPlaintiffs.names.length)})
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                Somente processos que você pode consultar. O link abre a carteira filtrada pelo nome.
              </p>
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                {intel.repeatPlaintiffs.names.map((n) => (
                  <li key={n.name} className="flex items-center justify-between gap-2">
                    <Link href={n.href} className={tableLinkClasses}>
                      {n.name}
                    </Link>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{pluralize(n.processCount, "processo", "processos")}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </IndicatorCard>

        <IndicatorCard
          title="Ações coletivas e com o Ministério Público"
          basis={intel.collectiveActions.basis}
          headline={pluralize(intel.collectiveActions.count, "processo", "processos")}
        >
          {intel.collectiveActions.processes.length > 0 ? (
            <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
              {intel.collectiveActions.processes.slice(0, 20).map((p) => (
                <li key={p.id}>
                  <Link href={`/processos/${p.id}`} className={tableLinkClasses}>
                    {p.number}
                  </Link>
                  <span className="ml-2 inline-block align-middle">
                    <StatusBadge label={PROCESS_STATUS_LABELS[p.status]} tone={PROCESS_STATUS_TONES[p.status]} />
                  </span>
                  <span className="block text-xs text-muted-foreground">{p.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nenhuma ação coletiva ou com o Ministério Público.</p>
          )}
        </IndicatorCard>

        <IndicatorCard
          title="Cadastros a verificar"
          basis={intel.verification.basis}
          headline={`${formatPercent(intel.verification.share, 1)}`}
        >
          <p className="text-sm text-slate-700">
            {pluralize(intel.verification.count, "processo ativo marcado", "processos ativos marcados")} para verificação (dados
            incompletos, divergentes ou com pendência na fonte).
          </p>
          {intel.verification.count > 0 ? (
            <Link href={verifyHref} className="mt-2 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">
              Ver processos a verificar
            </Link>
          ) : null}
        </IndicatorCard>
      </div>

      <IndicatorCard title="Razão valor liquidado ÷ valor da causa por tribunal" basis={intel.liquidatedRatio.basis}>
        <div className="-mx-5">
          <Table aria-label="Razão entre valor liquidado e valor da causa por tribunal">
            <TableHeader>
              <TableRow>
                <TableHead>Tribunal</TableHead>
                <TableHead className="text-right">Processos</TableHead>
                <TableHead className="text-right">Valor da causa</TableHead>
                <TableHead className="text-right">Valor liquidado</TableHead>
                <TableHead className="text-right">Razão</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {intel.liquidatedRatio.rows.length === 0 ? (
                <TableEmpty colSpan={5} message="Nenhum processo com valor da causa e valor liquidado informados." />
              ) : (
                intel.liquidatedRatio.rows.map((r) => (
                  <TableRow key={r.court}>
                    <TableCell>{r.court}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.processCount)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{formatMoneyCents(r.claimCents)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{formatMoneyCents(r.liquidatedCents)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {r.ratio.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </IndicatorCard>
    </section>
  );
}

function YearBars({ rows }: { rows: PreventiveIntelligence["filingTrend"]["rows"] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nenhum ano identificável.</p>;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <ul aria-label="Processos por ano de ajuizamento" className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.year} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 text-sm">
          <span className="tabular-nums text-slate-700">{r.year}</span>
          <span aria-hidden="true" className="h-3 overflow-hidden rounded-r bg-slate-100">
            <span className="block h-full rounded-r bg-primary-600" style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums text-slate-900">
            {formatNumber(r.count)}
            {r.fromFiledAt > 0 ? <span className="ml-1 text-xs text-muted-foreground">({formatNumber(r.fromFiledAt)} pela data)</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Section 2 — pedidos recorrentes (análises preliminares, documentos fictícios)
// ---------------------------------------------------------------------------

function ClaimsSection({ intel }: { intel: PreventiveIntelligence }) {
  const c = intel.recurringClaims;
  return (
    <section aria-labelledby="secao-pedidos" className="space-y-4 border-l-4 border-amber-400 pl-4">
      <SectionHeading
        id="secao-pedidos"
        badge={<DemoDocumentsBadge />}
        title="Pedidos recorrentes (a partir das análises preliminares — documentos de demonstração)"
        description="Agregado dos pedidos com proveniência “Extraído de documento” da análise preliminar mais recente de cada processo visível. As análises preliminares desta versão são SIMULADAS e leem documentos FICTÍCIOS gerados para demonstração: os números ilustram o recurso e não descrevem processos reais."
      />
      <Card className="py-4">
        <CardContent>
          {c.briefsConsidered === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma análise preliminar pronta ou aprovada nos processos visíveis com estes filtros.
            </p>
          ) : (
            <div className="-mx-5">
              <Table aria-label="Pedidos recorrentes por categoria">
                <TableHeader>
                  <TableRow>
                    <TableHead>Categoria de pedido</TableHead>
                    <TableHead className="text-right">Processos</TableHead>
                    <TableHead>Participação</TableHead>
                    <TableHead className="text-right">Valores indicados nas peças</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {c.rows.length === 0 ? (
                    <TableEmpty colSpan={4} message="Nenhum pedido extraído pôde ser categorizado." />
                  ) : (
                    c.rows.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell>{r.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(r.processCount)}</TableCell>
                        <TableCell>
                          <ShareBar share={r.share} label={r.label} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {r.withAmount > 0 ? (
                            <>
                              {formatMoneyCents(r.amountCents)}
                              <span className="block text-xs text-muted-foreground">
                                em {pluralize(r.withAmount, "pedido com valor", "pedidos com valor")}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">Não indicado</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          <BasisNote
            basis={{
              formula: `Processos com ao menos um pedido extraído na categoria ÷ processos com análise preliminar considerada. ${pluralize(c.claimsConsidered, "pedido extraído lido", "pedidos extraídos lidos")}; ${pluralize(c.uncategorized, "sem categoria", "sem categoria")}; ${pluralize(c.ignoredNotExtracted, "item não extraído ignorado", "itens não extraídos ignorados")}; ${pluralize(c.excludedSensitive, "pedido sobre dado sensível não agregado", "pedidos sobre dados sensíveis não agregados")} (saúde ou filiação sindical — PD-06).`,
              population: "Análises preliminares (mais recente por processo; prontas, em revisão ou aprovadas)",
              processCount: c.briefsConsidered,
            }}
          />
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 3 — sugestões ilustrativas
// ---------------------------------------------------------------------------

function SuggestionsSection({
  intel,
  filters,
  canCreateOccurrence,
  canCreateTasks,
}: {
  intel: PreventiveIntelligence;
  filters: PreventiveIntelFilters;
  canCreateOccurrence: boolean;
  canCreateTasks: boolean;
}) {
  return (
    <section aria-labelledby="secao-sugestoes" className="space-y-4 border-l-4 border-dashed border-amber-400 pl-4">
      <SectionHeading
        id="secao-sugestoes"
        badge={<IllustrativeBadge />}
        title="Sugestões preventivas ilustrativas"
        description="Medidas genéricas de gestão disparadas por um indicador calculado. São exemplos para discussão com as áreas responsáveis — não são fatos dos processos, parecer jurídico nem previsão de resultado. Nada é criado automaticamente: ocorrências e tarefas só surgem quando você clicar."
      />
      {intel.suggestions.length === 0 ? (
        <p className="rounded-md border border-dashed border-border-strong bg-surface px-4 py-6 text-center text-sm text-muted-foreground">
          Nenhum indicador atingiu os limiares de referência com os filtros atuais.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {intel.suggestions.map((s) => (
            <SuggestionCard
              key={s.key}
              suggestion={s}
              filters={filters}
              canCreateOccurrence={canCreateOccurrence}
              canCreateTasks={canCreateTasks}
            />
          ))}
        </div>
      )}
    </section>
  );
}
