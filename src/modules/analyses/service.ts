import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  analysisOutputSchema,
  DEMO_MODE_NOTICE,
  type AnalysisOutput,
  type AnalysisResult,
} from "@/domain/analysis";
import { entityHref, normalizePage, type EntityRef, type Page, type Paginated } from "@/domain/entities";
import {
  AI_MODE_LABELS,
  ANALYSIS_TYPE_LABELS,
  type AiMode,
  type AlertSeverity,
  type AnalysisReviewStatus,
  type AnalysisStatus,
  type AnalysisSubjectType,
  type AnalysisTrigger,
  type AnalysisType,
  type DeadlineKind,
  type EntityType,
  type Priority,
} from "@/domain/enums";
import { systemContext, type AuthContext } from "@/server/auth/context";
import {
  analysisWhere,
  contractWhere,
  documentWhere,
  occurrenceWhere,
  processWhere,
} from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  aiAnalyses,
  aiAnalysisSources,
  aiUsage,
  contracts,
  deadlines,
  documents,
  documentVersions,
  legalProcesses,
  occurrences,
  tasks,
  users,
} from "@/server/db/schema";
import { env } from "@/server/env";
import {
  AiProviderError,
  costMicroUsd,
  getAiProvider,
  getAiRuntimeInfo as runtimeInfo,
  PROMPT_VERSION,
} from "@/server/integrations/ai";
import { enqueueJob } from "@/server/jobs/queue";
import {
  AppError,
  BudgetExceededError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { upsertAlert } from "@/modules/alerts/service";
import { currentUsagePeriod, loadOrganization } from "./org-settings";
import {
  listAnalysesSchema,
  requestAnalysisSchema,
  reviewAnalysisSchema,
  staleInputSchema,
  suggestionIndexSchema,
  textReadyInputSchema,
  type RequestAnalysisInput,
} from "./schemas";
import {
  buildAnalysisSources,
  contractLabel,
  documentLabel,
  occurrenceLabel,
  ORGANIZATION_SUBJECT_LABEL,
  processLabel,
  rebuildSourceTexts,
  resolveSubject,
  sha256,
  type PreparedSource,
  type StoredSource,
} from "./sources";

/**
 * AI analyses: request (with dedupe, budget control and source snapshot),
 * background execution, review, staleness and application of suggestions.
 *
 * Safety rules enforced here:
 * - sources only include records/documents visible to the requester;
 * - provider output is validated, and citations to unknown refs are dropped;
 * - results are never merged into records: suggestions become tasks/deadlines
 *   only through applySuggested* (explicit user action), and deadlines are
 *   created pending human validation;
 * - nothing derived from document text, prompts or answers is logged/audited.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AnalysisListItem = {
  id: string;
  type: AnalysisType;
  subjectType: AnalysisSubjectType;
  subjectId: string | null;
  subjectLabel: string;
  subjectHref: string | null;
  /** Only for question/answer analyses (private to the requester). */
  question: string | null;
  status: AnalysisStatus;
  trigger: AnalysisTrigger;
  mode: AiMode;
  provider: string;
  model: string;
  reviewStatus: AnalysisReviewStatus;
  isStale: boolean;
  staleReason: string | null;
  errorMessage: string | null;
  summaryPreview: string | null;
  findingCount: number;
  requestedByName: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type AnalysisSourceItem = {
  ref: string;
  sourceType: string;
  entityId: string;
  versionId: string | null;
  versionNumber: number | null;
  label: string;
  href: string | null;
  charCount: number;
  truncated: boolean;
};

export type AnalysisDetail = AnalysisListItem & {
  promptVersion: string;
  result: AnalysisResult | null;
  inputTruncated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  attempts: number;
  maxAttempts: number;
  startedAt: Date | null;
  staleSince: Date | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  sources: AnalysisSourceItem[];
  /** Indexes of result.suggestedTasks / suggestedDeadlines already turned into records. */
  appliedTaskIndexes: number[];
  appliedDeadlineIndexes: number[];
  canReview: boolean;
  canApplyTasks: boolean;
  canApplyDeadlines: boolean;
  canApply: boolean;
};

export type AiUsageSummary = {
  period: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  monthlyTokenBudget: number;
};

// ---------------------------------------------------------------------------
// Constants (pt-BR texts stored with analyses)
// ---------------------------------------------------------------------------

export const SOURCES_CHANGED_MESSAGE = "As fontes foram alteradas após a solicitação. Solicite uma nova análise.";
export const PROMPT_INJECTION_NOTICE = "O conteúdo analisado continha instruções direcionadas à IA; elas foram ignoradas.";
export const TRUNCATION_NOTICE =
  "O conteúdo das fontes excedeu o limite de tamanho configurado e foi truncado: partes dos textos não foram analisadas.";
const NO_SOURCES_NOTICE = "Nenhuma fonte acessível com conteúdo foi encontrada; o provedor de IA não foi acionado.";
const PROVIDER_CHANGED_MESSAGE =
  "A configuração do provedor de IA mudou após a solicitação. Solicite uma nova análise.";
const SUBJECT_GONE_MESSAGE = "O registro analisado não está mais disponível. A análise foi cancelada.";
const UNEXPECTED_RUN_ERROR = "Falha inesperada ao processar a análise.";
const MAX_ITEMS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Verifique os campos informados.", z.flattenError(parsed.error).fieldErrors as Record<string, string[]>);
  }
  return parsed.data;
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function normalizeQuestion(q: string | null): string | null {
  return q ? q.trim().replace(/\s+/g, " ").toLowerCase() : null;
}

/** sha256 of the canonical description of an analysis input (dedupe key). */
export function computeInputHash(input: {
  type: AnalysisType;
  subjectType: AnalysisSubjectType;
  subjectId: string | null;
  question: string | null;
  provider: string;
  model: string;
  /** Question/answer analyses are private to the requester, so the requester is part of their identity. */
  requesterId: string | null;
  sources: { ref: string; sourceType: string; entityId: string; versionId: string | null; contentHash: string }[];
}): string {
  const sources = [...input.sources]
    .sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)))
    .map((s) => ({ ref: s.ref, sourceType: s.sourceType, entityId: s.entityId, versionId: s.versionId, contentHash: s.contentHash }));
  const canonical = {
    type: input.type,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    question: normalizeQuestion(input.question),
    promptVersion: PROMPT_VERSION,
    provider: input.provider,
    model: input.model,
    requester: input.type === "question_answer" ? input.requesterId : null,
    sources,
  };
  return sha256(JSON.stringify(canonical));
}

