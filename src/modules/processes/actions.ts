"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, int, moneyCents, str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type {
  CloseProcessInput,
  PartyInput,
  ProcessEventInput,
  ProcessInstanceInput,
  UpdateProcessInput,
} from "./schemas";
import {
  addParty,
  addProcessEvent,
  addProcessInstance,
  closeProcess,
  createProcess,
  deleteProcess,
  flagProcessForVerification,
  reactivateProcess,
  removeParty,
  removeProcessEvent,
  removeProcessInstance,
  resolveProcessVerification,
  updateParty,
  updateProcess,
  updateProcessInstance,
} from "./service";

/** ActionResult + submitted values on failure (forms re-fill their fields). */
export type ProcessActionState = ActionResult<{ id: string }> & { values?: Record<string, string> };

const DETAIL = (id: string) => `/processos/${id}`;

/** String entries of the submitted form, echoed back on failure. */
function submittedValues(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value === "string" && !key.startsWith("$ACTION")) out[key] = value;
  }
  return out;
}

function failure(err: unknown, action: string, fd?: FormData): ProcessActionState {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return { ...toActionError(err), values: fd ? submittedValues(fd) : undefined };
}

/** Ids from hidden fields; an empty value is passed through so the service answers NotFound. */
function idFrom(fd: FormData, key: string): string {
  return str(fd, key) ?? "";
}

/**
 * Optional field: absent from the form -> undefined (the stored value is kept);
 * present but empty -> null (cleared).
 */
function optional(fd: FormData, key: string): string | null | undefined {
  return fd.has(key) ? strOrNull(fd, key) : undefined;
}

function processInputFromForm(fd: FormData): UpdateProcessInput {
  return {
    number: str(fd, "number"),
    title: str(fd, "title"),
    court: str(fd, "court"),
    courtDivision: optional(fd, "courtDivision"),
    jurisdiction: optional(fd, "jurisdiction"),
    area: str(fd, "area") as UpdateProcessInput["area"],
    phase: str(fd, "phase") as UpdateProcessInput["phase"],
    phaseDetail: optional(fd, "phaseDetail"),
    // Rendered only while the process is in the active portfolio (closure has its own action).
    status: str(fd, "status") as UpdateProcessInput["status"],
    filedAt: optional(fd, "filedAt"),
    lastMovementAt: optional(fd, "lastMovementAt"),
    instance: optional(fd, "instance") as UpdateProcessInput["instance"],
    processClass: optional(fd, "processClass"),
    city: optional(fd, "city"),
    state: optional(fd, "state"),
    companyId: optional(fd, "companyId"),
    // Not rendered for external counsel (their firm is fixed).
    lawFirmId: optional(fd, "lawFirmId"),
    unitId: optional(fd, "unitId"),
    responsibleId: optional(fd, "responsibleId"),
    claimAmountCents: fd.has("claimAmountCents") ? moneyCents(fd, "claimAmountCents") : undefined,
    riskLevel: str(fd, "riskLevel") as UpdateProcessInput["riskLevel"],
    riskRationale: optional(fd, "riskRationale"),
    description: optional(fd, "description"),
    // The checkbox is only rendered for admin / legal manager; the marker tells
    // "unchecked" apart from "not shown". The service ignores it for other roles.
    isConfidential: fd.has("confidentialityField") ? bool(fd, "isConfidential") : undefined,
  };
}

function partyInputFromForm(fd: FormData): PartyInput {
  return {
    name: str(fd, "name") as string,
    role: str(fd, "role") as PartyInput["role"],
    documentNumber: strOrNull(fd, "documentNumber"),
    isClient: bool(fd, "isClient"),
    liabilityNature: strOrNull(fd, "liabilityNature") as PartyInput["liabilityNature"],
    counselName: strOrNull(fd, "counselName"),
  };
}

function eventInputFromForm(fd: FormData): ProcessEventInput {
  return {
    occurredAt: str(fd, "occurredAt") as string,
    type: str(fd, "type") as ProcessEventInput["type"],
    title: str(fd, "title") as string,
    description: strOrNull(fd, "description"),
    instance: strOrNull(fd, "instance") as ProcessEventInput["instance"],
    cnjMovementCode: int(fd, "cnjMovementCode") ?? null,
  };
}

function instanceInputFromForm(fd: FormData): ProcessInstanceInput {
  return {
    instance: str(fd, "instance") as ProcessInstanceInput["instance"],
    court: str(fd, "court") as string,
    courtDivision: strOrNull(fd, "courtDivision"),
    city: strOrNull(fd, "city"),
    state: strOrNull(fd, "state"),
    processClass: strOrNull(fd, "processClass"),
    phase: strOrNull(fd, "phase") as ProcessInstanceInput["phase"],
    phaseDetail: strOrNull(fd, "phaseDetail"),
    claimAmountCents: moneyCents(fd, "claimAmountCents"),
    liquidatedAmountCents: moneyCents(fd, "liquidatedAmountCents"),
    isCurrent: bool(fd, "isCurrent"),
  };
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

export async function createProcessAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  let target: string;
  try {
    const ctx = await requireActionContext("process:write");
    const fromOccurrenceId = strOrNull(formData, "fromOccurrenceId");
    const input = processInputFromForm(formData);
    const result = await createProcess(ctx, {
      ...(input as Parameters<typeof createProcess>[1]),
      fromOccurrenceId,
    });
    revalidatePath("/processos");
    if (fromOccurrenceId) {
      revalidatePath("/preventivo");
      revalidatePath(`/preventivo/${fromOccurrenceId}`);
    }
    target = result.occurrenceLinkError ? `${DETAIL(result.id)}?vinculo=falhou` : DETAIL(result.id);
  } catch (err) {
    return failure(err, "createProcess", formData);
  }
  redirect(target);
}

