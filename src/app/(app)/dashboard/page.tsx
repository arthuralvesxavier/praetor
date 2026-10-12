import { CalendarClock, CalendarX, FileClock, Inbox, ListTodo, ShieldAlert, TrendingUp } from "lucide-react";
import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { LEGAL_AREA_LABELS, OCCURRENCE_CATEGORY_LABELS, RISK_LEVEL_LABELS, RISK_LEVELS, type AiMode } from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, formatNumber } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam } from "@/lib/search-params";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { AlertList } from "@/modules/alerts/components/alert-list";
import { getAiRuntimeInfo } from "@/modules/analyses/service";
import {
  BI_PERIOD_LABELS,
  BI_PERIODS,
  contractsHref,
  deadlinesHref,
  hasDimensionFilter,
  parseBiFilters,
  processesHref,
  tasksHref,
  workListMatchesFilters,
} from "@/modules/dashboard/bi-filters";
import { getBiData } from "@/modules/dashboard/bi-service";
import { ActivityFeed } from "@/modules/dashboard/components/activity-feed";
import { BarChart } from "@/modules/dashboard/components/charts/bar-chart";
import { ChartCard } from "@/modules/dashboard/components/charts/chart-card";
import { ColumnChart } from "@/modules/dashboard/components/charts/column-chart";
import { CRITICAL, RISK_COLORS, SERIES } from "@/modules/dashboard/components/charts/palette";
import { ShareBars } from "@/modules/dashboard/components/charts/share-bars";
import { AlertGroupsCard, BriefsAwaitingCard, IntakeCard } from "@/modules/dashboard/components/follow-up-cards";
import { DecisionBand } from "@/modules/dashboard/components/decision-band";
import { HowToRead } from "@/modules/dashboard/components/how-to-read";
import { MoreIndicators } from "@/modules/dashboard/components/more-indicators";
import { NetExposureCard } from "@/modules/dashboard/components/net-exposure-card";
import {
  ExposureByDimension,
  PortfolioKpis,
  PreviousClosingCard,
  RegistrationGaps,
  TopExposures,
} from "@/modules/dashboard/components/portfolio-panel";
import { AiCard, ContractsCard } from "@/modules/dashboard/components/side-cards";
import { UpcomingDeadlines } from "@/modules/dashboard/components/upcoming-deadlines";
import { getDecisionBand } from "@/modules/dashboard/decision-service";
import { parseChartDimension } from "@/modules/dashboard/dimension-chart";
import { formatLongDate } from "@/modules/dashboard/format";
import { getFollowUpPanel, getPortfolioPanel } from "@/modules/dashboard/portfolio-service";
import { getDashboardData } from "@/modules/dashboard/service";
import { listCompanyOptions } from "@/modules/organization/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { logger } from "@/server/lib/logger";

export const metadata: Metadata = { title: "Painel executivo" };

const FILTER_KEYS = ["periodo", "empresa", "unidade", "area", "responsavel"] as const;
/** The portfolio chart's dimension (`dimensao`) is submitted with this form (see `ExposureByDimension`). */
const FILTER_FORM_ID = "filtros-painel";

/** "8 no período · 2 no período anterior" (neutral: more entries is neither good nor bad). */
function flowHint(current: number, previous: number | null, noun: string) {
  const base = `${formatNumber(current)} ${noun} no período`;
  return previous == null ? base : `${base} · ${formatNumber(previous)} no período anterior`;
}

