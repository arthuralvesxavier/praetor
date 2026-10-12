import type { NextRequest } from "next/server";
import { errorSummary } from "@/modules/documents/log";
import { BiNotConfiguredError, createBiEmbedToken } from "@/modules/bi/service";
import { can } from "@/server/auth/permissions";
import { getCurrentUser } from "@/server/auth/session";
import { PowerBiError } from "@/server/integrations/powerbi";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/bi/embed-token?report=<id do relatório>
 *
 * Token de incorporação (somente leitura, curta duração) de um painel Power BI
 * cadastrado, com a identidade efetiva do usuário atual (RLS: mesmas regras de
 * visibilidade do Praetor). Exige sessão e `report:read`. Nunca devolve o
 * segredo do aplicativo nem o token do Microsoft Entra ID.
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function GET(request: NextRequest): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return json({ error: "Sessão expirada. Entre novamente." }, 401);
  if (!can(ctx, "report:read")) return json({ error: "Você não tem permissão para ver os painéis." }, 403);

  const reportId = request.nextUrl.searchParams.get("report");
  try {
    const embed = await createBiEmbedToken(ctx, reportId);
    return json(embed, 200);
  } catch (err) {
    if (err instanceof PowerBiError) {
      logger.warn("bi_embed_token_rejected", { userId: ctx.userId, code: err.code, status: err.status, serviceCode: err.serviceCode });
      return json({ error: err.userMessage }, 502);
    }
    if (err instanceof BiNotConfiguredError) return json({ error: err.message }, 503);
    if (err instanceof AppError) {
      if (err.code === "forbidden") return json({ error: err.message }, 403);
      if (err.code === "unauthenticated") return json({ error: err.message }, 401);
      if (err.code === "validation") return json({ error: err.message }, 400);
      if (err.code === "not_found") return json({ error: err.message }, 404);
      return json({ error: err.message }, 409);
    }
    logger.error("bi_embed_token_failed", { userId: ctx.userId, ...errorSummary(err) });
    return json({ error: "Não foi possível abrir o painel. Tente novamente." }, 500);
  }
}
