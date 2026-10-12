import type { NextRequest } from "next/server";
import { attachmentDisposition } from "@/modules/documents/content-disposition";
import { exportProvisionMemo } from "@/modules/provision-memo/service";
import { getCurrentUser } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/provision-memo/:period?formato=xlsx|pdf
 *
 * Memória de cálculo da provisão da competência (P1.10): XLSX (abas "Memória"
 * e "Totais") ou PDF (motor de relatórios). Lida dos itens guardados da
 * competência; linhas pela visibilidade da pessoa, totais pela política da
 * página de provisão. Só leitura (o download é auditado pelo serviço).
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest, context: { params: Promise<{ period: string }> }): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return json({ error: "Sessão expirada. Entre novamente." }, 401);
  if (!can(ctx, "contingency:read")) return json({ error: "Você não tem permissão para consultar a provisão." }, 403);
  const { period } = await context.params;
  const format = request.nextUrl.searchParams.get("formato");

  try {
    const file = await exportProvisionMemo(ctx, period, format);
    return new Response(new Blob([file.bytes as BlobPart], { type: file.contentType }), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": attachmentDisposition(file.fileName),
        "Content-Length": String(file.bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "forbidden") return json({ error: err.message }, 403);
      if (err.code === "unauthenticated") return json({ error: err.message }, 401);
      if (err.code === "validation") return json({ error: err.message }, 400);
      return json({ error: err.message }, 404);
    }
    logger.error("provision_memo_export_failed", {
      userId: ctx.userId,
      period,
      errorName: err instanceof Error ? err.name : "unknown",
      code: (err as { code?: unknown } | null)?.code ?? null,
    });
    return json({ error: "Não foi possível gerar o arquivo. Tente novamente." }, 500);
  }
}
