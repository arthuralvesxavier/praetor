"use server";

import { revalidatePath } from "next/cache";
import type { DeadlineStatus, TaskStatus } from "@/domain/enums";
import { str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, ValidationError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type { DeadlineInput, TaskInput } from "./schemas";
import {
  createDeadline,
  createTask,
  deleteTask,
  searchWorkLinkProcesses,
  setDeadlineStatus,
  updateTask,
  validateDeadline,
} from "./service";
import type { WorkProcessHit } from "./types";

/**
 * Thin server actions over ./service (which validates everything with zod and
 * enforces permissions + row visibility). All work mutations change counters
 * shown in many places (dashboard, entity pages, tabs), so the whole app
 * layout is revalidated.
 */

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

function revalidateWork() {
  revalidatePath("/", "layout");
}

/**
 * Link fields: either a combined `link` select ("legal_process:<id>",
 * "occurrence:<id>", "contract:<id>") or fixed hidden fields processId /
 * occurrenceId / contractId (entity pages).
 */
function linkFields(fd: FormData): { processId?: string; occurrenceId?: string; contractId?: string } {
  const link = str(fd, "link");
  if (link) {
    const [type, id] = link.split(":", 2);
    // A link type was chosen but no record (e.g. "Processo" without picking a search result).
    if (!id) throw new ValidationError(undefined, { link: ["Selecione o registro a vincular ou escolha “Sem vínculo”."] });
    if (type === "legal_process") return { processId: id };
    if (type === "occurrence") return { occurrenceId: id };
    if (type === "contract") return { contractId: id };
    return { processId: "invalid" };
  }
  return { processId: str(fd, "processId"), occurrenceId: str(fd, "occurrenceId"), contractId: str(fd, "contractId") };
}

/** Maps service field errors of the hidden link ids onto the visible "link" select. */
function withLinkFieldError(result: ActionResult<{ id: string }>): ActionResult<{ id: string }> {
  if (result.ok || !result.fieldErrors) return result;
  const fe = { ...result.fieldErrors };
  const linkErrors = [...(fe.processId ?? []), ...(fe.occurrenceId ?? []), ...(fe.contractId ?? [])];
  if (linkErrors.length > 0) fe.link = linkErrors;
  return { ...result, fieldErrors: fe };
}

/** Process search of the deadline/task forms (called directly by the client field; at least 2 characters). */
export async function searchWorkLinkProcessesAction(query: string): Promise<ActionResult<WorkProcessHit[]>> {
  try {
    const ctx = await requireActionContext();
    return { ok: true, data: await searchWorkLinkProcesses(ctx, query) };
  } catch (err) {
    return fail("searchWorkLinkProcesses", err);
  }
}

export async function createDeadlineAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireActionContext("deadline:write");
    const input = {
      title: str(formData, "title"),
      description: strOrNull(formData, "description"),
      dueDate: str(formData, "dueDate"),
      kind: str(formData, "kind"),
      priority: str(formData, "priority"),
      responsibleId: str(formData, "responsibleId") ?? null,
      ...linkFields(formData),
    } as DeadlineInput;
    const { id } = await createDeadline(ctx, input);
    revalidateWork();
    return { ok: true, data: { id }, message: "Prazo cadastrado." };
  } catch (err) {
    return withLinkFieldError(fail("createDeadline", err));
  }
}

export async function setDeadlineStatusAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("deadline:write");
    const status = str(formData, "status") as DeadlineStatus;
    await setDeadlineStatus(ctx, str(formData, "id") ?? "", status);
    revalidateWork();
    const message =
      status === "done" ? "Prazo marcado como cumprido." : status === "cancelled" ? "Prazo cancelado." : "Prazo reaberto.";
    return { ok: true, message };
  } catch (err) {
    return fail("setDeadlineStatus", err);
  }
}

export async function validateDeadlineAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("deadline:validate");
    const decision = str(formData, "decision") as "validated" | "rejected";
    await validateDeadline(ctx, str(formData, "id") ?? "", {
      decision,
      note: strOrNull(formData, "note"),
      dueDate: decision === "validated" ? (str(formData, "dueDate") ?? null) : null,
      responsibleId: decision === "validated" ? (str(formData, "responsibleId") ?? null) : null,
    });
    revalidateWork();
    return {
      ok: true,
      message: decision === "validated" ? "Prazo validado. Ele passa a contar como prazo real." : "Sugestão de prazo rejeitada.",
    };
  } catch (err) {
    return fail("validateDeadline", err);
  }
}

export async function createTaskAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireActionContext("task:write");
    const input = {
      title: str(formData, "title"),
      description: strOrNull(formData, "description"),
      kind: str(formData, "kind"),
      priority: str(formData, "priority"),
      dueDate: str(formData, "dueDate") ?? null,
      assigneeId: str(formData, "assigneeId") ?? null,
      ...linkFields(formData),
    } as TaskInput;
    const { id } = await createTask(ctx, input);
    revalidateWork();
    return { ok: true, data: { id }, message: "Tarefa criada." };
  } catch (err) {
    return withLinkFieldError(fail("createTask", err));
  }
}

export async function updateTaskStatusAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("task:write");
    await updateTask(ctx, str(formData, "id") ?? "", { status: str(formData, "status") as TaskStatus });
    revalidateWork();
    return { ok: true, message: "Status da tarefa atualizado." };
  } catch (err) {
    return fail("updateTaskStatus", err);
  }
}

export async function deleteTaskAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("task:write");
    await deleteTask(ctx, str(formData, "id") ?? "");
    revalidateWork();
    return { ok: true, message: "Tarefa excluída." };
  } catch (err) {
    return fail("deleteTask", err);
  }
}
