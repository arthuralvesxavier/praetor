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
import { hasAnyParam } from "@/lib/search-params";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { AlertList } from "@/modules/alerts/components/alert-list";
import { getAiRuntimeInfo } from "@/modules/analyses/service";
import {
  BI_PERIOD_LABELS,
  BI_PERIODS,
  contractsHref,
  deadlinesHref,
  hasDimensionFilter,
  occurrencesHref,
  parseBiFilters,
  processesHref,
  tasksHref,
} from "@/modules/dashboard/bi-filters";
import { getBiData } from "@/modules/dashboard/bi-service";
import { ActivityFeed } from "@/modules/dashboard/components/activity-feed";
import { BarChart } from "@/modules/dashboard/components/charts/bar-chart";
import { ChartCard } from "@/modules/dashboard/components/charts/chart-card";
import { ColumnChart } from "@/modules/dashboard/components/charts/column-chart";
import { CRITICAL, RISK_COLORS, SERIES } from "@/modules/dashboard/components/charts/palette";
import { ShareBars } from "@/modules/dashboard/components/charts/share-bars";
import {
  AlertGroupsCard,
  BriefsAwaitingCard,
  IntakeCard,
  UpcomingHearingsCard,
} from "@/modules/dashboard/components/follow-up-cards";
import { HowToRead } from "@/modules/dashboard/components/how-to-read";
import {
  DimensionChart,
  PortfolioKpis,
  PreviousClosingCard,
  TopExposures,
} from "@/modules/dashboard/components/portfolio-panel";
import { AiCard, ContractsCard } from "@/modules/dashboard/components/side-cards";
import { UpcomingDeadlines } from "@/modules/dashboard/components/upcoming-deadlines";
import { formatLongDate } from "@/modules/dashboard/format";
import { getFollowUpPanel, getPortfolioPanel } from "@/modules/dashboard/portfolio-service";
import { getDashboardData } from "@/modules/dashboard/service";
import { listCompanyOptions } from "@/modules/organization/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { logger } from "@/server/lib/logger";

export const metadata: Metadata = { title: "Painel executivo" };

const FILTER_KEYS = ["periodo", "empresa", "unidade", "area", "responsavel"] as const;

/** "8 no período · 2 no período anterior" (neutral: more entries is neither good nor bad). */
function flowHint(current: number, previous: number | null, noun: string) {
  const base = `${formatNumber(current)} ${noun} no período`;
  return previous == null ? base : `${base} · ${formatNumber(previous)} no período anterior`;
}

