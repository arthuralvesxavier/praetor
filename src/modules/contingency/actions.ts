"use server";

import { revalidatePath } from "next/cache";
import type { ExposureResult, ProvisionResult } from "@/domain/contingency";
import type { LossProbability } from "@/domain/enums";
import { formatMoneyCents } from "@/lib/format";
import { bool, int, moneyCents, str, strOrNull, strings } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import {
  createGuarantee,
  deleteGuarantee,
  getGuaranteeProcessId,
  setGuaranteeStatus,
  updateGuarantee,
} from "./guarantee-service";
import {
  addRiskAssessment,
  approveRiskProposal,
  getRiskAssessmentProcessId,
  rejectRiskProposal,
  suggestRiskAssessment,
} from "./risk-service";
import type { GuaranteeInput, ReviewDecision } from "./schemas";
import {
  addValuation,
  bulkApproveValuations,
  getPositionAt,
  getValuationProcessId,
  registerExtinction,
  reviewValuation,
} from "./service";
import {
  createSettlement,
  getSettlementProcessId,
  setInstallmentPaid,
  setSettlementStatus,
  updateSettlementNotes,
  updateSettlementTerms,
} from "./settlement-service";
import { closeSnapshot, generateSnapshot } from "./snapshot-service";
import { formatPeriod } from "./rules";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

function id(fd: FormData, key = "id"): string {
  return str(fd, key) ?? "";
}

/** Whole percentage typed in pt-BR ("12,5") → number; empty → null; invalid → NaN. */
function percent(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (v === undefined) return null;
  const normalized = v.replace("%", "").trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

function revalidateProcess(processId: string) {
  revalidatePath(`/processos/${processId}`);
  revalidatePath("/contingencias");
  revalidatePath("/processos");
}

// ---------------------------------------------------------------------------
// Valuations
// ---------------------------------------------------------------------------

export async function addValuationAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const processId = id(formData, "processId");
    const result = await addValuation(ctx, {
      processId,
      kind: str(formData, "kind") as never,
      amountCents: moneyCents(formData, "amount") as number,
      baseDate: str(formData, "baseDate") ?? "",
      instance: strOrNull(formData, "instance") as never,
      source: (str(formData, "source") ?? "manual") as "manual" | "document",
      documentId: strOrNull(formData, "documentId"),
      page: int(formData, "page") ?? null,
      excerpt: strOrNull(formData, "excerpt"),
      reason: strOrNull(formData, "reason"),
    });
    revalidateProcess(processId);
    revalidatePath("/contingencias/revisao");
    return {
      ok: true,
      message:
        result.status === "proposed"
          ? "Valor registrado como proposto: aguarda conferência na fila de revisão."
          : result.status === "superseded"
            ? "Valor registrado no histórico (já existe valor oficial com data-base mais recente)."
            : "Valor registrado como oficial.",
    };
  } catch (err) {
    return fail("addValuation", err);
  }
}

export async function reviewValuationAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:approve");
    const valuationId = id(formData);
    const decision = (str(formData, "decision") ?? "") as ReviewDecision;
    const processId = await getValuationProcessId(ctx, valuationId);
    const result = await reviewValuation(ctx, valuationId, {
      decision,
      correctedAmountCents: decision === "correct" ? moneyCents(formData, "correctedAmount") : null,
      note: strOrNull(formData, "note"),
    });
    revalidateProcess(processId);
    revalidatePath("/contingencias/revisao");
    const message =
      decision === "reject"
        ? "Valor rejeitado."
        : decision === "correct"
          ? "Valor corrigido e oficializado (o valor proposto ficou registrado como rejeitado)."
          : result.status === "superseded"
            ? "Valor aprovado como histórico: já existe valor oficial mais recente."
            : "Valor aprovado e oficializado.";
    return { ok: true, message };
  } catch (err) {
    return fail("reviewValuation", err);
  }
}

export async function bulkApproveValuationsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:approve");
    const ids = strings(formData, "ids");
    const result = await bulkApproveValuations(ctx, ids);
    revalidatePath("/contingencias/revisao");
    revalidatePath("/contingencias");
    revalidatePath("/processos/[id]", "page");
    if (result.approved === 0) {
      return { ok: false, error: result.refused[0]?.reason ?? "Nenhum valor foi aprovado." };
    }
    const refused = result.refused.length
      ? ` ${result.refused.length} recusado(s): ${result.refused[0].reason}`
      : "";
    return { ok: true, message: `${result.approved} valor(es) aprovado(s) em lote.${refused}` };
  } catch (err) {
    return fail("bulkApproveValuations", err);
  }
}