function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Drops citations to refs that were not sent and items left without a valid
 * citation; drops suggested deadlines without a valid ISO date. Returns how
 * many items were removed.
 */
export function sanitizeAnalysisOutput(
  output: AnalysisOutput,
  validRefs: ReadonlySet<string>,
): { output: AnalysisOutput; dropped: number; droppedDates: number } {
  let dropped = 0;
  let droppedDates = 0;
  const refsOf = (refs: string[]) => Array.from(new Set(refs.map((r) => r.trim()).filter((r) => validRefs.has(r))));

  const findings = output.findings.flatMap((f) => {
    const sourceRefs = refsOf(f.sourceRefs);
    if (!sourceRefs.length) {
      dropped++;
      return [];
    }
    return [{ ...f, sourceRefs }];
  });
  const suggestedDeadlines = output.suggestedDeadlines.flatMap((d) => {
    const ref = d.sourceRef.trim();
    if (!validRefs.has(ref)) {
      dropped++;
      return [];
    }
    if (!isValidIsoDate(d.date.trim())) {
      droppedDates++;
      return [];
    }
    return [{ ...d, sourceRef: ref, date: d.date.trim() }];
  });
  const suggestedTasks = output.suggestedTasks.flatMap((t) => {
    const sourceRefs = refsOf(t.sourceRefs);
    if (!sourceRefs.length) {
      dropped++;
      return [];
    }
    return [{ ...t, sourceRefs }];
  });
  return {
    output: {
      ...output,
      findings: findings.slice(0, MAX_ITEMS),
      suggestedDeadlines: suggestedDeadlines.slice(0, MAX_ITEMS),
      suggestedTasks: suggestedTasks.slice(0, MAX_ITEMS),
      limitations: output.limitations.slice(0, MAX_ITEMS),
      validationPoints: output.validationPoints.slice(0, MAX_ITEMS),
    },
    dropped,
    droppedDates,
  };
}

/** Token estimate used for budget control (chars / 3.5 + max output). */
function estimateTokens(totalChars: number): number {
  return Math.ceil(totalChars / 3.5) + env().AI_MAX_OUTPUT_TOKENS;
}

async function assertWithinBudget(
  organizationId: string,
  monthlyTokenBudget: number,
  estimate: number,
  db: DbOrTx = getDb(),
): Promise<void> {
  if (monthlyTokenBudget <= 0) {
    throw new BudgetExceededError("O uso de IA está desativado para esta organização (orçamento mensal igual a zero).");
  }
  const [u] = await db
    .select({ inputTokens: aiUsage.inputTokens, outputTokens: aiUsage.outputTokens })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, organizationId), eq(aiUsage.period, currentUsagePeriod())));
  const used = Number(u?.inputTokens ?? 0) + Number(u?.outputTokens ?? 0);
  if (used + estimate > monthlyTokenBudget) throw new BudgetExceededError();
}

function subjectEntity(a: { id: string; subjectType: AnalysisSubjectType; subjectId: string | null }): {
  entityType: EntityType;
  entityId: string;
} {
  if (a.subjectType === "organization" || !a.subjectId) return { entityType: "analysis", entityId: a.id };
  return { entityType: a.subjectType, entityId: a.subjectId };
}

function subjectHref(subjectType: AnalysisSubjectType, subjectId: string | null): string | null {
  if (subjectType === "organization" || !subjectId) return null;
  return entityHref({ type: subjectType, id: subjectId });
}

function sourceHref(sourceType: string, entityId: string): string | null {
  const type: EntityRef["type"] | null =
    sourceType === "document_version"
      ? "document"
      : sourceType === "legal_process" || sourceType === "occurrence" || sourceType === "contract"
        ? sourceType
        : null;
  return type ? entityHref({ type, id: entityId }) : null;
}

// ---------------------------------------------------------------------------
// Runtime info
// ---------------------------------------------------------------------------

export function getAiRuntimeInfo(): { mode: AiMode; provider: string; model: string } {
  return runtimeInfo();
}

// ---------------------------------------------------------------------------
// requestAnalysis
// ---------------------------------------------------------------------------

