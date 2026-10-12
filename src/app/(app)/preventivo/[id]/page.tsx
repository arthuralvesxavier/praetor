import { FilePlus2, Lightbulb, Lock, Pencil, Scale, ShieldCheck, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { OriginBadge } from "@/components/ui/origin-badge";
import { PageHeader } from "@/components/ui/page-header";
import { RiskBadge } from "@/components/ui/risk-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { LinkTabs } from "@/components/ui/tabs";
import {
  OCCURRENCE_CATEGORY_LABELS,
  OCCURRENCE_STATUS_LABELS,
  PROCESS_STATUS_LABELS,
} from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents } from "@/lib/format";
import { param, type SearchParams } from "@/lib/search-params";
import { OCCURRENCE_STATUS_TONES, PROCESS_STATUS_TONES } from "@/lib/tones";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";
import { EntityHistory } from "@/modules/admin/components/entity-history";
import { AnalysisPanel } from "@/modules/analyses/components/analysis-panel";
import { CommentThread } from "@/modules/comments/components/comment-thread";
import { EntityDocuments } from "@/modules/documents/components/entity-documents";
import { deleteOccurrenceAction, unlinkOccurrenceFromProcessAction } from "@/modules/occurrences/actions";
import { ActionPlanSummary } from "@/modules/occurrences/components/action-plan-summary";
import { AiSignalsCard } from "@/modules/occurrences/components/ai-signals-card";
import { ProcessLinkForm } from "@/modules/occurrences/components/process-link-form";
import { PREVENTIVE_ORIGIN_LABEL } from "@/modules/occurrences/preventive-origin";
import { getActionPlanProgress, getOccurrence, type OccurrenceDetail } from "@/modules/occurrences/service";
import { listProcessOptions } from "@/modules/processes/service";
import { EntityWorkItems } from "@/modules/work/components/entity-work-items";

export const metadata: Metadata = { title: "Ocorrência" };

