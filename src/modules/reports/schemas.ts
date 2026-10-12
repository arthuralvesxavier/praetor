/**
 * Input contracts of the reports module (client-safe). URL params of
 * `/relatorios` and `/api/reports/<tipo>`: `empresa`, `unidade`,
 * `competencia` (YYYY-MM), `de` / `ate` (YYYY-MM-DD, movimentação),
 * `pagina` (movimentação on screen), `formato=csv|xlsx` (export route).
 */
import { z } from "zod";
import { idParam, param, type SearchParams } from "@/lib/search-params";
import { REPORT_TYPES, type ExportFormat, type ReportFilters, type ReportType } from "./types";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const reportFiltersSchema = z
  .object({
    companyId: z.guid({ error: "Empresa inválida." }).optional(),
    unitId: z.guid({ error: "Unidade inválida." }).optional(),
    period: z.string().regex(PERIOD_RE, { error: "Competência inválida (use AAAA-MM)." }).optional(),
    from: z.string().refine(isRealDate, { error: "Data inicial inválida." }).optional(),
    to: z.string().refine(isRealDate, { error: "Data final inválida." }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from && v.to && v.from > v.to) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "A data inicial deve ser anterior à data final." });
    }
  });

export function isReportType(value: string | null | undefined): value is ReportType {
  return typeof value === "string" && (REPORT_TYPES as readonly string[]).includes(value);
}

/**
 * Reads the report filters from URL params. Malformed values are dropped
 * (ids must be UUID-shaped, dates/periods must match their format); the
 * service still validates them and checks tenant ownership.
 */
export function reportFiltersFromParams(sp: SearchParams): ReportFilters {
  const period = param(sp, "competencia");
  const from = param(sp, "de");
  const to = param(sp, "ate");
  return {
    companyId: idParam(sp, "empresa"),
    unitId: idParam(sp, "unidade"),
    period: period && PERIOD_RE.test(period) ? period : undefined,
    from: from && isRealDate(from) ? from : undefined,
    to: to && isRealDate(to) ? to : undefined,
  };
}

/** Filters -> URL params (export links keep the filters on screen). */
export function reportFilterParams(filters: ReportFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.companyId) out.empresa = filters.companyId;
  if (filters.unitId) out.unidade = filters.unitId;
  if (filters.period) out.competencia = filters.period;
  if (filters.from) out.de = filters.from;
  if (filters.to) out.ate = filters.to;
  return out;
}

export function exportHref(type: ReportType, format: ExportFormat, filters: ReportFilters): string {
  const qs = new URLSearchParams({ formato: format, ...reportFilterParams(filters) });
  return `/api/reports/${type}?${qs.toString()}`;
}

export function exportFormatFromParam(value: string | null | undefined): ExportFormat | null {
  return value === "csv" || value === "xlsx" ? value : null;
}