export async function registerExtinctionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const processId = id(formData, "processId");
    const result = await registerExtinction(ctx, processId, {
      baseDate: str(formData, "baseDate") ?? "",
      documentId: strOrNull(formData, "documentId"),
      note: strOrNull(formData, "note"),
    });
    revalidateProcess(processId);
    revalidatePath("/contingencias/revisao");
    revalidatePath("/acordos");
    return {
      ok: true,
      message:
        result.status === "proposed"
          ? "Quitação proposta: aguarda conferência para zerar o valor liquidado."
          : "Quitação registrada: valor liquidado oficial zerado (histórico preservado).",
    };
  } catch (err) {
    return fail("registerExtinction", err);
  }
}

export type PositionView = {
  date: string;
  claimCents: number | null;
  claimBaseDate: string | null;
  liquidatedCents: number | null;
  liquidatedBaseDate: string | null;
  linkedGuaranteesCents: number;
  classification: LossProbability | null;
  percentageBp: number | null;
  riskEffectiveFrom: string | null;
  exposure: ExposureResult;
  provision: ProvisionResult;
  usedRecordFallback: boolean;
};

export async function getPositionAtAction(
  _prev: ActionResult<PositionView> | null,
  formData: FormData,
): Promise<ActionResult<PositionView>> {
  try {
    const ctx = await requireActionContext("contingency:read");
    const position = await getPositionAt(ctx, id(formData, "processId"), str(formData, "date") ?? "");
    return { ok: true, data: position };
  } catch (err) {
    return fail("getPositionAt", err);
  }
}

// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------

function guaranteeFromForm(fd: FormData): GuaranteeInput {
  return {
    kind: str(fd, "kind") as GuaranteeInput["kind"],
    amountCents: moneyCents(fd, "amount") as number,
    depositedAt: strOrNull(fd, "depositedAt"),
    documentId: strOrNull(fd, "documentId"),
    description: strOrNull(fd, "description"),
  };
}

export async function createGuaranteeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const processId = id(formData, "processId");
    await createGuarantee(ctx, processId, guaranteeFromForm(formData));
    revalidateProcess(processId);
    return { ok: true, message: "Garantia vinculada ao processo." };
  } catch (err) {
    return fail("createGuarantee", err);
  }
}

export async function updateGuaranteeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const guaranteeId = id(formData);
    await updateGuarantee(ctx, guaranteeId, guaranteeFromForm(formData));
    revalidateProcess(await getGuaranteeProcessId(ctx, guaranteeId));
    return { ok: true, message: "Garantia atualizada." };
  } catch (err) {
    return fail("updateGuarantee", err);
  }
}

export async function setGuaranteeStatusAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const guaranteeId = id(formData);
    await setGuaranteeStatus(ctx, guaranteeId, {
      status: str(formData, "status") as never,
      statusChangedAt: strOrNull(formData, "statusChangedAt"),
    });
    revalidateProcess(await getGuaranteeProcessId(ctx, guaranteeId));
    return { ok: true, message: "Situação da garantia atualizada." };
  } catch (err) {
    return fail("setGuaranteeStatus", err);
  }
}

export async function deleteGuaranteeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const { processId } = await deleteGuarantee(ctx, id(formData));
    revalidateProcess(processId);
    return { ok: true, message: "Garantia excluída." };
  } catch (err) {
    return fail("deleteGuarantee", err);
  }
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export async function addRiskAssessmentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const processId = id(formData, "processId");
    await addRiskAssessment(ctx, processId, {
      classification: str(formData, "classification") as never,
      percentage: percent(formData, "percentage"),
      opinion: str(formData, "opinion") ?? "",
      effectiveFrom: str(formData, "effectiveFrom") ?? "",
    });
    revalidateProcess(processId);
    return { ok: true, message: "Classificação de risco registrada." };
  } catch (err) {
    return fail("addRiskAssessment", err);
  }
}

export async function suggestRiskAssessmentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const processId = id(formData, "processId");
    const result = await suggestRiskAssessment(ctx, processId);
    revalidateProcess(processId);
    return {
      ok: true,
      message: result.reused
        ? "Já existe uma sugestão igual aguardando conferência."
        : "Sugestão por regra registrada como proposta (não oficial). Aprove ou rejeite abaixo.",
    };
  } catch (err) {
    return fail("suggestRiskAssessment", err);
  }
}

