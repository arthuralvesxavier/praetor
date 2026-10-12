import type { NextRequest } from "next/server";
import { attachmentDisposition, errorSummary, jsonResponse } from "@/modules/imports/http";
import { openImportFile } from "@/modules/imports/service";
import { getCurrentUser } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/** GET /api/imports/:id/file — original spreadsheet of the batch (traceability; audited). */
export async function GET(_request: NextRequest, context: RouteContext<"/api/imports/[id]/file">): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return jsonResponse({ error: "Sessão expirada. Entre novamente." }, 401);
  const { id } = await context.params;
  try {
    const file = await openImportFile(ctx, id);
    return new Response(file.stream, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": attachmentDisposition(file.fileName, "planilha.xlsx"),
        "Content-Length": String(file.sizeBytes),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "forbidden") return jsonResponse({ error: err.message }, 403);
      return jsonResponse({ error: err.message || "Arquivo não encontrado." }, 404);
    }
    logger.error("import_file_download_failed", { userId: ctx.userId, batchId: id, ...errorSummary(err) });
    return jsonResponse({ error: "Não foi possível baixar o arquivo. Tente novamente." }, 500);
  }
}
