import { Lock, Pencil, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { RiskBadge } from "@/components/ui/risk-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { LinkTabs } from "@/components/ui/tabs";
import { CONTRACT_STATUS_LABELS, CONTRACT_TYPE_LABELS, DOCUMENT_CATEGORY_LABELS } from "@/domain/enums";
import {
  formatDate,
  formatDateTime,
  formatDocument,
  formatMoneyCents,
  formatRelativeDays,
  pluralize,
  todayISO,
  truncate,
} from "@/lib/format";
import { buildHref, param } from "@/lib/search-params";
import { CONTRACT_STATUS_TONES } from "@/lib/tones";
import { EntityHistory } from "@/modules/admin/components/entity-history";
import { listUserOptions } from "@/modules/admin/service";
import { AnalysisPanel } from "@/modules/analyses/components/analysis-panel";
import { CommentThread } from "@/modules/comments/components/comment-thread";
import { deleteContractAction } from "@/modules/contracts/actions";
import { ContractLifecycleCard } from "@/modules/contracts/components/lifecycle-card";
import { RenewContractDialog, TerminateContractDialog } from "@/modules/contracts/components/lifecycle-dialogs";
import { NoticeBadge } from "@/modules/contracts/components/notice-badge";
import { ObligationDialog } from "@/modules/contracts/components/obligation-dialog";
import { ObligationsTable } from "@/modules/contracts/components/obligations-table";
import { VigencyBadge } from "@/modules/contracts/components/vigency-badge";
import { VigencyCard } from "@/modules/contracts/components/vigency-card";
import {
  getContract,
  listContractDocumentOptions,
  listContractLifecycle,
  type ContractDetail,
  type ContractDocumentOption,
  type ContractLifecycleEvent,
  type LinkedRecordSummary,
} from "@/modules/contracts/service";
import { EntityDocuments } from "@/modules/documents/components/entity-documents";
import { EntityWorkItems } from "@/modules/work/components/entity-work-items";
import type { UserContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Contrato" };

type TabKey = "visao-geral" | "obrigacoes" | "documentos" | "analises" | "prazos" | "comentarios" | "historico";

export default async function ContractDetailPage(props: PageProps<"/contratos/[id]">) {
  const ctx = await requirePageContext("contract:read");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let contract: ContractDetail;
  try {
    contract = await getContract(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const tabs: { key: TabKey; label: string; count?: number | null; visible: boolean }[] = [
    { key: "visao-geral", label: "Visão geral", visible: true },
    { key: "obrigacoes", label: "Obrigações", count: contract.pendingObligations, visible: true },
    { key: "documentos", label: "Documentos e versões", visible: can(ctx, "document:read") },
    { key: "analises", label: "Análises de IA", visible: can(ctx, "analysis:read") },
    { key: "prazos", label: "Prazos e tarefas", visible: can(ctx, "deadline:read") || can(ctx, "task:read") },
    { key: "comentarios", label: "Comentários", visible: true },
    { key: "historico", label: "Histórico", visible: true },
  ];
  const visibleTabs = tabs.filter((t) => t.visible);
  const requested = param(sp, "aba");
  const active: TabKey = visibleTabs.find((t) => t.key === requested)?.key ?? "visao-geral";
  const base = `/contratos/${contract.id}`;

  const canWrite = can(ctx, "contract:write");
  const canDelete = can(ctx, "contract:delete");

  return (
    <>
      <PageHeader
        title={contract.title}
        description={`${CONTRACT_TYPE_LABELS[contract.type]} · ${contract.counterparty}`}
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Contratos", href: "/contratos" },
          { label: contract.title },
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label={CONTRACT_STATUS_LABELS[contract.status]} tone={CONTRACT_STATUS_TONES[contract.status]} />
            <VigencyBadge vigency={contract.vigency} daysToEnd={contract.daysToEnd} />
            <NoticeBadge notice={contract.notice} />
            {contract.overdueObligations > 0 ? (
              <StatusBadge
                tone="danger"
                label={pluralize(contract.overdueObligations, "obrigação em atraso", "obrigações em atraso", { withCount: true })}
              />
            ) : null}
            <RiskBadge level={contract.riskLevel} withPrefix />
            {contract.isConfidential ? (
              <Badge tone="primary" icon={<Lock />}>
                Confidencial
              </Badge>
            ) : null}
            {contract.legalHold ? (
              <Badge tone="alert" icon={<ShieldAlert />}>
                Retenção legal
              </Badge>
            ) : null}
          </div>
        }
        actions={
          canWrite || canDelete ? (
            <div className="flex flex-wrap gap-2">
              {canWrite ? (
                <ButtonLink href={`${base}/editar`} variant="outline">
                  <Pencil aria-hidden="true" />
                  Editar
                </ButtonLink>
              ) : null}
              {canDelete && !contract.legalHold ? (
                <ConfirmDialog
                  action={deleteContractAction}
                  hiddenFields={{ id: contract.id }}
                  triggerLabel="Excluir"
                  title="Excluir contrato?"
                  description="O contrato deixará de aparecer nas listagens. A exclusão fica registrada na auditoria."
                  confirmLabel="Excluir contrato"
                  pendingLabel="Excluindo…"
                />
              ) : null}
            </div>
          ) : null
        }
      />

      <LinkTabs
        className="mb-6"
        label="Seções do contrato"
        active={active}
        tabs={visibleTabs.map((t) => ({
          key: t.key,
          label: t.label,
          count: t.count,
          href: t.key === "visao-geral" ? base : buildHref(base, {}, { aba: t.key }),
        }))}
      />

      <TabContent active={active} contract={contract} ctx={ctx} canWrite={canWrite} />
    </>
  );
}

async function TabContent({
  active,
  contract,
  ctx,
  canWrite,
}: {
  active: TabKey;
  contract: ContractDetail;
  ctx: UserContext;
  canWrite: boolean;
}) {
  const entity = { type: "contract" as const, id: contract.id };
  const today = todayISO();

  switch (active) {
    case "visao-geral": {
      const canRenew = canWrite && (contract.status === "active" || contract.status === "expired") && contract.endDate !== null;
      const canTerminate = canWrite && contract.status === "active";
      const [lifecycle, documents] = await Promise.all([
        listContractLifecycle(ctx, contract.id),
        canRenew || canTerminate ? listContractDocumentOptions(ctx, contract.id) : Promise.resolve([]),
      ]);
      return (
        <Overview
          contract={contract}
          today={today}
          lifecycle={lifecycle}
          documents={documents}
          canRenew={canRenew}
          canTerminate={canTerminate}
        />
      );
    }

    case "obrigacoes": {
      const users = canWrite ? (await listUserOptions(ctx)).map((u) => ({ value: u.id, label: u.name })) : [];
      return (
        <Card className="pb-0">
          <CardHeader
            actions={canWrite ? <ObligationDialog contractId={contract.id} users={users} /> : null}
          >
            <CardTitle>Obrigações contratuais</CardTitle>
            <CardDescription>
              Entregas, pagamentos e demais compromissos assumidos. “Em atraso” é calculado pelo vencimento; nas obrigações
              recorrentes, “Cumprir e gerar próxima” cria a ocorrência seguinte.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <ObligationsTable
              contractId={contract.id}
              obligations={contract.obligations}
              users={users}
              canWrite={canWrite}
              today={today}
            />
          </CardContent>
        </Card>
      );
    }

    case "documentos":
      return (
        <div className="flex flex-col gap-4">
          <Callout tone="info" title="Arquivos e versões">
            O contrato assinado, aditivos e minutas ficam no módulo de documentos. O histórico de versões é mantido por
            documento: abra um documento para consultar versões anteriores ou enviar uma nova versão.
          </Callout>
          <EntityDocuments ctx={ctx} entity={entity} />
        </div>
      );

    case "analises":
      return (
        <div className="flex flex-col gap-4">
          <Callout tone="ai" title="Preparação para análise de cláusulas">
            A IA pode extrair cláusulas, apontar inconsistências e riscos a partir dos documentos vinculados; os
            resultados exigem revisão jurídica. As análises não preveem resultados nem substituem a avaliação de um
            advogado.
          </Callout>
          <AnalysisPanel ctx={ctx} subject={{ type: "contract", id: contract.id }} />
        </div>
      );

    case "prazos":
      return <EntityWorkItems ctx={ctx} entity={entity} title="Prazos e tarefas do contrato" />;

    case "comentarios":
      return <CommentThread ctx={ctx} entity={entity} />;

    case "historico":
      return <EntityHistory ctx={ctx} entity={entity} />;
  }
}

function LinkedRecord({ record, hrefBase }: { record: LinkedRecordSummary; hrefBase: string }) {
  if (!record.visible) return <span className="text-muted-foreground">{record.label}</span>;
  return (
    <Link href={`${hrefBase}/${record.id}`} className="font-medium text-primary-700 underline-offset-2 hover:underline">
      {record.label}
    </Link>
  );
}

function Overview({
  contract,
  today,
  lifecycle,
  documents,
  canRenew,
  canTerminate,
}: {
  contract: ContractDetail;
  today: string;
  lifecycle: ContractLifecycleEvent[];
  documents: ContractDocumentOption[];
  canRenew: boolean;
  canTerminate: boolean;
}) {
  const documentOptions = documents.map((d) => ({ value: d.id, label: `${d.title} (${DOCUMENT_CATEGORY_LABELS[d.category]})` }));
  const next = contract.nextObligation;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <VigencyCard
          startDate={contract.startDate}
          endDate={contract.endDate}
          noticeDeadline={contract.noticeDeadline}
          renewalType={contract.renewalType}
          renewalNoticeDays={contract.renewalNoticeDays}
          vigency={contract.vigency}
          daysToEnd={contract.daysToEnd}
          expirationDays={contract.expirationDays}
          today={today}
          actions={
            canRenew || canTerminate ? (
              <>
                {canRenew && contract.endDate ? (
                  <RenewContractDialog contractId={contract.id} currentEndDate={contract.endDate} documents={documentOptions} />
                ) : null}
                {canTerminate ? (
                  <TerminateContractDialog
                    contractId={contract.id}
                    today={today}
                    openObligations={contract.pendingObligations}
                    documents={documentOptions}
                  />
                ) : null}
              </>
            ) : null
          }
        />
        <Card>
          <CardHeader>
            <CardTitle>Dados do contrato</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                { label: "Contraparte", value: contract.counterparty },
                { label: "CNPJ/CPF da contraparte", value: contract.counterpartyDocument ? formatDocument(contract.counterpartyDocument) : null },
                { label: "Tipo", value: CONTRACT_TYPE_LABELS[contract.type] },
                {
                  label: "Situação",
                  value: <StatusBadge label={CONTRACT_STATUS_LABELS[contract.status]} tone={CONTRACT_STATUS_TONES[contract.status]} />,
                },
                { label: "Valor", value: contract.valueCents !== null ? formatMoneyCents(contract.valueCents) : null },
                { label: "Risco", value: <RiskBadge level={contract.riskLevel} /> },
                { label: "Vigência", value: contract.startDate || contract.endDate ? `${formatDate(contract.startDate, "Início não informado")} a ${contract.endDate ? formatDate(contract.endDate) : "prazo indeterminado"}` : null },
                { label: "Descrição", value: contract.description ? <p className="whitespace-pre-line">{contract.description}</p> : null, full: true },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle as="h3">Responsabilidade e obrigações</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={1}
              items={[
                { label: "Responsável", value: contract.responsibleName },
                { label: "Unidade", value: contract.unitName },
                {
                  label: "Obrigações em aberto",
                  value:
                    contract.pendingObligations === 0
                      ? "Nenhuma"
                      : `${contract.pendingObligations}${contract.overdueObligations > 0 ? ` (${contract.overdueObligations} em atraso)` : ""}`,
                },
                {
                  label: "Próxima obrigação",
                  value: next ? (
                    <Link
                      href={`/contratos/${contract.id}?aba=obrigacoes`}
                      className="font-medium text-primary-700 underline-offset-2 hover:underline"
                    >
                      {truncate(next.description, 80)}
                      <span className={next.status === "overdue" ? "block text-xs text-red-700" : "block text-xs text-muted-foreground"}>
                        {next.dueDate ? `${formatDate(next.dueDate)} · ${formatRelativeDays(next.dueDate, today)}` : "Sem data"}
                      </span>
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Nenhuma</span>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>
        <ContractLifecycleCard events={lifecycle} />
        <Card>
          <CardHeader>
            <CardTitle as="h3">Vínculos</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={1}
              items={[
                { label: "Processo", value: contract.linkedProcess ? <LinkedRecord record={contract.linkedProcess} hrefBase="/processos" /> : null },
                { label: "Ocorrência", value: contract.linkedOccurrence ? <LinkedRecord record={contract.linkedOccurrence} hrefBase="/preventivo" /> : null },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h3">Registro</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={1}
              items={[
                { label: "Cadastrado por", value: contract.createdByName },
                { label: "Cadastrado em", value: formatDateTime(contract.createdAt) },
                { label: "Última atualização", value: formatDateTime(contract.updatedAt) },
              ]}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
