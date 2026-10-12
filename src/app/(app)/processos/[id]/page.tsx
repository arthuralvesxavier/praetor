import { Pencil } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { LinkTabs } from "@/components/ui/tabs";
import { CLOSURE_REASON_LABELS, PROCESS_PHASE_LABELS, PROCESS_STATUS_LABELS } from "@/domain/enums";
import { formatDate, formatMoneyCents, todayISO } from "@/lib/format";
import { param } from "@/lib/search-params";
import { PROCESS_STATUS_TONES } from "@/lib/tones";
import { EntityHistory } from "@/modules/admin/components/entity-history";
import { AnalysisPanel } from "@/modules/analyses/components/analysis-panel";
import { listAnalyses } from "@/modules/analyses/service";
import { ProcessBriefTab } from "@/modules/briefs/components/process-brief-tab";
import { ProcessClaimsPanel } from "@/modules/claims/components/process-claims-panel";
import { CommentThread } from "@/modules/comments/components/comment-thread";
import { ProcessContingencyTab, ProcessSettlementsTab } from "@/modules/contingency/components/process-tabs";
import { CourtSyncPanel } from "@/modules/court-sync/components/court-sync-panel";
import { EntityDocuments } from "@/modules/documents/components/entity-documents";
import { ProcessEmailsTab } from "@/modules/emails/components/process-emails-tab";
import { ProcessHearingsTab } from "@/modules/hearings/components/process-hearings-tab";
import { ProcessReportCard } from "@/modules/legal-reports/components/process-report-card";
import { ProcessScenarios } from "@/modules/legal-reports/components/process-scenarios";
import {
  closeProcessAction,
  deleteProcessAction,
  flagVerificationAction,
  reactivateProcessAction,
  resolveVerificationAction,
} from "@/modules/processes/actions";
import { ActiveTabScroller } from "@/modules/processes/components/active-tab-scroller";
import { ProcessActionsMenu } from "@/modules/processes/components/process-actions-menu";
import {
  CnjCheckFlag,
  ConfidentialBadge,
  InstanceBadge,
  LegalHoldBadge,
  VerificationBadge,
} from "@/modules/processes/components/process-badges";
import { ProcessEvents } from "@/modules/processes/components/process-events";
import { ProcessInstances } from "@/modules/processes/components/process-instances";
import { ProcessSummaryTab } from "@/modules/processes/components/process-overview";
import { ProcessParties } from "@/modules/processes/components/process-parties";
import { ScrollToSection } from "@/modules/processes/components/scroll-to-section";
import { SensitiveDownloadsCard } from "@/modules/processes/components/sensitive-downloads";
import {
  getProcess,
  isInActivePortfolio,
  recordConfidentialProcessView,
  type ProcessDetail,
} from "@/modules/processes/service";
import {
  CLAIM_PROPOSED_PARAM_VALUE,
  PROCESS_SECTION_IDS,
  PROCESS_TAB_KEYS,
  PROCESS_TAB_LABELS,
  processHeaderSubtitle,
  processTabUrl,
  resolveProcessTab,
  type ProcessTabKey,
} from "@/modules/processes/tabs";
import { EntityWorkItems } from "@/modules/work/components/entity-work-items";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

export const metadata: Metadata = { title: "Processo" };

/** Wrapper of a section that old links (`?aba=<chave antiga>`) and the decision band scroll to. */
function Section({ id, label, children }: { id: string; label?: string; children: ReactNode }) {
  return (
    <section id={id} aria-label={label} className="flex scroll-mt-4 flex-col gap-4">
      {children}
    </section>
  );
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="text-lg font-semibold tracking-tight text-slate-900">
      {children}
    </h2>
  );
}

