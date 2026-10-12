"use server";

import { revalidatePath } from "next/cache";
import { str, strings } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import type { CreatedApiKey } from "./schemas";
import { createApiKey, revokeApiKey } from "./service";

/**
 * Server actions of the API keys page. The full key travels back ONCE in the
 * action state (shown to the administrator, never stored or logged).
 */

export async function createApiKeyAction(_prev: ActionResult<CreatedApiKey> | null, fd: FormData): Promise<ActionResult<CreatedApiKey>> {
  try {
    const ctx = await requireActionContext("admin:organization");
    const created = await createApiKey(ctx, {
      name: str(fd, "name") ?? "",
      scopes: strings(fd, "scopes") as never,
      expiresOn: str(fd, "expiresOn") ?? null,
    });
    revalidatePath("/admin/integracoes/api");
    return {
      ok: true,
      data: { key: created.key, name: created.name, keyPrefix: created.keyPrefix },
      message: "Chave criada. Copie agora: ela não será mostrada de novo.",
    };
  } catch (err) {
    if (!(err instanceof AppError)) logger.error("action_failed", { action: "createApiKey", error: err });
    return toActionError(err);
  }
}

export async function revokeApiKeyAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("admin:organization");
    await revokeApiKey(ctx, str(fd, "id") ?? "");
    revalidatePath("/admin/integracoes/api");
    return { ok: true, message: "Chave revogada." };
  } catch (err) {
    if (!(err instanceof AppError)) logger.error("action_failed", { action: "revokeApiKey", error: err });
    return toActionError(err);
  }
}
