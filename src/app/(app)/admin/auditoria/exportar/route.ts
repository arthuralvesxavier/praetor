import type { NextRequest } from "next/server";
import { ENTITY_TYPES } from "@/domain/enums";
import { formatNumber, todayISO } from "@/lib/format";
import { enumParam, idParam, param, type SearchParams } from "@/lib/search-params";
import { auditCsvFileName, buildAuditCsv } from "@/modules/admin/audit-csv";
import { AUDIT_EXPORT_MAX_ROWS, exportAuditLogs } from "@/modules/admin/service";
import { can } from "@/server/auth/permissions";
import { getCurrentUser } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * GET /admin/auditoria/exportar?acao=&entidade=&usuario=&de=&ate=
 *
 * CSV of the filtered audit trail (RF-22), same filters as /admin/auditoria.
 * Requires `audit:read`; organization-scoped by the service; the export is
 * itself recorded in the trail.
 */

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function dateParam(sp: SearchParams, key: string): string | undefined {
  const v = param(sp, key);
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined;
}

export async function GET(request: NextRequest): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return text("Sessão expirada. Entre novamente.", 401);
  if (!can(ctx, "audit:read")) return text("Você não tem permissão para exportar a trilha de auditoria.", 403);

  const sp: SearchParams = Object.fromEntries(request.nextUrl.searchParams.entries());
  const action = param(sp, "acao");
  let from = dateParam(sp, "de");
  let to = dateParam(sp, "ate");
  if (from && to && from > to) [from, to] = [to, from];

  try {
    const result = await exportAuditLogs(ctx, {
      action: action && action.length <= 100 && /^[a-z0-9_.]+$/.test(action) ? action : undefined,
      entityType: enumParam(sp, "entidade", ENTITY_TYPES),
      actorId: idParam(sp, "usuario"),
      from,
      to,
    });
    const csv = buildAuditCsv(result.items, {
      truncatedNote: result.truncated
        ? `Exportação limitada aos ${formatNumber(AUDIT_EXPORT_MAX_ROWS)} registros mais recentes de ${formatNumber(result.total)}. Refine os filtros (período, ação, usuário) para exportar o restante.`
        : null,
    });
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${auditCsvFileName(todayISO())}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "forbidden") return text(err.message, 403);
      if (err.code === "validation") return text("Filtros inválidos. Revise as datas e tente novamente.", 400);
      return text(err.message, 400);
    }
    logger.error("audit_export_failed", { userId: ctx.userId, error: err });
    return text("Não foi possível gerar a exportação. Tente novamente.", 500);
  }
}
