"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, moneyCents, str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type { PartyInput, ProcessEventInput, UpdateProcessInput } from "./schemas";
import {
  addParty,
  addProcessEvent,
  createProcess,
  deleteProcess,
  removeParty,
  removeProcessEvent,
  updateParty,
  updateProcess,
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

function processInputFromForm(fd: FormData): UpdateProcessInput {
  return {
    number: str(fd, "number"),
    title: str(fd, "title"),
    court: str(fd, "court"),
    courtDivision: strOrNull(fd, "courtDivision"),
    jurisdiction: strOrNull(fd, "jurisdiction"),
    area: str(fd, "area") as UpdateProcessInput["area"],
    phase: str(fd, "phase") as UpdateProcessInput["phase"],
    status: str(fd, "status") as UpdateProcessInput["status"],
    filedAt: strOrNull(fd, "filedAt"),
    closedAt: strOrNull(fd, "closedAt"),
    unitId: strOrNull(fd, "unitId"),
    responsibleId: strOrNull(fd, "responsibleId"),
    claimAmountCents: moneyCents(fd, "claimAmountCents"),
    provisionAmountCents: moneyCents(fd, "provisionAmountCents"),
    riskLevel: str(fd, "riskLevel") as UpdateProcessInput["riskLevel"],
    lossProbability: strOrNull(fd, "lossProbability") as UpdateProcessInput["lossProbability"],
    riskRationale: strOrNull(fd, "riskRationale"),
    description: strOrNull(fd, "description"),
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
    counselName: strOrNull(fd, "counselName"),
  };
}

function eventInputFromForm(fd: FormData): ProcessEventInput {
  return {
    occurredAt: str(fd, "occurredAt") as string,
    type: str(fd, "type") as ProcessEventInput["type"],
    title: str(fd, "title") as string,
    description: strOrNull(fd, "description"),
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
// Parties
// ---------------------------------------------------------------------------

export async function addPartyAction(_prev: ProcessActionState | null, formData: FormData): Promise<ProcessActionState> {
  try {
    const ctx = await requireActionContext("process:write");
    const processId = idFrom(formData, "processId");
    const { id } = await addParty(ctx, processId, partyInputFromForm(formData));
    revalidatePath(DETAIL(processId));
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
