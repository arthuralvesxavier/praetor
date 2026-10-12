/**
 * Pure calculation of the UPDATED value of a valuation (P1.7). Client-safe, no
 * I/O. The updated value is always computed on read and never stored.
 *
 * Convention (product decision, not a legal rule): the monthly rates of the
 * chosen index are compounded from the month AFTER the base date up to the
 * last month published before the month of `asOf`:
 *
 *   factor = Π (1 + rate_m / 100),  m = month(baseDate)+1 … end
 *   end    = min(month(asOf) − 1, last month the series has)
 *
 * Any month without a rate inside that range makes the result unavailable
 * (`cents: null`, with the missing months listed): nothing is estimated or
 * interpolated. Which index applies to a case is the lawyer's choice; this
 * module only does the arithmetic.
 *
 * Exactness: rates are integer micro-percent (0.16% = 160000) and the product
 * is computed with BigInt, so the cents are exact (rounded half away from zero
 * only once, at the end).
 */
import type { CorrectionIndex, IndexSeriesCode } from "@/domain/enums";

// ---------------------------------------------------------------------------
// Months ("YYYY-MM")
// ---------------------------------------------------------------------------

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ISO_DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isMonth(value: string): boolean {
  return MONTH_RE.test(value);
}

export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value);
}

/** "2026-09-15" → "2026-09". */
export function monthOfDate(iso: string): string {
  return iso.slice(0, 7);
}

