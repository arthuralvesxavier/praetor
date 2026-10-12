"use server";

import { revalidatePath } from "next/cache";
import type { CorrectionIndex } from "@/domain/enums";
import { pluralize } from "@/lib/format";
import { str } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { requestIndexSeriesRefresh, setValuationCorrectionIndex, updateDefaultCorrectionIndex } from "./service";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

/**
 * Informs the index of a valuation without one or still in review (same row), or
 * changes the index of an official value (a new official record with the same
 * amount and base date supersedes it; `contingency:approve`).
 */
export async function setValuationCorrectionIndexAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const result = await setValuationCorrectionIndex(
      ctx,
      str(formData, "valuationId") ?? "",
      (str(formData, "correctionIndex") ?? "") as CorrectionIndex,
      { note: str(formData, "note") },
    );
    revalidatePath(`/processos/${result.processId}`);
    revalidatePath("/contingencias/revisao");
    revalidatePath("/contingencias");
    const message = !result.changed
      ? "O valor já usa este índice."
      : result.mode === "new_record"
        ? "Índice trocado: um novo registro oficial, com o mesmo valor e a mesma data-base, substituiu o anterior (que continua no histórico)."
        : "Índice de atualização registrado.";
    return { ok: true, message };
  } catch (err) {
    return fail("setValuationCorrectionIndex", err);
  }
}

/** Index written into new valuations of the organization. */
export async function updateDefaultCorrectionIndexAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("admin:organization");
    const result = await updateDefaultCorrectionIndex(ctx, (str(formData, "defaultCorrectionIndex") ?? "") as CorrectionIndex);
    revalidatePath("/admin/configuracoes");
    return { ok: true, message: result.changed ? "Índice padrão dos novos valores salvo." : "Nenhuma alteração." };
  } catch (err) {
    return fail("updateDefaultCorrectionIndex", err);
  }
}

/** "Atualizar agora" on the admin card: fetches the missing months now. */
export async function refreshIndexSeriesNowAction(): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("admin:organization");
    const summary = await requestIndexSeriesRefresh(ctx);
    revalidatePath("/admin/integracoes");
    if (summary.failed > 0) {
      return {
        ok: false,
        error: `Coleta concluída com ${pluralize(summary.failed, "falha", "falhas")} (detalhes na tabela). ${pluralize(summary.added, "mês novo gravado", "meses novos gravados")}.`,
      };
    }
    return {
      ok: true,
      message: summary.added > 0 ? `${pluralize(summary.added, "mês novo gravado", "meses novos gravados")}.` : "Nenhum mês novo publicado.",
    };
  } catch (err) {
    return fail("refreshIndexSeriesNow", err);
  }
}
