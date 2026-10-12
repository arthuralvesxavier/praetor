import { readFile } from "node:fs/promises";
import { computeCnjCheckDigit } from "@/domain/cnj";
import type { RawCell, RawSheet } from "@/modules/imports/parser";

/** The client's fictitious demo spreadsheet (see MODULE_CONTRACTS "Demo data facts"). */
export const DEMO_FILE = "scripts/seed-data/files/Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx";
export const DEMO_FILE_NAME = "Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx";
export const DEMO_CLIENT = "EMPRESA MODELO TESTE LTDA";

export async function demoBytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(DEMO_FILE));
}

/** A CNJ number with a VALID check digit (labor segment by default). */
export function validCnj(sequence: number, opts: { year?: number; segment?: string; tribunal?: string; origin?: string } = {}): string {
  const parts = {
    sequence: String(sequence).padStart(7, "0"),
    year: opts.year ?? 2024,
    segment: opts.segment ?? "5",
    tribunal: opts.tribunal ?? "10",
    origin: opts.origin ?? "0001",
  };
  const dv = computeCnjCheckDigit(parts);
  return `${parts.sequence}-${dv}.${parts.year}.${parts.segment}.${parts.tribunal}.${parts.origin}`;
}

/** Same number with a wrong check digit. */
export function invalidCnj(sequence: number): string {
  const ok = validCnj(sequence);
  const dv = ok.slice(8, 10);
  const wrong = String((Number(dv) + 1) % 100).padStart(2, "0");
  return `${ok.slice(0, 8)}${wrong}${ok.slice(10)}`;
}

export const HEADER = [
  "Instância",
  "TRT/Tribunal",
  "Nº do Processo",
  "Parte Autora",
  "Parte Ré",
  "Cidade",
  "Vara / Órgão Julgador / Turma",
  "Classe",
  "Fase",
  "Valor da Causa (R$)",
  "Valor Liquidado/Apurado - 1º grau (R$)",
];

export type RowInput = {
  instance?: string | null;
  court?: string | null;
  number: string | null;
  plaintiff?: string | null;
  defendant?: string | null;
  city?: string | null;
  division?: string | null;
  cls?: string | null;
  phase?: string | null;
  claim?: RawCell;
  liquidated?: RawCell;
};

/** `undefined` -> default value; `null` -> empty cell. */
function or<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function row(r: RowInput): RawCell[] {
  return [
    or(r.instance, "1º Grau"),
    or(r.court, "TRT10"),
    r.number,
    or(r.plaintiff, "FULANO DE TAL (FICTÍCIO)"),
    or(r.defendant, `${DEMO_CLIENT} e outros`),
    or(r.city, null),
    or(r.division, "1ª VARA DO TRABALHO"),
    or(r.cls, "ATOrd"),
    or(r.phase, "Conhecimento"),
    or(r.claim, null),
    or(r.liquidated, null),
  ];
}

export function sheet(name: string, rows: RawCell[][], header: string[] = HEADER): RawSheet {
  return { name, rows: [header, ...rows] };
}
