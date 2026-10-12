import type { NextRequest } from "next/server";
import { exportSnapshotCsv } from "@/modules/contingency/snapshot-service";
import { getCurrentUser } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/contingency/snapshots/:period/csv
 *
 * CSV "pronto para a contabilidade" of a competência (RF-16, TE-06): UTF-8
 * with BOM, `;`, decimal comma, empty cells for null values (RN-03), one row
 * per visible process with the memória de cálculo and the RN-07 caveat.
 * Read-only (no state change besides the audit entry of the export).
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ period: string }> }): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return json({ error: "Sessão expirada. Entre novamente." }, 401);
  const { period } = await context.params;

  try {
    const { fileName, content } = await exportSnapshotCsv(ctx, period);
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "forbidden") return json({ error: err.message }, 403);
      if (err.code === "unauthenticated") return json({ error: err.message }, 401);
      if (err.code === "validation") return json({ error: err.message }, 400);
      return json({ error: err.message }, 404);
    }
    logger.error("snapshot_csv_failed", {
      userId: ctx.userId,
      period,
      error: err instanceof Error ? err.name : "unknown",
      code: (err as { code?: unknown } | null)?.code ?? null,
    });
    return json({ error: "Não foi possível gerar o arquivo. Tente novamente." }, 500);
  }
}