/** Adds (or subtracts) whole months to a "YYYY-MM" string. */
export function addMonths(month: string, delta: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) throw new RangeError(`Mês inválido: ${month}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + Math.trunc(delta);
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
}

/** Months from `from` to `to`, inclusive (empty when `from` > `to`). */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** "2026-09" → "09/2026". */
export function formatMonth(month: string | null | undefined, fallback = ""): string {
  if (!month) return fallback;
  const m = MONTH_RE.exec(month);
  return m ? `${m[2]}/${m[1]}` : fallback;
}

/** Consecutive months grouped: ["2025-03","2025-04","2025-05","2025-08"] → [["2025-03","2025-05"],["2025-08","2025-08"]]. */
export function groupMonthRanges(months: readonly string[]): [string, string][] {
  const sorted = [...new Set(months)].filter(isMonth).sort();
  const out: [string, string][] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && addMonths(sorted[j], 1) === sorted[j + 1]) j++;
    out.push([sorted[i], sorted[j]]);
    i = j + 1;
  }
  return out;
}

/** Consecutive months grouped: ["2025-03","2025-04","2025-05","2025-08"] → "03/2025 a 05/2025, 08/2025". */
export function formatMonthRanges(months: readonly string[]): string {
  return groupMonthRanges(months)
    .map(([a, b]) => (a === b ? formatMonth(a) : `${formatMonth(a)} a ${formatMonth(b)}`))
    .join(", ");
}

/**
 * Months missing BETWEEN the first and the last stored month of a series
 * (["2024-01","2024-02","2024-05"] → ["2024-03","2024-04"]). Months before the
 * first stored one are not gaps (the series may start later at the source).
 */
export function seriesGaps(storedMonths: Iterable<string>): string[] {
  const set = new Set([...storedMonths].filter(isMonth));
  if (set.size < 2) return [];
  const sorted = [...set].sort();
  return monthRange(sorted[0], sorted[sorted.length - 1]).filter((m) => !set.has(m));
}

// ---------------------------------------------------------------------------
// Rates (integer micro-percent: 1 = 0.000001%)
// ---------------------------------------------------------------------------

const RATE_RE = /^(-)?(\d{1,6})(?:\.(\d{1,6}))?$/;
const MICRO_PER_PERCENT = 1_000_000;

/**
 * "0.16" / "-0.32" / "0.1690" / "0.160000" (dot decimal, as published by the
 * SGS API and returned by PostgreSQL numeric) → micro-percent. Null when the
 * text is not a plain decimal with up to 6 decimals, or the rate is −100% or
 * less (a factor ≤ 0 is never a valid monthly variation).
 */
export function parseRateMicro(text: string): number | null {
  const m = RATE_RE.exec(text.trim());
  if (!m) return null;
  const micro = Number(m[2]) * MICRO_PER_PERCENT + Number((m[3] ?? "").padEnd(6, "0"));
  const signed = m[1] ? -micro : micro;
  if (signed <= -100 * MICRO_PER_PERCENT) return null;
  return signed === 0 ? 0 : signed;
}

/** Micro-percent → "0.160000" (value written to the numeric column). */
export function microToRateText(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(micro));
  return `${sign}${Math.floor(abs / MICRO_PER_PERCENT)}.${String(abs % MICRO_PER_PERCENT).padStart(6, "0")}`;
}

/** Micro-percent → "0,16%" / "-0,32%" / "0,169%" (pt-BR, trailing zeros removed). */
export function formatRateMicro(micro: number): string {
  const text = microToRateText(micro).replace(/0+$/, "").replace(/\.$/, "");
  return `${text.replace(".", ",")}%`;
}

// ---------------------------------------------------------------------------
// Updated value
// ---------------------------------------------------------------------------

/** Monthly rates of one index: "YYYY-MM" → micro-percent. */
export type MonthlyRates = ReadonlyMap<string, number>;
export type SeriesByIndex = Partial<Record<IndexSeriesCode, MonthlyRates>>;

export type UpdatedValueStatus =
  /** Valuation without an index ("sem índice informado"). */
  | "no_index"
  /** Index "none": explicit choice of no update; the updated value IS the original. */
  | "not_corrected"
  /** No complete month after the base date before `asOf`: nothing to apply. */
  | "no_months"
  /** Rates compounded. */
  | "updated"
  /** A month inside the range has no rate: no value (never estimated). */
  | "unavailable";

export type UpdatedValue = {
  status: UpdatedValueStatus;
  /** Updated amount; null when there is no index or a month is missing. */
  cents: number | null;
  /** Accumulated factor (display only; the cents come from the exact product). */
  factor: number | null;
  monthsApplied: number;
  firstMonth: string | null;
  /** Last month applied ("atualizado até"). */
  throughMonth: string | null;
  /** Months inside the range without a rate (status "unavailable"). */
  missingMonths: string[];
  /** Months after `throughMonth` and before `asOf` not published/collected yet (informative). */
  pendingMonths: string[];
};

const RATE_SCALE = 100_000_000; // micro-percent → fraction: rate / 1e8
const FACTOR_DISPLAY_DECIMALS = 9;

function big(n: number): bigint {
  return BigInt(n);
}

/** Rounds numerator/denominator to the nearest integer, half away from zero. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const zero = big(0);
  const negative = numerator < zero !== denominator < zero;
  const n = numerator < zero ? -numerator : numerator;
  const d = denominator < zero ? -denominator : denominator;
  let q = n / d;
  if ((n % d) * big(2) >= d) q += big(1);
  return negative ? -q : q;
}

function empty(status: UpdatedValueStatus, cents: number | null, factor: number | null): UpdatedValue {
  return {
    status,
    cents,
    factor,
    monthsApplied: 0,
    firstMonth: null,
    throughMonth: null,
    missingMonths: [],
    pendingMonths: [],
  };
}

/**
 * Updated value of `amountCents` (base date `baseDate`) by `indexCode` as of
 * `asOf` ("YYYY-MM-DD"). See the module comment for the convention.
 */
export function updatedValue(
  amountCents: number,
  baseDate: string,
  indexCode: CorrectionIndex | null,
  asOf: string,
  series: SeriesByIndex,
): UpdatedValue {
  if (indexCode === null) return empty("no_index", null, null);
  if (indexCode === "none") return empty("not_corrected", amountCents, 1);
  if (!Number.isSafeInteger(amountCents) || !isIsoDate(baseDate) || !isIsoDate(asOf)) {
    return empty("unavailable", null, null);
  }

  const start = addMonths(monthOfDate(baseDate), 1);
  const cap = addMonths(monthOfDate(asOf), -1);
  if (start > cap) return empty("no_months", amountCents, 1);

  const rates = series[indexCode];
  let lastAvailable: string | null = null;
  if (rates) {
    for (const month of rates.keys()) {
      if (month <= cap && (lastAvailable === null || month > lastAvailable)) lastAvailable = month;
    }
  }
  // Nothing published inside the range: every month of it is missing.
  if (!rates || lastAvailable === null || lastAvailable < start) {
    return { ...empty("unavailable", null, null), missingMonths: monthRange(start, cap) };
  }

  const end = lastAvailable;
  const months = monthRange(start, end);
  const missing = months.filter((m) => !rates.has(m));
  const pending = monthRange(addMonths(end, 1), cap);
  if (missing.length > 0) {
    return { ...empty("unavailable", null, null), missingMonths: missing, pendingMonths: pending };
  }

  let numerator = big(1);
  for (const m of months) numerator *= big(RATE_SCALE + (rates.get(m) as number));
  const denominator = big(RATE_SCALE) ** big(months.length);

  const cents = divRound(big(amountCents) * numerator, denominator);
  const scaledFactor = divRound(numerator * big(10) ** big(FACTOR_DISPLAY_DECIMALS), denominator);
  return {
    status: "updated",
    cents: Number(cents),
    factor: Number(scaledFactor) / 10 ** FACTOR_DISPLAY_DECIMALS,
    monthsApplied: months.length,
    firstMonth: start,
    throughMonth: end,
    missingMonths: [],
    pendingMonths: pending,
  };
}

/** pt-BR explanation of an unavailable result: "atualização indisponível (faltam meses: 03/2025 a 05/2025)". */
export function unavailableMessage(result: Pick<UpdatedValue, "missingMonths">): string {
  return result.missingMonths.length > 0
    ? `atualização indisponível (faltam meses: ${formatMonthRanges(result.missingMonths)})`
    : "atualização indisponível (data-base ou valor inválido)";
}