const TABS = [
  { key: "visao-geral", label: "Visão geral" },
  { key: "plano", label: "Plano de ação" },
  { key: "documentos", label: "Documentos" },
  { key: "ia", label: "Análises de IA" },
  { key: "processo", label: "Vínculo com processo" },
  { key: "comentarios", label: "Comentários" },
  { key: "historico", label: "Histórico" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function activeTab(sp: SearchParams): TabKey {
  const v = param(sp, "aba");
  return TABS.some((t) => t.key === v) ? (v as TabKey) : "visao-geral";
}

function tabHref(id: string, key: TabKey): string {
  return key === "visao-geral" ? `/preventivo/${id}` : `/preventivo/${id}?aba=${key}`;
}

export default async function OccurrencePage(props: PageProps<"/preventivo/[id]">) {
  const ctx = await requirePageContext("occurrence:read");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let occurrence: OccurrenceDetail;
  try {
    occurrence = await getOccurrence(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const tab = activeTab(sp);
  const entity = { type: "occurrence" as const, id: occurrence.id };

  return (
    <div className="space-y-6">
      <PageHeader
        title={occurrence.title}
        breadcrumbs={[{ label: "Jurídico preventivo", href: "/preventivo" }, { label: occurrence.title }]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={OCCURRENCE_STATUS_LABELS[occurrence.status]}
              tone={OCCURRENCE_STATUS_TONES[occurrence.status]}
            />
            <RiskBadge level={occurrence.riskLevel} withPrefix />
            <Badge>{OCCURRENCE_CATEGORY_LABELS[occurrence.category]}</Badge>
            {occurrence.isConfidential ? (
              <Badge tone="warning" icon={<Lock />}>
                Confidencial
              </Badge>
            ) : null}
            {occurrence.legalHold ? (
              <Badge tone="neutral" icon={<ShieldCheck />}>
                Preservação legal
              </Badge>
            ) : null}
            {occurrence.preventiveOrigin ? (
              <Badge tone="primary" icon={<Lightbulb />}>
                {PREVENTIVE_ORIGIN_LABEL}
              </Badge>
            ) : null}
            <span className="text-sm text-muted-foreground">Reportada em {formatDate(occurrence.reportedOn)}</span>
          </div>
        }
        actions={
          <>
            {occurrence.canEdit ? (
              <ButtonLink href={`/preventivo/${occurrence.id}/editar`} variant="outline">
                <Pencil aria-hidden="true" />
                Editar
              </ButtonLink>
            ) : null}
            {occurrence.canDelete ? (
              <ConfirmDialog
                action={deleteOccurrenceAction}
                hiddenFields={{ id: occurrence.id }}
                title="Excluir ocorrência?"
                description="A ocorrência deixará de aparecer no sistema. O registro é preservado para fins de auditoria."
                confirmLabel="Excluir"
                pendingLabel="Excluindo…"
                trigger={
                  <Button type="button" variant="outline">
                    <Trash2 aria-hidden="true" />
                    Excluir
                  </Button>
                }
              />
            ) : null}
          </>
        }
      />

      <LinkTabs
        label="Seções da ocorrência"
        active={tab}
        tabs={TABS.map((t) => ({ key: t.key, label: t.label, href: tabHref(occurrence.id, t.key) }))}
      />

      {tab === "visao-geral" ? <OverviewTab ctx={ctx} occurrence={occurrence} /> : null}
      {tab === "plano" ? <ActionPlanTab ctx={ctx} occurrence={occurrence} /> : null}
      {tab === "documentos" ? <EntityDocuments ctx={ctx} entity={entity} /> : null}
      {tab === "ia" ? <AnalysisPanel ctx={ctx} subject={entity} /> : null}
      {tab === "processo" ? <ProcessLinkTab ctx={ctx} occurrence={occurrence} /> : null}
      {tab === "comentarios" ? <CommentThread ctx={ctx} entity={entity} /> : null}
      {tab === "historico" ? <EntityHistory ctx={ctx} entity={entity} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type TabProps = { ctx: AuthContext; occurrence: OccurrenceDetail };

function OverviewTab({ ctx, occurrence: o }: TabProps) {
  return (
    <div className="grid gap-6">
      {o.preventiveOrigin ? (
        <Callout tone="info" title={PREVENTIVE_ORIGIN_LABEL} icon={<Lightbulb />}>
          Criada a partir de um indicador calculado pela inteligência preventiva
          {o.preventiveOrigin.indicator ? (
            <>
              : <span className="font-medium">{o.preventiveOrigin.indicator}</span>
            </>
          ) : (
            "."
          )}{" "}
          A medida associada era uma sugestão ilustrativa, a ser avaliada com a área responsável.{" "}
          {can(ctx, "preventive_intel:read") ? <Link href="/inteligencia-preventiva">Ver indicadores atuais</Link> : null}
        </Callout>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Fatos</CardTitle>
            <CardDescription>Narrativa registrada pela equipe.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-800">{o.facts}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader actions={<OriginBadge origin="manual" />}>
            <CardTitle>Classificação</CardTitle>
            <CardDescription>Risco classificado pela equipe jurídica — não é gerado pela IA nem é previsão de resultado.</CardDescription>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={1}
              items={[
                { label: "Nível de risco", value: <RiskBadge level={o.riskLevel} /> },
                {
                  label: "Justificativa",
                  value: o.riskRationale ? <span className="whitespace-pre-wrap">{o.riskRationale}</span> : null,
                },
                { label: "Categoria", value: OCCURRENCE_CATEGORY_LABELS[o.category] },
                { label: "Exposição estimada", value: formatMoneyCents(o.estimatedExposureCents) },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Áreas e responsáveis</CardTitle>
        </CardHeader>
        <CardContent>
          <DescriptionList
            columns={3}
            items={[
              {
                label: "Áreas envolvidas",
                value:
                  o.areasInvolved.length > 0 ? (
                    <span className="flex flex-wrap gap-1.5">
                      {o.areasInvolved.map((a) => (
                        <Badge key={a}>{a}</Badge>
                      ))}
                    </span>
                  ) : null,
              },
              { label: "Unidade", value: o.unitName },
              { label: "Responsável", value: o.responsibleName },
              { label: "Reportada por", value: o.reportedByName },
              { label: "Data da ocorrência", value: o.occurredOn ? formatDate(o.occurredOn) : null },
              { label: "Reportada em", value: formatDate(o.reportedOn) },
              o.resolvedAt ? { label: "Resolvida em", value: formatDateTime(o.resolvedAt) } : null,
              { label: "Última atualização", value: formatDateTime(o.updatedAt) },
              {
                label: "Partes envolvidas",
                value: o.involvedParties ? <span className="whitespace-pre-wrap">{o.involvedParties}</span> : null,
                full: true,
              },
            ]}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader actions={<OriginBadge origin="manual" />}>
            <CardTitle as="h3">Informações faltantes</CardTitle>
            <CardDescription>Lista mantida pela equipe.</CardDescription>
          </CardHeader>
          <CardContent>
            {o.missingInformation.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma informação faltante registrada.</p>
            ) : (
              <ul className="grid list-disc gap-1.5 pl-5 text-sm text-slate-800">
                {o.missingInformation.map((item, i) => (
                  <li key={`${i}-${item}`}>{item}</li>
                ))}
              </ul>
            )}
            {o.canEdit ? (
              <Link
                href={`/preventivo/${o.id}/editar`}
                className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                Atualizar lista
              </Link>
            ) : null}
          </CardContent>
        </Card>
        <AiSignalsCard ctx={ctx} occurrenceId={o.id} aiTabHref={tabHref(o.id, "ia")} />
      </div>
    </div>
  );
}

async function ActionPlanTab({ ctx, occurrence }: TabProps) {
  const progress = await getActionPlanProgress(ctx, occurrence.id);
  return (
    <div className="grid gap-6">
      {progress ? <ActionPlanSummary progress={progress} /> : null}
      <EntityWorkItems
        ctx={ctx}
        entity={{ type: "occurrence", id: occurrence.id }}
        taskKind="action_plan"
        title="Plano de ação"
      />
    </div>
  );
}

async function ProcessLinkTab({ ctx, occurrence: o }: TabProps) {
  const linked = o.linkedProcess;

  if (linked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Processo vinculado</CardTitle>
          <CardDescription>Esta ocorrência deu origem a um processo judicial ou foi associada a um existente.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {linked.visible ? (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <Link
                  href={`/processos/${linked.id}`}
                  className="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Scale aria-hidden="true" className="size-4" />
                  {linked.number}
                </Link>
                {linked.title ? <p className="truncate text-sm text-slate-700">{linked.title}</p> : null}
              </div>
              {linked.status ? (
                <StatusBadge label={PROCESS_STATUS_LABELS[linked.status]} tone={PROCESS_STATUS_TONES[linked.status]} />
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              A ocorrência está vinculada a um processo que você não tem permissão para consultar.
            </p>
          )}
          {o.canEdit ? (
            <div>
              <ConfirmDialog
                action={unlinkOccurrenceFromProcessAction}
                hiddenFields={{ occurrenceId: o.id }}
                title="Remover vínculo com o processo?"
                description="O processo não é alterado. Se a ocorrência estiver como “Convertida em processo”, ela volta para “Em análise”."
                triggerLabel="Remover vínculo"
                confirmLabel="Remover vínculo"
                pendingLabel="Removendo…"
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const canLink = o.canEdit;
  const canCreateProcess = can(ctx, "process:write");
  const processes = canLink ? await listProcessOptions(ctx) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vínculo com processo</CardTitle>
        <CardDescription>
          Quando a ocorrência se tornar um processo judicial, vincule-a para manter o histórico preventivo junto ao contencioso.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {canLink ? (
          processes.length > 0 ? (
            <ProcessLinkForm
              occurrenceId={o.id}
              processes={processes.map((p) => ({ value: p.id, label: `${p.number} — ${p.title}` }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Não há processos disponíveis para vínculo.</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">Esta ocorrência não está vinculada a nenhum processo.</p>
        )}
        {canCreateProcess && canLink ? (
          <div className="border-t border-border pt-4">
            <p className="mb-2 text-sm text-slate-700">O processo ainda não foi cadastrado?</p>
            <ButtonLink href={`/processos/novo?ocorrencia=${o.id}`} variant="outline">
              <FilePlus2 aria-hidden="true" />
              Criar processo a partir desta ocorrência
            </ButtonLink>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
