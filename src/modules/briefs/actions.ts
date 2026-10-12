"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { int, str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, ValidationError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type { EditableSectionKey } from "./schemas";
import {
  applyBriefDeadline,
  applyBriefNextStep,
  approveCaseBrief,
  getBriefCitationPage,
  proposeBriefAmount,
  regenerateCaseBrief,
  rejectCaseBrief,
  requestCaseBrief,
  saveCaseBriefSection,
} from "./service";
import type { BriefCitationPage } from "./types";

/**
 * Server actions of the preliminary analysis (análise preliminar). Thin
 * wrappers: permissions, visibility and validation live in ./service.ts.
 */

function fail(action: string, err: unknown): { ok: false; error: string; fieldErrors?: Record<string, string[]> } {
  if (!(err instanceof AppError)) {
    logger.error("action_failed", { action, errorName: err instanceof Error ? err.name : typeof err });
  }
  return toActionError(err);
}

function briefPath(id: string): string {
  return `/analises-preliminares/${id}`;
}

function revalidateBrief(briefId: string, processId?: string | null): void {
  revalidatePath("/analises-preliminares");
  revalidatePath(briefPath(briefId));
  if (processId) revalidatePath(`/processos/${processId}`);
}

function briefIdFrom(formData: FormData): string {
  return str(formData, "briefId") ?? "";
}

/** Requests a new (simulated) preliminary analysis for a process; generated in the background. */
export async function requestCaseBriefAction(
  _prev: ActionResult<{ briefId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ briefId: string }>> {
  try {
    const ctx = await requireActionContext();
    const processId = str(formData, "processId") ?? "";
    const result = await requestCaseBrief(ctx, processId);
    revalidateBrief(result.briefId, processId);
    return {
      ok: true,
      data: { briefId: result.briefId },
      message: "Análise preliminar (simulação) solicitada. Ela será gerada em instantes e esta área é atualizada automaticamente.",
    };
  } catch (err) {
    return fail("requestCaseBrief", err);
  }
}

/** Generates a new version and opens it. */
export async function regenerateCaseBriefAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  let newId: string;
  try {
    const ctx = await requireActionContext("brief:review");
    const briefId = briefIdFrom(formData);
    const result = await regenerateCaseBrief(ctx, briefId);
    newId = result.briefId;
    revalidateBrief(briefId, str(formData, "processId"));
    revalidatePath(briefPath(newId));
  } catch (err) {
    return fail("regenerateCaseBrief", err);
  }
  redirect(briefPath(newId));
}

/** Saves one section (JSON in `value`) as a new revision. */
export async function saveBriefSectionAction(
  _prev: ActionResult<{ revision: number }> | null,
  formData: FormData,
): Promise<ActionResult<{ revision: number }>> {
  try {
    const ctx = await requireActionContext("brief:review");
    const briefId = briefIdFrom(formData);
    let value: unknown;
    try {
      value = JSON.parse(String(formData.get("value") ?? "null"));
    } catch {
      throw new ValidationError("Não foi possível ler os itens da seção. Recarregue a página e tente novamente.");
    }
    const result = await saveCaseBriefSection(ctx, briefId, {
      section: (str(formData, "section") ?? "") as EditableSectionKey,
      value,
      baseRevision: int(formData, "baseRevision") ?? Number.NaN,
      changeNote: strOrNull(formData, "changeNote"),
    });
    revalidateBrief(briefId, str(formData, "processId"));
    return result.changed
      ? { ok: true, data: { revision: result.revision }, message: `Revisão ${result.revision} salva. Os itens alterados ficam marcados como “Incluído/editado pelo advogado”.` }
      : { ok: true, data: { revision: result.revision }, message: "Nenhuma alteração encontrada nesta seção." };
  } catch (err) {
    return fail("saveBriefSection", err);
  }
}

export async function approveCaseBriefAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("brief:review");
    const briefId = briefIdFrom(formData);
    await approveCaseBrief(ctx, briefId, { note: strOrNull(formData, "note") });
    revalidateBrief(briefId, str(formData, "processId"));
    return { ok: true, message: "Análise preliminar aprovada." };
  } catch (err) {
    return fail("approveCaseBrief", err);
  }
}

export async function rejectCaseBriefAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("brief:review");
    const briefId = briefIdFrom(formData);
    await rejectCaseBrief(ctx, briefId, { reason: str(formData, "reason") ?? "" });
    revalidateBrief(briefId, str(formData, "processId"));
    return { ok: true, message: "Análise preliminar rejeitada." };
  } catch (err) {
    return fail("rejectCaseBrief", err);
  }
}

export async function applyBriefDeadlineAction(
  _prev: ActionResult<{ deadlineId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ deadlineId: string }>> {
  try {
    const ctx = await requireActionContext("deadline:write");
    const briefId = briefIdFrom(formData);
    const { deadlineId } = await applyBriefDeadline(ctx, briefId, int(formData, "index") ?? Number.NaN);
    revalidateBrief(briefId, str(formData, "processId"));
    revalidatePath("/prazos");
    return { ok: true, data: { deadlineId }, message: "Prazo criado e aguardando validação humana em Prazos › Validação." };
  } catch (err) {
    return fail("applyBriefDeadline", err);
  }
}

export async function applyBriefNextStepAction(
  _prev: ActionResult<{ taskId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ taskId: string }>> {
  try {
    const ctx = await requireActionContext("task:write");
    const briefId = briefIdFrom(formData);
    const { taskId } = await applyBriefNextStep(ctx, briefId, int(formData, "index") ?? Number.NaN);
    revalidateBrief(briefId, str(formData, "processId"));
    revalidatePath("/prazos");
    return { ok: true, data: { taskId }, message: "Tarefa criada no processo." };
  } catch (err) {
    return fail("applyBriefNextStep", err);
  }
}

export async function proposeBriefAmountAction(
  _prev: ActionResult<{ valuationId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ valuationId: string }>> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const briefId = briefIdFrom(formData);
    const { valuationId } = await proposeBriefAmount(ctx, briefId, int(formData, "index") ?? Number.NaN);
    revalidateBrief(briefId, str(formData, "processId"));
    revalidatePath("/contingencias/revisao");
    return { ok: true, data: { valuationId }, message: "Valor enviado para conferência (proposto, não oficial)." };
  } catch (err) {
    return fail("proposeBriefAmount", err);
  }
}

/** Page text for the citation viewer (called directly by the client dialog). */
export async function loadBriefCitationPageAction(input: {
  briefId: string;
  ref: string;
  page: number | null;
}): Promise<ActionResult<BriefCitationPage>> {
  try {
    const ctx = await requireActionContext("brief:read");
    const data = await getBriefCitationPage(ctx, input);
    return { ok: true, data };
  } catch (err) {
    return fail("loadBriefCitationPage", err);
  }
}
