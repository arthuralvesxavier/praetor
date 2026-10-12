import { ENTITY_TYPE_LABELS, type EntityType } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import { actionLabel, fieldLabel, formatChangeValue } from "./history-format";

/**
 * CSV of the audit trail (RF-22). Conventions shared by every CSV export of
 * the platform: UTF-8 with BOM (Excel opens accents correctly), `;` as the
 * separator, CRLF line breaks. Cells that could be read as spreadsheet
 * formulas (=, +, -, @, tab, CR) are prefixed with an apostrophe (CSV
 * injection). Pure module: no I/O.
 */

export type AuditCsvRow = {
  createdAt: Date;
  actorName: string | null;
  action: string;
  entityType: EntityType;
  entityId: string | null;
  summary: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  ipAddress: string | null;
  refNames: Record<string, string>;
};

export const AUDIT_CSV_HEADERS = [
  "Data/hora (Brasília)",
  "Usuário",
  "Ação",
  "Código da ação",
  "Entidade",
  "Identificador do registro",
  "Resumo",
  "Campos alterados",
  "IP",
] as const;

const BOM = "﻿";

/** Neutralizes formula-looking cells and quotes when needed. */
export function csvCell(value: string | null | undefined): string {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[;"\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function formatChangesForCsv(
  changes: AuditCsvRow["changes"],
  entityType: EntityType | null,
  names: Record<string, string>,
): string {
  if (!changes) return "";
  return Object.entries(changes)
    .map(
      ([key, c]) =>
        `${fieldLabel(key)}: ${formatChangeValue(key, c.from, entityType, names)} → ${formatChangeValue(key, c.to, entityType, names)}`,
    )
    .join(" | ");
}

export function buildAuditCsv(rows: readonly AuditCsvRow[], opts: { truncatedNote?: string | null } = {}): string {
  const lines: string[] = [AUDIT_CSV_HEADERS.map(csvCell).join(";")];
  for (const r of rows) {
    lines.push(
      [
        formatDateTime(r.createdAt),
        r.actorName ?? "Sistema",
        actionLabel(r.action),
        r.action,
        ENTITY_TYPE_LABELS[r.entityType] ?? r.entityType,
        r.entityId ?? "",
        r.summary,
        formatChangesForCsv(r.changes, r.entityType, r.refNames),
        r.ipAddress ?? "",
      ]
        .map(csvCell)
        .join(";"),
    );
  }
  if (opts.truncatedNote) lines.push(csvCell(opts.truncatedNote));
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** "trilha-auditoria-2026-10-11.csv" */
export function auditCsvFileName(todayIso: string): string {
  return `trilha-auditoria-${todayIso}.csv`;
}
