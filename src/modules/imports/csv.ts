/**
 * CSV of the import issues (UTF-8 with BOM, ";" separator — opens directly in
 * Excel pt-BR). Client-safe and pure.
 */
import { ISSUE_LEVEL_LABELS, type IssueLevel } from "@/domain/enums";
import { issueCodeLabel } from "./labels";

export type IssueCsvItem = {
  sheet: string;
  rowNumber: number;
  cnj: string | null;
  level: IssueLevel;
  code: string;
  field: string | null;
  message: string;
};

/** Quotes when needed and neutralizes formula injection (=, +, -, @ at the start). */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const ISSUE_CSV_HEADER = ["Aba", "Linha", "Número do processo", "Nível", "Tipo", "Campo", "Descrição"] as const;

export function issuesToCsv(items: readonly IssueCsvItem[]): string {
  const lines = [
    ISSUE_CSV_HEADER.map(csvCell).join(";"),
    ...items.map((i) =>
      [i.sheet, i.rowNumber, i.cnj, ISSUE_LEVEL_LABELS[i.level] ?? i.level, issueCodeLabel(i.code), i.field, i.message]
        .map(csvCell)
        .join(";"),
    ),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
