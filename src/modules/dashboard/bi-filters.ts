/**
 * BI dashboard filters (client-safe): URL parsing, period ranges, time buckets
 * and drill-down links to the lists that originate each figure.
 */
import { LEGAL_AREAS, type LegalArea, type OccurrenceCategory, type ProcessPhase, type RiskLevel } from "@/domain/enums";
import { addDaysISO, APP_LOCALE, todayISO } from "@/lib/format";
import { enumParam, idParam, type SearchParams } from "@/lib/search-params";

export const BI_PERIODS = ["30d", "90d", "6m", "12m", "ytd", "all"] as const;
export type BiPeriod = (typeof BI_PERIODS)[number];
export const BI_PERIOD_LABELS: Record<BiPeriod, string> = {
  "30d": "Últimos 30 dias",
  "90d": "Últimos 90 dias",
  "6m": "Últimos 6 meses",
  "12m": "Últimos 12 meses",
  ytd: "Ano atual",
  all: "Todo o período",
};
export const DEFAULT_BI_PERIOD: BiPeriod = "12m";

export type BiFilters = {
  period: BiPeriod;
  unitId: string | null;
  area: LegalArea | null;
  responsibleId: string | null;
};

/** URL params: periodo, unidade, area, responsavel (same names as the list pages). */
export function parseBiFilters(sp: SearchParams | null | undefined): BiFilters {
  return {
    period: enumParam(sp, "periodo", BI_PERIODS) ?? DEFAULT_BI_PERIOD,
    unitId: idParam(sp, "unidade") ?? null,
    area: enumParam(sp, "area", LEGAL_AREAS) ?? null,
    responsibleId: idParam(sp, "responsavel") ?? null,
  };
}

export function hasDimensionFilter(f: BiFilters): boolean {
  return Boolean(f.unitId || f.area || f.responsibleId);
}

// ---------------------------------------------------------------------------
// Period ranges & buckets
// ---------------------------------------------------------------------------

export type Granularity = "week" | "month";

export type PeriodRange = {
  /** Inclusive start, "YYYY-MM-DD". */
  start: string;
  /** Inclusive end (today). */
  end: string;
  granularity: Granularity;
  /** Equal-length range right before `start`, for deltas (null for "all"). */
  previous: { start: string; end: string } | null;
};

function parts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}
const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function firstOfMonth(isoDate: string, monthsBack = 0): string {
  const { y, m } = parts(isoDate);
  const total = y * 12 + (m - 1) - monthsBack;
  return iso(Math.floor(total / 12), (total % 12) + 1, 1);
}

/** Monday of the ISO week containing the date (matches Postgres date_trunc('week')). */
export function mondayOf(isoDate: string): string {
  const { y, m, d } = parts(isoDate);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysISO(isoDate, -((dow + 6) % 7));
}

function daysBetween(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/**
 * @param earliest earliest record date in scope, used by "all" (capped to 36 months).
 */
export function periodRange(period: BiPeriod, today: string = todayISO(), earliest?: string | null): PeriodRange {
  let start: string;
  switch (period) {
    case "30d":
      start = addDaysISO(today, -29);
      break;
    case "90d":
      start = addDaysISO(today, -89);
      break;
    case "6m":
      start = firstOfMonth(today, 5);
      break;
    case "12m":
      start = firstOfMonth(today, 11);
      break;
    case "ytd":
      start = `${today.slice(0, 4)}-01-01`;
      break;
    case "all": {
      const cap = firstOfMonth(today, 35);
      const from = earliest && earliest < today ? firstOfMonth(earliest) : firstOfMonth(today, 11);
      start = from < cap ? cap : from;
      break;
    }
  }
  const granularity: Granularity = period === "30d" || period === "90d" ? "week" : "month";
  const length = daysBetween(start, today) + 1;
  const previous =
    period === "all" ? null : { start: addDaysISO(start, -length), end: addDaysISO(start, -1) };
  return { start, end: today, granularity, previous };
}

export type Bucket = { key: string; label: string; longLabel: string; start: string; end: string };

const monthShort = new Intl.DateTimeFormat(APP_LOCALE, { month: "short", timeZone: "UTC" });
const monthLong = new Intl.DateTimeFormat(APP_LOCALE, { month: "long", year: "numeric", timeZone: "UTC" });

function utc(isoDate: string) {
  const { y, m, d } = parts(isoDate);
  return new Date(Date.UTC(y, m - 1, d));
}
const ddmm = (isoDate: string) => `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}`;

/** Buckets covering the range; `key` equals the SQL date_trunc(granularity) start date. */
export function buildBuckets(range: PeriodRange): Bucket[] {
  const out: Bucket[] = [];
  if (range.granularity === "week") {
    for (let s = mondayOf(range.start); s <= range.end; s = addDaysISO(s, 7)) {
      const e = addDaysISO(s, 6);
      out.push({ key: s, label: ddmm(s), longLabel: `Semana de ${ddmm(s)} a ${ddmm(e)}`, start: s, end: e });
    }
    return out;
  }
  for (let s = firstOfMonth(range.start); s <= range.end; ) {
    const next = firstOfMonth(addDaysISO(s, 32));
    const short = monthShort.format(utc(s)).replace(".", "");
    const yy = s.slice(2, 4);
    const long = monthLong.format(utc(s));
    out.push({
      key: s,
      label: `${short}/${yy}`,
      longLabel: long.charAt(0).toUpperCase() + long.slice(1),
      start: s,
      end: addDaysISO(next, -1),
    });
    s = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drill-down links (param names follow docs/dev/MODULE_CONTRACTS.md)
// ---------------------------------------------------------------------------

function qs(params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function processesHref(
  f: BiFilters,
  extra: { status?: string; risco?: RiskLevel; area?: LegalArea; phase?: ProcessPhase } = {},
): string {
  return `/processos${qs({
    status: extra.status,
    area: extra.area ?? f.area,
    phase: extra.phase,
    risco: extra.risco,
    unidade: f.unitId,
    responsavel: f.responsibleId,
  })}`;
}

export function occurrencesHref(
  f: BiFilters,
  extra: { status?: string; categoria?: OccurrenceCategory; risco?: RiskLevel } = {},
): string {
  return `/preventivo${qs({
    status: extra.status,
    categoria: extra.categoria,
    risco: extra.risco,
    unidade: f.unitId,
    responsavel: f.responsibleId,
  })}`;
}

export function deadlinesHref(f: BiFilters, extra: { situacao?: string; aba?: string; mes?: string } = {}): string {
  return `/prazos${qs({ aba: extra.aba ?? "prazos", situacao: extra.situacao, mes: extra.mes, responsavel: f.responsibleId })}`;
}

export function tasksHref(f: BiFilters, responsibleId?: string | null): string {
  return `/prazos${qs({ aba: "tarefas", responsavel: responsibleId ?? f.responsibleId })}`;
}

export function contractsHref(f: BiFilters, extra: { vencendo?: boolean } = {}): string {
  return `/contratos${qs({ vencendo: extra.vencendo ? "1" : null, responsavel: f.responsibleId })}`;
}
