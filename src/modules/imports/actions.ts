"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, str } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { commitImport, rollbackImport } from "./service";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, errorName: err instanceof Error ? err.name : "unknown" });
  return toActionError(err);
}

function revalidatePortfolio(id: string) {
  revalidatePath("/importacoes");
  revalidatePath(`/importacoes/${id}`);
  revalidatePath("/processos");
  revalidatePath("/contingencias");
  revalidatePath("/dashboard");
}

/** Confirms an analyzed batch. Expects `id`, `baseDate` and the optional `distributeAfterCommit` checkbox. */
export async function commitImportAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id") ?? "";
  try {
    const ctx = await requireActionContext("import:run");
    await commitImport(ctx, id, {
      baseDate: str(formData, "baseDate") ?? "",
      distributeAfterCommit: bool(formData, "distributeAfterCommit"),
    });
    revalidatePortfolio(id);
  } catch (err) {
    return fail("commitImport", err);
  }
  redirect(`/importacoes/${id}?confirmado=1`);
}

/** Undoes a committed batch. Expects `id`. */
export async function rollbackImportAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id") ?? "";
  try {
    const ctx = await requireActionContext("import:run");
    await rollbackImport(ctx, id);
    revalidatePortfolio(id);
  } catch (err) {
    return fail("rollbackImport", err);
  }
  redirect(`/importacoes/${id}?desfeito=1`);
}
