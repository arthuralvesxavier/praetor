"use server";

import { revalidatePath } from "next/cache";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { resolveAlert } from "./service";

function alertIdFrom(formData: FormData): string {
  const v = formData.get("alertId");
  return typeof v === "string" ? v.trim() : "";
}

/** For `useActionState`: marks an alert as resolved. */
export async function resolveAlertAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("alert:resolve");
    await resolveAlert(ctx, alertIdFrom(formData));
    revalidatePath("/", "layout");
    return { ok: true, message: "Alerta resolvido." };
  } catch (err) {
    if (!(err instanceof AppError)) logger.error("action_failed", { action: "resolveAlert", error: err });
    return toActionError(err);
  }
}

/** For plain `<form action>` usage in server components (no result state). */
export async function resolveAlertFormAction(formData: FormData): Promise<void> {
  const result = await resolveAlertAction(null, formData);
  if (!result.ok) logger.warn("resolve_alert_rejected", { reason: result.error });
}
