import { Pencil, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OriginBadge } from "@/components/ui/origin-badge";
import { PageHeader } from "@/components/ui/page-header";
import { RiskBadge } from "@/components/ui/risk-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { LinkTabs } from "@/components/ui/tabs";
import { PROCESS_STATUS_LABELS } from "@/domain/enums";
import { buildHref, enumParam, param } from "@/lib/search-params";
import { PROCESS_STATUS_TONES } from "@/lib/tones";
import { EntityHistory } from "@/modules/admin/components/entity-history";
import { AnalysisPanel } from "@/modules/analyses/components/analysis-panel";
import { CommentThread } from "@/modules/comments/components/comment-thread";
import { EntityDocuments } from "@/modules/documents/components/entity-documents";
import { deleteProcessAction } from "@/modules/processes/actions";
import { CnjFormatFlag, ConfidentialBadge, LegalHoldBadge } from "@/modules/processes/components/process-badges";
import { ProcessEvents } from "@/modules/processes/components/process-events";
import { ProcessOverview } from "@/modules/processes/components/process-overview";
import { ProcessParties } from "@/modules/processes/components/process-parties";
import { getProcess, type ProcessDetail } from "@/modules/processes/service";
import { EntityWorkItems } from "@/modules/work/components/entity-work-items";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Processo" };

const TAB_KEYS = [
  "visao-geral",
  "partes",
  "movimentacoes",
  "documentos",
  "prazos",
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

  const base = `/processos/${process.id}`;
  const entity = { type: "legal_process" as const, id: process.id };
  const tabHref = (key: TabKey) => buildHref(base, {}, { aba: key === "visao-geral" ? null : key });

  const tabs: { key: TabKey; label: string; count?: number; visible: boolean }[] = [
    { key: "visao-geral", label: "Visão geral", visible: true },
    { key: "partes", label: "Partes", count: process.parties.length, visible: true },
    { key: "movimentacoes", label: "Movimentações", count: process.events.length, visible: true },
    { key: "documentos", label: "Documentos", visible: can(ctx, "document:read") },
    { key: "prazos", label: "Prazos e tarefas", visible: can(ctx, "deadline:read") || can(ctx, "task:read") },
    { key: "ia", label: "Análises de IA", visible: can(ctx, "analysis:read") },
    { key: "comentarios", label: "Comentários", visible: true },
    { key: "historico", label: "Histórico", visible: true },
  ];
  const visibleTabs = tabs.filter((t) => t.visible);
  const requested = enumParam(sp, "aba", TAB_KEYS) ?? "visao-geral";
  const active: TabKey = visibleTabs.some((t) => t.key === requested) ? requested : "visao-geral";
  const linkFailed = param(sp, "vinculo") === "falhou";

  return (
    <>
      <PageHeader
        title={process.title}
        breadcrumbs={[{ label: "Processos", href: "/processos" }, { label: process.number }]}
        meta={
          <>
            <span className="font-mono text-sm text-slate-700">{process.number}</span>
            <CnjFormatFlag isCnjFormat={process.isCnjFormat} />
            <StatusBadge label={PROCESS_STATUS_LABELS[process.status]} tone={PROCESS_STATUS_TONES[process.status]} />
            <RiskBadge level={process.riskLevel} withPrefix />
            <OriginBadge origin={process.dataOrigin} />
            {process.isConfidential ? <ConfidentialBadge /> : null}
            {process.legalHold ? <LegalHoldBadge /> : null}
          </>
        }
        actions={
          <>
            {process.permissions.canEdit ? (
              <ButtonLink href={`${base}/editar`} variant="outline">
                <Pencil aria-hidden="true" />
                Editar
              </ButtonLink>
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
                description={`O processo ${process.number} deixará de aparecer nas listagens. A exclusão fica registrada na auditoria.`}
                confirmLabel="Excluir processo"
                pendingLabel="Excluindo…"
              />
            ) : null}
          </>
        }
      />

      {linkFailed ? (
        <Callout tone="warning" title="Ocorrência não vinculada" className="mb-6">
          O processo foi cadastrado, mas não foi possível vincular a ocorrência de origem. Abra a ocorrência no módulo
          preventivo e faça o vínculo manualmente.
        </Callout>
      ) : null}

      <LinkTabs
        label="Seções do processo"
        active={active}
        className="mb-6"
        tabs={visibleTabs.map((t) => ({ key: t.key, label: t.label, href: tabHref(t.key), count: t.count }))}
      />

      {active === "visao-geral" ? <ProcessOverview ctx={ctx} process={process} aiTabHref={tabHref("ia")} /> : null}
      {active === "partes" ? <ProcessParties process={process} /> : null}
      {active === "movimentacoes" ? <ProcessEvents process={process} /> : null}
      {active === "documentos" ? <EntityDocuments ctx={ctx} entity={entity} /> : null}
      {active === "prazos" ? <EntityWorkItems ctx={ctx} entity={entity} /> : null}
      {active === "ia" ? <AnalysisPanel ctx={ctx} subject={entity} /> : null}
      {active === "comentarios" ? <CommentThread ctx={ctx} entity={entity} /> : null}
      {active === "historico" ? <EntityHistory ctx={ctx} entity={entity} /> : null}
    </>
  );
}
