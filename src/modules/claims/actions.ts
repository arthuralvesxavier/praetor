"use server";

import { revalidatePath } from "next/cache";
import { moneyCents, str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type { ClaimInput } from "./schemas";
import {
  applyDerivedRisk,
  assessClaim,
  confirmClaim,
  createClaim,
  dismissClaim,
  overrideProcessRisk,
  removeClaim,
  suggestClaimsFromBrief,
  updateClaim,
  type DerivationOutcome,
} from "./service";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

function revalidateProcess(processId: string) {
  revalidatePath(`/processos/${processId}`);
  revalidatePath("/processos");
  revalidatePath("/contingencias");
}

/** Whole percentage typed in pt-BR ("12,5") -> number; empty -> null; invalid -> NaN. */
function percent(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (v === undefined) return null;
  const normalized = v.replace("%", "").trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

function claimInput(fd: FormData): ClaimInput {
  return {
    description: str(fd, "description") ?? "",
    category: strOrNull(fd, "category") as never,
    claimedAmountCents: moneyCents(fd, "claimedAmount"),
    amountBaseDate: strOrNull(fd, "amountBaseDate"),
    correctionIndex: strOrNull(fd, "correctionIndex") as never,
    instance: strOrNull(fd, "instance") as never,
  };
}

function derivationMessage(outcome: DerivationOutcome | null): string {
  if (!outcome) return "";
  switch (outcome.status) {
    case "recorded":
      return outcome.needsReview
        ? " A classificação de risco do processo foi recalculada a partir dos pedidos e marcada para revisão: há pedido avaliado sem valor."
        : " A classificação de risco do processo foi recalculada a partir dos pedidos.";
    case "override_kept":
      return outcome.needsReview
        ? " A classificação manual do processo foi mantida e marcada para revisão."
        : " A classificação manual do processo foi mantida.";
    case "no_assessed_claims":
      return outcome.needsReview
        ? " Nenhum pedido tem mais avaliação vigente: a classificação derivada dos pedidos foi mantida e marcada para revisão."
        : "";
    case "skipped_without_permission":
      return " A classificação do processo não foi recalculada: seu perfil não lança risco.";
    default:
      return "";
  }
}

export async function createClaimAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId } = await createClaim(ctx, str(formData, "processId") ?? "", claimInput(formData));
    revalidateProcess(processId);
    return { ok: true, message: "Pedido incluído." };
  } catch (err) {
    return fail("createClaim", err);
  }
}

export async function updateClaimAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId } = await updateClaim(ctx, str(formData, "id") ?? "", claimInput(formData));
    revalidateProcess(processId);
    return { ok: true, message: "Pedido alterado. Avaliações já registradas mantêm a base que usaram." };
  } catch (err) {
    return fail("updateClaim", err);
  }
}

export async function confirmClaimAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId } = await confirmClaim(ctx, str(formData, "id") ?? "", claimInput(formData));
    revalidateProcess(processId);
    return { ok: true, message: "Pedido confirmado. Agora ele pode ser avaliado e passa a contar no risco quando avaliado." };
  } catch (err) {
    return fail("confirmClaim", err);
  }
}

export async function dismissClaimAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId } = await dismissClaim(ctx, str(formData, "id") ?? "", { reason: strOrNull(formData, "reason") });
    revalidateProcess(processId);
    return { ok: true, message: "Sugestão descartada." };
  } catch (err) {
    return fail("dismissClaim", err);
  }
}

export async function removeClaimAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId, derivation } = await removeClaim(ctx, str(formData, "id") ?? "", { reason: str(formData, "reason") ?? "" });
    revalidateProcess(processId);
    return { ok: true, message: `Pedido excluído.${derivationMessage(derivation)}` };
  } catch (err) {
    return fail("removeClaim", err);
  }
}

export async function assessClaimAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const baseMode = str(formData, "baseMode") ?? "claim";
    const { processId, derivation } = await assessClaim(ctx, str(formData, "id") ?? "", {
      classification: str(formData, "classification") as never,
      percentage: percent(formData, "percentage"),
      baseAmountCents:
        baseMode === "claim" ? undefined : baseMode === "unquantified" ? null : (moneyCents(formData, "baseAmount") ?? Number.NaN),
      baseDate: baseMode === "other" ? strOrNull(formData, "baseDate") : null,
      correctionIndex: baseMode === "other" ? (strOrNull(formData, "correctionIndex") as never) : null,
      opinion: str(formData, "opinion") ?? "",
      effectiveFrom: str(formData, "effectiveFrom") ?? "",
    });
    revalidateProcess(processId);
    return { ok: true, message: `Avaliação do pedido registrada.${derivationMessage(derivation)}` };
  } catch (err) {
    return fail("assessClaim", err);
  }
}

export async function applyDerivedRiskAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const processId = str(formData, "processId") ?? "";
    const outcome = await applyDerivedRisk(ctx, processId);
    revalidateProcess(processId);
    const review = outcome.status === "recorded" && outcome.needsReview ? " Ela continua marcada para revisão: há pedido avaliado sem valor." : "";
    return { ok: true, message: `Classificação derivada dos pedidos registrada como vigente.${review}` };
  } catch (err) {
    return fail("applyDerivedRisk", err);
  }
}

export async function overrideProcessRiskAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const { processId } = await overrideProcessRisk(ctx, str(formData, "processId") ?? "", {
      classification: str(formData, "classification") as never,
      percentage: percent(formData, "percentage"),
      justification: str(formData, "justification") ?? "",
    });
    revalidateProcess(processId);
    return { ok: true, message: "Classificação definida manualmente, com a justificativa registrada." };
  } catch (err) {
    return fail("overrideProcessRisk", err);
  }
}

export async function suggestClaimsFromBriefAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId, created } = await suggestClaimsFromBrief(ctx, str(formData, "briefId") ?? "");
    revalidateProcess(processId);
    return {
      ok: true,
      message: created
        ? `${created} pedido(s) sugerido(s) incluído(s), aguardando confirmação.`
        : "Nenhum pedido novo: os pedidos da análise já estão no processo.",
    };
  } catch (err) {
    return fail("suggestClaimsFromBrief", err);
  }
}
