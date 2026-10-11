"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, int, moneyCents, str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type { ContractInput, ObligationInput, ObligationPatch } from "./schemas";
import {
  addObligation,
  createContract,
  deleteContract,
  getObligationContractId,
  removeObligation,
  updateContract,
  updateObligation,
} from "./service";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

function idFrom(fd: FormData, key = "id"): string {
  return str(fd, key) ?? "";
}

function contractFromForm(fd: FormData): ContractInput {
  return {
    title: str(fd, "title") ?? "",
    counterparty: str(fd, "counterparty") ?? "",
    counterpartyDocument: strOrNull(fd, "counterpartyDocument"),
    type: str(fd, "type") as ContractInput["type"],
    status: str(fd, "status") as ContractInput["status"],
    startDate: strOrNull(fd, "startDate"),
    endDate: strOrNull(fd, "endDate"),
    renewalType: str(fd, "renewalType") as ContractInput["renewalType"],
    renewalNoticeDays: int(fd, "renewalNoticeDays") ?? null,
    valueCents: moneyCents(fd, "value"),
    riskLevel: str(fd, "riskLevel") as ContractInput["riskLevel"],
    unitId: strOrNull(fd, "unitId"),
    responsibleId: strOrNull(fd, "responsibleId"),
    linkedProcessId: strOrNull(fd, "linkedProcessId"),
    linkedOccurrenceId: strOrNull(fd, "linkedOccurrenceId"),
    description: strOrNull(fd, "description"),
    isConfidential: bool(fd, "isConfidential"),
  };
}

function obligationFromForm(fd: FormData): ObligationInput {
  return {
    description: str(fd, "description") ?? "",
    responsibleId: strOrNull(fd, "responsibleId"),
    dueDate: strOrNull(fd, "dueDate"),
    recurrence: strOrNull(fd, "recurrence"),
    status: (str(fd, "status") ?? "pending") as ObligationInput["status"],
  };
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export async function createContractAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let id: string;
  try {
    const ctx = await requireActionContext("contract:write");
    ({ id } = await createContract(ctx, contractFromForm(formData)));
    revalidatePath("/contratos");
  } catch (err) {
    return fail("createContract", err);
  }
  redirect(`/contratos/${id}`);
}

export async function updateContractAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const id = idFrom(formData);
  try {
    const ctx = await requireActionContext("contract:write");
    await updateContract(ctx, id, contractFromForm(formData));
    revalidatePath("/contratos");
    revalidatePath(`/contratos/${id}`);
  } catch (err) {
    return fail("updateContract", err);
  }
  redirect(`/contratos/${id}`);
}

export async function deleteContractAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contract:delete");
    await deleteContract(ctx, idFrom(formData));
    revalidatePath("/contratos");
  } catch (err) {
    return fail("deleteContract", err);
  }
  redirect("/contratos");
}

// ---------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------

export async function addObligationAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contract:write");
    const contractId = idFrom(formData, "contractId");
    await addObligation(ctx, contractId, obligationFromForm(formData));
    revalidatePath(`/contratos/${contractId}`);
    revalidatePath("/contratos");
    return { ok: true, message: "Obrigação adicionada." };
  } catch (err) {
    return fail("addObligation", err);
  }
}

export async function updateObligationAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contract:write");
    const id = idFrom(formData);
    await updateObligation(ctx, id, obligationFromForm(formData));
    revalidatePath(`/contratos/${await getObligationContractId(ctx, id)}`);
    revalidatePath("/contratos");
    return { ok: true, message: "Obrigação atualizada." };
  } catch (err) {
    return fail("updateObligation", err);
  }
}

/** Status-only change (e.g. "Marcar como cumprida"). Expects `id` and `status`. */
export async function setObligationStatusAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contract:write");
    const id = idFrom(formData);
    const patch: ObligationPatch = { status: str(formData, "status") as ObligationPatch["status"] };
    await updateObligation(ctx, id, patch);
    revalidatePath(`/contratos/${await getObligationContractId(ctx, id)}`);
    revalidatePath("/contratos");
    return { ok: true, message: "Situação da obrigação atualizada." };
  } catch (err) {
    return fail("setObligationStatus", err);
  }
}

export async function removeObligationAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contract:write");
    const { contractId } = await removeObligation(ctx, idFrom(formData));
    revalidatePath(`/contratos/${contractId}`);
    revalidatePath("/contratos");
    return { ok: true, message: "Obrigação removida." };
  } catch (err) {
    return fail("removeObligation", err);
  }
}
