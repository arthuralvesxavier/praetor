"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, lines, moneyCents, str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { splitList, type CreateOccurrenceInput, type UpdateOccurrenceInput } from "./schemas";
import {
  createOccurrence,
  deleteOccurrence,
  linkOccurrenceToProcess,
  unlinkOccurrenceFromProcess,
  updateOccurrence,
} from "./service";

/**
 * Server actions of the preventive module: thin wrappers over ./service.ts
 * (which validates input, permissions and row visibility).
 */

function idFrom(formData: FormData, key: string): string {
  return str(formData, key) ?? "";
}

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

/**
 * Maps the occurrence form to the service input. Required fields are sent as ""
 * when blank so the service reports a field error instead of keeping the old
 * value. `isConfidential` is only sent when the form rendered the checkbox
 * (`confidentialField`), i.e. for roles allowed to change it.
 */
function occurrenceInputFromForm(formData: FormData) {
  return {
    title: str(formData, "title") ?? "",
    facts: str(formData, "facts") ?? "",
    category: str(formData, "category") ?? "",
    status: str(formData, "status") ?? "",
    riskLevel: str(formData, "riskLevel") ?? "",
    riskRationale: strOrNull(formData, "riskRationale"),
    areasInvolved: splitList(str(formData, "areasInvolved")),
    involvedParties: strOrNull(formData, "involvedParties"),
    missingInformation: lines(formData, "missingInformation"),
    estimatedExposureCents: moneyCents(formData, "estimatedExposure"),
    unitId: strOrNull(formData, "unitId"),
    responsibleId: strOrNull(formData, "responsibleId"),
    reportedById: strOrNull(formData, "reportedById"),
    occurredOn: strOrNull(formData, "occurredOn"),
    reportedOn: str(formData, "reportedOn") ?? "",
    isConfidential: formData.has("confidentialField") ? bool(formData, "isConfidential") : undefined,
  };
}

export async function createOccurrenceAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let id: string;
  try {
    const ctx = await requireActionContext("occurrence:write");
    // Enum/date strings are validated by the service's zod schema.
    const result = await createOccurrence(ctx, occurrenceInputFromForm(formData) as CreateOccurrenceInput);
    id = result.id;
    revalidatePath("/preventivo");
  } catch (err) {
    return fail("createOccurrence", err);
  }
  redirect(`/preventivo/${id}`);
}

export async function updateOccurrenceAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const id = idFrom(formData, "id");
  try {
    const ctx = await requireActionContext("occurrence:write");
    await updateOccurrence(ctx, id, occurrenceInputFromForm(formData) as UpdateOccurrenceInput);
    revalidatePath("/preventivo");
    revalidatePath(`/preventivo/${id}`);
  } catch (err) {
    return fail("updateOccurrence", err);
  }
  redirect(`/preventivo/${id}`);
}

export async function deleteOccurrenceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("occurrence:delete");
    await deleteOccurrence(ctx, idFrom(formData, "id"));
    revalidatePath("/preventivo");
  } catch (err) {
    return fail("deleteOccurrence", err);
  }
  redirect("/preventivo");
}

export async function linkOccurrenceToProcessAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const occurrenceId = idFrom(formData, "occurrenceId");
  const processId = idFrom(formData, "processId");
  try {
    const ctx = await requireActionContext("occurrence:write");
    if (!processId) return { ok: false, error: "Selecione um processo.", fieldErrors: { processId: ["Selecione um processo."] } };
    await linkOccurrenceToProcess(ctx, occurrenceId, processId);
    revalidatePath("/preventivo");
    revalidatePath(`/preventivo/${occurrenceId}`);
    revalidatePath(`/processos/${processId}`);
    return { ok: true, message: "Ocorrência vinculada ao processo." };
  } catch (err) {
    return fail("linkOccurrenceToProcess", err);
  }
}

export async function unlinkOccurrenceFromProcessAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const occurrenceId = idFrom(formData, "occurrenceId");
  try {
    const ctx = await requireActionContext("occurrence:write");
    await unlinkOccurrenceFromProcess(ctx, occurrenceId);
    revalidatePath("/preventivo");
    revalidatePath(`/preventivo/${occurrenceId}`);
    return { ok: true, message: "Vínculo com o processo removido." };
  } catch (err) {
    return fail("unlinkOccurrenceFromProcess", err);
  }
}
