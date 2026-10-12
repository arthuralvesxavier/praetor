"use server";

import { revalidatePath } from "next/cache";
import { str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type { CreateHearingInput, HearingStatusInput, UpdateHearingInput } from "./schemas";
import {
  createHearing,
  findVisibleProcessByNumber,
  getHearingProcessId,
  setHearingStatus,
  updateHearing,
} from "./service";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

function revalidateHearingPaths(processId: string) {
  revalidatePath(`/processos/${processId}`);
  revalidatePath("/audiencias");
  revalidatePath("/prazos");
  revalidatePath("/alertas");
}

function fieldsFromForm(fd: FormData): UpdateHearingInput {
  return {
    kind: str(fd, "kind") as UpdateHearingInput["kind"],
    mode: str(fd, "mode") as UpdateHearingInput["mode"],
    date: str(fd, "date") ?? "",
    time: str(fd, "time") ?? "",
    location: strOrNull(fd, "location"),
    meetingUrl: strOrNull(fd, "meetingUrl"),
    responsibleId: strOrNull(fd, "responsibleId"),
    notes: strOrNull(fd, "notes"),
  };
}

/**
 * Creates a hearing. The process comes either from the hidden `processId`
 * (process page) or from the typed `processNumber` (agenda page).
 */
export async function createHearingAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireActionContext("process:write");
    let processId = str(formData, "processId");
    if (!processId) {
      const found = await findVisibleProcessByNumber(ctx, str(formData, "processNumber") ?? "");
      processId = found.id;
    }
    const input: CreateHearingInput = { ...fieldsFromForm(formData), processId };
    const { id } = await createHearing(ctx, input);
    revalidateHearingPaths(processId);
    return { ok: true, data: { id }, message: "Audiência cadastrada." };
  } catch (err) {
    return fail("createHearing", err);
  }
}

export async function updateHearingAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("process:write");
    const id = str(formData, "id") ?? "";
    await updateHearing(ctx, id, fieldsFromForm(formData));
    revalidateHearingPaths(await getHearingProcessId(ctx, id));
    return { ok: true, message: "Audiência atualizada." };
  } catch (err) {
    return fail("updateHearing", err);
  }
}

/** Expects `id` and `status` (held | cancelled | rescheduled) plus the fields of that status. */
export async function setHearingStatusAction(
  _prev: ActionResult<{ newHearingId: string | null }> | null,
  formData: FormData,
): Promise<ActionResult<{ newHearingId: string | null }>> {
  try {
    const ctx = await requireActionContext("process:write");
    const id = str(formData, "id") ?? "";
    const status = str(formData, "status");
    let input: HearingStatusInput;
    if (status === "held") {
      input = { status, outcome: str(formData, "outcome") ?? "" };
    } else if (status === "cancelled") {
      input = { status, reason: strOrNull(formData, "reason") };
    } else if (status !== "rescheduled") {
      // Invalid / missing status: the service schema reports it.
      input = { status } as unknown as HearingStatusInput;
    } else {
      input = {
        status: "rescheduled",
        date: str(formData, "date") ?? "",
        time: str(formData, "time") ?? "",
        mode: str(formData, "mode") as Extract<HearingStatusInput, { status: "rescheduled" }>["mode"],
        location: strOrNull(formData, "location"),
        meetingUrl: strOrNull(formData, "meetingUrl"),
        reason: strOrNull(formData, "reason"),
      };
    }
    const result = await setHearingStatus(ctx, id, input);
    revalidateHearingPaths(await getHearingProcessId(ctx, id));
    const message =
      input.status === "held"
        ? "Resultado da audiência registrado."
        : input.status === "cancelled"
          ? "Audiência cancelada."
          : "Audiência redesignada: a nova data foi cadastrada.";
    return { ok: true, data: result, message };
  } catch (err) {
    return fail("setHearingStatus", err);
  }
}
