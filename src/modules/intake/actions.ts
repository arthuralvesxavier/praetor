"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { int, moneyCents, str, strOrNull } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type { RegisterIntakeInput } from "./schemas";
import {
  assignIntakeManually,
  autoAssignIntake,
  regenerateIntakeBrief,
  registerIncomingProcess,
  requestIntakeProcessing,
  resendIntakeEmail,
  simulateIncomingProcess,
} from "./service";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

function revalidateIntake(intakeId?: string, processId?: string) {
  revalidatePath("/entrada");
  if (intakeId) revalidatePath(`/entrada/${intakeId}`);
  if (processId) revalidatePath(`/processos/${processId}`);
}

function intakeFromForm(fd: FormData): RegisterIntakeInput {
  return {
    number: str(fd, "number") ?? "",
    court: str(fd, "court") ?? "",
    courtDivision: strOrNull(fd, "courtDivision"),
    city: strOrNull(fd, "city"),
    state: str(fd, "state") ?? "",
    processClass: strOrNull(fd, "processClass"),
    area: str(fd, "area") as RegisterIntakeInput["area"],
    phase: str(fd, "phase") as RegisterIntakeInput["phase"],
    instance: str(fd, "instance") as RegisterIntakeInput["instance"],
    companyId: str(fd, "companyId") ?? "",
    unitId: str(fd, "unitId") ?? "",
    responsibleId: str(fd, "responsibleId") ?? "",
    claimAmountCents: moneyCents(fd, "claimAmount"),
    filedAt: str(fd, "filedAt") ?? "",
    plaintiffName: str(fd, "plaintiffName") ?? "",
    defendantName: strOrNull(fd, "defendantName"),
    title: strOrNull(fd, "title"),
    description: strOrNull(fd, "description"),
  };
}

/**
 * Step 1 of the registration form: creates process + intake WITHOUT starting
 * the pipeline. The form then uploads the files to /api/documents/upload and
 * calls `startIntakeProcessingAction`. Files never go through this action.
 */
export async function registerIntakeAction(
  _prev: ActionResult<{ intakeId: string; processId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ intakeId: string; processId: string }>> {
  try {
    const ctx = await requireActionContext("intake:manage");
    const result = await registerIncomingProcess(ctx, { ...intakeFromForm(formData), source: "manual", deferProcessing: true });
    revalidateIntake(result.intakeId, result.processId);
    return { ok: true, data: { intakeId: result.intakeId, processId: result.processId }, message: "Processo registrado." };
  } catch (err) {
    return fail("registerIntake", err);
  }
}

/** Step 2 of the registration form (after the uploads): enqueues the pipeline. */
export async function startIntakeProcessingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const intakeId = str(formData, "intakeId") ?? "";
  try {
    const ctx = await requireActionContext("intake:manage");
    await requestIntakeProcessing(ctx, intakeId, { reason: "start", failedUploads: int(formData, "failedUploads") ?? 0 });
    revalidateIntake(intakeId);
    return { ok: true, message: "Processamento iniciado." };
  } catch (err) {
    return fail("startIntakeProcessing", err);
  }
}

/** DEMO: creates a fictitious incoming case and opens its pipeline. */
export async function simulateIntakeAction(): Promise<ActionResult> {
  let intakeId: string;
  try {
    const ctx = await requireActionContext("intake:manage");
    const result = await simulateIncomingProcess(ctx);
    intakeId = result.intakeId;
    revalidateIntake(result.intakeId, result.processId);
  } catch (err) {
    return fail("simulateIntake", err);
  }
  redirect(`/entrada/${intakeId}`);
}

export async function retryIntakeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const intakeId = str(formData, "intakeId") ?? "";
  try {
    const ctx = await requireActionContext("intake:manage");
    const { deduplicated } = await requestIntakeProcessing(ctx, intakeId, { reason: "retry" });
    revalidateIntake(intakeId);
    return {
      ok: true,
      message: deduplicated
        ? "Já existe um processamento agendado para esta entrada; ele será executado em instantes."
        : "Reprocessamento agendado.",
    };
  } catch (err) {
    return fail("retryIntake", err);
  }
}

export async function autoAssignIntakeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const intakeId = str(formData, "intakeId") ?? "";
  try {
    const ctx = await requireActionContext();
    const decision = await autoAssignIntake(ctx, intakeId);
    revalidateIntake(intakeId);
    return { ok: true, message: `Responsável definido: ${decision.userName}.` };
  } catch (err) {
    return fail("autoAssignIntake", err);
  }
}

export async function assignIntakeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const intakeId = str(formData, "intakeId") ?? "";
  try {
    const ctx = await requireActionContext();
    const decision = await assignIntakeManually(ctx, intakeId, {
      userId: str(formData, "userId") ?? "",
      reason: str(formData, "reason") ?? "",
    });
    revalidateIntake(intakeId);
    return { ok: true, message: `Responsável alterado para ${decision.userName}. O novo responsável será avisado por e-mail (simulado).` };
  } catch (err) {
    return fail("assignIntake", err);
  }
}

export async function regenerateIntakeBriefAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const intakeId = str(formData, "intakeId") ?? "";
  try {
    const ctx = await requireActionContext("intake:manage");
    await regenerateIntakeBrief(ctx, intakeId);
    revalidateIntake(intakeId);
    revalidatePath("/analises-preliminares");
    return { ok: true, message: "Nova análise preliminar (simulação) gerada." };
  } catch (err) {
    revalidateIntake(intakeId);
    return fail("regenerateIntakeBrief", err);
  }
}

export async function resendIntakeEmailAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const intakeId = str(formData, "intakeId") ?? "";
  try {
    const ctx = await requireActionContext("email:send");
    await resendIntakeEmail(ctx, intakeId);
    revalidateIntake(intakeId);
    revalidatePath("/emails");
    return { ok: true, message: "E-mail simulado registrado na Central de e-mails — nenhuma mensagem real foi enviada." };
  } catch (err) {
    return fail("resendIntakeEmail", err);
  }
}
