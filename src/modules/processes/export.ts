/**
 * Portfolio export files (RF-17). Server-only (uses write-excel-file/node).
 *
 * Columns mirror the client spreadsheet (Instância, TRT/Tribunal, Nº do
 * Processo, Parte Autora, Parte Ré, Cidade, Vara / Órgão Julgador / Turma,
 * Classe, Fase, Valor da Causa (R$), Valor Liquidado/Apurado (R$)) plus
 * Empresa, Responsável, Situação and a few traceability columns.
 *
 * RN-02: causa and liquidado are separate columns, never added together.
 * RN-03: a null value is an EMPTY cell (not zero).
 * CPF/CNPJ are masked (`maskDocument`).
 * CSV: UTF-8 with BOM, ";" separator, decimal comma, CRLF; text cells that
 * start with = + - @ are prefixed with "'" (spreadsheet formula injection).
 */
import writeXlsxFile, { type Cell, type Row, type Sheet } from "write-excel-file/node";
import {
  CLOSURE_REASON_LABELS,
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCES,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  type ProcessInstance,
} from "@/domain/enums";
import { formatDate, maskDocument } from "@/lib/format";
import { INSTANCE_SHEET_LABELS } from "./filters";
import type { ProcessExportData, ProcessExportInstanceRow, ProcessExportRow } from "./service";

type ColumnKind = "text" | "money";
type Column = { header: string; kind: ColumnKind; width: number };

const COLUMNS: Column[] = [
  { header: "Instância", kind: "text", width: 12 },
  { header: "TRT/Tribunal", kind: "text", width: 12 },
  { header: "Nº do Processo", kind: "text", width: 27 },
  { header: "Parte Autora", kind: "text", width: 34 },
  { header: "Parte Ré", kind: "text", width: 34 },
  { header: "Cidade", kind: "text", width: 20 },
  { header: "UF", kind: "text", width: 5 },
  { header: "Vara / Órgão Julgador / Turma", kind: "text", width: 30 },
  { header: "Classe", kind: "text", width: 10 },
  { header: "Fase", kind: "text", width: 40 },
  { header: "Valor da Causa (R$)", kind: "money", width: 18 },
  { header: "Valor Liquidado/Apurado (R$)", kind: "money", width: 22 },
  { header: "Empresa", kind: "text", width: 28 },
  { header: "Responsável", kind: "text", width: 24 },
  { header: "Escritório externo", kind: "text", width: 26 },
  { header: "Situação", kind: "text", width: 26 },
  { header: "Fase (classificação)", kind: "text", width: 20 },
  { header: "Área", kind: "text", width: 14 },
  { header: "Ajuizamento", kind: "text", width: 12 },
  { header: "Verificar", kind: "text", width: 9 },
  { header: "Sigiloso", kind: "text", width: 9 },
  { header: "CPF/CNPJ Parte Autora (mascarado)", kind: "text", width: 22 },
  { header: "CPF/CNPJ Parte Ré (mascarado)", kind: "text", width: 22 },
];

export const PROCESS_EXPORT_HEADERS = COLUMNS.map((c) => c.header);

type Value = string | number | null;

function partyLabel(name: string | null, count: number): string | null {
  if (!name) return null;
  return count > 1 ? `${name} (e outros)` : name;
}

function situation(p: ProcessExportRow): string {
  const status = PROCESS_STATUS_LABELS[p.status];
  return p.closureReason ? `${status} — ${CLOSURE_REASON_LABELS[p.closureReason]}` : status;
}

function maskedOrNull(value: string | null): string | null {
  return value ? maskDocument(value) : null;
}

