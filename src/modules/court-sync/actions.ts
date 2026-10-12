"use server";

import { revalidatePath } from "next/cache";
import { bool, int, str } from "@/lib/form";
import type { Permission } from "@/server/auth/permissions";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { requestPortfolioSync, syncProcessNow, updateCourtIntegrationSettings } from "./service";

/**
 * Server actions of the court-sync module (thin wrappers: authenticate,
 * translate FormData, call the service, revalidate, map errors to pt-BR).
 */

type Result = ActionResult;

async function run(action: string, permission: Permission, fn: (ctx: Awaited<ReturnType<typeof requireActionContext>>) => Promise<Result>): Promise<Result> {
  try {
    const ctx = await requireActionContext(permission);
    return await fn(ctx);
  } catch (err) {
    if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
    return toActionError(err);
  }
}

const num = (fd: FormData, key: string) => int(fd, key) ?? Number.NaN;

/** "Sincronizar agora" on one process. */
export async function syncProcessNowAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("syncProcessNow", "court_sync:run", async (ctx) => {
    const processId = str(fd, "processId") ?? "";
    const result = await syncProcessNow(ctx, processId);
    revalidatePath(`/processos/${processId}`);
    if (result.status === "found" || result.status === "not_found") return { ok: true, message: result.message };
    return { ok: false, error: result.message };
  });
}

/** "Sincronizar a carteira agora" (admin). */
export async function requestPortfolioSyncAction(): Promise<Result> {
  return run("requestPortfolioSync", "admin:organization", async (ctx) => {
    const { jobs, processes } = await requestPortfolioSync(ctx);
    revalidatePath("/admin/integracoes/datajud");
    return {
      ok: true,
      message:
        processes === 0
          ? "Nenhum processo da carteira ativa com número CNJ consultável: nada a sincronizar."
          : jobs > 0
            ? `Sincronização solicitada: ${processes} processo(s) em ${jobs} tarefa(s) na fila. Acompanhe nesta página.`
            : "Uma sincronização completa pedida antes ainda está na fila. Acompanhe nesta página.",
    };
  });
}

export async function updateCourtIntegrationSettingsAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("updateCourtIntegrationSettings", "admin:organization", async (ctx) => {
    await updateCourtIntegrationSettings(ctx, {
      enabled: bool(fd, "enabled"),
      syncIntervalHours: num(fd, "syncIntervalHours"),
      maxRequestsPerMinute: num(fd, "maxRequestsPerMinute"),
      batchSize: num(fd, "batchSize"),
      autoApplyPhase: bool(fd, "autoApplyPhase"),
      enrichOnIntake: bool(fd, "enrichOnIntake"),
      simulatedFeedEnabled: bool(fd, "simulatedFeedEnabled"),
      simulatedFeedIntervalMinutes: num(fd, "simulatedFeedIntervalMinutes"),
    });
    revalidatePath("/admin/integracoes/datajud");
    revalidatePath("/admin/integracoes");
    return { ok: true, message: "Parâmetros salvos." };
  });
}
