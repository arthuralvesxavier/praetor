import { CalendarClock, History, MessageSquareQuote, Sparkles } from "lucide-react";
import Link from "next/link";
import {
  ANALYSIS_REVIEW_STATUS_LABELS,
  ANALYSIS_TRIGGER_LABELS,
  ANALYSIS_TYPE_LABELS,
} from "@/domain/enums";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PriorityBadge } from "@/components/ui/priority-badge";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import type { AnalysisDetail } from "../service";
import { AnalysisStatusBadge, PendingBadge, ReviewStatusBadge, StaleBadge } from "./analysis-badges";
import { loadSourceHashPrefixes } from "./analysis-data";
import { FindingsByKind, SourceRefChips } from "./analysis-findings";
import { AnalysisReviewForm, ApplySuggestionForm, ReanalyzeForm } from "./analysis-forms";
import { COST_VISIBLE_ROLES, formatMicroUsd } from "./analysis-labels";
import {
  BulletList,
  DemoNotice,
  DisclaimerNotice,
  PromptInjectionNotice,
  ResultSection,
  SourcesList,
  systemNoticesToShow,
} from "./analysis-sections";

export type AnalysisResultViewProps = {
  ctx: AuthContext;
  /** Loaded with `getAnalysis(ctx, id)` (permission + visibility already enforced). */
  analysis: AnalysisDetail;
};

/**
 * Full view of an AI analysis: metadata, mandatory notices (demo, disclaimer,
 * staleness, system notices), result sections, sources and review. AI output
 * is presented as suggestions to be checked against the cited sources.
 */
