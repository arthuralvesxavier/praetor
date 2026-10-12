"use server";

import { revalidatePath } from "next/cache";
import { requireActionContext } from "@/server/auth/session";
import { PowerBiError } from "@/server/integrations/powerbi";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { errorSummary } from "@/modules/documents/log";
import { biSettingsFromFormData } from "./schemas";
import { requestBiRefresh, testPowerBiConnection, updateBiSettings, type BiConnectionTest } from "./service";

/**
 * Server actions dos painéis Power BI (administração). Finas: autenticam,
 * convertem o FormData e chamam o service, que valida e autoriza de novo.
 */

const ADMIN_PATH = "/admin/integracoes/power-bi";

function fail(action: string, err: unknown): { ok: false; error: string; fieldErrors?: Record<string, string[]> } {
  if (err instanceof PowerBiError) return { ok: false, error: err.userMessage };
  if (!(err instanceof AppError)) logger.error("action_failed", { action, ...errorSummary(err) });
  return toActionError(err);
}

export async function updateBiSettingsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("admin:organization");
    const { changed } = await updateBiSettings(ctx, biSettingsFromFormData(formData));
    revalidatePath(ADMIN_PATH);
    revalidatePath("/paineis-bi");
    return { ok: true, message: changed ? "Configuração dos painéis salva." : "Nenhuma alteração para salvar." };
  } catch (err) {
    return fail("updateBiSettings", err);
  }
}

export async function requestBiRefreshAction(): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("admin:organization");
    const { deduplicated } = await requestBiRefresh(ctx);
    revalidatePath(ADMIN_PATH);
    return {
      ok: true,
      message: deduplicated
        ? "Já existe uma atualização na fila. Ela será executada pelo processamento em segundo plano."
        : "Atualização enfileirada: os acessos serão recalculados e o Power BI será acionado em instantes.",
    };
  } catch (err) {
    return fail("requestBiRefresh", err);
  }
}

export async function testPowerBiConnectionAction(): Promise<ActionResult<BiConnectionTest>> {
  try {
    const ctx = await requireActionContext("admin:organization");
    const data = await testPowerBiConnection(ctx);
    return {
      ok: true,
      data,
      message:
        data.reports.length > 0
          ? `Conexão bem-sucedida: ${data.reports.length} relatório(s) encontrado(s) no workspace.`
          : "Conexão bem-sucedida, mas o workspace ainda não tem relatórios publicados.",
    };
  } catch (err) {
    return fail("testPowerBiConnection", err);
  }
}
