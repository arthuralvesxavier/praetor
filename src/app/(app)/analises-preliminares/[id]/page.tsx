import { ArrowLeft, Check, Database, FileText, Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CASE_BRIEF_SECTIONS } from "@/domain/case-brief";
import { CASE_BRIEF_STATUS_LABELS } from "@/domain/enums";
import { formatDateTime, formatNumber, pluralize } from "@/lib/format";
import { flagParam } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { BriefReviewActions } from "@/modules/briefs/components/brief-actions";
import { BriefAutoRefresh } from "@/modules/briefs/components/brief-auto-refresh";
import { BriefStatusBadge, ProvenanceLegend, SimulationBadge } from "@/modules/briefs/components/brief-badges";
import { BriefNotices } from "@/modules/briefs/components/brief-notices";
import { BriefSectionEditor } from "@/modules/briefs/components/brief-section-editor";
import { BriefView, sectionAnchor } from "@/modules/briefs/components/brief-view";
import { getCaseBrief, isStuckGenerating, REVIEWABLE_STATUSES, type CaseBriefDetail } from "@/modules/briefs/service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Análise preliminar" };

async function loadBrief(ctx: AuthContext, id: string): Promise<CaseBriefDetail> {
  try {
    return await getCaseBrief(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

export default async function CaseBriefPage(props: PageProps<"/analises-preliminares/[id]">) {
  const ctx = await requirePageContext("brief:read");
  const { id } = await props.params;
  const sp = await props.searchParams;
  const brief = await loadBrief(ctx, id);
  const content = brief.content;

  const canReview = can(ctx, "brief:review");
  const reviewable = !!content && REVIEWABLE_STATUSES.includes(brief.status);
  const wantsEdit = flagParam(sp, "editar");
  const editing = wantsEdit && canReview && reviewable;
  const applicable = !!content && ["ready_for_review", "in_review", "approved"].includes(brief.status);
  const canOpenDocuments = can(ctx, "document:read");
  const sourceLabels = Object.fromEntries(brief.sources.map((s) => [s.ref, s.label]));
  const basePath = `/analises-preliminares/${brief.id}`;
  const processTab = `/processos/${brief.process.id}?aba=analise-preliminar`;
  const stuck = brief.status === "generating" && isStuckGenerating(brief.createdAt);

  return (
    <>
      <PageHeader
        title={`Análise preliminar — ${brief.process.number}`}
        description={brief.process.title}
        breadcrumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Análises preliminares", href: "/analises-preliminares" },
          { label: `${brief.process.number} · v${brief.version}` },
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <BriefStatusBadge status={brief.status} />
            <SimulationBadge mode={brief.mode} />
            <Badge tone="neutral">
              Versão {brief.version}
              {brief.currentRevision > 0 ? ` · revisão ${brief.currentRevision}` : ""}
            </Badge>
            {brief.isStale ? <Badge tone="alert">Possivelmente desatualizada</Badge> : null}
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={processTab} variant="outline">
              <ArrowLeft aria-hidden="true" />
              Ver processo
            </ButtonLink>
            {canReview && reviewable ? (
              editing ? (
                <ButtonLink href={basePath} variant="outline">
                  <Check aria-hidden="true" />
                  Concluir edição
                </ButtonLink>
              ) : (
                <ButtonLink href={`${basePath}?editar=1`} variant="outline">
                  <Pencil aria-hidden="true" />
                  Editar
                </ButtonLink>
              )
            ) : null}
            <BriefReviewActions
              briefId={brief.id}
              processId={brief.process.id}
              canDecide={canReview && reviewable && !editing}
              canRegenerate={canReview && (brief.status !== "generating" || stuck) && !editing}
            />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <BriefNotices
            mode={brief.mode}
            systemNotices={content?.systemNotices}
            promptInjectionSuspected={content?.promptInjectionSuspected ?? false}
          />
          <StatusCallouts brief={brief} />
          {wantsEdit && !editing ? (
            <Callout tone="info" title="Edição indisponível">
              {canReview
                ? `Análises na situação “${CASE_BRIEF_STATUS_LABELS[brief.status]}” não podem ser editadas. Gere uma nova versão para revisar novamente.`
                : "Seu perfil pode consultar, mas não editar análises preliminares."}
            </Callout>
          ) : null}

          {stuck ? (
            <Callout tone="warning" title="Geração sem resposta">
              A geração desta análise não terminou no tempo esperado. Use “Gerar nova versão” para tentar novamente.
            </Callout>
          ) : null}
          {brief.status === "generating" && !stuck ? (
            <Card>
              <CardContent className="flex flex-col gap-3">
                <BriefAutoRefresh active />
                <p className="text-sm text-muted-foreground">
                  A simulação está lendo o cadastro e os documentos com texto do processo. Documentos com extração pendente são
                  processados antes.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {content ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Resumo</CardTitle>
                  <CardDescription>Visão geral para o advogado responsável (também usada no e-mail simulado).</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {editing ? (
                    <BriefSectionEditor
                      briefId={brief.id}
                      processId={brief.process.id}
                      section="headline"
                      label="Resumo"
                      value={content.headline}
                      baseRevision={brief.currentRevision}
                    />
                  ) : (
                    <p className="text-sm leading-relaxed">{content.headline}</p>
                  )}
                  <div className="border-t border-border pt-3">
                    <p className="mb-2 text-xs font-semibold text-muted-foreground">Origem de cada item</p>
                    <ProvenanceLegend />
                  </div>
                </CardContent>
              </Card>

              {editing ? (
                <>
                  <Callout tone="info" title="Modo de edição">
                    Salve cada seção separadamente; cada gravação cria uma nova revisão. Itens incluídos ou alterados passam a
                    aparecer como “Incluído/editado pelo advogado”. As citações dos itens que você não alterar são mantidas.
                  </Callout>
                  {CASE_BRIEF_SECTIONS.map((s) => (
                    <Card key={s.key} id={sectionAnchor(s.key)} className="scroll-mt-20">
                      <CardHeader>
                        <CardTitle>{s.label}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <BriefSectionEditor
                          briefId={brief.id}
                          processId={brief.process.id}
                          section={s.key}
                          label={s.label}
                          value={content[s.key] as unknown as Parameters<typeof BriefSectionEditor>[0]["value"]}
                          baseRevision={brief.currentRevision}
                        />
                      </CardContent>
                    </Card>
                  ))}
                </>
              ) : (
                <BriefView
                  briefId={brief.id}
                  processId={brief.process.id}
                  content={content}
                  sourceLabels={sourceLabels}
                  abilities={{
                    canOpenDocuments,
                    applicable,
                    canCreateDeadline: can(ctx, "deadline:write"),
                    canCreateTask: can(ctx, "task:write"),
                    canProposeAmount: can(ctx, "contingency:write"),
                  }}
                />
              )}

              <Card>
                <CardHeader>
                  <CardTitle>Limitações</CardTitle>
                  <CardDescription>O que a análise não conseguiu avaliar.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc space-y-1.5 pl-5 text-sm">
                    {content.limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </>
          ) : null}
        </div>

        <aside className="flex min-w-0 flex-col gap-6" aria-label="Detalhes da análise">
          {content ? (
            <Card>
              <CardHeader>
                <CardTitle as="h2">Seções</CardTitle>
              </CardHeader>
              <CardContent>
                <nav aria-label="Seções da análise">
                  <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm lg:grid-cols-1">
                    {CASE_BRIEF_SECTIONS.map((s) => {
                      const count = (content[s.key] as unknown[]).length;
                      return (
                        <li key={s.key}>
                          <a
                            href={`#${sectionAnchor(s.key)}`}
                            className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-primary-700 hover:bg-surface-muted hover:underline"
                          >
                            <span className="truncate">{s.label}</span>
                            <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle as="h2">Fontes consultadas</CardTitle>
              <CardDescription>Citadas como “REG” (cadastro) e “D1”, “D2”… (documentos).</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3 text-sm">
                {brief.sources.map((s) => (
                  <li key={s.ref} className="flex gap-2">
                    <span
                      className={cn(
                        "inline-flex h-6 min-w-9 shrink-0 items-center justify-center rounded border px-1 text-xs font-semibold",
                        s.ref === "REG" ? "border-border bg-surface-muted" : "border-sky-200 bg-sky-50 text-sky-900",
                      )}
                    >
                      {s.ref}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      {s.sourceType === "document_version" && canOpenDocuments ? (
                        <Link href={`/documentos/${s.entityId}`} className="font-medium break-words text-primary-700 hover:underline">
                          {s.label}
                        </Link>
                      ) : (
                        <span className="font-medium break-words">{s.label}</span>
                      )}
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        {s.sourceType === "legal_process" ? (
                          <>
                            <Database aria-hidden="true" className="size-3" /> Cadastro do processo
                          </>
                        ) : (
                          <>
                            <FileText aria-hidden="true" className="size-3" />
                            {s.versionNumber ? `versão ${s.versionNumber}` : "documento"}
                            {s.pageCount ? ` · ${pluralize(s.pageCount, "página", "páginas")}` : ""}
                            {s.charCount ? ` · ${formatNumber(s.charCount)} caracteres` : ""}
                          </>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">Histórico</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-2 text-sm">
                <HistoryLine label="Solicitada" who={brief.requestedByName ?? "Sistema"} when={brief.createdAt} />
                {brief.generatedAt ? <HistoryLine label="Gerada" who={brief.mode === "demo" ? "Simulação" : "Provedor de IA"} when={brief.generatedAt} /> : null}
                {brief.lastEditedAt ? <HistoryLine label="Última edição" who={brief.lastEditedByName} when={brief.lastEditedAt} /> : null}
                {brief.approvedAt ? <HistoryLine label="Aprovada" who={brief.approvedByName} when={brief.approvedAt} /> : null}
                {brief.rejectedAt ? <HistoryLine label="Rejeitada" who={brief.rejectedByName} when={brief.rejectedAt} /> : null}
              </ol>
            </CardContent>
          </Card>

          {brief.revisions.length ? (
            <Card>
              <CardHeader>
                <CardTitle as="h2">Revisões</CardTitle>
                <CardDescription>A revisão 1 é o conteúdo gerado, mantido sem alterações.</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col gap-3 text-sm">
                  {brief.revisions.map((r) => (
                    <li key={r.revision} className="flex flex-col">
                      <span className="font-medium">
                        Revisão {r.revision}
                        {r.revision === brief.currentRevision ? <span className="ml-1 text-xs text-muted-foreground">(atual)</span> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {r.editedByName ?? (brief.mode === "demo" ? "Simulação" : "Gerada")} · {formatDateTime(r.createdAt)}
                      </span>
                      {r.changeNote ? <span className="text-xs">{r.changeNote}</span> : null}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}

          {brief.otherVersions.length > 1 ? (
            <Card>
              <CardHeader>
                <CardTitle as="h2">Versões</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-sm">
                  {brief.otherVersions.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2">
                      {v.id === brief.id ? (
                        <span className="font-medium" aria-current="page">
                          Versão {v.version} (esta)
                        </span>
                      ) : (
                        <Link href={`/analises-preliminares/${v.id}`} className="font-medium text-primary-700 hover:underline">
                          Versão {v.version}
                        </Link>
                      )}
                      <BriefStatusBadge status={v.status} />
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function HistoryLine({ label, who, when }: { label: string; who: string | null; when: Date }) {
  return (
    <li className="flex flex-col">
      <span className="font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">
        {who ?? "—"} · {formatDateTime(when)}
      </span>
    </li>
  );
}

function StatusCallouts({ brief }: { brief: CaseBriefDetail }) {
  return (
    <>
      {brief.status === "failed" ? (
        <Callout tone="danger" title="Não foi possível gerar a análise">
          {brief.errorMessage ?? "Falha na geração."} Use “Gerar nova versão” para tentar novamente.
        </Callout>
      ) : null}
      {brief.status === "approved" ? (
        <Callout tone="success" title="Aprovada pelo advogado">
          {brief.approvedByName ?? "—"}
          {brief.approvedAt ? ` em ${formatDateTime(brief.approvedAt)}` : ""}.{brief.approvalNote ? ` Observação: ${brief.approvalNote}` : ""}
        </Callout>
      ) : null}
      {brief.status === "rejected" ? (
        <Callout tone="warning" title="Rejeitada">
          {brief.rejectedByName ?? "—"}
          {brief.rejectedAt ? ` em ${formatDateTime(brief.rejectedAt)}` : ""}. Motivo: {brief.rejectionReason ?? "não informado"}
        </Callout>
      ) : null}
      {brief.isStale ? (
        <Callout tone="warning" title="Análise possivelmente desatualizada">
          {brief.staleReason ?? "O processo mudou depois da geração."} Gere uma nova versão para considerar as informações atuais.
        </Callout>
      ) : null}
    </>
  );
}
