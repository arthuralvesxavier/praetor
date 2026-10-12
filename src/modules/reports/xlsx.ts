import writeXlsxFile, { type Cell, type Row, type SheetData } from "write-excel-file/node";
import type { ExportCell, ReportExport } from "./csv";

/**
 * XLSX writer for report exports (write-excel-file/node). Money is written as
 * a number in reais with 2 decimals, percentages as fractions with a % format,
 * dates as real Excel dates (built in UTC, so the calendar day never shifts)
 * and null values as EMPTY cells (RN-03).
 */

const MONEY_FORMAT = "#,##0.00";
const PERCENT_FORMAT = "0.00%";
const DATE_FORMAT = "dd/mm/yyyy";

function toCell(c: ExportCell): Cell {
  if (c.v === null) return null;
  switch (c.t) {
    case "text":
      return { type: String, value: c.v };
    case "int":
      return { type: Number, value: c.v };
    case "money":
      return { type: Number, value: c.v / 100, format: MONEY_FORMAT };
    case "bp":
      return { type: Number, value: c.v / 10_000, format: PERCENT_FORMAT };
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.v);
      if (!m) return { type: String, value: c.v };
      return { type: Date, value: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))), format: DATE_FORMAT };
    }
    case "bool":
      return { type: String, value: c.v ? "Sim" : "Não" };
  }
}

/** Excel sheet names: max 31 chars, no []:*?/\ and unique within the workbook. */
function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Planilha";
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${base.slice(0, 28)} ${i}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function reportToXlsx(exp: ReportExport): Promise<Buffer> {
  const used = new Set<string>();
  const header = (text: string): Cell => ({ type: String, value: text, fontWeight: "bold", backgroundColor: "#E8ECF2" });

  const aboutData: SheetData = [
    [{ type: String, value: exp.title, fontWeight: "bold", fontSize: 13 }, null],
    [null, null],
    ...exp.about.map((a): Row => [{ type: String, value: a.label, fontWeight: "bold" }, { type: String, value: a.value, wrap: true }]),
  ];

  const sheets = [
    { data: aboutData, sheet: sheetName("Sobre", used), columns: [{ width: 28 }, { width: 110 }] },
    ...exp.sheets.map((s) => ({
      data: [s.columns.map((c) => header(c.header)), ...s.rows.map((r) => r.map(toCell))] as SheetData,
      sheet: sheetName(s.name, used),
      columns: s.columns.map((c) => ({ width: c.width ?? 16 })),
      stickyRowsCount: 1,
    })),
  ];

  return writeXlsxFile(sheets, { fontFamily: "Calibri", fontSize: 11 }).toBuffer();
}
