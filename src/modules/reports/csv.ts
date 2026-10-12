/**
 * Tabular export model and CSV writer (pure, client-safe).
 *
 * CSV conventions (MODULE_CONTRACTS "XLSX export"): UTF-8 with BOM, ";" as
 * separator, CRLF line breaks, decimal comma, no thousands separator, dates as
 * dd/mm/aaaa and null cells EMPTY (RN-03 — never "0").
 */

export type ExportCell =
  | { t: "text"; v: string | null }
  | { t: "int"; v: number | null }
  /** Money in integer cents. */
  | { t: "money"; v: number | null }
  /** Percentage in basis points (5000 = 50%). */
  | { t: "bp"; v: number | null }
  /** Calendar date "YYYY-MM-DD". */
  | { t: "date"; v: string | null }
  | { t: "bool"; v: boolean | null };

export const cell = {
  text: (v: string | null | undefined): ExportCell => ({ t: "text", v: v ?? null }),
  int: (v: number | null | undefined): ExportCell => ({ t: "int", v: v ?? null }),
  money: (v: number | null | undefined): ExportCell => ({ t: "money", v: v ?? null }),
  bp: (v: number | null | undefined): ExportCell => ({ t: "bp", v: v ?? null }),
  date: (v: string | null | undefined): ExportCell => ({ t: "date", v: v ?? null }),
  bool: (v: boolean | null | undefined): ExportCell => ({ t: "bool", v: v ?? null }),
};

export type ExportColumn = { header: string; /** Approximate width in characters (XLSX). */ width?: number };

export type ExportSheet = { name: string; columns: ExportColumn[]; rows: ExportCell[][] };

export type ReportExport = {
  /** File name without extension, e.g. "relatorio-carteira-2026-10-11". */
  fileBase: string;
  title: string;
  /** "Sobre" sheet (XLSX) lines: label/value pairs (filters, scope, notes). */
  about: { label: string; value: string }[];
  sheets: ExportSheet[];
  /** Index of the sheet written to the CSV file (the report's main table). */
  csvSheet: number;
};

export const CSV_BOM = "﻿";
export const CSV_SEPARATOR = ";";

/** Integer cents -> "1234,56" / "-0,05" (decimal comma, no thousands separator). */
export function csvMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** Basis points -> percentage with decimal comma: 5000 -> "50", 1250 -> "12,5". */
export function csvPercent(bp: number): string {
  const fixed = (bp / 100).toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed.replace(".", ",");
}

/** "YYYY-MM-DD" -> "dd/mm/aaaa" (calendar date, no timezone). */
export function csvDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Text that a spreadsheet could execute as a formula is prefixed with an apostrophe. */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvValue(c: ExportCell): string {
  if (c.v === null) return "";
  switch (c.t) {
    case "text":
      return quote(neutralizeFormula(c.v));
    case "int":
      return String(Math.trunc(c.v));
    case "money":
      return csvMoney(c.v);
    case "bp":
      return csvPercent(c.v);
    case "date":
      return csvDate(c.v);
    case "bool":
      return c.v ? "Sim" : "Não";
  }
}

/** Full CSV document (with BOM) for one sheet. */
export function sheetToCsv(sheet: ExportSheet): string {
  const lines = [
    sheet.columns.map((c) => quote(c.header)).join(CSV_SEPARATOR),
    ...sheet.rows.map((row) => row.map(csvValue).join(CSV_SEPARATOR)),
  ];
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}
