import type { NextRequest } from "next/server";
import { ISSUE_LEVELS } from "@/domain/enums";
import { enumParam, param, type SearchParams } from "@/lib/search-params";
import { issuesToCsv } from "@/modules/imports/csv";
import { attachmentDisposition, errorSummary, jsonResponse } from "@/modules/imports/http";
import { listAllImportIssues } from "@/modules/imports/service";
import { getCurrentUser } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/imports/:id/issues?planilha=&nivel=&codigo=
 * CSV (UTF-8 with BOM, ";" separator) with every issue of the batch matching the filters.
 */
export async function GET(request: NextRequest, context: RouteContext<"/api/imports/[id]/issues">): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return jsonResponse({ error: "Sessão expirada. Entre novamente." }, 401);
  const { id } = await context.params;
  const sp: SearchParams = Object.fromEntries(request.nextUrl.searchParams.entries());
  const code = param(sp, "codigo");

  try {
    const { fileName, items } = await listAllImportIssues(ctx, id, {
      sheet: param(sp, "planilha"),
      level: enumParam(sp, "nivel", ISSUE_LEVELS),
      code: code && /^[a-z_]{1,60}$/.test(code) ? code : undefined,
    });
    const base = fileName.replace(/\.xlsx$/i, "");
    return new Response(issuesToCsv(items), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": attachmentDisposition(`inconsistencias-${base}.csv`, "inconsistencias.csv"),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "forbidden") return jsonResponse({ error: err.message }, 403);
      return jsonResponse({ error: "Importação não encontrada ou sem permissão de acesso." }, 404);
    }
    logger.error("import_issues_export_failed", { userId: ctx.userId, batchId: id, ...errorSummary(err) });
    return jsonResponse({ error: "Não foi possível exportar as inconsistências. Tente novamente." }, 500);
  }
}
