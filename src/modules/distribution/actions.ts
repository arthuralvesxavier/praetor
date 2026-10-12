"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, int, moneyCents, str, strOrNull, strings } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { splitList, type RuleInput } from "./schemas";
import {
  assignResponsible,
  createRule,
  deleteRule,
  moveRule,
  reassignResponsible,
  setRuleActive,
  updateRule,
} from "./service";

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

function ruleFromForm(fd: FormData): RuleInput {
  return {
    name: str(fd, "name") ?? "",
    description: strOrNull(fd, "description"),
    priority: int(fd, "priority") as number,
    isActive: bool(fd, "isActive"),
    courts: splitList(str(fd, "courts")),
    areas: strings(fd, "areas") as RuleInput["areas"],
    companyIds: strings(fd, "companyIds"),
    unitIds: strings(fd, "unitIds"),
    states: splitList(str(fd, "states")),
    cities: splitList(str(fd, "cities")),
    instances: strings(fd, "instances") as RuleInput["instances"],
    processClasses: splitList(str(fd, "processClasses")),
    minClaimCents: moneyCents(fd, "minClaim"),
    maxClaimCents: moneyCents(fd, "maxClaim"),
    method: str(fd, "method") as RuleInput["method"],
    userIds: strings(fd, "userIds"),
    lawFirmId: strOrNull(fd, "lawFirmId"),
    assignUnitId: strOrNull(fd, "assignUnitId"),
  };
}

function revalidateDistribution() {
  revalidatePath("/distribuicao");
}

export async function createRuleAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("distribution:manage");
    await createRule(ctx, ruleFromForm(formData));
    revalidateDistribution();
  } catch (err) {
    return fail("createDistributionRule", err);
  }
  redirect("/distribuicao?aba=regras");
}

export async function updateRuleAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("distribution:manage");
    await updateRule(ctx, str(formData, "id") ?? "", ruleFromForm(formData));
    revalidateDistribution();
  } catch (err) {
    return fail("updateDistributionRule", err);
  }
  redirect("/distribuicao?aba=regras");
}

export async function deleteRuleAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("distribution:manage");
    await deleteRule(ctx, str(formData, "id") ?? "");
    revalidateDistribution();
    return { ok: true, message: "Regra excluída." };
  } catch (err) {
    return fail("deleteDistributionRule", err);
  }
}

export async function setRuleActiveAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("distribution:manage");
    const active = str(formData, "active") === "1";
    await setRuleActive(ctx, str(formData, "id") ?? "", active);
    revalidateDistribution();
    return { ok: true, message: active ? "Regra ativada." : "Regra desativada." };
  } catch (err) {
    return fail("setDistributionRuleActive", err);
  }
}

export async function moveRuleAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("distribution:manage");
    const direction = str(formData, "direction") === "down" ? "down" : "up";
    await moveRule(ctx, str(formData, "id") ?? "", direction);
    revalidateDistribution();
    return { ok: true, message: "Ordem atualizada." };
  } catch (err) {
    return fail("moveDistributionRule", err);
  }
}

/** Applies the rules to the process now, replacing the current responsible when needed. */
export async function applyDistributionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("distribution:manage");
    const processId = str(formData, "processId") ?? "";
    const decision = await assignResponsible(ctx, processId, { force: true });
    revalidateDistribution();
    revalidatePath(`/processos/${processId}`);
    if (!decision.userId) return { ok: false, error: decision.reason };
    return { ok: true, message: `Processo distribuído para ${decision.userName}. ${decision.reason}` };
  } catch (err) {
    return fail("applyDistribution", err);
  }
}

export async function reassignProcessAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("distribution:manage");
    const processId = str(formData, "processId") ?? "";
    const decision = await reassignResponsible(ctx, processId, {
      userId: str(formData, "userId") ?? "",
      reason: str(formData, "reason") ?? "",
    });
    revalidateDistribution();
    revalidatePath(`/processos/${processId}`);
    return { ok: true, message: `Processo redistribuído para ${decision.userName}.` };
  } catch (err) {
    return fail("reassignProcess", err);
  }
}
