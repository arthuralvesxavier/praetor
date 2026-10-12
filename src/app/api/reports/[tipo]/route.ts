import type { NextRequest } from "next/server";
import { attachmentDisposition } from "@/modules/documents/content-disposition";
import { errorSummary } from "@/modules/documents/log";
import { exportFormatFromParam, isReportType, reportFiltersFromParams } from "@/modules/reports/schemas";
import { exportReport } from "@/modules/reports/service";
import { getCurrentUser } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/reports/<tipo>?formato=csv|xlsx&empresa=&unidade=&competencia=&de=&ate=
 *
 * Exports a report (RF-17) for an authenticated user with `report:read`. Row
 * visibility is applied by the service; the export is audited
 * (`report.export`: type, format, filters, row count — never content).
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest, context: RouteContext<"/api/reports/[tipo]">): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return json({ error: "Sessão expirada. Entre novamente." }, 401);
  if (!can(ctx, "report:read")) return json({ error: "Você não tem permissão para exportar relatórios." }, 403);

  const { tipo } = await context.params;
  if (!isReportType(tipo)) return json({ error: "Relatório não encontrado." }, 404);

  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const format = exportFormatFromParam(sp.formato);
  if (!format) return json({ error: "Formato inválido. Use formato=csv ou formato=xlsx." }, 400);

  try {
    const file = await exportReport(ctx, tipo, reportFiltersFromParams(sp), format);
    return new Response(Buffer.from(file.body), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": attachmentDisposition(file.fileName),
        "Content-Length": String(file.body.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "forbidden") return json({ error: err.message }, 403);
      if (err.code === "unauthenticated") return json({ error: err.message }, 401);
      if (err.code === "validation") return json({ error: err.message, fieldErrors: err.fieldErrors ?? null }, 400);
      return json({ error: err.message }, 404);
    }
    logger.error("report_export_failed", { userId: ctx.userId, reportType: tipo, format, ...errorSummary(err) });
    return json({ error: "Não foi possível gerar o arquivo. Tente novamente." }, 500);
  }
}