/** One line: process-level data with the instance-specific fields of `inst` when given. */
function line(p: ProcessExportRow, inst?: ProcessExportInstanceRow | null): Value[] {
  const instance: ProcessInstance | null = inst ? inst.instance : p.instance;
  const phase = inst ? inst.phase : p.phase;
  const phaseDetail = inst ? inst.phaseDetail : p.phaseDetail;
  return [
    instance ? INSTANCE_SHEET_LABELS[instance] : null,
    inst ? inst.court : p.court,
    p.number,
    partyLabel(p.plaintiffName, p.plaintiffCount),
    partyLabel(p.defendantName, p.defendantCount),
    inst ? inst.city : p.city,
    inst ? inst.state : p.state,
    inst ? inst.courtDivision : p.courtDivision,
    inst ? inst.processClass : p.processClass,
    phaseDetail ?? (phase ? PROCESS_PHASE_LABELS[phase] : null),
    inst ? inst.claimAmountCents : p.claimAmountCents,
    inst ? inst.liquidatedAmountCents : p.liquidatedAmountCents,
    p.companyName,
    p.responsibleName,
    p.lawFirmName,
    situation(p),
    phase ? PROCESS_PHASE_LABELS[phase] : null,
    LEGAL_AREA_LABELS[p.area],
    p.filedAt ? formatDate(p.filedAt) : null,
    p.needsVerification ? "Sim" : "Não",
    p.isConfidential ? "Sim" : "Não",
    maskedOrNull(p.plaintiffDocument),
    maskedOrNull(p.defendantDocument),
  ];
}

/** "Consolidado Geral": one row per process (unique CNJ, RN-01). */
export function consolidatedRows(data: ProcessExportData): Value[][] {
  return data.processes.map((p) => line(p));
}

/**
 * Rows of one instance sheet, from `process_instances`. A process without any
 * instance link but whose current instance is `instance` appears with its own
 * (process-level) data, so that manually registered processes are not lost.
 */
export function instanceRows(data: ProcessExportData, instance: ProcessInstance): Value[][] {
  const byProcess = new Map<string, ProcessExportInstanceRow[]>();
  for (const i of data.instances) {
    const list = byProcess.get(i.processId) ?? [];
    list.push(i);
    byProcess.set(i.processId, list);
  }
  const rows: Value[][] = [];
  for (const p of data.processes) {
    const links = byProcess.get(p.id);
    if (links && links.length > 0) {
      const link = links.find((l) => l.instance === instance);
      if (link) rows.push(line(p, link));
    } else if (p.instance === instance) {
      rows.push(line(p));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Cents -> "1234,56" (decimal comma, no thousands separator); null -> "" (RN-03). */
export function csvMoney(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return "";
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const value = `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${value}` : value;
}

export function csvText(value: string | null): string {
  if (value === null || value === "") return "";
  let v = value.replace(/\r?\n/g, " ");
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csvLine(values: Value[]): string {
  return values
    .map((v, i) => (COLUMNS[i].kind === "money" ? csvMoney(v as number | null) : csvText(v === null ? null : String(v))))
    .join(";");
}

/** Consolidated CSV (one row per process). */
export function buildProcessCsv(data: ProcessExportData): string {
  const lines = [PROCESS_EXPORT_HEADERS.map((h) => csvText(h)).join(";"), ...consolidatedRows(data).map(csvLine)];
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const HEADER_STYLE = {
  fontWeight: "bold" as const,
  backgroundColor: "#0B1A2C",
  textColor: "#FFFFFF",
  wrap: true,
};

function xlsxCell(value: Value, kind: ColumnKind): Cell {
  if (value === null || value === "") return null;
  if (kind === "money") return { value: Number(value) / 100, type: Number, format: "#,##0.00" };
  return { value: String(value), type: String };
}

function sheet(name: string, rows: Value[][]): Sheet<never> {
  const header: Row = COLUMNS.map((c) => ({ value: c.header, ...HEADER_STYLE }));
  const data: Row[] = [header, ...rows.map((r) => r.map((v, i) => xlsxCell(v, COLUMNS[i].kind)))];
  return {
    sheet: name,
    data,
    columns: COLUMNS.map((c) => ({ width: c.width })),
    stickyRowsCount: 1,
  };
}

/** Workbook: "Consolidado Geral" + one sheet per instance ("1º Grau", "2º Grau", "3º Grau"). */
export async function buildProcessXlsx(data: ProcessExportData): Promise<Buffer> {
  const sheets: Sheet<never>[] = [
    sheet("Consolidado Geral", consolidatedRows(data)),
    ...PROCESS_INSTANCES.map((i) => sheet(INSTANCE_SHEET_LABELS[i], instanceRows(data, i))),
  ];
  return writeXlsxFile(sheets).toBuffer();
}
