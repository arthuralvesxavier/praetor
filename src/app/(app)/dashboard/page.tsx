import {
  AlertTriangle,
  BadgeDollarSign,
  CalendarClock,
  CalendarX,
  FileClock,
  Scale,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import type { AiMode } from "@/domain/enums";
import { formatDateTime, formatNumber } from "@/lib/format";
import { AlertList } from "@/modules/alerts/components/alert-list";
import { getAiRuntimeInfo } from "@/modules/analyses/service";
import { ActivityFeed } from "@/modules/dashboard/components/activity-feed";
import { AreaPhasePanel, LitigationPanel, PreventivePanel } from "@/modules/dashboard/components/distribution-panels";
import { ExposurePanel } from "@/modules/dashboard/components/exposure-panel";
import { HowToRead } from "@/modules/dashboard/components/how-to-read";
import { AiCard, ContractsCard } from "@/modules/dashboard/components/side-cards";
import { UpcomingDeadlines } from "@/modules/dashboard/components/upcoming-deadlines";
import { WorkloadTable } from "@/modules/dashboard/components/workload-table";
import { formatCompactMoneyCents, formatLongDate } from "@/modules/dashboard/format";
import { getDashboardData } from "@/modules/dashboard/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { logger } from "@/server/lib/logger";

export const metadata: Metadata = { title: "Visão geral" };

export default async function DashboardPage() {
  const ctx = await requirePageContext("dashboard:read");
  const data = await getDashboardData(ctx);
  const { sections, processes, occurrences, deadlines, contracts, analyses, exposure, settings } = data;

  let aiMode: AiMode | null = null;
  if (sections.analyses) {
    try {
      aiMode = getAiRuntimeInfo().mode;
    } catch (error) {
      logger.error("ai_runtime_info_failed", { error });
    }
  }

  const isEmpty =
    processes.total === 0 &&
    occurrences.total === 0 &&
    contracts.active === 0 &&
    Object.values(contracts.byStatus).every((n) => n === 0) &&
    deadlines.next.length === 0 &&
    deadlines.overdue === 0;

  const highActive = processes.byRisk.high;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visão geral"
        description="Panorama do contencioso e do jurídico preventivo com base nos registros que o seu perfil pode acessar."
        meta={
          <p className="text-xs text-muted-foreground">
            {formatLongDate(data.today)} · dados atualizados em{" "}
            <time dateTime={data.generatedAt.toISOString()}>{formatDateTime(data.generatedAt)}</time>
          </p>
        }
        className="mb-0"
      />

      <HowToRead upcomingDays={settings.upcomingDeadlineDays} contractDays={settings.contractExpirationDays} />

      {isEmpty ? (
        <EmptyState
          title="Ainda não há registros para compor o painel"
          description="Cadastre processos, ocorrências, contratos ou prazos para acompanhar os indicadores aqui."
          action={
            <>
              {can(ctx, "process:write") ? (
                <ButtonLink href="/processos/novo" size="sm">
                  Cadastrar processo
                </ButtonLink>
              ) : null}
              {can(ctx, "occurrence:write") ? (
                <ButtonLink href="/preventivo" size="sm" variant="outline">
                  Ir para o preventivo
                </ButtonLink>
              ) : null}
            </>
          }
        />
      ) : null}

      <section aria-labelledby="indicadores-principais">
        <h2 id="indicadores-principais" className="sr-only">
          Indicadores principais
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {sections.processes ? (
            <StatCard
              label="Processos ativos"
              value={formatNumber(processes.active)}
              hint={`${formatNumber(processes.total)} cadastrados no total`}
              href="/processos?status=active"
              icon={<Scale />}
              tone="primary"
            />
          ) : null}
          {sections.deadlines ? (
            <>
              <StatCard
                label="Prazos vencidos"
                value={formatNumber(deadlines.overdue)}
                hint="Em aberto, manuais ou validados"
                href="/prazos?aba=prazos&situacao=vencidos"
                icon={<CalendarX />}
                tone={deadlines.overdue > 0 ? "danger" : "neutral"}
              />
              <StatCard
                label="Prazos próximos"
                value={formatNumber(deadlines.upcoming)}
                hint={`Vencem nos próximos ${settings.upcomingDeadlineDays} dias`}
                href="/prazos?aba=prazos&situacao=proximos"
                icon={<CalendarClock />}
                tone={deadlines.upcoming > 0 ? "warning" : "neutral"}
              />
            </>
          ) : null}
          {sections.processes ? (
            <>
              <StatCard
                label="Risco crítico (ativos)"
                value={formatNumber(processes.byRisk.critical)}
                hint={`Além de ${formatNumber(highActive)} ${highActive === 1 ? "processo" : "processos"} de risco alto`}
                href="/processos?status=active&risco=critical"
                icon={<ShieldAlert />}
                tone={processes.byRisk.critical > 0 ? "danger" : "neutral"}
              />
              <StatCard
                label="Exposição informada"
                value={formatCompactMoneyCents(exposure.activeProcesses.claimCents)}
                hint="Pedidos dos processos ativos · não é estimativa da IA"
                href="/processos?status=active"
                icon={<BadgeDollarSign />}
              />
            </>
          ) : null}
          {sections.occurrences ? (
            <StatCard
              label="Ocorrências abertas"
              value={formatNumber(occurrences.byStatus.open)}
              hint={`${formatNumber(occurrences.inProgress)} em andamento, somando análise, plano e monitoramento`}
              href="/preventivo?status=open"
              icon={<AlertTriangle />}
              tone={occurrences.byStatus.open > 0 ? "info" : "neutral"}
            />
          ) : null}
          {sections.contracts ? (
            <StatCard
              label="Contratos vencendo"
              value={formatNumber(contracts.expiring)}
              hint={`Vigentes com término em até ${settings.contractExpirationDays} dias`}
              href="/contratos?vencendo=1"
              icon={<FileClock />}
              tone={contracts.expiring > 0 ? "warning" : "neutral"}
            />
          ) : null}
          {sections.analyses ? (
            <StatCard
              label="Análises a revisar"
              value={formatNumber(analyses.pendingReview)}
              hint="Análises de IA concluídas aguardando revisão humana"
              href="/ia?status=succeeded"
              icon={<Sparkles />}
              tone={analyses.pendingReview > 0 ? "ai" : "neutral"}
            />
          ) : null}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {sections.deadlines ? (
          <div className="min-w-0 lg:col-span-2">
            <UpcomingDeadlines deadlines={deadlines} today={data.today} upcomingDays={settings.upcomingDeadlineDays} />
          </div>
        ) : null}
        <div className={sections.deadlines ? "min-w-0" : "min-w-0 lg:col-span-3"}>
          <AlertList ctx={ctx} limit={8} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
        {sections.processes ? (
          <>
            <LitigationPanel processes={processes} />
            <AreaPhasePanel processes={processes} />
          </>
        ) : null}
        {sections.occurrences ? <PreventivePanel occurrences={occurrences} /> : null}
      </div>

      {sections.processes || sections.occurrences || sections.contracts ? (
        <ExposurePanel exposure={exposure} sections={sections} />
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {sections.tasks || sections.deadlines ? (
          <div className="min-w-0 lg:col-span-2">
            <WorkloadTable workload={data.workload} />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-6">
          {sections.contracts ? <ContractsCard contracts={contracts} expirationDays={settings.contractExpirationDays} /> : null}
          {sections.analyses ? <AiCard analyses={analyses} mode={aiMode} /> : null}
        </div>
      </div>

      <ActivityFeed items={data.activity} now={data.generatedAt} />
    </div>
  );
}
