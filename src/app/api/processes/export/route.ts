import type { NextRequest } from "next/server";
import { todayISO } from "@/lib/format";
import { buildProcessCsv, buildProcessXlsx } from "@/modules/processes/export";
import { processFiltersFromSearchParams } from "@/modules/processes/filters";
import { exportProcesses, type ProcessExportFormat } from "@/modules/processes/service";
import { getCurrentUser } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/processes/export?<same params as /processos>&formato=csv|xlsx
 *
 * Downloads the filtered portfolio (row visibility of the current user). The
 * service records the `legal_process.export` audit entry (filters and count,
 * no data). Errors are plain pt-BR text (the request is a browser download).
 */

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return text("Sessão expirada. Entre novamente.", 401);
  if (!can(ctx, "process:read")) return text("Você não tem permissão para exportar a carteira de processos.", 403);

  const sp: Record<string, string | string[]> = {};
  for (const key of new Set(request.nextUrl.searchParams.keys())) {
    const values = request.nextUrl.searchParams.getAll(key);
    sp[key] = values.length > 1 ? values : values[0];
  }
  const format: ProcessExportFormat = sp.formato === "xlsx" ? "xlsx" : "csv";
  const filters = processFiltersFromSearchParams(sp);
  const baseName = `carteira-processos-${todayISO()}`;

  try {
    const data = await exportProcesses(ctx, filters, format);
    if (format === "xlsx") {
      const buffer = await buildProcessXlsx(data);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${baseName}.xlsx"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return new Response(buildProcessCsv(data), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${baseName}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return text(err.message, err.code === "forbidden" ? 403 : 400);
    logger.error("process_export_failed", { format, errorName: err instanceof Error ? err.name : "unknown" });
    return text("Não foi possível gerar a exportação. Tente novamente.", 500);
  }
}
