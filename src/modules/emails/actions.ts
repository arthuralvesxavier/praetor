"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { str } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { resendEmail, sendDailyDigest } from "./service";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

/** "Reenviar (simulação)": creates a copy of the message and opens it. Expects `id`. */
export async function resendEmailAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id") ?? "";
  let emailId: string;
  try {
    const ctx = await requireActionContext("email:send");
    ({ emailId } = await resendEmail(ctx, id));
    revalidatePath("/emails");
    revalidatePath(`/emails/${id}`);
  } catch (err) {
    return fail("resendEmail", err);
  }
  redirect(`/emails/${emailId}`);
}

/** "Gerar resumo diário (simulação)" for the current user; opens the generated message. */
export async function sendDailyDigestAction(): Promise<ActionResult> {
  let emailId: string;
  try {
    const ctx = await requireActionContext("email:send");
    ({ emailId } = await sendDailyDigest(ctx));
    revalidatePath("/emails");
  } catch (err) {
    return fail("sendDailyDigest", err);
  }
  redirect(`/emails/${emailId}`);
}
