import type { NextRequest } from "next/server";
import { attachmentDisposition } from "@/modules/documents/content-disposition";
import { openLegalReportPdf } from "@/modules/legal-reports/service";
import { getCurrentUser } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/legal-reports/:id/pdf
 *
 * PDF armazenado do relatório (o mesmo hash registrado), para quem pode ver o
 * relatório (404 caso contrário, sem revelar a existência). Download auditado
 * pelo serviço.
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_request: NextRequest, context: RouteContext<"/api/legal-reports/[id]/pdf">): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return json({ error: "Sessão expirada. Entre novamente." }, 401);
  if (!can(ctx, "report:read")) return json({ error: "Você não tem permissão para baixar relatórios." }, 403);
  const { id } = await context.params;
  try {
    const file = await openLegalReportPdf(ctx, id);
    return new Response(new Blob([file.bytes as BlobPart], { type: "application/pdf" }), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": attachmentDisposition(file.fileName),
        "Content-Length": String(file.bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-SHA256": file.sha256,
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "forbidden") return json({ error: err.message }, 403);
      if (err.code === "unauthenticated") return json({ error: err.message }, 401);
      if (err.code === "conflict") return json({ error: err.message }, 409);
      return json({ error: "Relatório não encontrado ou sem permissão de acesso." }, 404);
    }
    logger.error("legal_report_download_failed", { userId: ctx.userId, reportId: id, errorName: err instanceof Error ? err.name : "unknown" });
    return json({ error: "Não foi possível baixar o PDF. Tente novamente." }, 500);
  }
}
