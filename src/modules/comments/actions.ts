"use server";

import { revalidatePath } from "next/cache";
import type { EntityRef } from "@/domain/entities";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { addComment, deleteComment } from "./service";

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

function fail(action: string, err: unknown) {
  // Never log the comment body.
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

/** Adds a comment to `entityType`/`entityId` (validated and authorized in the service). */
export async function addCommentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("comment:write");
    const entity = { type: text(formData, "entityType").trim(), id: text(formData, "entityId").trim() } as EntityRef;
    await addComment(ctx, entity, text(formData, "body"));
    revalidatePath("/", "layout");
    return { ok: true, message: "Comentário publicado." };
  } catch (err) {
    return fail("addComment", err);
  }
}

/** Soft-deletes the author's own comment. */
export async function deleteCommentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("comment:write");
    await deleteComment(ctx, text(formData, "commentId").trim());
    revalidatePath("/", "layout");
    return { ok: true, message: "Comentário excluído." };
  } catch (err) {
    return fail("deleteComment", err);
  }
}
