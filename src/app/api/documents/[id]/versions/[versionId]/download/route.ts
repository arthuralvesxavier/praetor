import type { NextRequest } from "next/server";
import { attachmentDisposition } from "@/modules/documents/content-disposition";
import { errorSummary } from "@/modules/documents/log";
import { openDocumentVersion } from "@/modules/documents/service";
import { getCurrentUser } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/documents/:id/versions/:versionId/download
 *
 * Streams a document version to an authenticated user who can see the
 * document (404 otherwise, never revealing existence). Always served as an
 * attachment with the MIME type detected at upload and `nosniff`.
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/documents/[id]/versions/[versionId]/download">,
): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return json({ error: "Sessão expirada. Entre novamente." }, 401);
  const { id, versionId } = await context.params;

  try {
    const file = await openDocumentVersion(ctx, id, versionId);
    const contentType = file.mimeType.startsWith("text/") ? `${file.mimeType}; charset=utf-8` : file.mimeType;
    return new Response(file.stream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": attachmentDisposition(file.fileName),
        "Content-Length": String(file.sizeBytes),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "forbidden") return json({ error: err.message }, 403);
      if (err.code === "unauthenticated") return json({ error: err.message }, 401);
      return json({ error: "Documento não encontrado ou sem permissão de acesso." }, 404);
    }
    logger.error("document_download_failed", { userId: ctx.userId, documentId: id, versionId, ...errorSummary(err) });
    return json({ error: "Não foi possível baixar o arquivo. Tente novamente." }, 500);
  }
}