export async function updateProcessAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  const id = idFrom(formData, "id");
  try {
    const ctx = await requireActionContext("process:write");
    await updateProcess(ctx, id, processInputFromForm(formData));
    revalidatePath("/processos");
    revalidatePath(DETAIL(id));
  } catch (err) {
    return failure(err, "updateProcess", formData);
  }
  redirect(DETAIL(id));
}

export async function deleteProcessAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:delete");
    await deleteProcess(ctx, idFrom(formData, "id"));
    revalidatePath("/processos");
  } catch (err) {
    return failure(err, "deleteProcess");
  }
  redirect("/processos");
}

// ---------------------------------------------------------------------------
// Active portfolio lifecycle (RN-12) and verification
// ---------------------------------------------------------------------------

export async function closeProcessAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  const id = idFrom(formData, "id");
  try {
    const ctx = await requireActionContext("process:write");
    await closeProcess(ctx, id, {
      closureReason: str(formData, "closureReason") as CloseProcessInput["closureReason"],
      closedAt: strOrNull(formData, "closedAt"),
      note: strOrNull(formData, "note"),
    });
    revalidatePath("/processos");
    revalidatePath(DETAIL(id));
    return { ok: true, data: { id }, message: "Processo retirado da carteira ativa." };
  } catch (err) {
    return failure(err, "closeProcess", formData);
  }
}

export async function reactivateProcessAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  const id = idFrom(formData, "id");
  try {
    const ctx = await requireActionContext("process:write");
    await reactivateProcess(ctx, id, { note: strOrNull(formData, "note") });
    revalidatePath("/processos");
    revalidatePath(DETAIL(id));
    return { ok: true, data: { id }, message: "Processo reativado na carteira ativa." };
  } catch (err) {
    return failure(err, "reactivateProcess", formData);
  }
}

export async function flagVerificationAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  const id = idFrom(formData, "id");
  try {
    const ctx = await requireActionContext("process:write");
    await flagProcessForVerification(ctx, id, { note: str(formData, "note") ?? "" });
    revalidatePath("/processos");
    revalidatePath(DETAIL(id));
    return { ok: true, data: { id }, message: "Processo marcado para verificação." };
  } catch (err) {
    return failure(err, "flagProcessForVerification", formData);
  }
}

export async function resolveVerificationAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  const id = idFrom(formData, "id");
  try {
    const ctx = await requireActionContext("process:write");
    await resolveProcessVerification(ctx, id, { note: strOrNull(formData, "note") });
    revalidatePath("/processos");
    revalidatePath(DETAIL(id));
    return { ok: true, data: { id }, message: "Verificação concluída." };
  } catch (err) {
    return failure(err, "resolveProcessVerification", formData);
  }
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export async function addInstanceAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const processId = idFrom(formData, "processId");
    const { id } = await addProcessInstance(ctx, processId, instanceInputFromForm(formData));
    revalidatePath(DETAIL(processId));
    revalidatePath("/processos");
    return { ok: true, data: { id }, message: "Instância incluída." };
  } catch (err) {
    return failure(err, "addProcessInstance", formData);
  }
}

export async function updateInstanceAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const instanceId = idFrom(formData, "instanceId");
    const { processId } = await updateProcessInstance(ctx, instanceId, instanceInputFromForm(formData));
    revalidatePath(DETAIL(processId));
    revalidatePath("/processos");
    return { ok: true, data: { id: instanceId }, message: "Instância atualizada." };
  } catch (err) {
    return failure(err, "updateProcessInstance", formData);
  }
}

export async function removeInstanceAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId } = await removeProcessInstance(ctx, idFrom(formData, "instanceId"));
    revalidatePath(DETAIL(processId));
    return { ok: true, message: "Instância removida." };
  } catch (err) {
    return failure(err, "removeProcessInstance");
  }
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export async function addPartyAction(_prev: ProcessActionState | null, formData: FormData): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const processId = idFrom(formData, "processId");
    const { id } = await addParty(ctx, processId, partyInputFromForm(formData));
    revalidatePath(DETAIL(processId));
    revalidatePath("/processos");
    return { ok: true, data: { id }, message: "Parte adicionada." };
  } catch (err) {
    return failure(err, "addParty", formData);
  }
}

export async function updatePartyAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const partyId = idFrom(formData, "partyId");
    const { processId } = await updateParty(ctx, partyId, partyInputFromForm(formData));
    revalidatePath(DETAIL(processId));
    revalidatePath("/processos");
    return { ok: true, data: { id: partyId }, message: "Parte atualizada." };
  } catch (err) {
    return failure(err, "updateParty", formData);
  }
}

export async function removePartyAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId } = await removeParty(ctx, idFrom(formData, "partyId"));
    revalidatePath(DETAIL(processId));
    revalidatePath("/processos");
    return { ok: true, message: "Parte removida." };
  } catch (err) {
    return failure(err, "removeParty");
  }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export async function addProcessEventAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const processId = idFrom(formData, "processId");
    const { id } = await addProcessEvent(ctx, processId, eventInputFromForm(formData));
    revalidatePath(DETAIL(processId));
    revalidatePath("/processos");
    return { ok: true, data: { id }, message: "Movimentação registrada." };
  } catch (err) {
    return failure(err, "addProcessEvent", formData);
  }
}

export async function removeProcessEventAction(
  _prev: ProcessActionState | null,
  formData: FormData,
): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const { processId } = await removeProcessEvent(ctx, idFrom(formData, "eventId"));
    revalidatePath(DETAIL(processId));
    return { ok: true, message: "Movimentação removida." };
  } catch (err) {
    return failure(err, "removeProcessEvent");
  }
}
