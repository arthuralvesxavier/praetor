/**
 * Pure rule-matching helpers (no I/O, client-safe). A distribution rule
 * matches a process when EVERY non-empty criterion is satisfied; empty
 * criteria do not restrict. Text comparisons are tolerant to the variants
 * found in the portfolio spreadsheet ("TRT-10" = "TRT10", "Palmas - TO" =
 * "Palmas/TO" = "Palmas").
 */
import {
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCE_LABELS,
  type LegalArea,
  type ProcessInstance,
} from "@/domain/enums";
import { formatMoneyCents } from "@/lib/format";
// Type-only import (erased at build time).
import type { DistributionCriteria } from "@/server/db/schema";

export type ProcessFacts = {
  court: string;
  area: LegalArea;
  companyId: string | null;
  unitId: string | null;
  state: string | null;
  city: string | null;
  instance: ProcessInstance | null;
  processClass: string | null;
  claimAmountCents: number | null;
};

export type NameMaps = {
  companies?: Record<string, string>;
  units?: Record<string, string>;
};

export type CriteriaEvaluation = {
  matched: boolean;
  /** pt-BR fragments of the criteria the process satisfied ("tribunal TRT10"). */
  matchedOn: string[];
  /** pt-BR reasons why the rule does not apply. */
  mismatches: string[];
};

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** "TRT-10" / "trt 10" → "TRT10". */
export function normalizeCourt(value: string | null | undefined): string {
  return stripAccents(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** "Palmas - TO", "Palmas/TO", "PALMAS (TO)" → "palmas". */
export function normalizeCity(value: string | null | undefined): string {
  return stripAccents(value ?? "")
    .toLowerCase()
    .replace(/\s*[-/–—(]\s*[a-z]{2}\)?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeClass(value: string | null | undefined): string {
  return stripAccents(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function normalizeState(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function nonEmpty<T>(list: readonly T[] | null | undefined): list is readonly T[] {
  return Array.isArray(list) && list.length > 0;
}

function joinList(values: readonly string[]): string {
  return values.join(", ");
}

/** Evaluates every criterion of a rule against the process. */
export function evaluateCriteria(
  criteria: DistributionCriteria,
  facts: ProcessFacts,
  names: NameMaps = {},
): CriteriaEvaluation {
  const matchedOn: string[] = [];
  const mismatches: string[] = [];
  const companyName = (id: string | null) => (id ? (names.companies?.[id] ?? "empresa vinculada") : "sem empresa");
  const unitName = (id: string | null) => (id ? (names.units?.[id] ?? "unidade vinculada") : "sem unidade");

  if (nonEmpty(criteria.courts)) {
    const wanted = criteria.courts.map(normalizeCourt);
    if (wanted.includes(normalizeCourt(facts.court))) matchedOn.push(`tribunal ${facts.court}`);
    else mismatches.push(`Tribunal ${facts.court || "não informado"} fora da regra (${joinList(criteria.courts)}).`);
  }

  if (nonEmpty(criteria.areas)) {
    if (criteria.areas.includes(facts.area)) matchedOn.push(`área ${LEGAL_AREA_LABELS[facts.area]}`);
    else
      mismatches.push(
        `Área ${LEGAL_AREA_LABELS[facts.area]} fora da regra (${joinList(criteria.areas.map((a) => LEGAL_AREA_LABELS[a]))}).`,
      );
  }

  if (nonEmpty(criteria.companyIds)) {
    if (facts.companyId && criteria.companyIds.includes(facts.companyId)) matchedOn.push(`empresa ${companyName(facts.companyId)}`);
    else mismatches.push(`Empresa do processo (${companyName(facts.companyId)}) fora da regra.`);
  }

  if (nonEmpty(criteria.unitIds)) {
    if (facts.unitId && criteria.unitIds.includes(facts.unitId)) matchedOn.push(`unidade ${unitName(facts.unitId)}`);
    else mismatches.push(`Unidade do processo (${unitName(facts.unitId)}) fora da regra.`);
  }

  if (nonEmpty(criteria.states)) {
    const state = normalizeState(facts.state);
    if (state && criteria.states.map(normalizeState).includes(state)) matchedOn.push(`UF ${state}`);
    else mismatches.push(`UF ${state || "não informada"} fora da regra (${joinList(criteria.states)}).`);
  }

  if (nonEmpty(criteria.cities)) {
    const city = normalizeCity(facts.city);
    if (city && criteria.cities.map(normalizeCity).includes(city)) matchedOn.push(`cidade ${facts.city}`);
    else mismatches.push(`Cidade ${facts.city || "não informada"} fora da regra (${joinList(criteria.cities)}).`);
  }

  if (nonEmpty(criteria.instances)) {
    if (facts.instance && criteria.instances.includes(facts.instance)) {
      matchedOn.push(`instância ${PROCESS_INSTANCE_LABELS[facts.instance]}`);
    } else {
      const current = facts.instance ? PROCESS_INSTANCE_LABELS[facts.instance] : "não informada";
      mismatches.push(
        `Instância ${current} fora da regra (${joinList(criteria.instances.map((i) => PROCESS_INSTANCE_LABELS[i]))}).`,
      );
    }
  }

  if (nonEmpty(criteria.processClasses)) {
    const cls = normalizeClass(facts.processClass);
    if (cls && criteria.processClasses.map(normalizeClass).includes(cls)) matchedOn.push(`classe ${facts.processClass}`);
    else
      mismatches.push(`Classe ${facts.processClass || "não informada"} fora da regra (${joinList(criteria.processClasses)}).`);
  }

  const min = criteria.minClaimCents ?? null;
  const max = criteria.maxClaimCents ?? null;
  if (min !== null || max !== null) {
    const claim = facts.claimAmountCents;
    if (claim === null) {
      mismatches.push("Valor da causa não informado (a regra exige faixa de valor).");
    } else if ((min !== null && claim < min) || (max !== null && claim > max)) {
      mismatches.push(`Valor da causa ${formatMoneyCents(claim)} fora da faixa ${describeClaimRange(min, max)}.`);
    } else {
      matchedOn.push(`valor da causa ${describeClaimRange(min, max)}`);
    }
  }

  return { matched: mismatches.length === 0, matchedOn, mismatches };
}

export function describeClaimRange(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `de ${formatMoneyCents(min)} a ${formatMoneyCents(max)}`;
  if (min !== null) return `a partir de ${formatMoneyCents(min)}`;
  if (max !== null) return `até ${formatMoneyCents(max)}`;
  return "qualquer valor";
}

export function isEmptyCriteria(criteria: DistributionCriteria): boolean {
  return (
    !nonEmpty(criteria.courts) &&
    !nonEmpty(criteria.areas) &&
    !nonEmpty(criteria.companyIds) &&
    !nonEmpty(criteria.unitIds) &&
    !nonEmpty(criteria.states) &&
    !nonEmpty(criteria.cities) &&
    !nonEmpty(criteria.instances) &&
    !nonEmpty(criteria.processClasses) &&
    (criteria.minClaimCents ?? null) === null &&
    (criteria.maxClaimCents ?? null) === null
  );
}

/** pt-BR summary of the criteria ("Tribunal: TRT10, TRT2"), one entry per restricted field. */
export function describeCriteria(criteria: DistributionCriteria, names: NameMaps = {}): string[] {
  const out: string[] = [];
  if (nonEmpty(criteria.courts)) out.push(`Tribunal: ${joinList(criteria.courts)}`);
  if (nonEmpty(criteria.areas)) out.push(`Área: ${joinList(criteria.areas.map((a) => LEGAL_AREA_LABELS[a]))}`);
  if (nonEmpty(criteria.companyIds)) {
    out.push(`Empresa: ${joinList(criteria.companyIds.map((id) => names.companies?.[id] ?? "empresa removida"))}`);
  }
  if (nonEmpty(criteria.unitIds)) {
    out.push(`Unidade: ${joinList(criteria.unitIds.map((id) => names.units?.[id] ?? "unidade removida"))}`);
  }
  if (nonEmpty(criteria.states)) out.push(`UF: ${joinList(criteria.states)}`);
  if (nonEmpty(criteria.cities)) out.push(`Cidade: ${joinList(criteria.cities)}`);
  if (nonEmpty(criteria.instances)) {
    out.push(`Instância: ${joinList(criteria.instances.map((i) => PROCESS_INSTANCE_LABELS[i]))}`);
  }
  if (nonEmpty(criteria.processClasses)) out.push(`Classe: ${joinList(criteria.processClasses)}`);
  const min = criteria.minClaimCents ?? null;
  const max = criteria.maxClaimCents ?? null;
  if (min !== null || max !== null) out.push(`Valor da causa: ${describeClaimRange(min, max)}`);
  return out;
}
