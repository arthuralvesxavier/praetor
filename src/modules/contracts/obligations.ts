/**
 * Pure helpers for contract obligations (client-safe, no server imports).
 *
 * Recurrence: the `contract_obligations.recurrence` column is free text (older
 * rows hold values such as "mensal"). The module maps it onto a small fixed set
 * of recurrences; values written by this module are the canonical pt-BR words
 * below, so existing rows, the seed and AI source blocks keep reading
 * naturally. Text that does not match a known recurrence is kept as is and
 * shown verbatim ("custom"), without automatic next occurrence.
 *
 * Status: "em atraso" is COMPUTED from the due date (an open obligation whose
 * due date is before today), never trusted from the stored value alone.
 */
import type { ObligationStatus } from "@/domain/enums";

export const OBLIGATION_RECURRENCES = ["none", "monthly", "quarterly", "semiannual", "annual"] as const;
export type ObligationRecurrence = (typeof OBLIGATION_RECURRENCES)[number];
export type RepeatingRecurrence = Exclude<ObligationRecurrence, "none">;

export const OBLIGATION_RECURRENCE_LABELS: Record<ObligationRecurrence, string> = {
  none: "Sem recorrência (única)",
  monthly: "Mensal",
  quarterly: "Trimestral",
  semiannual: "Semestral",
  annual: "Anual",
};

/** Value of the recurrence select that keeps a legacy free-text recurrence unchanged (edit form). */
export const KEEP_RECURRENCE = "__manter__";

/** Months between two occurrences. */
export const RECURRENCE_MONTHS: Record<RepeatingRecurrence, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

/** Canonical text stored in the free-text column. */
export const RECURRENCE_STORED_TEXT: Record<RepeatingRecurrence, string> = {
  monthly: "mensal",
  quarterly: "trimestral",
  semiannual: "semestral",
  annual: "anual",
};

/** Accepted spellings (lower case, without accents, single spaces, no final period). */
const ALIASES: Record<string, ObligationRecurrence> = {
  none: "none",
  nenhuma: "none",
  "sem recorrencia": "none",
  unica: "none",
  "nao recorrente": "none",
  monthly: "monthly",
  mensal: "monthly",
  mensalmente: "monthly",
  "todo mes": "monthly",
  "todos os meses": "monthly",
  "a cada mes": "monthly",
  "a cada 1 mes": "monthly",
  quarterly: "quarterly",
  trimestral: "quarterly",
  trimestralmente: "quarterly",
  "a cada 3 meses": "quarterly",
  "a cada tres meses": "quarterly",
  semiannual: "semiannual",
  semestral: "semiannual",
  semestralmente: "semiannual",
  "a cada 6 meses": "semiannual",
  "a cada seis meses": "semiannual",
  annual: "annual",
  anual: "annual",
  anualmente: "annual",
  "todo ano": "annual",
  "a cada ano": "annual",
  "a cada 12 meses": "annual",
  "a cada doze meses": "annual",
};

function normalizeKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.;]+$/, "")
    .trim();
}

export type ParsedRecurrence = { kind: ObligationRecurrence; text: string | null } | { kind: "custom"; text: string };

/** Maps the stored text onto a known recurrence ("custom" keeps unrecognized text). */
export function parseRecurrence(text: string | null | undefined): ParsedRecurrence {
  const raw = (text ?? "").trim();
  if (!raw) return { kind: "none", text: null };
  const kind = ALIASES[normalizeKey(raw)];
  return kind ? { kind, text: raw } : { kind: "custom", text: raw };
}

export function isRecurrenceId(value: string): value is ObligationRecurrence {
  return (OBLIGATION_RECURRENCES as readonly string[]).includes(value);
}

/** Value to store for a recurrence id (null = no recurrence). */
export function recurrenceToStored(kind: ObligationRecurrence): string | null {
  return kind === "none" ? null : RECURRENCE_STORED_TEXT[kind];
}

/** Display text: label of a known recurrence, or the custom text as informed. */
export function recurrenceDisplay(text: string | null | undefined): string {
  const parsed = parseRecurrence(text);
  return parsed.kind === "custom" ? parsed.text : OBLIGATION_RECURRENCE_LABELS[parsed.kind];
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Adds calendar months to a "YYYY-MM-DD" date keeping the day of the month;
 * when the target month is shorter, uses its last day (31/01 + 1 mês = 28/02).
 */
export function addMonthsISO(iso: string, months: number): string {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) throw new RangeError(`Data inválida: ${iso}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + Math.trunc(months);
  const year = Math.floor(total / 12);
  const month0 = total - year * 12;
  const day = Math.min(Number(m[3]), daysInMonth(year, month0));
  return `${String(year).padStart(4, "0")}-${String(month0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Due date of the next occurrence, or null when the obligation does not repeat (or has no valid due date). */
export function nextDueDate(dueDate: string | null | undefined, recurrence: ObligationRecurrence | "custom"): string | null {
  if (!dueDate || !ISO_DATE_RE.test(dueDate)) return null;
  if (recurrence === "none" || recurrence === "custom") return null;
  return addMonthsISO(dueDate, RECURRENCE_MONTHS[recurrence]);
}

export const OPEN_OBLIGATION_STATUSES: readonly ObligationStatus[] = ["pending", "overdue"];

export function isOpenObligation(status: ObligationStatus): boolean {
  return status === "pending" || status === "overdue";
}

/**
 * Status shown everywhere: closed statuses are kept; an open obligation is
 * "overdue" when its due date is before today and "pending" otherwise. Without
 * a due date the stored value is kept (it may have been set manually).
 */
export function effectiveObligationStatus(status: ObligationStatus, dueDate: string | null, today: string): ObligationStatus {
  if (!isOpenObligation(status)) return status;
  if (!dueDate || !ISO_DATE_RE.test(dueDate)) return status;
  return dueDate < today ? "overdue" : "pending";
}