export default async function DashboardPage(props: PageProps<"/dashboard">) {
  const ctx = await requirePageContext("dashboard:read");
  const sp = await props.searchParams;
  const filters = parseBiFilters(sp);

  const [portfolio, followUpV2, bi, followUp, unitOptions, userOptions, companyOptions] = await Promise.all([
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
  const canIntake = can(ctx, "intake:manage") || can(ctx, "distribution:manage");
  const canBriefs = can(ctx, "brief:read");
  const followUpCards = [
    followUpV2.hearings.status !== "forbidden",
    followUpV2.intake.status !== "forbidden",
    true,
    followUpV2.briefs.status !== "forbidden",
  ].filter(Boolean).length;

  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <PageHeader
          title="Painel executivo"
          description="Carteira de passivo, contingências, entradas e pendências calculadas sobre os registros que o seu perfil pode acessar."
          meta={
            <p className="text-xs text-muted-foreground">
              {formatLongDate(bi.today)} · dados atualizados em{" "}
              <time dateTime={bi.generatedAt.toISOString()}>{formatDateTime(bi.generatedAt)}</time>
            </p>
          }
          className="mb-0"
        />

        {/* One filter row above everything it scopes. */}
        <FilterBar basePath="/dashboard" search={false} showClear={hasAnyParam(sp, FILTER_KEYS)} className="mb-0">
          <FilterSelect
            name="periodo"
            label="Período"
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

        <HowToRead upcomingDays={bi.upcomingDays} contractDays={bi.contractDays} />
      </div>

      {/* Portfolio of legal liabilities (stock) */}
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
              <PortfolioKpis data={portfolio.data} filters={filters} />
              <PreviousClosingCard
                data={portfolio.data}
                closingsHref={can(ctx, "contingency:read") ? "/contingencias/provisao" : null}
              />
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <DimensionChart
                  title="Exposição e processos por tribunal"
                  dimensionLabel="Tribunal"
                  dimension={portfolio.data.dimensions.court}
                />
                <DimensionChart
                  title="Exposição e processos por instância"
                  description="Instância atual de cada processo (um processo conta uma vez)."
                  dimensionLabel="Instância"
                  dimension={portfolio.data.dimensions.instance}
                />
                <DimensionChart
                  title="Exposição e processos por fase"
                  dimensionLabel="Fase"
                  dimension={portfolio.data.dimensions.phase}
                />
                <DimensionChart
                  title="Exposição e processos por cidade"
                  description="As 10 cidades com maior exposição; as demais aparecem somadas na tabela."
                  dimensionLabel="Cidade"
                  dimension={portfolio.data.dimensions.city}
                />
                <DimensionChart
                  title="Exposição e processos por empresa"
                  dimensionLabel="Empresa"
                  dimension={portfolio.data.dimensions.company}
                />
                <DimensionChart
                  title="Exposição e processos por unidade"
                  dimensionLabel="Unidade"
                  dimension={portfolio.data.dimensions.unit}
                />
              </div>
              <TopExposures items={portfolio.data.top} />
            </>
          )}
        </section>
      ) : null}

      {/* Hearings, intake, alerts, preliminary analyses — not affected by filters */}
      <section aria-labelledby="pendencias" className="space-y-4">
        <div>
          <h2 id="pendencias" className="text-lg font-semibold tracking-tight text-slate-900">
            Audiências, entradas e pendências
          </h2>
          <p className="text-sm text-muted-foreground">
            Situação atual de todos os registros que você pode acessar
            {hasDimensionFilter(filters) ? " — esta seção não é afetada pelos filtros acima" : ""}.
          </p>
        </div>
        <div
          className={
            followUpCards >= 4
              ? "grid grid-cols-1 gap-6 md:grid-cols-2 2xl:grid-cols-4"
              : "grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3"
          }
        >
          <UpcomingHearingsCard data={followUpV2} />
          <IntakeCard data={followUpV2} canOpenIntake={canIntake} canOpenBriefs={canBriefs} />
          <AlertGroupsCard data={followUpV2} />
          <BriefsAwaitingCard data={followUpV2} />
        </div>
      </section>

      {/* Legal operations (flows within the period) */}
      <section aria-labelledby="operacao" className="space-y-6 border-t border-border pt-6">
        <div>
          <h2 id="operacao" className="text-lg font-semibold tracking-tight text-slate-900">
            Operação jurídica
          </h2>
          <p className="text-sm text-muted-foreground">
            Entradas, encerramentos, prazos, tarefas, preventivo e contratos · {periodLabel}.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {sections.processes ? (
            <>
              <StatCard
                label="Processos novos no período"
                value={formatNumber(kpis.newProcesses)}
                hint={flowHint(kpis.newProcesses, kpis.newProcessesPrevious, "novos")}
                href={processesHref(filters)}
                icon={<Inbox />}
                tone="primary"
              />
              <StatCard
                label="Encerramentos no período"
                value={formatNumber(kpis.closedProcesses)}
                hint={`Processos encerrados · ${periodLabel}`}
                href={processesHref(filters, { carteira: "encerrada" })}
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
                href={deadlinesHref(filters, { situacao: "vencidos" })}
                icon={<CalendarX />}
                tone={kpis.overdueDeadlines > 0 ? "danger" : "neutral"}
              />
              <StatCard
                label="Prazos próximos"
                value={formatNumber(kpis.upcomingDeadlines)}
                hint={`Próximos ${bi.upcomingDays} dias · ${formatNumber(kpis.pendingValidation)} aguardando validação`}
                href={deadlinesHref(filters, { situacao: "proximos" })}
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
              href={tasksHref(filters)}
              icon={<ListTodo />}
              tone={kpis.overdueTasks > 0 ? "danger" : "neutral"}
            />
          ) : null}
          {sections.occurrences ? (
            <StatCard
              label="Ocorrências abertas"
              value={formatNumber(kpis.openOccurrences)}
              hint={flowHint(kpis.newOccurrences, kpis.newOccurrencesPrevious, "registradas")}
              href={occurrencesHref(filters)}
              icon={<ShieldAlert />}
              tone={kpis.openOccurrences > 0 ? "info" : "neutral"}
            />
          ) : null}
          {sections.contracts ? (
            <StatCard
              label="Contratos vencendo"
              value={formatNumber(kpis.expiringContracts)}
              hint={`${formatNumber(kpis.activeContracts)} vigentes · término em até ${bi.contractDays} dias`}
              href={contractsHref(filters, { vencendo: true })}
              icon={<FileClock />}
              tone={kpis.expiringContracts > 0 ? "warning" : "neutral"}
            />
          ) : null}
        </div>

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
              description="Classificação de criticidade informada nos cadastros (não é estimativa da IA). Clique num trecho para ver os registros."
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
                          segments: RISK_LEVELS.map((r) => ({
                            key: r,
                            label: RISK_LEVEL_LABELS[r],
                            color: RISK_COLORS[r],
                            value: bi.riskOccurrences[r],
                            href: occurrencesHref(filters, { risco: r }),
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
                  href: occurrencesHref(filters, { categoria: r.key }),
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
                      href: deadlinesHref(filters, { situacao: "vencidos" }),
                    },
                    ...bi.deadlineLoad.weeks.map((w) => ({
                      key: w.start,
                      label: formatDate(w.start).slice(0, 5),
                      longLabel: `Semana de ${formatDate(w.start)}`,
                      href: deadlinesHref(filters, { aba: "calendario", mes: w.start.slice(0, 7) }),
                    })),
                  ]}
                  values={[[bi.deadlineLoad.overdue, ...bi.deadlineLoad.weeks.map((w) => w.count)]]}
                />
              </ChartCard>
            ) : null}
            <ChartCard
              className={sections.deadlines ? "xl:col-span-2" : "xl:col-span-3"}
              title="Pendências por responsável"
              description="Prazos e tarefas em aberto (até 10 pessoas, ordenadas por atrasos). Clique para ver as tarefas da pessoa."
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
                  href: tasksHref(filters, w.userId),
                }))}
              />
            </ChartCard>
          </div>
        ) : null}
      </section>

      {/* Follow-up — not affected by filters */}
      <section aria-labelledby="acompanhamento" className="space-y-4 border-t border-border pt-6">
        <div>
          <h2 id="acompanhamento" className="text-lg font-semibold tracking-tight text-slate-900">
            Acompanhamento
          </h2>
          <p className="text-sm text-muted-foreground">
            Próximos prazos, alertas recentes e atividades de todos os registros que você pode acessar
            {hasDimensionFilter(filters) || filters.period !== "12m" ? " — esta seção não é afetada pelos filtros acima" : ""}.
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
    </div>
  );
}
