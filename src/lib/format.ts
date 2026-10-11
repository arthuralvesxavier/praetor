/**
 * pt-BR formatting helpers (client-safe, no server imports).
 *
 * Date conventions:
 * - `date` columns arrive as "YYYY-MM-DD" strings. They are calendar dates and
 *   are NEVER converted through a timezone (no off-by-one shifts).
 * - Timestamps (`Date` or full ISO strings) are shown in the organization's
 *   time zone, `APP_TIME_ZONE` (America/Sao_Paulo), so server-rendered and
 *   client-rendered values match regardless of the host time zone.
 * - "Today" (`todayISO`) is also computed in `APP_TIME_ZONE`.
 */

export const APP_TIME_ZONE = "America/Sao_Paulo";
export const APP_LOCALE = "pt-BR";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const EMPTY = "—";

type DateInput = Date | string | null | undefined;

function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value);
}

function toDate(value: Date | string): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Calendar parts of a timestamp in APP_TIME_ZONE. */
function zonedParts(d: Date): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** "dd/mm/aaaa". "YYYY-MM-DD" strings are treated as calendar dates (no timezone shift). */
export function formatDate(value: DateInput, fallback = EMPTY): string {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") {
    const m = ISO_DATE_RE.exec(value);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  const d = toDate(value);
  if (!d) return fallback;
  const p = zonedParts(d);
  return `${p.day}/${p.month}/${p.year}`;
}

