"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { str } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { createActionPlanFromSuggestion, createOccurrenceFromSuggestion } from "./service";
import type { PreventiveIntelFilters } from "./types";

/**
 * Explicit user actions on illustrative suggestions (thin wrappers: the
 * service recomputes the indicator, checks permissions and visibility).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function filtersFromForm(formData: FormData): PreventiveIntelFilters {
  const companyId = str(formData, "empresa");
  const court = str(formData, "tribunal");
  return {
    companyId: companyId && UUID_RE.test(companyId) ? companyId : undefined,
    court: court ? court.slice(0, 120) : undefined,
  };
}

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

export async function createOccurrenceFromSuggestionAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let id: string;
  try {
    const ctx = await requireActionContext("occurrence:write");
    const result = await createOccurrenceFromSuggestion(ctx, str(formData, "key") ?? "", filtersFromForm(formData));
    id = result.occurrenceId;
    revalidatePath("/preventivo");
    revalidatePath("/inteligencia-preventiva");
  } catch (err) {
    return fail("createOccurrenceFromSuggestion", err);
  }
  redirect(`/preventivo/${id}`);
}

export async function createActionPlanFromSuggestionAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let id: string;
  try {
    const ctx = await requireActionContext("task:write");
    const result = await createActionPlanFromSuggestion(ctx, str(formData, "key") ?? "", filtersFromForm(formData));
    id = result.occurrenceId;
    revalidatePath("/preventivo");
    revalidatePath(`/preventivo/${id}`);
    revalidatePath("/inteligencia-preventiva");
    revalidatePath("/prazos");
  } catch (err) {
    return fail("createActionPlanFromSuggestion", err);
  }
  redirect(`/preventivo/${id}?aba=plano`);
}
