"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Role } from "@/domain/enums";
import { bool, int, str, strings } from "@/lib/form";
import type { Permission } from "@/server/auth/permissions";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import {
  createTeam,
  createUnit,
  createUser,
  deleteTeam,
  deleteUnit,
  processQueueNow,
  resetUserPassword,
  runRoutineNow,
  setUnitActive,
  setUserActive,
  updateOrganizationSettings,
  updateRoutine,
  updateTeam,
  updateUnit,
  updateUser,
} from "./service";

/**
 * Server actions of the administration area. Thin wrappers: authenticate,
 * translate FormData, call the service (which validates and authorizes again),
 * revalidate and map errors to pt-BR messages.
 */

type Result<T = undefined> = ActionResult<T>;

function fail(action: string, err: unknown) {
  if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
  return toActionError(err);
}

async function run<T>(
  action: string,
  permission: Permission,
  fn: (ctx: Awaited<ReturnType<typeof requireActionContext>>) => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    const ctx = await requireActionContext(permission);
    return await fn(ctx);
  } catch (err) {
    return fail(action, err);
  }
}

/** Integer field; missing -> NaN so the schema reports the field as required. */
function num(fd: FormData, key: string): number {
  return int(fd, key) ?? Number.NaN;
}

function idFrom(fd: FormData): string {
  return str(fd, "id") ?? "";
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function createUserAction(_prev: Result<{ id: string }> | null, fd: FormData): Promise<Result<{ id: string }>> {
  const result = await run<{ id: string }>("createUser", "admin:users", async (ctx) => {
    const created = await createUser(ctx, {
      name: str(fd, "name") ?? "",
      email: str(fd, "email") ?? "",
      role: (str(fd, "role") ?? "") as Role,
      unitId: str(fd, "unitId") ?? null,
      jobTitle: str(fd, "jobTitle") ?? null,
      password: (fd.get("password") as string | null) ?? "",
      teamIds: strings(fd, "teamIds"),
    });
    revalidatePath("/admin", "layout");
    return { ok: true, data: created, message: "Usuário criado." };
  });
  if (result.ok && result.data) redirect(`/admin/usuarios/${result.data.id}?criado=1`);
  return result;
}

export async function updateUserAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("updateUser", "admin:users", async (ctx) => {
    const id = idFrom(fd);
    await updateUser(ctx, id, {
      name: str(fd, "name") ?? "",
      role: (str(fd, "role") ?? "") as Role,
      unitId: str(fd, "unitId") ?? null,
      jobTitle: str(fd, "jobTitle") ?? null,
      isActive: bool(fd, "isActive"),
      teamIds: strings(fd, "teamIds"),
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Alterações salvas." };
  });
}

export async function setUserActiveAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("setUserActive", "admin:users", async (ctx) => {
    const active = str(fd, "active") === "1";
    await setUserActive(ctx, idFrom(fd), active);
    revalidatePath("/admin", "layout");
    return { ok: true, message: active ? "Usuário reativado." : "Usuário desativado e sessões encerradas." };
  });
}

export async function resetUserPasswordAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("resetUserPassword", "admin:users", async (ctx) => {
    await resetUserPassword(ctx, idFrom(fd), {
      password: (fd.get("password") as string | null) ?? "",
      confirmPassword: (fd.get("confirmPassword") as string | null) ?? "",
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Senha redefinida. As sessões ativas do usuário foram encerradas." };
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function teamInput(fd: FormData) {
  return {
    name: str(fd, "name") ?? "",
    description: str(fd, "description") ?? null,
    unitId: str(fd, "unitId") ?? null,
    leaderId: str(fd, "leaderId") ?? null,
    memberIds: strings(fd, "memberIds"),
  };
}

export async function createTeamAction(_prev: Result<{ id: string }> | null, fd: FormData): Promise<Result<{ id: string }>> {
  const result = await run<{ id: string }>("createTeam", "admin:users", async (ctx) => {
    const created = await createTeam(ctx, teamInput(fd));
    revalidatePath("/admin", "layout");
    return { ok: true, data: created, message: "Equipe criada." };
  });
  if (result.ok && result.data) redirect(`/admin/equipes/${result.data.id}?criado=1`);
  return result;
}

export async function updateTeamAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("updateTeam", "admin:users", async (ctx) => {
    await updateTeam(ctx, idFrom(fd), teamInput(fd));
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Alterações salvas." };
  });
}

export async function deleteTeamAction(_prev: Result | null, fd: FormData): Promise<Result> {
  const result = await run<undefined>("deleteTeam", "admin:users", async (ctx) => {
    await deleteTeam(ctx, idFrom(fd));
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Equipe excluída." };
  });
  if (result.ok) redirect("/admin/equipes");
  return result;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export async function createUnitAction(_prev: Result<{ id: string }> | null, fd: FormData): Promise<Result<{ id: string }>> {
  const result = await run<{ id: string }>("createUnit", "admin:users", async (ctx) => {
    const created = await createUnit(ctx, { name: str(fd, "name") ?? "", code: str(fd, "code") ?? null });
    revalidatePath("/admin", "layout");
    return { ok: true, data: created, message: "Unidade criada." };
  });
  if (result.ok && result.data) redirect(`/admin/unidades/${result.data.id}?criado=1`);
  return result;
}

export async function updateUnitAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("updateUnit", "admin:users", async (ctx) => {
    await updateUnit(ctx, idFrom(fd), {
      name: str(fd, "name") ?? "",
      code: str(fd, "code") ?? null,
      isActive: bool(fd, "isActive"),
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Alterações salvas." };
  });
}

export async function setUnitActiveAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("setUnitActive", "admin:users", async (ctx) => {
    const active = str(fd, "active") === "1";
    await setUnitActive(ctx, idFrom(fd), active);
    revalidatePath("/admin", "layout");
    return { ok: true, message: active ? "Unidade reativada." : "Unidade desativada." };
  });
}

export async function deleteUnitAction(_prev: Result | null, fd: FormData): Promise<Result> {
  let deleted = false;
  const result = await run<undefined>("deleteUnit", "admin:users", async (ctx) => {
    const { outcome } = await deleteUnit(ctx, idFrom(fd));
    revalidatePath("/admin", "layout");
    deleted = outcome === "deleted";
    return {
      ok: true,
      message: deleted
        ? "Unidade excluída."
        : "A unidade possui vínculos (usuários, equipes ou registros) e foi desativada em vez de excluída.",
    };
  });
  if (result.ok && deleted) redirect("/admin/unidades");
  return result;
}

// ---------------------------------------------------------------------------
// Organization settings & routines
// ---------------------------------------------------------------------------

export async function updateOrganizationSettingsAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("updateOrganizationSettings", "admin:organization", async (ctx) => {
    await updateOrganizationSettings(ctx, {
      name: str(fd, "name") ?? "",
      monthlyTokenBudget: num(fd, "monthlyTokenBudget"),
      maxInputChars: num(fd, "maxInputChars"),
      autoAnalyzeOnUpload: bool(fd, "autoAnalyzeOnUpload"),
      upcomingDeadlineDays: num(fd, "upcomingDeadlineDays"),
      contractExpirationDays: num(fd, "contractExpirationDays"),
      closedRecordRetentionDays: num(fd, "closedRecordRetentionDays"),
      auditLogRetentionDays: num(fd, "auditLogRetentionDays"),
    });
    // The organization name and alert thresholds appear across the app.
    revalidatePath("/", "layout");
    return { ok: true, message: "Configurações salvas." };
  });
}

export async function updateRoutineAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("updateRoutine", "admin:organization", async (ctx) => {
    const hasStaleConfig = fd.has("maxPerRun");
    await updateRoutine(ctx, idFrom(fd), {
      enabled: bool(fd, "enabled"),
      intervalMinutes: num(fd, "intervalMinutes"),
      ...(hasStaleConfig ? { autoRefresh: bool(fd, "autoRefresh"), maxPerRun: num(fd, "maxPerRun") } : {}),
    });
    revalidatePath("/admin/configuracoes");
    return { ok: true, message: "Rotina atualizada." };
  });
}

export async function runRoutineNowAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("runRoutineNow", "admin:organization", async (ctx) => {
    const { deduplicated } = await runRoutineNow(ctx, idFrom(fd));
    revalidatePath("/admin/configuracoes");
    return {
      ok: true,
      message: deduplicated
        ? "Esta rotina já está na fila de execução."
        : "Execução colocada na fila. Use “Processar fila agora” se não houver worker em execução.",
    };
  });
}

/** Signature-compatible with useActionState (prev state and form data are not needed). */
export async function processQueueNowAction(): Promise<Result> {
  return run("processQueueNow", "admin:organization", async (ctx) => {
    const { processed } = await processQueueNow(ctx);
    revalidatePath("/", "layout");
    return {
      ok: true,
      message:
        processed === 0
          ? "Nenhuma tarefa pendente na fila."
          : `${processed} ${processed === 1 ? "tarefa processada" : "tarefas processadas"}.`,
    };
  });
}
