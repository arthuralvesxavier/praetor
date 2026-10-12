import { REPORT_ITEM_ORIGINS, type ReportItemOrigin } from "@/domain/enums";
import { RECORD_DATE_BASES, type LegalReportDraft, type RecordSource, type ReportItemData, type ReportItemDraft } from "@/domain/legal-reports";

/**
 * Regras de emissão (puras, sem I/O). Todo problema listado aqui é ERRO que
 * bloqueia a emissão (nunca um aviso): item sem origem, item documentado sem
 * documento/versão/hash/página/trecho, cadastro ou análise sem tabela/campo/data,
 * inferência sem base…
 */

export const PENDING_SECTION_KEY = "pending";
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DraftIssueCode =
  | "empty_title"
  | "invalid_base_date"
  | "invalid_sections"
  | "duplicate_key"
  | "unknown_section"
  | "missing_origin"
  | "invalid_origin"
  | "empty_content"
  | "invalid_confidence"
  | "documented_incomplete"
  | "documented_without_hash"
  | "record_without_source"
  | "source_without_date"
  | "analysis_without_source"
  | "inference_without_basis"
  | "inference_unknown_ref"
  | "inference_cycle"
  | "gap_with_value"
  | "invalid_table";

export type DraftIssue = { code: DraftIssueCode; message: string; itemKey: string | null };

