"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ConfidentialityLevel, DocumentCategory } from "@/domain/enums";
import { bool, str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { errorSummary } from "./log";
import type { UpdateDocumentInput } from "./schemas";
import { deleteDocument, updateDocumentMetadata } from "./service";

/**
 * Server actions of the documents module. File uploads do NOT go through
 * server actions (body size limit): they use POST /api/documents/upload.
 */

function documentIdFrom(formData: FormData): string {
  return str(formData, "id") ?? "";
}

/** Edits title, category, description, confidentiality, links, retention and legal hold. */
export async function updateDocumentMetadataAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("document:upload");
    const id = documentIdFrom(formData);
    const input: UpdateDocumentInput = {
      title: str(formData, "title") ?? "",
      // Enum values are validated by the service schema (unknown values -> field error).
      category: str(formData, "category") as DocumentCategory | undefined,
      description: strOrNull(formData, "description"),
      confidentiality: str(formData, "confidentiality") as ConfidentialityLevel | undefined,
      processId: strOrNull(formData, "processId"),
      occurrenceId: strOrNull(formData, "occurrenceId"),
      contractId: strOrNull(formData, "contractId"),
      retentionUntil: strOrNull(formData, "retentionUntil"),
      // The checkbox is only rendered for users allowed to change it; a marker
      // field tells "unchecked" apart from "not editable".
      legalHold: formData.has("legalHoldEditable") ? bool(formData, "legalHold") : undefined,
    };
    await updateDocumentMetadata(ctx, id, input);
    revalidatePath(`/documentos/${id}`);
    revalidatePath("/documentos");
    return { ok: true, message: "Dados do documento atualizados." };
  } catch (err) {
    if (!(err instanceof AppError)) logger.error("action_failed", { action: "updateDocumentMetadata", ...errorSummary(err) });
    return toActionError(err);
  }
}

/** Soft-deletes a document and goes back to the list. */
export async function deleteDocumentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("document:delete");
    await deleteDocument(ctx, documentIdFrom(formData));
    revalidatePath("/documentos");
  } catch (err) {
    if (!(err instanceof AppError)) logger.error("action_failed", { action: "deleteDocument", ...errorSummary(err) });
    return toActionError(err);
  }
  redirect("/documentos");
}