export async function reviewRiskProposalAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const assessmentId = id(formData);
    const decision = str(formData, "decision");
    const processId = await getRiskAssessmentProcessId(ctx, assessmentId);
    if (decision === "approve") await approveRiskProposal(ctx, assessmentId, { note: strOrNull(formData, "note") });
    else await rejectRiskProposal(ctx, assessmentId, { note: strOrNull(formData, "note") });
    revalidateProcess(processId);
    return { ok: true, message: decision === "approve" ? "Sugestão aprovada: classificação oficial." : "Sugestão rejeitada." };
  } catch (err) {
    return fail("reviewRiskProposal", err);
  }
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

function revalidateSettlement(processId: string) {
  revalidatePath(`/processos/${processId}`);
  revalidatePath("/acordos");
}

export async function createSettlementAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const result = await createSettlement(ctx, {
      processId: id(formData, "processId"),
      status: (str(formData, "status") ?? "proposal") as never,
      totalAmountCents: moneyCents(formData, "total"),
      installmentsCount: int(formData, "installmentsCount") ?? null,
      firstDueDate: strOrNull(formData, "firstDueDate"),
      proposedAt: strOrNull(formData, "proposedAt"),
      responsibleId: strOrNull(formData, "responsibleId"),
      notes: strOrNull(formData, "notes"),
    });
    revalidateSettlement(result.processId);
    return { ok: true, message: "Acordo registrado." };
  } catch (err) {
    return fail("createSettlement", err);
  }
}

export async function updateSettlementTermsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const settlementId = id(formData);
    await updateSettlementTerms(ctx, settlementId, {
      totalAmountCents: moneyCents(formData, "total"),
      installmentsCount: int(formData, "installmentsCount") ?? null,
      firstDueDate: strOrNull(formData, "firstDueDate"),
    });
    revalidateSettlement(await getSettlementProcessId(ctx, settlementId));
    return { ok: true, message: "Termos do acordo atualizados e parcelas recalculadas." };
  } catch (err) {
    return fail("updateSettlementTerms", err);
  }
}

export async function setSettlementStatusAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const { processId } = await setSettlementStatus(ctx, id(formData), {
      status: str(formData, "status") as never,
      date: strOrNull(formData, "date"),
    });
    revalidateSettlement(processId);
    return { ok: true, message: "Situação do acordo atualizada." };
  } catch (err) {
    return fail("setSettlementStatus", err);
  }
}

export async function updateSettlementNotesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const settlementId = id(formData);
    await updateSettlementNotes(ctx, settlementId, { notes: strOrNull(formData, "notes") });
    revalidateSettlement(await getSettlementProcessId(ctx, settlementId));
    return { ok: true, message: "Observações salvas." };
  } catch (err) {
    return fail("updateSettlementNotes", err);
  }
}

export async function setInstallmentPaidAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const paid = bool(formData, "paid");
    const { processId } = await setInstallmentPaid(ctx, id(formData), { paid, paidAt: strOrNull(formData, "paidAt") });
    revalidateSettlement(processId);
    return { ok: true, message: paid ? "Parcela marcada como paga." : "Parcela voltou para “a pagar”." };
  } catch (err) {
    return fail("setInstallmentPaid", err);
  }
}

// ---------------------------------------------------------------------------
// Monthly close
// ---------------------------------------------------------------------------

export async function generateSnapshotAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:approve");
    const period = str(formData, "period") ?? "";
    const result = await generateSnapshot(ctx, period);
    revalidatePath("/contingencias/provisao");
    return {
      ok: true,
      message:
        `Prévia de ${formatPeriod(period)} calculada: ${result.itemCount} processo(s), provisão ` +
        `${formatMoneyCents(result.metrics.totals.provisionCents)} + estimativa ${formatMoneyCents(result.metrics.totals.provisionEstimateCents)}.`,
    };
  } catch (err) {
    return fail("generateSnapshot", err);
  }
}

export async function closeSnapshotAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("snapshot:close");
    const period = str(formData, "period") ?? "";
    await closeSnapshot(ctx, period);
    revalidatePath("/contingencias/provisao");
    return { ok: true, message: `Competência ${formatPeriod(period)} fechada. A partir de agora ela é imutável.` };
  } catch (err) {
    return fail("closeSnapshot", err);
  }
}