/** "dd/mm/aaaa hh:mm" in APP_TIME_ZONE. A "YYYY-MM-DD" string is formatted as a date only. */
export function formatDateTime(value: DateInput, fallback = EMPTY): string {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" && isIsoDate(value)) return formatDate(value, fallback);
  const d = toDate(value);
  if (!d) return fallback;
  const p = zonedParts(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** "outubro de 2026" for a "YYYY-MM" or "YYYY-MM-DD" string. */
export function formatMonthYear(value: string | null | undefined, fallback = EMPTY): string {
  if (!value) return fallback;
  const m = /^(\d{4})-(\d{2})/.exec(value);
  if (!m) return fallback;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return new Intl.DateTimeFormat(APP_LOCALE, { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

// ---------------------------------------------------------------------------
// Calendar arithmetic on "YYYY-MM-DD" strings (timezone-free)
// ---------------------------------------------------------------------------

function isoToUtcMs(iso: string): number {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) throw new RangeError(`Data inválida: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function utcMsToIso(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** Today's calendar date ("YYYY-MM-DD") in APP_TIME_ZONE. */
export function todayISO(now: Date = new Date()): string {
  const p = zonedParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Converts a timestamp to its calendar date ("YYYY-MM-DD") in APP_TIME_ZONE. */
export function toISODate(value: Date): string {
  return todayISO(value);
}

/** Adds (or subtracts) calendar days to a "YYYY-MM-DD" string. */
export function addDaysISO(iso: string, days: number): string {
  return utcMsToIso(isoToUtcMs(iso) + Math.trunc(days) * DAY_MS);
}

/** Calendar days from `today` until `iso` (negative when in the past, 0 = today). */
export function daysUntil(iso: string, today: string = todayISO()): number {
  return Math.round((isoToUtcMs(iso) - isoToUtcMs(today)) / DAY_MS);
}

/** "vence hoje" / "vence amanhã" / "vence em 3 dias" / "vencido há 2 dias". */
export function formatRelativeDays(iso: string | null | undefined, today: string = todayISO()): string {
  if (!iso || !isIsoDate(iso)) return EMPTY;
  const diff = daysUntil(iso, today);
  if (diff === 0) return "vence hoje";
  if (diff === 1) return "vence amanhã";
  if (diff > 1) return `vence em ${diff} dias`;
  const past = -diff;
  return past === 1 ? "vencido há 1 dia" : `vencido há ${past} dias`;
}

// ---------------------------------------------------------------------------
// Numbers & money
// ---------------------------------------------------------------------------

const moneyFormatter = new Intl.NumberFormat(APP_LOCALE, { style: "currency", currency: "BRL" });
const numberFormatter = new Intl.NumberFormat(APP_LOCALE);

/** Integer cents -> "R$ 1.234,56" (with a non-breaking space after "R$"). */
export function formatMoneyCents(cents: number | null | undefined, fallback = EMPTY): string {
  if (cents == null || !Number.isFinite(cents)) return fallback;
  return moneyFormatter.format(cents / 100);
}

/**
 * Parses user-typed money into integer cents. Accepts "1.234,56", "1234,5",
 * "R$ 1.234,56", "1234.56", "1,234.56", "1234" and a leading "-".
 * A single "." followed by exactly three digits is a pt-BR thousands
 * separator ("1.234" -> 123400). Returns null when empty or invalid
 * (including more than two decimal places).
 */
export function parseMoneyToCents(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = input.replace(/R\$/gi, "").replace(/[\s ]/g, "");
  if (!s) return null;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let intPart: string;
  let fracPart = "";

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSep = lastComma > lastDot ? "," : ".";
    const thousandsSep = decimalSep === "," ? "." : ",";
    const [i, f, ...rest] = s.split(decimalSep);
    if (rest.length > 0) return null;
    intPart = i.split(thousandsSep).join("");
    fracPart = f;
  } else if (lastComma >= 0) {
    const pieces = s.split(",");
    if (pieces.length > 2) return null;
    intPart = pieces[0];
    fracPart = pieces[1];
  } else if (lastDot >= 0) {
    const pieces = s.split(".");
    const thousandsOnly = pieces.length > 2 || pieces[1].length === 3;
    if (thousandsOnly) {
      if (pieces.slice(1).some((p) => p.length !== 3)) return null;
      intPart = pieces.join("");
    } else {
      intPart = pieces[0];
      fracPart = pieces[1];
    }
  } else {
    intPart = s;
  }

  if (!/^\d*$/.test(intPart) || !/^\d{0,2}$/.test(fracPart)) return null;
  if (intPart === "" && fracPart === "") return null;
  const cents = Number(intPart || "0") * 100 + Number(fracPart.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Cents -> "1.234,56" (no currency symbol), for pre-filling money inputs. */
export function centsToInputValue(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  return new Intl.NumberFormat(APP_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/** "1.234" / "1.234,5". */
export function formatNumber(value: number | null | undefined, fallback = EMPTY): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  return numberFormatter.format(value);
}

/** 0.256 -> "25,6%". */
export function formatPercent(ratio: number | null | undefined, fractionDigits = 0, fallback = EMPTY): string {
  if (ratio == null || !Number.isFinite(ratio)) return fallback;
  return new Intl.NumberFormat(APP_LOCALE, { style: "percent", maximumFractionDigits: fractionDigits }).format(ratio);
}

/** Bytes -> "820 KB" / "2,4 MB". */
export function formatFileSize(bytes: number | null | undefined, fallback = EMPTY): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return fallback;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[i]}`;
}

/**
 * pluralize(3, "processo", "processos") -> "3 processos"
 * pluralize(1, "prazo vencido", "prazos vencidos") -> "1 prazo vencido"
 * pluralize(0, "tarefa", "tarefas", { withCount: false }) -> "tarefas"
 */
export function pluralize(count: number, singular: string, plural: string, opts: { withCount?: boolean } = {}): string {
  const word = Math.abs(count) === 1 ? singular : plural;
  return opts.withCount === false ? word : `${formatNumber(count)} ${word}`;
}

// ---------------------------------------------------------------------------
// Brazilian documents (CPF / CNPJ)
// ---------------------------------------------------------------------------

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Full formatting: "123.456.789-09" / "12.345.678/0001-90". Unknown formats are returned unchanged. */
export function formatDocument(value: string | null | undefined, fallback = EMPTY): string {
  if (!value) return fallback;
  const d = digitsOnly(value);
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return value;
}

/**
 * For lists (LGPD data minimization): CPFs (personal data) are partially
 * masked -> "***.456.789-**"; CNPJs (company identifiers) are formatted in
 * full. Anything else is masked except the last 4 characters.
 */
export function maskDocument(value: string | null | undefined, fallback = EMPTY): string {
  if (!value) return fallback;
  const d = digitsOnly(value);
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return formatDocument(d);
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(Math.min(8, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Cuts text at `max` characters (on a word boundary when possible) and appends "…". */
export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** "Camila Rocha" -> "CR". */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}