export async function AnalysisResultView({ ctx, analysis: a }: AnalysisResultViewProps) {
  const hashPrefixes = await loadSourceHashPrefixes(ctx, a.id);
  const result = a.status === "succeeded" ? a.result : null;
  const notices = systemNoticesToShow(result);
  const canRequest = can(ctx, "analysis:request");
  const showCosts = (COST_VISIBLE_ROLES as readonly string[]).includes(ctx.role);
  const dismissed = a.reviewStatus === "dismissed";
  const sourceRefs = a.sources.map((s) => ({ ref: s.ref, label: s.label }));

  const deadlineDisabledReason = !can(ctx, "deadline:write")
    ? "Seu perfil não permite cadastrar prazos. Peça a um advogado ou gestor para registrar esta sugestão."
    : dismissed
      ? "Esta análise foi descartada na revisão; suas sugestões não podem ser aplicadas."
      : !a.canApplyDeadlines
        ? "Esta sugestão não pode ser aplicada no momento."
        : null;
  const taskDisabledReason = !can(ctx, "task:write")
    ? "Seu perfil não permite criar tarefas."
    : dismissed
      ? "Esta análise foi descartada na revisão; suas sugestões não podem ser aplicadas."
      : !a.canApplyTasks
        ? "Esta sugestão não pode ser aplicada no momento."
        : null;

  return (
    <div className="space-y-6">
      {/* Mandatory notices, demo first so it is never missed. */}
      <div className="space-y-3">
        <DemoNotice mode={a.mode} />
        <DisclaimerNotice />
        {a.isStale ? (
          <Callout tone="warning" title="Análise desatualizada" icon={<History />}>
            <p>
              As fontes usadas mudaram depois desta análise, que pode não refletir as informações atuais.
              {a.staleReason ? <> Motivo: {a.staleReason}</> : null}
              {a.staleSince ? <> (desde {formatDateTime(a.staleSince)})</> : null}
            </p>
            {canRequest ? (
              <div className="pt-2">
                <ReanalyzeForm analysisId={a.id} variant="primary" />
              </div>
            ) : null}
          </Callout>
        ) : null}
        {a.status === "failed" || a.status === "cancelled" ? (
          <Callout tone="danger" title={a.status === "failed" ? "A análise falhou" : "A análise foi cancelada"}>
            <p>{a.errorMessage ?? "A análise não foi concluída."}</p>
            {canRequest ? (
              <div className="pt-2">
                <ReanalyzeForm analysisId={a.id} label="Solicitar novamente" />
              </div>
            ) : null}
          </Callout>
        ) : null}
        {a.status === "queued" || a.status === "running" ? (
          <Callout tone="info" title={a.status === "queued" ? "Análise na fila" : "Análise em processamento"}>
            O resultado aparecerá nesta página assim que o processamento terminar.
            {a.attempts > 1 ? ` Tentativa ${a.attempts} de ${a.maxAttempts}.` : null}
          </Callout>
        ) : null}
        <PromptInjectionNotice result={result} />
        {notices.map((n, i) => (
          <Callout key={i} tone="info" title="Aviso do sistema">
            {n}
          </Callout>
        ))}
      </div>

      {/* Metadata */}
      <Card>
        <CardHeader>
          <CardTitle>Dados da análise</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <AnalysisStatusBadge status={a.status} />
            <PendingBadge status={a.status} />
            <AiModeBadge mode={a.mode} />
            <ReviewStatusBadge status={a.reviewStatus} analysisStatus={a.status} />
            <StaleBadge isStale={a.isStale} />
          </div>
          <DescriptionList
            columns={3}
            items={[
              { label: "Tipo", value: ANALYSIS_TYPE_LABELS[a.type] },
              {
                label: "Objeto",
                value: a.subjectHref ? (
                  <Link href={a.subjectHref} className="text-primary-700 underline-offset-2 hover:underline">
                    {a.subjectLabel}
                  </Link>
                ) : (
                  a.subjectLabel
                ),
              },
              { label: "Origem da solicitação", value: ANALYSIS_TRIGGER_LABELS[a.trigger] },
              { label: "Solicitada por", value: a.requestedByName ?? "Sistema (automática)" },
              { label: "Solicitada em", value: formatDateTime(a.createdAt) },
              { label: "Concluída em", value: a.completedAt ? formatDateTime(a.completedAt) : null },
              {
                label: "Provedor e modelo",
                value: a.mode === "demo" ? `${a.provider} (regras de demonstração, sem IA)` : `${a.provider} · ${a.model}`,
              },
              { label: "Versão das instruções", value: a.promptVersion },
              { label: "Fontes utilizadas", value: formatNumber(a.sources.length) },
              showCosts && {
                label: "Tokens (entrada / saída)",
                value:
                  a.inputTokens == null && a.outputTokens == null
                    ? null
                    : `${formatNumber(a.inputTokens ?? 0)} / ${formatNumber(a.outputTokens ?? 0)}`,
              },
              showCosts && { label: "Custo estimado", value: formatMicroUsd(a.costMicroUsd) },
            ]}
          />
        </CardContent>
      </Card>

      {result ? (
        <Card className="border-ai-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles aria-hidden="true" className="size-4 text-ai-700" />
              Resultado {a.mode === "demo" ? "demonstrativo" : "da análise"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-8">
            {a.type === "question_answer" && a.question ? (
              <ResultSection title="Pergunta" id="pergunta">
                <p className="flex gap-2 rounded-md bg-slate-50 p-3 text-sm whitespace-pre-line text-slate-800">
                  <MessageSquareQuote aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-slate-500" />
                  {a.question}
                </p>
              </ResultSection>
            ) : null}

            {result.answer ? (
              <ResultSection
                title="Resposta"
                id="resposta"
                description="Baseada apenas nos registros e documentos a que você tem acesso; confira as fontes citadas."
              >
                <div className="rounded-md border border-ai-200 bg-ai-50/50 p-4 text-sm leading-relaxed whitespace-pre-line text-slate-900">
                  {result.answer}
                </div>
              </ResultSection>
            ) : null}

            <ResultSection title="Resumo" id="resumo">
              <p className="text-sm leading-relaxed whitespace-pre-line text-slate-800">{result.summary}</p>
            </ResultSection>

            <ResultSection
              title={`Achados (${formatNumber(result.findings.length)})`}
              id="achados"
              description="Pontos identificados nas fontes. São sugestões para conferência, não fatos confirmados."
            >
              <FindingsByKind analysisId={a.id} findings={result.findings} sources={sourceRefs} />
            </ResultSection>

            <ResultSection
              title={`Prazos sugeridos (${formatNumber(result.suggestedDeadlines.length)})`}
              id="prazos-sugeridos"
              description="Datas mencionadas literalmente nas fontes. Nenhuma contagem automática de prazo legal ou processual foi aplicada."
            >
              {result.suggestedDeadlines.length ? (
                <>
                  <Callout tone="ai" icon={<CalendarClock />}>
                    Ao criar um prazo a partir de uma sugestão, ele é registrado como <strong>aguardando validação</strong> e
                    só passa a valer depois que um responsável conferir a data na fonte e validá-lo.
                  </Callout>
                  <ul className="space-y-3">
                    {result.suggestedDeadlines.map((d, i) => (
                      <li key={i} className="space-y-2 rounded-md border border-ai-100 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="text-sm font-medium text-slate-900">{d.title}</p>
                          <span className="rounded bg-ai-50 px-2 py-0.5 text-sm font-semibold text-ai-900 tabular-nums">
                            {formatDate(d.date)}
                          </span>
                        </div>
                        {d.excerpt ? (
                          <blockquote className="border-l-2 border-ai-300 bg-ai-50/60 py-1 pr-2 pl-3 text-sm text-slate-700 italic">
                            “{d.excerpt}”
                          </blockquote>
                        ) : null}
                        {d.rationale ? (
                          <p className="text-sm text-slate-700">
                            <span className="font-medium">Justificativa: </span>
                            {d.rationale}
                          </p>
                        ) : null}
                        <SourceRefChips analysisId={a.id} refs={[d.sourceRef]} sources={sourceRefs} />
                        <ApplySuggestionForm
                          kind="deadline"
                          analysisId={a.id}
                          index={i}
                          applied={a.appliedDeadlineIndexes.includes(i)}
                          disabledReason={deadlineDisabledReason}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhum prazo foi sugerido.</p>
              )}
            </ResultSection>

            <ResultSection
              title={`Tarefas sugeridas (${formatNumber(result.suggestedTasks.length)})`}
              id="tarefas-sugeridas"
              description="Ações recomendadas a partir das fontes. Só viram tarefas se você decidir criá-las."
            >
              {result.suggestedTasks.length ? (
                <ul className="space-y-3">
                  {result.suggestedTasks.map((t, i) => (
                    <li key={i} className="space-y-2 rounded-md border border-ai-100 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="text-sm font-medium text-slate-900">{t.title}</p>
                        <PriorityBadge priority={t.priority} withPrefix />
                      </div>
                      {t.description ? <p className="text-sm whitespace-pre-line text-slate-700">{t.description}</p> : null}
                      <SourceRefChips analysisId={a.id} refs={t.sourceRefs} sources={sourceRefs} />
                      <ApplySuggestionForm
                        kind="task"
                        analysisId={a.id}
                        index={i}
                        applied={a.appliedTaskIndexes.includes(i)}
                        disabledReason={taskDisabledReason}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhuma tarefa foi sugerida.</p>
              )}
            </ResultSection>

            <div className="grid gap-8 lg:grid-cols-2">
              <ResultSection title="Limitações" id="limitacoes" description="O que esta análise não conseguiu avaliar.">
                <BulletList items={result.limitations} empty="Nenhuma limitação foi registrada." />
              </ResultSection>
              <ResultSection
                title="Pontos que exigem validação"
                id="validacao"
                description="Confirme estes pontos com um advogado antes de usar o resultado."
              >
                <BulletList
                  items={result.validationPoints}
                  tone="warning"
                  empty="Nenhum ponto específico foi indicado; ainda assim, valide o conteúdo nas fontes."
                />
              </ResultSection>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Fontes utilizadas ({formatNumber(a.sources.length)})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Somente estas fontes foram enviadas para a análise, na versão indicada. O hash identifica exatamente o conteúdo
            usado.
            {a.inputTruncated ? " Parte do conteúdo excedeu o limite de tamanho e não foi analisada." : null}
          </p>
          <SourcesList analysisId={a.id} sources={a.sources} hashPrefixes={hashPrefixes} />
        </CardContent>
      </Card>

      {a.status === "succeeded" ? (
        <Card>
          <CardHeader>
            <CardTitle>Revisão humana</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {a.reviewStatus === "pending_review" ? (
              <p className="text-sm text-muted-foreground">
                Esta análise ainda não foi revisada por um advogado ou gestor.
              </p>
            ) : (
              <DescriptionList
                columns={3}
                items={[
                  { label: "Situação", value: ANALYSIS_REVIEW_STATUS_LABELS[a.reviewStatus] },
                  { label: "Revisada por", value: a.reviewedByName },
                  { label: "Data da revisão", value: a.reviewedAt ? formatDateTime(a.reviewedAt) : null },
                  a.reviewNote ? { label: "Observação", value: a.reviewNote, full: true } : null,
                ]}
              />
            )}
            {a.canReview ? (
              <div className="border-t border-border pt-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-900">
                  {a.reviewStatus === "pending_review" ? "Registrar revisão" : "Alterar revisão"}
                </h3>
                <AnalysisReviewForm analysisId={a.id} />
              </div>
            ) : a.reviewStatus === "pending_review" ? (
              <p className="text-xs text-muted-foreground">Seu perfil não permite revisar análises de IA.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