export async function requestAnalysis(
  ctx: AuthContext,
  input: RequestAnalysisInput,
): Promise<{ analysisId: string; reused: boolean }> {
  assertCan(ctx, "analysis:request");
  const v = parseOrThrow(requestAnalysisSchema, input);
  const db = getDb();
  const org = await loadOrganization(ctx.organizationId);
  const subjectId = v.subjectType === "organization" ? null : (v.subjectId ?? null);
  const subject = await resolveSubject(ctx, v.subjectType, subjectId);

  let provider;
  try {
    provider = getAiProvider();
  } catch (err) {
    if (err instanceof AiProviderError) throw new AppError(err.userMessage, "bad_request");
    throw err;
  }

  const bundle = await buildAnalysisSources(
    ctx,
    { type: v.type, subjectType: v.subjectType, subjectId, question: v.question },
    subject,
    org.settings.ai.maxInputChars,
  );
  const inputHash = computeInputHash({
    type: v.type,
    subjectType: v.subjectType,
    subjectId,
    question: v.question,
    provider: provider.name,
    model: provider.model,
    requesterId: ctx.userId,
    sources: bundle.sources,
  });

  // Dedupe: identical request in flight, or an up-to-date result already available.
  const existing = await findReusable(ctx.organizationId, inputHash, !v.force);
  if (existing) return { analysisId: existing, reused: true };

  if (provider.mode === "live" && bundle.sources.length) {
    const totalChars = bundle.sources.reduce((n, s) => n + s.charCount, 0);
    await assertWithinBudget(ctx.organizationId, org.settings.ai.monthlyTokenBudget, estimateTokens(totalChars));
  }

  const base = {
    organizationId: ctx.organizationId,
    type: v.type,
    subjectType: v.subjectType,
    subjectId,
    question: v.type === "question_answer" ? v.question : null,
    trigger: v.trigger,
    mode: provider.mode,
    provider: provider.name,
    model: provider.model,
    promptVersion: PROMPT_VERSION,
    inputHash,
    inputTruncated: bundle.inputTruncated,
    requestedById: ctx.userId,
  };

  try {
    return await db.transaction(async (tx) => {
      const noSources = bundle.sources.length === 0;
      const [row] = await tx
        .insert(aiAnalyses)
        .values(
          noSources
            ? {
                ...base,
                status: "succeeded" as const,
                result: noSourcesResult(v.type, provider.mode, bundle.notes),
                inputTokens: 0,
                outputTokens: 0,
                costMicroUsd: 0,
                completedAt: new Date(),
              }
            : { ...base, status: "queued" as const },
        )
        .returning({ id: aiAnalyses.id });

      if (!noSources) {
        await tx.insert(aiAnalysisSources).values(
          bundle.sources.map((s: PreparedSource) => ({
            organizationId: ctx.organizationId,
            analysisId: row.id,
            ref: s.ref,
            sourceType: s.sourceType,
            entityId: s.entityId,
            versionId: s.versionId,
            versionNumber: s.versionNumber,
            label: s.label,
            contentHash: s.contentHash,
            charCount: s.charCount,
            truncated: s.truncated,
          })),
        );
        await enqueueJob(
          {
            type: "analysis.run",
            organizationId: ctx.organizationId,
            // `notes` are pt-BR limitation texts (document titles only, never content).
            payload: { analysisId: row.id, notes: bundle.notes.slice(0, 30) },
            dedupeKey: `analysis:${row.id}`,
            maxAttempts: 3,
          },
          tx,
        );
      }

      await recordAudit(
        ctx,
        {
          action: "analysis.request",
          entityType: "analysis",
          entityId: row.id,
          summary: `Análise de IA solicitada: ${ANALYSIS_TYPE_LABELS[v.type]} — ${subject.label}`.slice(0, 300),
          metadata: {
            type: v.type,
            subjectType: v.subjectType,
            subjectId,
            sourceCount: bundle.sources.length,
            trigger: v.trigger,
            mode: provider.mode,
            forced: v.force,
          },
        },
        tx,
      );
      return { analysisId: row.id, reused: false };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const inflight = await findReusable(ctx.organizationId, inputHash, false);
      if (inflight) return { analysisId: inflight, reused: true };
    }
    throw err;
  }
}

async function findReusable(organizationId: string, inputHash: string, includeSucceeded: boolean): Promise<string | null> {
  const db = getDb();
  const [inflight] = await db
    .select({ id: aiAnalyses.id })
    .from(aiAnalyses)
    .where(
      and(
        eq(aiAnalyses.organizationId, organizationId),
        eq(aiAnalyses.inputHash, inputHash),
        inArray(aiAnalyses.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (inflight) return inflight.id;
  if (!includeSucceeded) return null;
  const [done] = await db
    .select({ id: aiAnalyses.id })
    .from(aiAnalyses)
    .where(
      and(
        eq(aiAnalyses.organizationId, organizationId),
        eq(aiAnalyses.inputHash, inputHash),
        eq(aiAnalyses.status, "succeeded"),
        eq(aiAnalyses.isStale, false),
        ne(aiAnalyses.reviewStatus, "dismissed"),
      ),
    )
    .orderBy(desc(aiAnalyses.createdAt))
    .limit(1);
  return done?.id ?? null;
}

function noSourcesResult(type: AnalysisType, mode: AiMode, notes: string[]): AnalysisResult {
  const systemNotices = mode === "demo" ? [DEMO_MODE_NOTICE, NO_SOURCES_NOTICE] : [NO_SOURCES_NOTICE];
  return {
    summary: "Nenhuma fonte acessível com conteúdo foi encontrada para esta análise.",
    answer: type === "question_answer" ? "Não foram encontradas informações sobre isso nas fontes acessíveis." : null,
    findings: [],
    suggestedDeadlines: [],
    suggestedTasks: [],
    limitations: [...notes, "A análise não foi enviada ao provedor de IA porque não havia fontes com texto disponíveis."],
    validationPoints: ["Verifique se os documentos relevantes foram enviados e se o texto deles pôde ser extraído."],
    promptInjectionSuspected: false,
    systemNotices,
  };
}

// ---------------------------------------------------------------------------
// runAnalysisJob (background)
// ---------------------------------------------------------------------------

export type RunAnalysisOptions = { attempt: number; maxAttempts: number; notes?: string[] };

/**
 * Executes a queued analysis. Idempotent: does nothing unless the analysis is
 * queued (or left running by a previous, interrupted attempt). Throws provider
 * errors after recording them so the queue can retry with backoff.
 */
export async function runAnalysisJob(
  analysisId: string,
  opts: RunAnalysisOptions = { attempt: 1, maxAttempts: 1 },
): Promise<{ status: AnalysisStatus | "skipped" }> {
  if (!z.uuid().safeParse(analysisId).success) return { status: "skipped" };
  const db = getDb();
  const [a] = await db.select().from(aiAnalyses).where(eq(aiAnalyses.id, analysisId));
  if (!a) return { status: "skipped" };
  const resumable = a.status === "running" && a.attempts < opts.attempt;
  if (a.status !== "queued" && !resumable) return { status: "skipped" };

  const claimed = await db
    .update(aiAnalyses)
    .set({ status: "running", startedAt: new Date(), attempts: Math.max(opts.attempt, a.attempts + 1) })
    .where(and(eq(aiAnalyses.id, a.id), eq(aiAnalyses.status, a.status), eq(aiAnalyses.attempts, a.attempts)))
    .returning({ id: aiAnalyses.id });
  if (!claimed.length) return { status: "skipped" };

  const org = await loadOrganization(a.organizationId);
  const sys = systemContext(a.organizationId, org.isDemo);

  try {
    // Subject still exists?
    let subjectLabel = ORGANIZATION_SUBJECT_LABEL;
    try {
      subjectLabel = (await resolveSubject(sys, a.subjectType, a.subjectId)).label;
    } catch (err) {
      if (err instanceof NotFoundError) return await cancelAnalysis(a.id, SUBJECT_GONE_MESSAGE);
      throw err;
    }

    // Rebuild the exact source texts and verify they did not change.
    const stored: StoredSource[] = await db
      .select({
        ref: aiAnalysisSources.ref,
        sourceType: aiAnalysisSources.sourceType,
        entityId: aiAnalysisSources.entityId,
        versionId: aiAnalysisSources.versionId,
        versionNumber: aiAnalysisSources.versionNumber,
        label: aiAnalysisSources.label,
        contentHash: aiAnalysisSources.contentHash,
        charCount: aiAnalysisSources.charCount,
        truncated: aiAnalysisSources.truncated,
      })
      .from(aiAnalysisSources)
      .where(and(eq(aiAnalysisSources.analysisId, a.id), eq(aiAnalysisSources.organizationId, a.organizationId)));
    const sources = await rebuildSourceTexts(a.organizationId, a, stored);
    if (!sources) return await cancelAnalysis(a.id, SOURCES_CHANGED_MESSAGE);

    const provider = getAiProvider();
    if (provider.name !== a.provider || provider.model !== a.model) {
      return await cancelAnalysis(a.id, PROVIDER_CHANGED_MESSAGE);
    }

    if (provider.mode === "live") {
      const totalChars = stored.reduce((n, s) => n + s.charCount, 0);
      try {
        await assertWithinBudget(a.organizationId, org.settings.ai.monthlyTokenBudget, estimateTokens(totalChars));
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          await markFailed(a, sys, err.message);
          return { status: "failed" };
        }
        throw err;
      }
    }

    const response = await provider.analyze({ type: a.type, subjectLabel, question: a.question, sources });
    const validated = analysisOutputSchema.safeParse(response.output);
    if (!validated.success) {
      throw new AiProviderError("invalid_output_schema", {
        retryable: true,
        userMessage: "O provedor de IA retornou um resultado em formato inválido. A análise será tentada novamente.",
      });
    }

    const refs = new Set(sources.map((s) => s.ref));
    const { output, dropped, droppedDates } = sanitizeAnalysisOutput(validated.data, refs);
    const limitations = [...(opts.notes ?? []).filter((n) => typeof n === "string").slice(0, 30), ...output.limitations];
    if (dropped) {
      limitations.push(`${dropped} item(ns) sem referência válida às fontes foram descartados pelo sistema.`);
    }
    if (droppedDates) {
      limitations.push(`${droppedDates} sugestão(ões) de prazo sem data válida foram descartadas pelo sistema.`);
    }
    const systemNotices: string[] = [];
    if (provider.mode === "demo") systemNotices.push(DEMO_MODE_NOTICE);
    if (a.inputTruncated || stored.some((s) => s.truncated)) systemNotices.push(TRUNCATION_NOTICE);
    if (output.promptInjectionSuspected) systemNotices.push(PROMPT_INJECTION_NOTICE);
    const result: AnalysisResult = { ...output, limitations, systemNotices };

    const usage = provider.mode === "live" ? response.usage : { inputTokens: 0, outputTokens: 0 };
    const cost = provider.mode === "live" ? costMicroUsd(provider.model, usage) : 0;

    const highRisks = output.findings.filter(
      (f) => f.kind === "risk_signal" && (f.severity === "high" || f.severity === "critical"),
    );

    await db.transaction(async (tx) => {
      await tx
        .update(aiAnalyses)
        .set({
          status: "succeeded",
          result,
          errorMessage: null,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicroUsd: cost,
          completedAt: new Date(),
        })
        .where(eq(aiAnalyses.id, a.id));

      if (provider.mode === "live") {
        await tx
          .insert(aiUsage)
          .values({
            organizationId: a.organizationId,
            period: currentUsagePeriod(),
            requests: 1,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costMicroUsd: cost,
          })
          .onConflictDoUpdate({
            target: [aiUsage.organizationId, aiUsage.period],
            set: {
              requests: sql`${aiUsage.requests} + 1`,
              inputTokens: sql`${aiUsage.inputTokens} + ${usage.inputTokens}`,
              outputTokens: sql`${aiUsage.outputTokens} + ${usage.outputTokens}`,
              costMicroUsd: sql`${aiUsage.costMicroUsd} + ${cost}`,
              updatedAt: new Date(),
            },
          });
      }

      if (highRisks.length) {
        const severity: AlertSeverity = highRisks.some((f) => f.severity === "critical") ? "critical" : "warning";
        const demo = provider.mode === "demo";
        await upsertAlert(
          {
            organizationId: a.organizationId,
            type: "risk_signal",
            severity,
            title: `${demo ? "[Demonstrativo] " : ""}Sinais de risco relevantes identificados`,
            message:
              `A análise "${ANALYSIS_TYPE_LABELS[a.type]}" (${AI_MODE_LABELS[provider.mode]}) apontou ${highRisks.length} ` +
              `sinal(is) de risco de severidade alta ou crítica. Revise a análise e confirme nas fontes indicadas.`,
            ...subjectEntity(a),
            dedupeKey: `risk:${a.id}`,
          },
          tx,
        );
      }

      await recordAudit(
        sys,
        {
          action: "analysis.completed",
          entityType: "analysis",
          entityId: a.id,
          summary: `Análise de IA concluída: ${ANALYSIS_TYPE_LABELS[a.type]}`,
          metadata: {
            mode: provider.mode,
            sourceCount: sources.length,
            findingCount: output.findings.length,
            suggestedTaskCount: output.suggestedTasks.length,
            suggestedDeadlineCount: output.suggestedDeadlines.length,
            droppedItems: dropped + droppedDates,
            promptInjectionSuspected: output.promptInjectionSuspected,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
        },
        tx,
      );
    });
    return { status: "succeeded" };
  } catch (err) {
    const retryable = err instanceof AiProviderError ? err.retryable : !(err instanceof AppError);
    const message = err instanceof AiProviderError ? err.userMessage : err instanceof AppError ? err.message : UNEXPECTED_RUN_ERROR;
    logger.warn("analysis_run_failed", {
      analysisId: a.id,
      attempt: opts.attempt,
      retryable,
      errorName: err instanceof Error ? err.name : typeof err,
      errorCode: err instanceof AiProviderError ? err.message : undefined,
    });
    if (retryable && opts.attempt < opts.maxAttempts) {
      await db
        .update(aiAnalyses)
        .set({ status: "queued", errorMessage: message })
        .where(and(eq(aiAnalyses.id, a.id), eq(aiAnalyses.status, "running")));
    } else {
      await markFailed(a, sys, message);
    }
    throw err;
  }
}

async function cancelAnalysis(id: string, message: string): Promise<{ status: AnalysisStatus }> {
  await getDb()
    .update(aiAnalyses)
    .set({ status: "cancelled", errorMessage: message, completedAt: new Date() })
    .where(eq(aiAnalyses.id, id));
  return { status: "cancelled" };
}

async function markFailed(
  a: { id: string; organizationId: string; type: AnalysisType; subjectType: AnalysisSubjectType; subjectId: string | null },
  sys: AuthContext,
  message: string,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .update(aiAnalyses)
      .set({ status: "failed", errorMessage: message.slice(0, 500), completedAt: new Date() })
      .where(eq(aiAnalyses.id, a.id));
    await upsertAlert(
      {
        organizationId: a.organizationId,
        type: "analysis_failed",
        severity: "warning",
        title: "Falha em análise de IA",
        message: `A análise "${ANALYSIS_TYPE_LABELS[a.type]}" não pôde ser concluída: ${message}`.slice(0, 2000),
        ...subjectEntity(a),
        dedupeKey: `analysis_failed:${a.id}`,
      },
      tx,
    );
    await recordAudit(
      sys,
      {
        action: "analysis.failed",
        entityType: "analysis",
        entityId: a.id,
        summary: `Análise de IA falhou: ${ANALYSIS_TYPE_LABELS[a.type]}`,
        metadata: { type: a.type },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type AnalysisRow = typeof aiAnalyses.$inferSelect;

async function userNames(organizationId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (!unique.length) return new Map();
  const rows = await getDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), inArray(users.id, unique)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Labels of analysis subjects, looked up with the viewer's visibility scope. */
async function subjectLabels(ctx: AuthContext, rows: Pick<AnalysisRow, "subjectType" | "subjectId">[]): Promise<Map<string, string>> {
  const db = getDb();
  const idsOf = (t: AnalysisSubjectType) =>
    Array.from(new Set(rows.filter((r) => r.subjectType === t && r.subjectId).map((r) => r.subjectId!)));
  const out = new Map<string, string>();
  const p = idsOf("legal_process");
  if (p.length) {
    for (const r of await db
      .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
      .from(legalProcesses)
      .where(and(inArray(legalProcesses.id, p), processWhere(ctx))))
      out.set(r.id, processLabel(r));
  }
  const o = idsOf("occurrence");
  if (o.length) {
    for (const r of await db
      .select({ id: occurrences.id, title: occurrences.title })
      .from(occurrences)
      .where(and(inArray(occurrences.id, o), occurrenceWhere(ctx))))
      out.set(r.id, occurrenceLabel(r));
  }
  const c = idsOf("contract");
  if (c.length) {
    for (const r of await db
      .select({ id: contracts.id, title: contracts.title, counterparty: contracts.counterparty })
      .from(contracts)
      .where(and(inArray(contracts.id, c), contractWhere(ctx))))
      out.set(r.id, contractLabel(r));
  }
  const d = idsOf("document");
  if (d.length) {
    for (const r of await db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(and(inArray(documents.id, d), documentWhere(ctx))))
      out.set(r.id, documentLabel(r));
  }
  return out;
}

function toListItem(r: AnalysisRow, labels: Map<string, string>, names: Map<string, string>): AnalysisListItem {
  const summary = r.result?.summary ?? null;
  return {
    id: r.id,
    type: r.type,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    subjectLabel:
      r.subjectType === "organization" || !r.subjectId
        ? ORGANIZATION_SUBJECT_LABEL
        : (labels.get(r.subjectId) ?? "Registro indisponível"),
    subjectHref: subjectHref(r.subjectType, r.subjectId),
    question: r.type === "question_answer" ? r.question : null,
    status: r.status,
    trigger: r.trigger,
    mode: r.mode,
    provider: r.provider,
    model: r.model,
    reviewStatus: r.reviewStatus,
    isStale: r.isStale,
    staleReason: r.staleReason,
    errorMessage: r.errorMessage,
    summaryPreview: summary ? (summary.length > 240 ? `${summary.slice(0, 239)}…` : summary) : null,
    findingCount: r.result?.findings.length ?? 0,
    requestedByName: r.requestedById ? (names.get(r.requestedById) ?? null) : null,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}

export async function listAnalyses(
  ctx: AuthContext,
  filters: {
    subjectType?: AnalysisSubjectType;
    subjectId?: string;
    status?: AnalysisStatus;
    type?: AnalysisType;
    staleOnly?: boolean;
  } & Page = {},
): Promise<Paginated<AnalysisListItem>> {
  assertCan(ctx, "analysis:read");
  const f = parseOrThrow(listAnalysesSchema, filters);
  const { page, pageSize, offset } = normalizePage({ page: f.page, pageSize: f.pageSize });
  const db = getDb();
  const conds: (SQL | undefined)[] = [
    analysisWhere(ctx),
    f.subjectType ? eq(aiAnalyses.subjectType, f.subjectType) : undefined,
    f.subjectId ? eq(aiAnalyses.subjectId, f.subjectId) : undefined,
    f.status ? eq(aiAnalyses.status, f.status) : undefined,
    f.type ? eq(aiAnalyses.type, f.type) : undefined,
    f.staleOnly ? eq(aiAnalyses.isStale, true) : undefined,
  ];
  const where = and(...conds);
  const [{ total }] = await db.select({ total: count() }).from(aiAnalyses).where(where);
  const rows = await db
    .select()
    .from(aiAnalyses)
    .where(where)
    .orderBy(desc(aiAnalyses.createdAt), desc(aiAnalyses.id))
    .limit(pageSize)
    .offset(offset);
  const [labels, names] = await Promise.all([
    subjectLabels(ctx, rows),
    userNames(ctx.organizationId, rows.map((r) => r.requestedById)),
  ]);
  return { items: rows.map((r) => toListItem(r, labels, names)), total: Number(total), page, pageSize };
}

async function loadVisibleAnalysis(ctx: AuthContext, id: string, db: DbOrTx = getDb()): Promise<AnalysisRow> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError();
  const [row] = await db
    .select()
    .from(aiAnalyses)
    .where(and(eq(aiAnalyses.id, id), analysisWhere(ctx)));
  if (!row) throw new NotFoundError("Análise não encontrada ou sem permissão de acesso.");
  return row;
}

export async function getAnalysis(ctx: AuthContext, id: string): Promise<AnalysisDetail> {
  assertCan(ctx, "analysis:read");
  const db = getDb();
  const row = await loadVisibleAnalysis(ctx, id);
  const sourceRows = await db
    .select()
    .from(aiAnalysisSources)
    .where(and(eq(aiAnalysisSources.analysisId, row.id), eq(aiAnalysisSources.organizationId, ctx.organizationId)));
  sourceRows.sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));

  const [labels, names, appliedTasks, appliedDeadlines] = await Promise.all([
    subjectLabels(ctx, [row]),
    userNames(ctx.organizationId, [row.requestedById, row.reviewedById]),
    db
      .select({ title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.sourceAnalysisId, row.id), isNull(tasks.deletedAt))),
    db
      .select({ title: deadlines.title })
      .from(deadlines)
      .where(
        and(eq(deadlines.organizationId, ctx.organizationId), eq(deadlines.sourceAnalysisId, row.id), isNull(deadlines.deletedAt)),
      ),
  ]);
  const taskTitles = new Set(appliedTasks.map((t) => t.title));
  const deadlineTitles = new Set(appliedDeadlines.map((d) => d.title));
  const result = row.result ?? null;
  const appliedTaskIndexes = (result?.suggestedTasks ?? []).flatMap((t, i) => (taskTitles.has(suggestedTaskTitle(t.title)) ? [i] : []));
  const appliedDeadlineIndexes = (result?.suggestedDeadlines ?? []).flatMap((d, i) =>
    deadlineTitles.has(suggestedDeadlineTitle(d.title)) ? [i] : [],
  );

  const succeeded = row.status === "succeeded";
  const usable = succeeded && row.reviewStatus !== "dismissed";
  const canApplyTasks = usable && can(ctx, "task:write") && (result?.suggestedTasks.length ?? 0) > 0;
  const canApplyDeadlines = usable && can(ctx, "deadline:write") && (result?.suggestedDeadlines.length ?? 0) > 0;

  return {
    ...toListItem(row, labels, names),
    promptVersion: row.promptVersion,
    result,
    inputTruncated: row.inputTruncated,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicroUsd: row.costMicroUsd,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    startedAt: row.startedAt,
    staleSince: row.staleSince,
    reviewedByName: row.reviewedById ? (names.get(row.reviewedById) ?? null) : null,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    sources: sourceRows.map((s) => ({
      ref: s.ref,
      sourceType: s.sourceType,
      entityId: s.entityId,
      versionId: s.versionId,
      versionNumber: s.versionNumber,
      label: s.label,
      href: sourceHref(s.sourceType, s.entityId),
      charCount: s.charCount,
      truncated: s.truncated,
    })),
    appliedTaskIndexes,
    appliedDeadlineIndexes,
    canReview: succeeded && can(ctx, "analysis:review"),
    canApplyTasks,
    canApplyDeadlines,
    canApply: canApplyTasks || canApplyDeadlines,
  };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export async function reviewAnalysis(
  ctx: AuthContext,
  id: string,
  input: { decision: "reviewed" | "dismissed"; note?: string | null },
): Promise<void> {
  assertCan(ctx, "analysis:review");
  const v = parseOrThrow(reviewAnalysisSchema, input);
  await getDb().transaction(async (tx) => {
    const row = await loadVisibleAnalysis(ctx, id, tx);
    if (row.status !== "succeeded") throw new ConflictError("Somente análises concluídas podem ser revisadas.");
    const after = { reviewStatus: v.decision, reviewNote: v.note, reviewedById: ctx.userId, reviewedAt: new Date() };
    await tx
      .update(aiAnalyses)
      .set(after)
      .where(and(eq(aiAnalyses.id, row.id), eq(aiAnalyses.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "analysis.review",
        entityType: "analysis",
        entityId: row.id,
        summary: v.decision === "reviewed" ? "Análise de IA marcada como revisada" : "Análise de IA descartada na revisão",
        changes: diffChanges(
          { reviewStatus: row.reviewStatus, reviewNote: row.reviewNote },
          { reviewStatus: after.reviewStatus, reviewNote: after.reviewNote },
        ),
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Applying suggestions (explicit user action)
// ---------------------------------------------------------------------------

function suggestedTaskTitle(title: string): string {
  return title.trim().slice(0, 300);
}
function suggestedDeadlineTitle(title: string): string {
  return title.trim().slice(0, 300);
}

/** Parent records (visible to ctx) a task/deadline created from this analysis is linked to. */
async function suggestionLinks(
  ctx: AuthContext,
  a: AnalysisRow,
): Promise<{ processId: string | null; occurrenceId: string | null; contractId: string | null }> {
  const db = getDb();
  let processId: string | null = null;
  let occurrenceId: string | null = null;
  let contractId: string | null = null;
  if (a.subjectType === "legal_process") processId = a.subjectId;
  else if (a.subjectType === "occurrence") occurrenceId = a.subjectId;
  else if (a.subjectType === "contract") contractId = a.subjectId;
  else if (a.subjectType === "document" && a.subjectId) {
    const [d] = await db
      .select({ processId: documents.processId, occurrenceId: documents.occurrenceId, contractId: documents.contractId })
      .from(documents)
      .where(and(eq(documents.id, a.subjectId), documentWhere(ctx)));
    if (d) ({ processId, occurrenceId, contractId } = d);
  }
  // Keep only links the user can see (never link to records outside the scope).
  if (processId) {
    const [p] = await db.select({ id: legalProcesses.id }).from(legalProcesses).where(and(eq(legalProcesses.id, processId), processWhere(ctx)));
    if (!p) processId = null;
  }
  if (occurrenceId) {
    const [o] = await db.select({ id: occurrences.id }).from(occurrences).where(and(eq(occurrences.id, occurrenceId), occurrenceWhere(ctx)));
    if (!o) occurrenceId = null;
  }
  if (contractId) {
    const [c] = await db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, contractId), contractWhere(ctx)));
    if (!c) contractId = null;
  }
  return { processId, occurrenceId, contractId };
}

async function loadApplicableAnalysis(ctx: AuthContext, analysisId: string): Promise<AnalysisRow & { result: AnalysisResult }> {
  const row = await loadVisibleAnalysis(ctx, analysisId);
  if (row.status !== "succeeded" || !row.result) {
    throw new ConflictError("Somente sugestões de análises concluídas podem ser aplicadas.");
  }
  if (row.reviewStatus === "dismissed") throw new ConflictError("Esta análise foi descartada na revisão.");
  return row as AnalysisRow & { result: AnalysisResult };
}

type WorkService = typeof import("@/modules/work/service");
type CreateTaskInput = Parameters<WorkService["createTask"]>[1];
type CreateSuggestedDeadlineInput = Parameters<WorkService["createSuggestedDeadline"]>[1];

export async function applySuggestedTask(ctx: AuthContext, analysisId: string, index: number): Promise<{ taskId: string }> {
  assertCan(ctx, "task:write");
  const v = parseOrThrow(suggestionIndexSchema, { analysisId, index });
  const row = await loadApplicableAnalysis(ctx, v.analysisId);
  const suggestion = row.result.suggestedTasks[v.index];
  if (!suggestion) throw new NotFoundError("Sugestão não encontrada.");
  const title = suggestedTaskTitle(suggestion.title);

  const [dup] = await getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, ctx.organizationId),
        eq(tasks.sourceAnalysisId, row.id),
        eq(tasks.title, title),
        isNull(tasks.deletedAt),
      ),
    )
    .limit(1);
  if (dup) throw new ConflictError("Esta sugestão já foi aplicada.");

  const links = await suggestionLinks(ctx, row);
  const priority: Priority = suggestion.priority;
  const description =
    `${suggestion.description.trim()}\n\n` +
    `Sugestão da análise "${ANALYSIS_TYPE_LABELS[row.type]}" (${AI_MODE_LABELS[row.mode]}); fontes: ${suggestion.sourceRefs.join(", ")}.`;
  const { createTask } = await import("@/modules/work/service");
  const input = {
    title,
    description: description.slice(0, 5000),
    priority,
    kind: row.subjectType === "occurrence" ? "action_plan" : "follow_up",
    ...links,
    origin: "ai_suggested" as const,
    sourceAnalysisId: row.id,
  };
  const { id: taskId } = await createTask(ctx, input as unknown as CreateTaskInput);

  await recordAudit(ctx, {
    action: "analysis.apply_task",
    entityType: "analysis",
    entityId: row.id,
    summary: "Sugestão de tarefa da análise de IA aplicada",
    metadata: { taskId, index: v.index },
  });
  return { taskId };
}

export async function applySuggestedDeadline(
  ctx: AuthContext,
  analysisId: string,
  index: number,
): Promise<{ deadlineId: string }> {
  assertCan(ctx, "deadline:write");
  const v = parseOrThrow(suggestionIndexSchema, { analysisId, index });
  const row = await loadApplicableAnalysis(ctx, v.analysisId);
  const suggestion = row.result.suggestedDeadlines[v.index];
  if (!suggestion) throw new NotFoundError("Sugestão não encontrada.");
  if (!isValidIsoDate(suggestion.date)) throw new ValidationError("A data sugerida é inválida.");
  const title = suggestedDeadlineTitle(suggestion.title);

  const [dup] = await getDb()
    .select({ id: deadlines.id })
    .from(deadlines)
    .where(
      and(
        eq(deadlines.organizationId, ctx.organizationId),
        eq(deadlines.sourceAnalysisId, row.id),
        eq(deadlines.title, title),
        isNull(deadlines.deletedAt),
      ),
    )
    .limit(1);
  if (dup) throw new ConflictError("Esta sugestão já foi aplicada.");

  const links = await suggestionLinks(ctx, row);
  const kind: DeadlineKind = links.processId ? "procedural" : links.contractId ? "contractual" : "internal";
  const { createSuggestedDeadline } = await import("@/modules/work/service");
  const input: CreateSuggestedDeadlineInput = {
    title,
    dueDate: suggestion.date,
    kind,
    description:
      `${suggestion.rationale.trim()}\n\n` +
      `Sugestão da análise "${ANALYSIS_TYPE_LABELS[row.type]}" (${AI_MODE_LABELS[row.mode]}); fonte: ${suggestion.sourceRef}. ` +
      "Data copiada do texto da fonte: confirme o prazo antes de validar.",
    sourceAnalysisId: row.id,
    sourceExcerpt: suggestion.excerpt.slice(0, 2000),
    ...links,
  };
  const { id: deadlineId } = await createSuggestedDeadline(ctx, input);

  await recordAudit(ctx, {
    action: "analysis.apply_deadline",
    entityType: "analysis",
    entityId: row.id,
    summary: "Sugestão de prazo da análise de IA registrada para validação humana",
    metadata: { deadlineId, index: v.index },
  });
  return { deadlineId };
}

// ---------------------------------------------------------------------------
// Staleness (system)
// ---------------------------------------------------------------------------

/**
 * Flags succeeded, non-stale analyses that used `entityId` as a source.
 * `exceptVersionId`: analyses that already include this document version are
 * left untouched (they are up to date with it).
 */
async function markStale(
  input: { organizationId: string; entityId: string; reason: string; exceptVersionId?: string | null },
  db: DbOrTx,
): Promise<number> {
  const usesEntity = db
    .select({ id: aiAnalysisSources.analysisId })
    .from(aiAnalysisSources)
    .where(and(eq(aiAnalysisSources.organizationId, input.organizationId), eq(aiAnalysisSources.entityId, input.entityId)));
  const hasVersion = input.exceptVersionId
    ? db
        .select({ id: aiAnalysisSources.analysisId })
        .from(aiAnalysisSources)
        .where(
          and(eq(aiAnalysisSources.organizationId, input.organizationId), eq(aiAnalysisSources.versionId, input.exceptVersionId)),
        )
    : null;
  const updated = await db
    .update(aiAnalyses)
    .set({ isStale: true, staleReason: input.reason.slice(0, 500), staleSince: new Date() })
    .where(
      and(
        eq(aiAnalyses.organizationId, input.organizationId),
        eq(aiAnalyses.status, "succeeded"),
        eq(aiAnalyses.isStale, false),
        inArray(aiAnalyses.id, usesEntity),
        hasVersion ? notInArray(aiAnalyses.id, hasVersion) : undefined,
      ),
    )
    .returning({ id: aiAnalyses.id, type: aiAnalyses.type });
  for (const a of updated) {
    await upsertAlert(
      {
        organizationId: input.organizationId,
        type: "analysis_stale",
        severity: "info",
        title: "Análise de IA desatualizada",
        message: `A análise "${ANALYSIS_TYPE_LABELS[a.type]}" pode não refletir as informações atuais. Motivo: ${input.reason}`.slice(
          0,
          2000,
        ),
        entityType: "analysis",
        entityId: a.id,
        dedupeKey: `stale:${a.id}`,
      },
      db,
    );
  }
  return updated.length;
}

export async function markAnalysesStaleForEntity(
  input: { organizationId: string; entityId: string; reason: string },
  db?: DbOrTx,
): Promise<number> {
  const v = parseOrThrow(staleInputSchema, input);
  if (db) return markStale(v, db);
  return getDb().transaction((tx) => markStale(v, tx));
}

export async function onDocumentVersionTextReady(input: {
  organizationId: string;
  documentId: string;
  versionId: string;
}): Promise<void> {
  const v = parseOrThrow(textReadyInputSchema, input);
  const db = getDb();
  const [doc] = await db
    .select({
      id: documents.id,
      title: documents.title,
      processId: documents.processId,
      occurrenceId: documents.occurrenceId,
      contractId: documents.contractId,
      versionNumber: documentVersions.versionNumber,
      extractionStatus: documentVersions.extractionStatus,
    })
    .from(documents)
    .innerJoin(
      documentVersions,
      and(eq(documentVersions.documentId, documents.id), eq(documentVersions.id, v.versionId)),
    )
    .where(and(eq(documents.id, v.documentId), eq(documents.organizationId, v.organizationId), isNull(documents.deletedAt)));
  if (!doc) {
    logger.warn("document_text_ready_missing_document", { documentId: v.documentId, versionId: v.versionId });
    return;
  }

  const title = doc.title.length > 120 ? `${doc.title.slice(0, 119)}…` : doc.title;
  const marked = await db.transaction(async (tx) => {
    let n = await markStale(
      {
        organizationId: v.organizationId,
        entityId: doc.id,
        reason: `Nova versão do documento "${title}" (v${doc.versionNumber}).`,
        exceptVersionId: v.versionId,
      },
      tx,
    );
    for (const parentId of [doc.processId, doc.occurrenceId, doc.contractId]) {
      if (!parentId) continue;
      n += await markStale(
        {
          organizationId: v.organizationId,
          entityId: parentId,
          reason:
            doc.versionNumber > 1
              ? `Nova versão do documento vinculado "${title}" (v${doc.versionNumber}).`
              : `Novo documento vinculado: "${title}".`,
          exceptVersionId: v.versionId,
        },
        tx,
      );
    }
    return n;
  });
  logger.info("document_text_ready", { documentId: doc.id, versionId: v.versionId, staleAnalyses: marked });

  if (doc.extractionStatus !== "succeeded") return;
  const org = await loadOrganization(v.organizationId);
  if (!org.settings.ai.autoAnalyzeOnUpload) return;
  try {
    await requestAnalysis(systemContext(v.organizationId, org.isDemo), {
      type: "summary",
      subjectType: "document",
      subjectId: doc.id,
      trigger: "document_uploaded",
    });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn("auto_analysis_skipped", { documentId: doc.id, reason: err.code });
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export async function getAiUsageSummary(ctx: AuthContext): Promise<AiUsageSummary> {
  assertCan(ctx, "analysis:read");
  const org = await loadOrganization(ctx.organizationId);
  const period = currentUsagePeriod();
  const [u] = await getDb()
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, ctx.organizationId), eq(aiUsage.period, period)));
  return {
    period,
    requests: u?.requests ?? 0,
    inputTokens: Number(u?.inputTokens ?? 0),
    outputTokens: Number(u?.outputTokens ?? 0),
    costMicroUsd: Number(u?.costMicroUsd ?? 0),
    monthlyTokenBudget: org.settings.ai.monthlyTokenBudget,
  };
}

/** Oldest stale analyses without a newer analysis of the same subject/type (used by the refresh routine). */
export async function listStaleAnalysesForRefresh(
  organizationId: string,
  limit: number,
): Promise<{ id: string; type: AnalysisType; subjectType: AnalysisSubjectType; subjectId: string | null }[]> {
  const newer = sql`exists (
    select 1 from ${aiAnalyses} as n
    where n.organization_id = ${aiAnalyses.organizationId}
      and n.type = ${aiAnalyses.type}
      and n.subject_type = ${aiAnalyses.subjectType}
      and n.subject_id is not distinct from ${aiAnalyses.subjectId}
      and n.created_at > ${aiAnalyses.staleSince}
      and n.status in ('queued', 'running', 'succeeded')
  )`;
  return getDb()
    .select({ id: aiAnalyses.id, type: aiAnalyses.type, subjectType: aiAnalyses.subjectType, subjectId: aiAnalyses.subjectId })
    .from(aiAnalyses)
    .where(
      and(
        eq(aiAnalyses.organizationId, organizationId),
        eq(aiAnalyses.status, "succeeded"),
        eq(aiAnalyses.isStale, true),
        ne(aiAnalyses.type, "question_answer"),
        ne(aiAnalyses.subjectType, "organization"),
        sql`not ${newer}`,
      ),
    )
    .orderBy(asc(aiAnalyses.staleSince), asc(aiAnalyses.id))
    .limit(Math.max(1, Math.min(100, limit)));
}
