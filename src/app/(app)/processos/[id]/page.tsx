import { Pencil, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { LinkTabs } from "@/components/ui/tabs";
import { CLOSURE_REASON_LABELS, PROCESS_PHASE_LABELS, PROCESS_STATUS_LABELS } from "@/domain/enums";
import { formatDate, todayISO } from "@/lib/format";
import { buildHref, enumParam, param } from "@/lib/search-params";
import { PROCESS_STATUS_TONES } from "@/lib/tones";
import { EntityHistory } from "@/modules/admin/components/entity-history";
import { AnalysisPanel } from "@/modules/analyses/components/analysis-panel";
import { ProcessBriefTab } from "@/modules/briefs/components/process-brief-tab";
import { CommentThread } from "@/modules/comments/components/comment-thread";
import { ProcessContingencyTab, ProcessSettlementsTab } from "@/modules/contingency/components/process-tabs";
import { EntityDocuments } from "@/modules/documents/components/entity-documents";
import { ProcessEmailsTab } from "@/modules/emails/components/process-emails-tab";
import { ProcessHearingsTab } from "@/modules/hearings/components/process-hearings-tab";
import {
  closeProcessAction,
  deleteProcessAction,
  flagVerificationAction,
  reactivateProcessAction,
  resolveVerificationAction,
} from "@/modules/processes/actions";
import {
  CloseProcessDialog,
  FlagVerificationDialog,
  ReactivateProcessDialog,
  ResolveVerificationDialog,
} from "@/modules/processes/components/lifecycle-dialogs";
import {
  CnjCheckFlag,
  ConfidentialBadge,
  ImportedBadge,
  InstanceBadge,
  LegalHoldBadge,
  VerificationBadge,
} from "@/modules/processes/components/process-badges";
import { ProcessEvents } from "@/modules/processes/components/process-events";
import { ProcessInstances } from "@/modules/processes/components/process-instances";
import { ProcessOverview } from "@/modules/processes/components/process-overview";
import { ProcessParties } from "@/modules/processes/components/process-parties";
import {
  getProcess,
  isInActivePortfolio,
  recordConfidentialProcessView,
  type ProcessDetail,
} from "@/modules/processes/service";
import { EntityWorkItems } from "@/modules/work/components/entity-work-items";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Processo" };

/** MODULE_CONTRACTS "Process detail tabs" (order and keys are part of the contract). */
const TAB_KEYS = [
  "visao-geral",
  "partes",
  "instancias",
  "movimentacoes",
  "valores",
  "acordos",
  "audiencias",
  "analise-preliminar",
  "documentos",
  "prazos",
  "emails",
  "ia",
  "comentarios",
  "historico",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

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
  // TE-10: access to confidential processes is logged (at most once per user/process/hour).
  if (process.isConfidential) await recordConfidentialProcessView(ctx, process.id);

  const base = `/processos/${process.id}`;
  const entity = { type: "legal_process" as const, id: process.id };
  const tabHref = (key: TabKey) => buildHref(base, {}, { aba: key === "visao-geral" ? null : key });
  const canEdit = process.permissions.canEdit;
  const active = isInActivePortfolio(process.status);
  const closureLabel = process.closureReason ? CLOSURE_REASON_LABELS[process.closureReason] : null;

  const tabs: { key: TabKey; label: string; count?: number; visible: boolean }[] = [
    { key: "visao-geral", label: "Visão geral", visible: true },
    { key: "partes", label: "Partes", count: process.parties.length, visible: true },
    { key: "instancias", label: "Instâncias", count: process.instances.length, visible: true },
    { key: "movimentacoes", label: "Movimentações", count: process.events.length, visible: true },
    { key: "valores", label: "Valores e risco", visible: can(ctx, "contingency:read") },
    { key: "acordos", label: "Acordos", visible: can(ctx, "contingency:read") },
    { key: "audiencias", label: "Audiências", visible: can(ctx, "process:read") },
    { key: "analise-preliminar", label: "Análise preliminar", visible: can(ctx, "brief:read") },
    { key: "documentos", label: "Documentos", visible: can(ctx, "document:read") },
    { key: "prazos", label: "Prazos e tarefas", visible: can(ctx, "deadline:read") || can(ctx, "task:read") },
    { key: "emails", label: "E-mails", visible: can(ctx, "email:read") },
    { key: "ia", label: "Análises de IA", visible: can(ctx, "analysis:read") },
    { key: "comentarios", label: "Comentários", visible: true },
    { key: "historico", label: "Histórico", visible: true },
  ];
  const visibleTabs = tabs.filter((t) => t.visible);
  const requested = enumParam(sp, "aba", TAB_KEYS) ?? "visao-geral";
  const activeTab: TabKey = visibleTabs.some((t) => t.key === requested) ? requested : "visao-geral";
  const linkFailed = param(sp, "vinculo") === "falhou";

  return (
    <>
      <PageHeader
        title={process.title}
        breadcrumbs={[{ label: "Processos", href: "/processos" }, { label: process.number }]}
        meta={
          <>
            <span className="font-mono text-sm text-slate-700">{process.number}</span>
            <CnjCheckFlag check={process.cnjCheck} />
            <InstanceBadge instance={process.instance} />
            <Badge tone="neutral">{PROCESS_PHASE_LABELS[process.phase]}</Badge>
            <StatusBadge
              label={closureLabel ? `${PROCESS_STATUS_LABELS[process.status]} · ${closureLabel}` : PROCESS_STATUS_LABELS[process.status]}
              tone={PROCESS_STATUS_TONES[process.status]}
            />
            {process.isConfidential ? <ConfidentialBadge /> : null}
            {process.needsVerification ? <VerificationBadge note={process.verificationNote} /> : null}
            {process.dataOrigin === "imported" ? <ImportedBadge source={process.externalSource} /> : null}
            {process.legalHold ? <LegalHoldBadge /> : null}
          </>
        }
        actions={
          // Wraps into rows on medium screens so the title keeps its width.
          <div className="flex flex-wrap gap-2 sm:max-w-[23rem] sm:justify-end xl:max-w-none">
            {canEdit ? (
              <ButtonLink href={`${base}/editar`} variant="outline">
                <Pencil aria-hidden="true" />
                Editar
              </ButtonLink>
            ) : null}
            {canEdit && active ? (
              <CloseProcessDialog
                action={closeProcessAction}
                processId={process.id}
                processNumber={process.number}
                today={todayISO()}
              />
            ) : null}
            {canEdit && !active ? (
              <ReactivateProcessDialog action={reactivateProcessAction} processId={process.id} closureLabel={closureLabel} />
            ) : null}
            {canEdit && !process.needsVerification ? (
              <FlagVerificationDialog action={flagVerificationAction} processId={process.id} />
            ) : null}
            {canEdit && process.needsVerification ? (
              <ResolveVerificationDialog
                action={resolveVerificationAction}
                processId={process.id}
                note={process.verificationNote}
              />
            ) : null}
            {process.permissions.canDelete ? (
              <ConfirmDialog
                action={deleteProcessAction}
                hiddenFields={{ id: process.id }}
                trigger={
                  <Button type="button" variant="outline">
                    <Trash2 aria-hidden="true" />
                    Excluir
                  </Button>
                }
                title="Excluir processo?"
                description={`O processo ${process.number} deixará de aparecer nas listagens. A exclusão fica registrada na auditoria. Para tirá-lo apenas da carteira ativa, use “Retirar da carteira ativa”.`}
                confirmLabel="Excluir processo"
                pendingLabel="Excluindo…"
              />
            ) : null}
          </div>
        }
      />

      {linkFailed ? (
        <Callout tone="warning" title="Ocorrência não vinculada" className="mb-6">
          O processo foi cadastrado, mas não foi possível vincular a ocorrência de origem. Abra a ocorrência no módulo
          preventivo e faça o vínculo manualmente.
        </Callout>
      ) : null}

      {!active ? (
        <Callout tone="info" title="Fora da carteira ativa" className="mb-4">
          {closureLabel ? `Motivo: ${closureLabel}` : "Motivo não informado"}
          {process.closedAt ? ` · desde ${formatDate(process.closedAt)}` : ""}. O processo não entra nos totais da carteira
          ativa; valores, documentos e histórico continuam disponíveis.
        </Callout>
      ) : null}

      {process.needsVerification ? (
        <Callout tone="warning" title="Marcado para verificação" className="mb-4">
          {process.verificationNote ?? "Sem nota registrada."}
        </Callout>
      ) : null}

      {process.isConfidential ? (
        <p className="mb-4 text-xs text-muted-foreground">
          Processo sigiloso: as consultas a este registro ficam registradas na trilha de auditoria.
        </p>
      ) : null}

      <LinkTabs
        label="Seções do processo"
        active={activeTab}
        className="mb-6"
        tabs={visibleTabs.map((t) => ({ key: t.key, label: t.label, href: tabHref(t.key), count: t.count }))}
      />

      {activeTab === "visao-geral" ? <ProcessOverview ctx={ctx} process={process} tabHref={tabHref} /> : null}
      {activeTab === "partes" ? <ProcessParties process={process} /> : null}
      {activeTab === "instancias" ? <ProcessInstances process={process} /> : null}
      {activeTab === "movimentacoes" ? <ProcessEvents process={process} /> : null}
      {activeTab === "valores" ? <ProcessContingencyTab ctx={ctx} processId={process.id} /> : null}
      {activeTab === "acordos" ? <ProcessSettlementsTab ctx={ctx} processId={process.id} /> : null}
      {activeTab === "audiencias" ? <ProcessHearingsTab ctx={ctx} processId={process.id} /> : null}
      {activeTab === "analise-preliminar" ? <ProcessBriefTab ctx={ctx} processId={process.id} /> : null}
      {activeTab === "documentos" ? <EntityDocuments ctx={ctx} entity={entity} /> : null}
      {activeTab === "prazos" ? <EntityWorkItems ctx={ctx} entity={entity} /> : null}
      {activeTab === "emails" ? <ProcessEmailsTab ctx={ctx} processId={process.id} /> : null}
      {activeTab === "ia" ? <AnalysisPanel ctx={ctx} subject={entity} /> : null}
      {activeTab === "comentarios" ? <CommentThread ctx={ctx} entity={entity} /> : null}
      {activeTab === "historico" ? <EntityHistory ctx={ctx} entity={entity} /> : null}
    </>
  );
}
