/**
 * Pure helpers of the "Resumo" tab (P0.6): which cover fields are empty (listed once in
 * "Completar cadastro") and the one-sentence excerpt of the preliminary analysis.
 * Client-safe.
 */
import type { ProcessInstance } from "@/domain/enums";
import { truncate } from "@/lib/format";

/** Fields of the edit form that the cover hides when empty and lists in "Completar cadastro". */
export const COVER_FIELDS = [
  "court",
  "courtDivision",
  "city",
  "processClass",
  "instance",
  "company",
  "unit",
  "responsible",
  "filedAt",
  "claim",
] as const;
export type CoverField = (typeof COVER_FIELDS)[number];

export const COVER_FIELD_LABELS: Record<CoverField, string> = {
  court: "Tribunal",
  courtDivision: "Vara ou órgão julgador",
  city: "Cidade",
  processClass: "Classe processual",
  instance: "Instância atual",
  company: "Empresa do grupo",
  unit: "Unidade",
  responsible: "Responsável",
  filedAt: "Data de ajuizamento",
  claim: "Valor da causa",
};

export const isBlank = (v: string | null | undefined) => !v || v.trim() === "";

export type CoverFacts = {
  court: string | null;
  courtDivision: string | null;
  city: string | null;
  processClass: string | null;
  instance: ProcessInstance | null;
  companyId: string | null;
  unitId: string | null;
  responsibleId: string | null;
  filedAt: string | null;
  claimAmountCents: number | null;
};

/**
 * Cover fields with no value on the record (blank text counts as empty; a zero claim is
 * informed), in form order. The ONLY list of registration gaps on the "Resumo" tab (the
 * decision band does not repeat it). `claimPending`: a valor da causa already informed and
 * waiting in the review queue is not a gap (the record only takes it once approved).
 */
export function missingCoverFields(p: CoverFacts, opts: { claimPending?: boolean } = {}): CoverField[] {
  const empty: Record<CoverField, boolean> = {
    court: isBlank(p.court),
    courtDivision: isBlank(p.courtDivision),
    city: isBlank(p.city),
    processClass: isBlank(p.processClass),
    instance: p.instance === null,
    company: p.companyId === null,
    unit: p.unitId === null,
    responsible: p.responsibleId === null,
    filedAt: p.filedAt === null,
    claim: p.claimAmountCents === null && !opts.claimPending,
  };
  return COVER_FIELDS.filter((f) => empty[f]);
}

/** First sentence of the brief headline (at most 220 characters). */
export function firstSentence(text: string | null | undefined): string | null {
  const clean = text?.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const match = /^(.+?[.!?])(\s|$)/.exec(clean);
  return truncate(match ? match[1] : clean, 220);
}
