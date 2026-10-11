"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AnalysisSubjectType, AnalysisType } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, ValidationError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { int, str, strOrNull } from "@/lib/form";
import {
  applySuggestedDeadline,
  applySuggestedTask,
  getAnalysis,
  requestAnalysis,
  reviewAnalysis,
} from "./service";

/**
 * Server actions of the AI analysis UI. Thin wrappers: permission, record
 * visibility and input validation are enforced by the analyses service.
 */

type RequestResult = ActionResult<{ analysisId: string; reused: boolean }>;

function fail(action: string, err: unknown): { ok: false; error: string; fieldErrors?: Record<string, string[]> } {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

function analysisPath(id: string): string {
  return `/ia/analises/${id}`;
}

/** Revalidates the AI center, the analysis page and the page of the analysed record (if visible). */
async function revalidateAnalysis(ctx: AuthContext, analysisId: string): Promise<void> {
  revalidatePath("/ia");
  revalidatePath(analysisPath(analysisId));
  try {
    const a = await getAnalysis(ctx, analysisId);
    if (a.subjectHref) revalidatePath(a.subjectHref);
  } catch {
    // The analysis may not be visible (or no longer exists): nothing else to refresh.
  }
}

function analysisIdFrom(formData: FormData): string {
  return str(formData, "analysisId") ?? "";
}

/**
 * Requests a new analysis of a record (`type`, `subjectType`, `subjectId`).
 * With `redirectTo=analysis` the user is taken to the analysis page.
 */
export async function requestAnalysisAction(_prev: RequestResult | null, formData: FormData): Promise<RequestResult> {
  let analysisId: string;
  let reused: boolean;
  try {
    const ctx = await requireActionContext("analysis:request");
    const subjectType = str(formData, "subjectType");
    const result = await requestAnalysis(ctx, {
      type: str(formData, "type") as AnalysisType,
      subjectType: subjectType as AnalysisSubjectType,
      subjectId: subjectType === "organization" ? null : (str(formData, "subjectId") ?? null),
      question: strOrNull(formData, "question"),
      trigger: "manual",
    });
    analysisId = result.analysisId;
    reused = result.reused;
    await revalidateAnalysis(ctx, analysisId);
  } catch (err) {
    return fail("requestAnalysis", err);
  }
  if (str(formData, "redirectTo") === "analysis") redirect(analysisPath(analysisId));
  return {
    ok: true,
    data: { analysisId, reused },
    message: reused
      ? "Já existe uma análise atualizada (ou em andamento) com as mesmas fontes; ela foi reaproveitada sem novo custo."
      : "Análise solicitada. Ela será processada em segundo plano e aparecerá na lista ao concluir.",
  };
}

/** Requests a fresh analysis with the same type/subject/question, bypassing reuse of a finished result. */
export async function reanalyzeAction(_prev: RequestResult | null, formData: FormData): Promise<RequestResult> {
  let analysisId: string;
  try {
    const ctx = await requireActionContext("analysis:request");
    const previous = await getAnalysis(ctx, analysisIdFrom(formData));
    const result = await requestAnalysis(ctx, {
      type: previous.type,
      subjectType: previous.subjectType,
      subjectId: previous.subjectType === "organization" ? null : previous.subjectId,
      question: previous.type === "question_answer" ? previous.question : null,
      trigger: "manual",
      force: true,
    });
    analysisId = result.analysisId;
    await revalidateAnalysis(ctx, previous.id);
    if (analysisId !== previous.id) await revalidateAnalysis(ctx, analysisId);
  } catch (err) {
    return fail("reanalyze", err);
  }
  redirect(analysisPath(analysisId));
}

/** Marks an analysis as reviewed or dismissed (with an optional note). */
export async function reviewAnalysisAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("analysis:review");
    const id = analysisIdFrom(formData);
    const decision = str(formData, "decision");
    await reviewAnalysis(ctx, id, {
      decision: decision as "reviewed" | "dismissed",
      note: strOrNull(formData, "note"),
    });
    await revalidateAnalysis(ctx, id);
    return {
      ok: true,
      message: decision === "dismissed" ? "Análise descartada na revisão." : "Análise marcada como revisada.",
    };
  } catch (err) {
    return fail("reviewAnalysis", err);
  }
}

function suggestionIndexFrom(formData: FormData): number {
  const index = int(formData, "index");
  if (index === undefined || Number.isNaN(index)) throw new ValidationError("Sugestão inválida.");
  return index;
}

/** Creates a task from `result.suggestedTasks[index]` (origin "sugerido pela IA"). */
export async function applySuggestedTaskAction(
  _prev: ActionResult<{ taskId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ taskId: string }>> {
  try {
    const ctx = await requireActionContext("task:write");
    const id = analysisIdFrom(formData);
    const { taskId } = await applySuggestedTask(ctx, id, suggestionIndexFrom(formData));
    await revalidateAnalysis(ctx, id);
    revalidatePath("/prazos");
    return { ok: true, data: { taskId }, message: "Tarefa criada a partir da sugestão." };
  } catch (err) {
    return fail("applySuggestedTask", err);
  }
}

/** Creates a deadline from `result.suggestedDeadlines[index]`, pending human validation. */
export async function applySuggestedDeadlineAction(
  _prev: ActionResult<{ deadlineId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ deadlineId: string }>> {
  try {
    const ctx = await requireActionContext("deadline:write");
    const id = analysisIdFrom(formData);
    const { deadlineId } = await applySuggestedDeadline(ctx, id, suggestionIndexFrom(formData));
    await revalidateAnalysis(ctx, id);
    revalidatePath("/prazos");
    revalidatePath("/dashboard");
    return {
      ok: true,
      data: { deadlineId },
      message: "Prazo registrado como “aguardando validação”. Ele só passa a valer após a validação humana.",
    };
  } catch (err) {
    return fail("applySuggestedDeadline", err);
  }
}

/** Asks a question about the organization's records (private to the requester) and opens the answer page. */
export async function askQuestionAction(_prev: RequestResult | null, formData: FormData): Promise<RequestResult> {
  let analysisId: string;
  try {
    const ctx = await requireActionContext("analysis:request");
    const result = await requestAnalysis(ctx, {
      type: "question_answer",
      subjectType: "organization",
      subjectId: null,
      question: str(formData, "question") ?? null,
      trigger: "manual",
    });
    analysisId = result.analysisId;
    revalidatePath("/ia");
  } catch (err) {
    return fail("askQuestion", err);
  }
  redirect(analysisPath(analysisId));
}
