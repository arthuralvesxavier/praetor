/**
 * Pure contingency helpers owned by the contingency module (client-safe, no
 * I/O). Money math for exposure/provision lives in `@/domain/contingency`;
 * this file holds the module-specific rules: installment split, settlement
 * state machine, the deterministic risk suggestion (RF-12), period handling
 * and document-page slicing for the review queue (TE-04).
 */
import type {
  ClosureReason,
  LossProbability,
  ProcessInstance,
  ProcessPhase,
  ProcessStatus,
  SettlementStatus,
} from "@/domain/enums";

// ---------------------------------------------------------------------------
// Calendar helpers ("YYYY-MM-DD" / "YYYY-MM", timezone-free)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True for a real calendar date in "YYYY-MM-DD" (rejects 2026-02-30). */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** True for a competência "YYYY-MM" between 2000-01 and 2100-12. */
export function isValidPeriod(value: string): boolean {
  const m = PERIOD_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  return y >= 2000 && y <= 2100;
}

/** "2026-10" → "10/2026". */
export function formatPeriod(period: string): string {
  const m = PERIOD_RE.exec(period);
  return m ? `${m[2]}/${m[1]}` : period;
}

/** `YYYY-MM` of a "YYYY-MM-DD" date. */
export function periodOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Adds calendar months to a "YYYY-MM-DD" date, clamping the day to the month length (31/01 + 1 → 28/02). */
export function addMonthsISO(iso: string, months: number): string {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) throw new RangeError(`Data inválida: ${iso}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const target = new Date(Date.UTC(y, mo - 1 + months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Last `count` competências up to (and including) `period`, most recent first. */
export function recentPeriods(period: string, count: number): string[] {
  const out: string[] = [];
  let [y, m] = period.split("-").map(Number);
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export type InstallmentPlanItem = { number: number; dueDate: string; amountCents: number };

/**
 * Splits a settlement total into `count` monthly installments starting on
 * `firstDueDate`. Every installment gets the same amount; the LAST one absorbs
 * the rounding remainder so the sum is always exactly the total.
 */
export function splitInstallments(totalCents: number, count: number, firstDueDate: string): InstallmentPlanItem[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new RangeError("Valor total inválido.");
  if (!Number.isInteger(count) || count < 1) throw new RangeError("Quantidade de parcelas inválida.");
  const base = Math.floor(totalCents / count);
  const items: InstallmentPlanItem[] = [];
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    items.push({
      number: i + 1,
      dueDate: addMonthsISO(firstDueDate, i),
      amountCents: isLast ? totalCents - base * (count - 1) : base,
    });
  }
  return items;
}

/**
 * Allowed settlement status transitions:
 * proposta → em negociação → firmado → homologado → cumprido | descumprido,
 * with cancellation while not yet homologated and late fulfilment of a breached one.
 */
export const SETTLEMENT_TRANSITIONS: Record<SettlementStatus, readonly SettlementStatus[]> = {
  proposal: ["negotiating", "signed", "cancelled"],
  negotiating: ["signed", "cancelled"],
  signed: ["homologated", "fulfilled", "breached", "cancelled"],
  homologated: ["fulfilled", "breached"],
  breached: ["fulfilled"],
  fulfilled: [],
  cancelled: [],
};

export function canTransitionSettlement(from: SettlementStatus, to: SettlementStatus): boolean {
  return SETTLEMENT_TRANSITIONS[from].includes(to);
}

/** Statuses whose installments are real obligations (alerts, "próximas parcelas"). */
export const BINDING_SETTLEMENT_STATUSES: readonly SettlementStatus[] = ["signed", "homologated", "breached"];

/** Terms (total / installments) can be changed only before anything was paid and while the deal is open. */
export const TERMS_EDITABLE_STATUSES: readonly SettlementStatus[] = ["proposal", "negotiating", "signed"];

// ---------------------------------------------------------------------------
// Deterministic risk suggestion (RF-12) — never official by itself
// ---------------------------------------------------------------------------

export const RISK_SUGGESTION_PREFIX = "Sugestão automática por regra (não oficial):";

export type RiskRuleInput = {
  status: ProcessStatus;
  phase: ProcessPhase;
  instance: ProcessInstance | null;
  closureReason: ClosureReason | null;
  /** Current official liquidated value (null = não apurado). */
  liquidatedCents: number | null;
};

export type RiskRuleResult = {
  classification: LossProbability;
  /** pt-BR explanation of the factors that led to the classification. */
  factors: string[];
};

const ENFORCEMENT_PHASES: readonly ProcessPhase[] = ["liquidation", "enforcement", "settlement"];

/**
 * Transparent rule (no AI): uses only phase, instance, closure and the
 * presence of a liquidated value.
 *   1. Closed/archived process, phase "encerrado" or liquidated value zeroed (quitação) → remota.
 *   2. Liquidated value assessed, or phase liquidação / execução / acordo → provável.
 *   3. Otherwise (conhecimento, recursal, pré-ajuizamento) → possível.
 */
export function suggestRiskByRule(input: RiskRuleInput): RiskRuleResult {
  const factors: string[] = [];
  if (input.status === "closed" || input.status === "archived" || input.phase === "closed") {
    factors.push("o processo está encerrado ou arquivado, sem expectativa de novo desembolso");
    if (input.closureReason) factors.push(`motivo de encerramento registrado: ${closureText(input.closureReason)}`);
    return { classification: "remote", factors };
  }
  if (input.liquidatedCents === 0) {
    factors.push("o valor liquidado vigente é zero (quitação registrada)");
    return { classification: "remote", factors };
  }
  if (input.liquidatedCents !== null || ENFORCEMENT_PHASES.includes(input.phase)) {
    if (input.liquidatedCents !== null) factors.push("há valor liquidado/apurado oficial vigente");
    if (input.phase === "liquidation") factors.push("o processo está em fase de liquidação");
    if (input.phase === "enforcement") factors.push("o processo está em fase de execução / cumprimento");
    if (input.phase === "settlement") factors.push("há acordo em andamento");
    factors.push("a obrigação de pagar já está definida ou em definição");
    return { classification: "probable", factors };
  }
  if (input.phase === "appeal") {
    factors.push(
      input.instance === "second" || input.instance === "superior"
        ? "o processo está em fase recursal em instância superior, com resultado ainda reversível"
        : "o processo está em fase recursal, com resultado ainda reversível",
    );
  } else if (input.phase === "pre_filing") {
    factors.push("a demanda ainda não foi ajuizada");
  } else {
    factors.push("o processo está em fase de conhecimento, sem condenação definida");
  }
  factors.push("não há valor liquidado oficial");
  return { classification: "possible", factors };
}

function closureText(reason: ClosureReason): string {
  const map: Record<ClosureReason, string> = {
    paid_extinct: "pago / extinto pela satisfação",
    settlement_fulfilled: "acordo cumprido",
    dismissed: "improcedente / extinto sem ônus",
    archived: "arquivado definitivamente",
    returned_to_origin: "baixado à origem",
    lost_patronage: "saída do acervo / perda do patrocínio",
    other: "outro motivo",
  };
  return map[reason];
}

/** Opinion text stored with a rule suggestion (starts with RISK_SUGGESTION_PREFIX). */
export function ruleSuggestionOpinion(result: RiskRuleResult, rulesVersion: number, percentLabel: string): string {
  return (
    `${RISK_SUGGESTION_PREFIX} classificação sugerida "${riskLabel(result.classification)}" (${percentLabel}) ` +
    `porque ${result.factors.join("; ")}. Regra determinística baseada em fase, instância, encerramento e ` +
    `existência de valor liquidado (versão ${rulesVersion} dos parâmetros de risco). Não considera o mérito: ` +
    "confirme ou rejeite com o seu parecer."
  );
}

function riskLabel(c: LossProbability): string {
  return c === "remote" ? "Remota" : c === "possible" ? "Possível" : "Provável";
}

// ---------------------------------------------------------------------------
// Document page slicing (review queue, TE-04)
// ---------------------------------------------------------------------------

/**
 * Text of page `page` (1-based) using the page start offsets of the version
 * (`pageOffsets[0]` = start of page 1). Without offsets, page 1 is the whole
 * text and other pages are unknown (null).
 */
export function slicePageText(text: string, pageOffsets: number[] | null | undefined, page: number): string | null {
  if (!Number.isInteger(page) || page < 1) return null;
  if (!pageOffsets || pageOffsets.length === 0) return page === 1 ? text : null;
  if (page > pageOffsets.length) return null;
  const start = Math.max(0, Math.min(text.length, pageOffsets[page - 1] ?? 0));
  const endRaw = page < pageOffsets.length ? pageOffsets[page] : text.length;
  const end = Math.max(start, Math.min(text.length, endRaw ?? text.length));
  return text.slice(start, end);
}

/**
 * Locates `excerpt` inside `text` ignoring case and whitespace differences.
 * Returns [start, end) in `text` coordinates, or null when not found.
 */
export function findExcerpt(text: string, excerpt: string | null | undefined): { start: number; end: number } | null {
  if (!excerpt) return null;
  const needleChars = excerpt.trim();
  if (needleChars.length < 3) return null;
  // Build a normalized haystack (lower case, runs of whitespace → one space) with a map back to original indexes.
  const map: number[] = [];
  let norm = "";
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (prevSpace || norm.length === 0) continue;
      norm += " ";
      map.push(i);
      prevSpace = true;
    } else {
      norm += ch.toLocaleLowerCase("pt-BR");
      map.push(i);
      prevSpace = false;
    }
  }
  const needle = needleChars.replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
  const idx = norm.indexOf(needle);
  if (idx < 0) return null;
  const start = map[idx];
  const end = map[idx + needle.length - 1] + 1;
  return { start, end };
}

/** Caps a page text for display, keeping the highlighted region visible. */
export function windowAround(
  text: string,
  highlight: { start: number; end: number } | null,
  max = 12_000,
): { text: string; highlight: { start: number; end: number } | null; truncatedStart: boolean; truncatedEnd: boolean } {
  if (text.length <= max) return { text, highlight, truncatedStart: false, truncatedEnd: false };
  const center = highlight ? Math.floor((highlight.start + highlight.end) / 2) : 0;
  let from = Math.max(0, center - Math.floor(max / 2));
  const to = Math.min(text.length, from + max);
  from = Math.max(0, to - max);
  return {
    text: text.slice(from, to),
    highlight: highlight && highlight.start >= from && highlight.end <= to ? { start: highlight.start - from, end: highlight.end - from } : null,
    truncatedStart: from > 0,
    truncatedEnd: to < text.length,
  };
}