function tableProblem(data: ReportItemData): string | null {
  if (data.kind !== "table") return "Tipo de conteúdo estruturado desconhecido.";
  if (!Array.isArray(data.columns) || data.columns.length === 0) return "Tabela sem colunas.";
  const n = data.columns.length;
  if (data.columns.some((c) => !c.header?.trim())) return "Coluna de tabela sem título.";
  if (data.rows.some((r) => !Array.isArray(r) || r.length !== n)) return "Linha de tabela com número de células diferente do número de colunas.";
  if (data.totals && data.totals.length !== n) return "Linha de totais com número de células diferente do número de colunas.";
  return null;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * `YYYY-MM-DD` that exists on the calendar. `Date.parse` accepts dates such as
 * 2026-02-30 (it rolls them over), so the components are checked with a round trip.
 */
export function isCalendarDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * What may follow the date in an ISO 8601 date-time: `THH:MM`, optional `:SS`
 * and fraction, optional `Z` or `±HH:MM` (e.g. `toISOString()`). Nothing else:
 * `Date.parse` alone accepts trailing junk, spaces and newlines.
 */
const ISO_TIME_SUFFIX_RE = /^T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$/;

/** Data do registro utilizável: ISO estrito (YYYY-MM-DD ou data e hora), com dia existente no calendário. */
export function isRecordDate(value: string | null | undefined): value is string {
  if (!value || !isCalendarDate(value.slice(0, 10))) return false;
  const time = value.slice(10);
  if (time !== "" && !ISO_TIME_SUFFIX_RE.test(time)) return false;
  return !Number.isNaN(Date.parse(value));
}

function sourceDateProblem(source: RecordSource): string | null {
  if (source.dateBasis !== undefined && !(RECORD_DATE_BASES as readonly string[]).includes(source.dateBasis)) {
    return "Referência de data desconhecida na fonte do item.";
  }
  if (!isRecordDate(source.recordedAt)) {
    return "Item de cadastro ou de análise exige a data do registro lido (ou, sem registro encontrado, a data da consulta).";
  }
  return null;
}

/** Valida um rascunho. Lista vazia = pode ser emitido. */
export function validateDraft(draft: LegalReportDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const add = (code: DraftIssueCode, message: string, itemKey: string | null = null) => issues.push({ code, message, itemKey });

  if (!draft.title?.trim()) add("empty_title", "O relatório precisa de um título.");
  if (!isCalendarDate(draft.baseDate)) add("invalid_base_date", "Data-base inválida.");

  const sectionKeys = new Set<string>();
  for (const s of draft.sections ?? []) {
    if (!s.key || !s.title?.trim() || sectionKeys.has(s.key) || s.key === PENDING_SECTION_KEY) {
      add("invalid_sections", `Seção inválida ou repetida: "${s.key}".`);
    }
    sectionKeys.add(s.key);
  }

  const keys = new Set<string>();
  const byKey = new Map<string, ReportItemDraft>();
  for (const item of draft.items ?? []) {
    const key = item.key ?? null;
    if (!key || keys.has(key)) add("duplicate_key", "Item sem identificador ou com identificador repetido.", key);
    if (key) {
      keys.add(key);
      byKey.set(key, item);
    }
    if (!sectionKeys.has(item.section)) add("unknown_section", `Item em seção inexistente: "${item.section}".`, key);
    if (!item.content?.trim()) add("empty_content", "Item sem texto.", key);
    if (
      item.confidence !== null &&
      item.confidence !== undefined &&
      (!Number.isInteger(item.confidence) || item.confidence < 0 || item.confidence > 100)
    ) {
      add("invalid_confidence", "Confiança deve ser um inteiro de 0 a 100.", key);
    }
    if (item.data) {
      const problem = tableProblem(item.data);
      if (problem) add("invalid_table", problem, key);
    }

    const origin = item.origin;
    if (origin === null || origin === undefined || (origin as string) === "") {
      add(
        "missing_origin",
        `Item sem origem declarada ("${(item.content ?? "").slice(0, 60)}"): toda afirmação precisa de origem antes da emissão.`,
        key,
      );
      continue;
    }
    if (!(REPORT_ITEM_ORIGINS as readonly string[]).includes(origin)) {
      add("invalid_origin", `Origem desconhecida: "${String(origin)}".`, key);
      continue;
    }
    switch (origin as ReportItemOrigin) {
      case "documented":
        if (
          !item.documentId ||
          !item.documentVersionId ||
          !Number.isInteger(item.page) ||
          (item.page ?? 0) < 1 ||
          !item.excerpt?.trim()
        ) {
          add("documented_incomplete", "Item documentado exige documento, versão, página e trecho literal.", key);
        }
        // O verificador sempre compara o hash da versão lida com o atual: sem hash não há conferência.
        if (!SHA256_RE.test(item.documentSha256 ?? "")) {
          add("documented_without_hash", "Item documentado exige o hash (SHA-256) da versão lida pelo gerador.", key);
        }
        break;
      case "record": {
        if (!item.recordSource?.table || !item.recordSource.field || !item.recordSource.label?.trim()) {
          add("record_without_source", "Item de cadastro exige tabela, campo e descrição da fonte.", key);
          break;
        }
        const problem = sourceDateProblem(item.recordSource);
        if (problem) add("source_without_date", problem, key);
        break;
      }
      case "analysis": {
        if (!item.recordSource?.table || !item.recordSource.label?.trim()) {
          add("analysis_without_source", "Item de análise exige a referência da análise registrada.", key);
          break;
        }
        const problem = sourceDateProblem(item.recordSource);
        if (problem) add("source_without_date", problem, key);
        break;
      }
      case "inference":
        if (!item.derivedFrom?.length) add("inference_without_basis", "Inferência exige os itens dos quais deriva.", key);
        break;
      case "gap":
        if (item.data || item.excerpt) add("gap_with_value", "Lacuna não carrega valor nem trecho.", key);
        break;
    }
  }

  // Referências das inferências: existem e não formam ciclo.
  for (const item of draft.items ?? []) {
    if (item.origin !== "inference" || !item.derivedFrom?.length) continue;
    for (const ref of item.derivedFrom) {
      if (!byKey.has(ref) || ref === item.key) {
        add("inference_unknown_ref", `Inferência aponta para item inexistente: "${ref}".`, item.key);
      }
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): boolean => {
    const st = state.get(key);
    if (st === "visiting") return true;
    if (st === "done") return false;
    state.set(key, "visiting");
    const item = byKey.get(key);
    const refs = item?.origin === "inference" ? (item.derivedFrom ?? []) : [];
    for (const ref of refs) if (byKey.has(ref) && visit(ref)) return true;
    state.set(key, "done");
    return false;
  };
  for (const key of byKey.keys()) {
    if (visit(key)) {
      add("inference_cycle", "Inferências com dependência circular.", key);
      break;
    }
  }
  return issues;
}

export type SourceVerdict = { confirmed: boolean; reason: string | null };

/**
 * Decide quais itens são afirmados e quais vão para "Pendências do relatório"
 * (devolve o motivo; null = afirmado):
 * - documentado com fonte não confirmada (a fonte nunca serve de base);
 * - confiança abaixo do limite;
 * - inferência cujas bases são todas lacunas (não há dado afirmado que a sustente);
 * - inferência que depende de item não afirmado (propagado até estabilizar).
 */
export function placeItems(
  items: readonly ReportItemDraft[],
  opts: { threshold: number; sourceVerdicts: ReadonlyMap<string, SourceVerdict> },
): Map<string, string | null> {
  const reasons = new Map<string, string | null>();
  const originOf = new Map(items.map((i) => [i.key, i.origin]));
  for (const item of items) {
    let reason: string | null = null;
    if (item.origin === "documented") {
      const verdict = opts.sourceVerdicts.get(item.key);
      if (!verdict?.confirmed) {
        reason = `Fonte não confirmada: ${verdict?.reason ?? "conferência não realizada"}`;
      }
    }
    if (
      item.origin === "inference" &&
      item.derivedFrom?.length &&
      item.derivedFrom.every((ref) => originOf.get(ref) === "gap")
    ) {
      reason = "Inferência sem base afirmada: todos os itens dos quais deriva são lacunas.";
    }
    if (!reason && item.confidence !== null && item.confidence !== undefined && item.confidence < opts.threshold) {
      reason = `Confiança ${item.confidence} abaixo do limite de ${opts.threshold} definido para afirmações.`;
    }
    reasons.set(item.key, reason);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.origin !== "inference" || reasons.get(item.key)) continue;
      const blocked = (item.derivedFrom ?? []).some((ref) => !!reasons.get(ref));
      if (blocked) {
        reasons.set(item.key, "Baseada em item não afirmado (fonte não confirmada ou confiança abaixo do limite).");
        changed = true;
      }
    }
  }
  return reasons;
}

/** Normalização para conferir um trecho literal no texto extraído (espaços, ligaduras e aspas). */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb]/g, '"')
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const MIN_EXCERPT_LENGTH = 12;

/** O trecho aparece, literalmente (salvo espaços), no texto da página? */
export function excerptFoundIn(pageText: string, excerpt: string): boolean {
  const needle = normalizeForMatch(excerpt);
  if (needle.length < MIN_EXCERPT_LENGTH) return false;
  return normalizeForMatch(pageText).includes(needle);
}