/** AI analyses are shown when the viewer can request one or there is already something to read. */
async function hasAnalysesToShow(ctx: AuthContext, processId: string): Promise<boolean> {
  if (!can(ctx, "analysis:read")) return false;
  if (can(ctx, "analysis:request")) return true;
  try {
    const list = await listAnalyses(ctx, { subjectType: "legal_process", subjectId: processId, pageSize: 1 });
    return list.total > 0;
  } catch (error) {
    logger.warn("process_analyses_probe_failed", { processId, errorName: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

export default async function ProcessDetailPage(props: PageProps<"/processos/[id]">) {
  const ctx = await requirePageContext("process:read");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let process: ProcessDetail;
  try {
    process = await getProcess(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  // Access to confidential processes is logged (at most once per user/process/hour).
  if (process.isConfidential) await recordConfidentialProcessView(ctx, process.id);

  const entity = { type: "legal_process" as const, id: process.id };
  const canEdit = process.permissions.canEdit;
  const active = isInActivePortfolio(process.status);
  const closureLabel = process.closureReason ? CLOSURE_REASON_LABELS[process.closureReason] : null;

  // MODULE_CONTRACTS "Process detail tabs": six tabs; keys of the previous layout open the tab that holds them.
  const visible: Record<ProcessTabKey, boolean> = {
    resumo: true,
    "partes-e-andamento": true,
    // Claims (pedidos) need process:read; values, settlements and scenarios check contingency:read below.
    "valores-e-acordos": true,
    "prazos-e-audiencias": true,
    "documentos-e-analises": can(ctx, "document:read") || can(ctx, "brief:read") || can(ctx, "analysis:read"),
    historico: true,
  };
  const resolved = resolveProcessTab(sp.aba);
  const activeTab: ProcessTabKey = visible[resolved.tab] ? resolved.tab : "resumo";
  const scrollTo = activeTab === resolved.tab ? resolved.section : null;
  const linkFailed = param(sp, "vinculo") === "falhou";
  const claimProposed = param(sp, "valor_causa") === CLAIM_PROPOSED_PARAM_VALUE;

  return (
    <>
      <PageHeader
        title={<span className="tabular-nums">{process.number}</span>}
        description={processHeaderSubtitle(process)}
        breadcrumbs={[{ label: "Processos", href: "/processos" }, { label: process.number }]}
        meta={
          <>
            <StatusBadge
              label={closureLabel ? `${PROCESS_STATUS_LABELS[process.status]} · ${closureLabel}` : PROCESS_STATUS_LABELS[process.status]}
              tone={PROCESS_STATUS_TONES[process.status]}
            />
            <InstanceBadge instance={process.instance} />
            <Badge tone="neutral">{PROCESS_PHASE_LABELS[process.phase]}</Badge>
            <CnjCheckFlag check={process.cnjCheck} />
            {process.isConfidential ? <ConfidentialBadge /> : null}
            {process.needsVerification ? <VerificationBadge note={process.verificationNote} /> : null}
            {process.legalHold ? <LegalHoldBadge /> : null}
          </>
        }
        actions={
          <>
            {canEdit ? (
              <ButtonLink href={`/processos/${process.id}/editar`} variant="outline">
                <Pencil aria-hidden="true" />
                Editar
              </ButtonLink>
            ) : null}
            <ProcessActionsMenu
              processId={process.id}
              processNumber={process.number}
              today={todayISO()}
              active={active}
              closureLabel={closureLabel}
              needsVerification={process.needsVerification}
              verificationNote={process.verificationNote}
              canEdit={canEdit}
              canDelete={process.permissions.canDelete}
              actions={{
                close: closeProcessAction,
                reactivate: reactivateProcessAction,
                flag: flagVerificationAction,
                resolve: resolveVerificationAction,
                remove: deleteProcessAction,
              }}
            />
          </>
        }
      />

      {linkFailed ? (
        <Callout tone="warning" title="Ocorrência não vinculada" className="mb-6">
          O processo foi cadastrado, mas não foi possível vincular a ocorrência de origem. Abra a ocorrência no módulo
          preventivo e faça o vínculo manualmente.
        </Callout>
      ) : null}

      {claimProposed ? (
        <Callout tone="info" title="Valor da causa enviado para conferência" className="mb-6">
          O valor informado aguarda a conferência de quem aprova valores e só passa a valer, inclusive nos totais, quando
          for aprovado.{" "}
          {process.claimAmountCents === null
            ? "Até lá, o valor da causa do processo fica como não informado."
            : `Até lá, continua valendo o valor da causa atual (${formatMoneyCents(process.claimAmountCents)}).`}
        </Callout>
      ) : null}

      {!active ? (
        <Callout tone="info" title="Fora da carteira ativa" className="mb-4">
          {closureLabel ? `Motivo: ${closureLabel}` : "Motivo não informado"}
          {process.closedAt ? `, desde ${formatDate(process.closedAt)}` : ""}. O processo não entra nos totais da carteira
          ativa; valores, documentos e histórico continuam disponíveis.
        </Callout>
      ) : null}

      {process.isConfidential ? (
        <p className="mb-4 text-xs text-muted-foreground">
          Processo sigiloso: as consultas a este registro ficam registradas na trilha de auditoria.
        </p>
      ) : null}

      {/* On a phone the bar scrolls sideways: the open tab is scrolled into view. */}
      <ActiveTabScroller active={activeTab}>
        <LinkTabs
          label="Seções do processo"
          active={activeTab}
          className="mb-6"
          tabs={PROCESS_TAB_KEYS.filter((key) => visible[key]).map((key) => ({
            key,
            label: PROCESS_TAB_LABELS[key],
            href: processTabUrl(process.id, key),
          }))}
        />
      </ActiveTabScroller>

      {scrollTo ? <ScrollToSection id={scrollTo} /> : null}

      {activeTab === "resumo" ? <ProcessSummaryTab ctx={ctx} process={process} /> : null}

      {activeTab === "partes-e-andamento" ? (
        <div className="flex flex-col gap-6">
          <ProcessParties process={process} />
          <ProcessInstances process={process} />
          <ProcessEvents process={process} aside={<CourtSyncPanel ctx={ctx} processId={process.id} />} />
        </div>
      ) : null}

      {activeTab === "valores-e-acordos" ? (
        <div className="flex flex-col gap-10">
          {can(ctx, "contingency:read") ? (
            <Section id={PROCESS_SECTION_IDS.values} label="Valores, garantias e risco">
              <ProcessContingencyTab ctx={ctx} processId={process.id} />
            </Section>
          ) : null}
          <Section id={PROCESS_SECTION_IDS.claims} label="Pedidos">
            <ProcessClaimsPanel ctx={ctx} processId={process.id} />
          </Section>
          {can(ctx, "contingency:read") ? (
            <>
              <section id={PROCESS_SECTION_IDS.settlements} aria-labelledby="acordos-titulo" className="flex scroll-mt-4 flex-col gap-4">
                <SectionTitle id="acordos-titulo">Acordos</SectionTitle>
                <ProcessSettlementsTab ctx={ctx} processId={process.id} />
              </section>
              <Section id={PROCESS_SECTION_IDS.scenarios} label="Cenários">
                <ProcessScenarios ctx={ctx} processId={process.id} />
              </Section>
            </>
          ) : null}
        </div>
      ) : null}

      {activeTab === "prazos-e-audiencias" ? (
        <div className="flex flex-col gap-10">
          <Section id={PROCESS_SECTION_IDS.deadlines} label="Prazos e tarefas">
            <EntityWorkItems ctx={ctx} entity={entity} />
          </Section>
          <section id={PROCESS_SECTION_IDS.hearings} aria-labelledby="audiencias-titulo" className="flex scroll-mt-4 flex-col gap-4">
            <SectionTitle id="audiencias-titulo">Audiências</SectionTitle>
            <ProcessHearingsTab ctx={ctx} processId={process.id} />
          </section>
        </div>
      ) : null}

      {activeTab === "documentos-e-analises" ? (
        <div className="flex flex-col gap-10">
          {can(ctx, "document:read") ? (
            <Section id={PROCESS_SECTION_IDS.documents} label="Documentos">
              <EntityDocuments ctx={ctx} entity={entity} />
              <SensitiveDownloadsCard ctx={ctx} processId={process.id} />
            </Section>
          ) : null}
          {can(ctx, "brief:read") ? (
            <section id={PROCESS_SECTION_IDS.brief} aria-labelledby="analise-preliminar-titulo" className="flex scroll-mt-4 flex-col gap-4">
              <SectionTitle id="analise-preliminar-titulo">Análise preliminar</SectionTitle>
              <ProcessBriefTab ctx={ctx} processId={process.id} />
            </section>
          ) : null}
          {can(ctx, "legal_report:read") ? (
            <section id={PROCESS_SECTION_IDS.legalReport} aria-labelledby="relatorio-processo-titulo" className="flex scroll-mt-4 flex-col gap-4">
              <SectionTitle id="relatorio-processo-titulo">Relatório do processo</SectionTitle>
              <ProcessReportCard ctx={ctx} processId={process.id} />
            </section>
          ) : null}
          {(await hasAnalysesToShow(ctx, process.id)) ? (
            <Section id={PROCESS_SECTION_IDS.analyses} label="Análises de IA">
              <AnalysisPanel ctx={ctx} subject={entity} />
            </Section>
          ) : null}
        </div>
      ) : null}

      {activeTab === "historico" ? (
        <div className="flex flex-col gap-10">
          <Section id={PROCESS_SECTION_IDS.comments} label="Comentários">
            <CommentThread ctx={ctx} entity={entity} />
          </Section>
          {can(ctx, "email:read") ? (
            <section id={PROCESS_SECTION_IDS.emails} aria-labelledby="emails-titulo" className="flex scroll-mt-4 flex-col gap-4">
              <SectionTitle id="emails-titulo">E-mails</SectionTitle>
              <ProcessEmailsTab ctx={ctx} processId={process.id} />
            </section>
          ) : null}
          <Section id={PROCESS_SECTION_IDS.history} label="Histórico de alterações">
            <EntityHistory ctx={ctx} entity={entity} />
          </Section>
        </div>
      ) : null}
    </>
  );
}