export default async function DashboardPage(props: PageProps<"/dashboard">) {
  const ctx = await requirePageContext("dashboard:read");
  const sp = await props.searchParams;
  const filters = parseBiFilters(sp);
  const chartDimension = parseChartDimension(sp);

  const [decision, portfolio, followUpV2, bi, followUp, unitOptions, userOptions, companyOptions] = await Promise.all([
    getDecisionBand(ctx),
    getPortfolioPanel(ctx, filters),
    getFollowUpPanel(ctx),
    getBiData(ctx, filters),
    getDashboardData(ctx),
    listUnitOptions(ctx),
    listUserOptions(ctx),
    listCompanyOptions(ctx),
  ]);
  const { kpis, sections, buckets } = bi;

  let aiMode: AiMode | null = null;
  try {
    aiMode = getAiRuntimeInfo().mode;
  } catch (error) {
    logger.error("ai_runtime_info_failed", { error });
  }

  const money = (n: number) => formatMoneyCents(n);
  const scopeNote =
    filters.area || filters.companyId
      ? "Os filtros de empresa e de área jurídica não se aplicam a ocorrências nem a contratos (eles não têm empresa nem área)."
      : undefined;
  const periodLabel = BI_PERIOD_LABELS[filters.period].toLowerCase();
  // `/entrada` requires intake:manage: without it the intake figures are shown without links.
  const canIntake = can(ctx, "intake:manage");
  // Links only where the list reproduces the figure (`/prazos` filters by responsible only; `/contratos` has no unit).
  const workLinks = workListMatchesFilters(filters);
  const contractLinks = !filters.unitId;
  const followUpCards = [followUpV2.intake.status !== "forbidden", true, followUpV2.briefs.status !== "forbidden"].filter(
    Boolean,
  ).length;
  // The period only applies inside "Mais indicadores": open it when the URL chose one.
  const moreOpen = enumParam(sp, "periodo", BI_PERIODS) !== undefined;
  const notFiltered = hasDimensionFilter(filters) ? " Os filtros acima não se aplicam a este grupo." : "";

  return (
    <div className="space-y-8">
      <PageHeader
        title="Painel executivo"
        description="O que exige decisão agora e a carteira de passivo, calculados sobre os registros que o seu perfil pode acessar. Os demais indicadores ficam em “Mais indicadores”."
        meta={
          <p className="text-xs text-muted-foreground">
            {formatLongDate(bi.today)} · dados atualizados em{" "}
            <time dateTime={bi.generatedAt.toISOString()}>{formatDateTime(bi.generatedAt)}</time>
          </p>
        }
        actions={<HowToRead upcomingDays={bi.upcomingDays} contractDays={bi.contractDays} />}
      />

      {/* 1. What requires a decision now (not affected by the filters below). */}
      <DecisionBand band={decision} />

      <div className="border-t border-border pt-6">
        {/* One filter row above everything it scopes. */}
        <FilterBar
          id={FILTER_FORM_ID}
          basePath="/dashboard"
          search={false}
          showClear={hasAnyParam(sp, FILTER_KEYS)}
          className="mb-0"
        >
          <FilterSelect
            name="periodo"
            label="Período (mais indicadores)"
            options={BI_PERIODS.filter((p) => p !== "12m").map((p) => ({ value: p, label: BI_PERIOD_LABELS[p] }))}
            placeholder={BI_PERIOD_LABELS["12m"]}
            defaultValue={filters.period === "12m" ? undefined : filters.period}
          />
          {companyOptions.length > 0 ? (
            <FilterSelect
              name="empresa"
              label="Empresa"
              options={companyOptions.map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Todas"
              defaultValue={filters.companyId ?? undefined}
            />
          ) : null}
          <FilterSelect
            name="unidade"
            label="Unidade"
            options={unitOptions.map((u) => ({ value: u.id, label: u.name }))}
            placeholder="Todas"
            defaultValue={filters.unitId ?? undefined}
          />
          <FilterSelect
            name="area"
            label="Área jurídica"
            options={optionsFromLabels(LEGAL_AREA_LABELS)}
            placeholder="Todas"
            defaultValue={filters.area ?? undefined}
          />
          <FilterSelect
            name="responsavel"
            label="Responsável"
            options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
            defaultValue={filters.responsibleId ?? undefined}
          />
        </FilterBar>
      </div>

      {/* 2. Portfolio of legal liabilities (stock): net exposure first, then KPIs and the unified chart. */}
      {portfolio.status !== "forbidden" ? (
        <section aria-labelledby="carteira" className="space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="carteira" className="text-lg font-semibold tracking-tight text-slate-900">
                Carteira de passivo
              </h2>
              <p className="text-sm text-muted-foreground">
                Posição atual da carteira ativa. O período não se aplica; empresa, unidade, área e responsável sim.
              </p>
            </div>
            <Badge tone="info" dot>
              Calculado a partir da carteira
            </Badge>
          </div>

          {portfolio.status === "error" ? (
            <Callout tone="warning" title="Indicadores de contingência indisponíveis">
              Não foi possível calcular a posição da carteira agora. Os demais indicadores do painel continuam disponíveis.
              Tente novamente em alguns instantes.
            </Callout>
          ) : (
            <>
              <NetExposureCard summary={portfolio.data.netExposure} />
              <PortfolioKpis data={portfolio.data} filters={filters} />
              <PreviousClosingCard
                data={portfolio.data}
                closingsHref={can(ctx, "contingency:read") ? "/contingencias/provisao" : null}
              />
              {/* Processes without tribunal/instância/fase/cidade/empresa/unidade stay out of the chart below. */}
              <RegistrationGaps gaps={portfolio.data.registrationGaps} />
              <ExposureByDimension
                dimensions={portfolio.data.dimensions}
                initial={chartDimension}
                filterFormId={FILTER_FORM_ID}
              />
              <TopExposures items={portfolio.data.top} />
            </>
          )}
        </section>
      ) : null}

      {/* 3. Everything else, collapsed by default. */}
      <MoreIndicators
        defaultOpen={moreOpen}
        description={`Entradas e pendências, operação jurídica (${periodLabel}) e acompanhamento.`}
      >
        {/* Intake, alerts, preliminary analyses: not affected by the filters. */}
        <section aria-labelledby="pendencias" className="space-y-4">
          <div>
            <h3 id="pendencias" className="text-base font-semibold tracking-tight text-slate-900">
              Entradas e pendências
            </h3>
            <p className="text-sm text-muted-foreground">
              Situação atual de todos os registros que você pode acessar.{notFiltered}
            </p>
          </div>
          <div
            className={
              followUpCards >= 3
                ? "grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3"
                : "grid grid-cols-1 gap-6 md:grid-cols-2"
            }
          >
            <IntakeCard data={followUpV2} canOpenIntake={canIntake} />
            <AlertGroupsCard data={followUpV2} />
            <BriefsAwaitingCard data={followUpV2} />
          </div>
        </section>

        {/* Legal operations (flows within the period) */}
        <section aria-labelledby="operacao" className="space-y-6">
          <div>
            <h3 id="operacao" className="text-base font-semibold tracking-tight text-slate-900">
              Operação jurídica
            </h3>
            <p className="text-sm text-muted-foreground">
              Entradas, encerramentos, prazos, tarefas, preventivo e contratos · {periodLabel}.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {sections.processes ? (
              <>
                {/* No link: the portfolio list has no filter by entry or closing date. */}
                <StatCard
                  label="Processos novos no período"
                  value={formatNumber(kpis.newProcesses)}
                  hint={flowHint(kpis.newProcesses, kpis.newProcessesPrevious, "novos")}
                  icon={<Inbox />}
                  tone="primary"
                />
                <StatCard
                  label="Encerramentos no período"
                  value={formatNumber(kpis.closedProcesses)}
                  hint={`Processos encerrados · ${periodLabel}. Veja mês a mês no gráfico abaixo.`}
                  icon={<TrendingUp />}
                />
              </>
            ) : null}
            {sections.deadlines ? (
              <>
                <StatCard
                  label="Prazos vencidos"
                  value={formatNumber(kpis.overdueDeadlines)}
                  hint="Em aberto, manuais ou validados"
                  href={workLinks ? deadlinesHref(filters, { situacao: "vencidos" }) : undefined}
                  icon={<CalendarX />}
                  tone={kpis.overdueDeadlines > 0 ? "danger" : "neutral"}
                />
                <StatCard
                  label="Prazos próximos"
                  value={formatNumber(kpis.upcomingDeadlines)}
                  hint={`Próximos ${bi.upcomingDays} dias · ${formatNumber(kpis.pendingValidation)} aguardando validação`}
                  href={workLinks ? deadlinesHref(filters, { situacao: "proximos" }) : undefined}
                  icon={<CalendarClock />}
                  tone={kpis.upcomingDeadlines > 0 ? "warning" : "neutral"}
                />
              </>
            ) : null}
            {sections.tasks ? (
              <StatCard
                label="Tarefas em atraso"
                value={formatNumber(kpis.overdueTasks)}
                hint={`${formatNumber(kpis.openTasks)} tarefas em aberto`}
                href={workLinks ? tasksHref(filters, null, { situacao: "vencidos" }) : undefined}
                icon={<ListTodo />}
                tone={kpis.overdueTasks > 0 ? "danger" : "neutral"}
              />
            ) : null}
            {sections.occurrences ? (
              // No link: the preventive list has no filter for "abertas" (four statuses).
              <StatCard
                label="Ocorrências abertas"
                value={formatNumber(kpis.openOccurrences)}
                hint={flowHint(kpis.newOccurrences, kpis.newOccurrencesPrevious, "registradas")}
                icon={<ShieldAlert />}
                tone={kpis.openOccurrences > 0 ? "info" : "neutral"}
              />
            ) : null}
            {sections.contracts ? (
              <StatCard
                label="Contratos vencendo"
                value={formatNumber(kpis.expiringContracts)}
                hint={`${formatNumber(kpis.activeContracts)} vigentes · término em até ${bi.contractDays} dias`}
                href={contractLinks ? contractsHref(filters, { vencendo: true }) : undefined}
                icon={<FileClock />}
                tone={kpis.expiringContracts > 0 ? "warning" : "neutral"}
              />
            ) : null}
          </div>
          {!workLinks && (sections.deadlines || sections.tasks) ? (
            <p className="text-xs text-muted-foreground">
              Com filtro de unidade, área jurídica ou empresa, os indicadores de prazos e tarefas ficam sem link: a lista de
              prazos filtra apenas por responsável e mostraria outra quantidade.
            </p>
          ) : null}

          {/* Flows over time + current risk */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            {sections.processes ? (
              <ChartCard
                className="xl:col-span-2"
                title="Contencioso: entradas e encerramentos"
                description={`Processos por ${bi.range.granularity === "week" ? "semana" : "mês"} · ${periodLabel}. Entrada = data de distribuição (ou de cadastro, se não informada).`}
                legend={[
                  { label: `Entradas (${formatNumber(kpis.newProcesses)})`, color: SERIES.blue },
                  { label: `Encerramentos (${formatNumber(kpis.closedProcesses)})`, color: SERIES.orange },
                ]}
                table={{
                  caption: "Entradas e encerramentos de processos por período",
                  headers: ["Período", "Entradas", "Encerramentos"],
                  rows: buckets.map((b, i) => [b.longLabel, bi.processFlow.entered[i], bi.processFlow.closed[i]]),
                }}
              >
                <ColumnChart
                  label="Entradas e encerramentos de processos"
                  categories={buckets}
                  series={[
                    { key: "in", label: "Entradas", color: SERIES.blue },
                    { key: "out", label: "Encerramentos", color: SERIES.orange },
                  ]}
                  values={[bi.processFlow.entered, bi.processFlow.closed]}
                />
              </ChartCard>
            ) : null}

            {sections.processes || sections.occurrences ? (
              <ChartCard
                title="Risco atual por criticidade"
                description={
                  sections.processes
                    ? "Classificação de criticidade informada nos cadastros (não é estimativa da IA). Clique num trecho de processos para ver os registros."
                    : "Classificação de criticidade informada nos cadastros (não é estimativa da IA)."
                }
                legend={RISK_LEVELS.map((r) => ({ label: RISK_LEVEL_LABELS[r], color: RISK_COLORS[r] }))}
                note={scopeNote}
                table={{
                  caption: "Distribuição de risco",
                  headers: [
                    "Risco",
                    ...(sections.processes ? ["Processos ativos"] : []),
                    ...(sections.occurrences ? ["Ocorrências abertas"] : []),
                  ],
                  rows: RISK_LEVELS.map((r) => [
                    RISK_LEVEL_LABELS[r],
                    ...(sections.processes ? [bi.riskProcesses[r]] : []),
                    ...(sections.occurrences ? [bi.riskOccurrences[r]] : []),
                  ]),
                }}
              >
                <ShareBars
                  label="Distribuição de risco"
                  rows={[
                    ...(sections.processes
                      ? [
                          {
                            key: "processes",
                            label: "Processos ativos",
                            segments: RISK_LEVELS.map((r) => ({
                              key: r,
                              label: RISK_LEVEL_LABELS[r],
                              color: RISK_COLORS[r],
                              value: bi.riskProcesses[r],
                              href: processesHref(filters, { status: "active", risco: r }),
                            })),
                          },
                        ]
                      : []),
                    ...(sections.occurrences
                      ? [
                          {
                            key: "occurrences",
                            label: "Ocorrências abertas",
                            // No link: the preventive list cannot show only the open occurrences.
                            segments: RISK_LEVELS.map((r) => ({
                              key: r,
                              label: RISK_LEVEL_LABELS[r],
                              color: RISK_COLORS[r],
                              value: bi.riskOccurrences[r],
                            })),
                          },
                        ]
                      : []),
                  ]}
                />
              </ChartCard>
            ) : null}
          </div>

          {sections.occurrences ? (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <ChartCard
                className="xl:col-span-2"
                title="Preventivo: ocorrências registradas e resolvidas"
                description={`Por ${bi.range.granularity === "week" ? "semana" : "mês"} · ${periodLabel}.`}
                legend={[
                  { label: `Registradas (${formatNumber(kpis.newOccurrences)})`, color: SERIES.blue },
                  { label: `Resolvidas (${formatNumber(kpis.resolvedOccurrences)})`, color: SERIES.orange },
                ]}
                note={scopeNote}
                table={{
                  caption: "Ocorrências registradas e resolvidas por período",
                  headers: ["Período", "Registradas", "Resolvidas"],
                  rows: buckets.map((b, i) => [b.longLabel, bi.occurrenceFlow.registered[i], bi.occurrenceFlow.resolved[i]]),
                }}
              >
                <ColumnChart
                  label="Ocorrências registradas e resolvidas"
                  categories={buckets}
                  series={[
                    { key: "in", label: "Registradas", color: SERIES.blue },
                    { key: "out", label: "Resolvidas", color: SERIES.orange },
                  ]}
                  values={[bi.occurrenceFlow.registered, bi.occurrenceFlow.resolved]}
                />
              </ChartCard>
              <ChartCard
                title="Ocorrências abertas por categoria"
                description={`Exposição estimada informada nas ocorrências: ${money(kpis.occurrenceExposureCents)}`}
                note={scopeNote}
                table={{
                  caption: "Ocorrências abertas por categoria",
                  headers: ["Categoria", "Ocorrências"],
                  rows: bi.occurrencesByCategory.map((r) => [OCCURRENCE_CATEGORY_LABELS[r.key], r.count]),
                }}
              >
                <BarChart
                  label="Ocorrências abertas por categoria"
                  series={[{ key: "n", label: "Ocorrências", color: SERIES.blue }]}
                  rows={bi.occurrencesByCategory.map((r) => ({
                    key: r.key,
                    label: OCCURRENCE_CATEGORY_LABELS[r.key],
                    values: [r.count],
                  }))}
                />
              </ChartCard>
            </div>
          ) : null}

          {/* Deadlines & workload */}
          {sections.deadlines || sections.tasks ? (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              {sections.deadlines ? (
                <ChartCard
                  title="Carga de prazos"
                  description="Prazos em aberto (manuais ou validados): vencidos e por semana de vencimento, nas próximas 8 semanas."
                  table={{
                    caption: "Prazos por semana de vencimento",
                    headers: ["Semana", "Prazos"],
                    rows: [
                      ["Vencidos", bi.deadlineLoad.overdue],
                      ...bi.deadlineLoad.weeks.map((w) => [`Semana de ${formatDate(w.start)}`, w.count]),
                    ],
                  }}
                >
                  <ColumnChart
                    label="Prazos vencidos e por semana de vencimento"
                    series={[{ key: "n", label: "Prazos", color: SERIES.blue }]}
                    categories={[
                      {
                        key: "overdue",
                        label: "Vencidos",
                        longLabel: "Prazos vencidos",
                        color: CRITICAL,
                        href: workLinks ? deadlinesHref(filters, { situacao: "vencidos" }) : undefined,
                      },
                      // No link per week: the deadline list has no weekly filter.
                      ...bi.deadlineLoad.weeks.map((w) => ({
                        key: w.start,
                        label: formatDate(w.start).slice(0, 5),
                        longLabel: `Semana de ${formatDate(w.start)}`,
                      })),
                    ]}
                    values={[[bi.deadlineLoad.overdue, ...bi.deadlineLoad.weeks.map((w) => w.count)]]}
                  />
                </ChartCard>
              ) : null}
              <ChartCard
                className={sections.deadlines ? "xl:col-span-2" : "xl:col-span-3"}
                title="Pendências por responsável"
                description="Prazos e tarefas em aberto (até 10 pessoas, ordenadas por atrasos)."
                legend={[
                  { label: "Prazos em aberto", color: SERIES.blue },
                  { label: "Tarefas em aberto", color: SERIES.orange },
                ]}
                table={{
                  caption: "Pendências por responsável",
                  headers: ["Responsável", "Prazos", "Prazos vencidos", "Tarefas", "Tarefas atrasadas"],
                  rows: bi.workload.map((w) => [w.name, w.openDeadlines, w.overdueDeadlines, w.openTasks, w.overdueTasks]),
                }}
              >
                <BarChart
                  label="Pendências por responsável"
                  mode="stacked"
                  series={[
                    { key: "deadlines", label: "Prazos em aberto", color: SERIES.blue },
                    { key: "tasks", label: "Tarefas em aberto", color: SERIES.orange },
                  ]}
                  valueText={(row) => {
                    const w = bi.workload.find((x) => x.userId === row.key);
                    const late = (w?.overdueDeadlines ?? 0) + (w?.overdueTasks ?? 0);
                    return `${(row.values[0] ?? 0) + (row.values[1] ?? 0)}${late ? ` · ${late} em atraso` : ""}`;
                  }}
                  rows={bi.workload.map((w) => ({
                    key: w.userId,
                    label: w.name,
                    values: [w.openDeadlines, w.openTasks],
                  }))}
                />
              </ChartCard>
            </div>
          ) : null}
        </section>

        {/* Follow-up: not affected by filters */}
        <section aria-labelledby="acompanhamento" className="space-y-4">
          <div>
            <h3 id="acompanhamento" className="text-base font-semibold tracking-tight text-slate-900">
              Acompanhamento
            </h3>
            <p className="text-sm text-muted-foreground">
              Próximos prazos, alertas recentes e atividades de todos os registros que você pode acessar.
              {hasDimensionFilter(filters) || filters.period !== "12m" ? " Os filtros acima não se aplicam a este grupo." : ""}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {followUp.sections.deadlines ? (
              <div className="min-w-0 lg:col-span-2">
                <UpcomingDeadlines
                  deadlines={followUp.deadlines}
                  today={followUp.today}
                  upcomingDays={followUp.settings.upcomingDeadlineDays}
                />
              </div>
            ) : null}
            <div className="flex min-w-0 flex-col gap-6">
              <AlertList ctx={ctx} limit={8} />
              {followUp.sections.contracts ? (
                <ContractsCard contracts={followUp.contracts} expirationDays={followUp.settings.contractExpirationDays} />
              ) : null}
              {followUp.sections.analyses ? <AiCard analyses={followUp.analyses} mode={aiMode} /> : null}
            </div>
          </div>
          <ActivityFeed items={followUp.activity} now={followUp.generatedAt} />
        </section>
      </MoreIndicators>
    </div>
  );
}
