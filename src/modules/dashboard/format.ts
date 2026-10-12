/** Dashboard-only formatting helpers (client-safe, pt-BR). */
import { APP_LOCALE } from "@/lib/format";

/** "Domingo, 11 de outubro de 2026" for a "YYYY-MM-DD" calendar date (no timezone shift). */
export function formatLongDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const text = new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: "full", timeZone: "UTC" }).format(d);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Compact BRL ("R$ 1,2 mi") from integer cents, for KPI cards (charts use `moneyScaleFor`). */
export function formatCompactMoneyCents(cents: number): string {
  return new Intl.NumberFormat(APP_LOCALE, {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/**
 * One money unit for a whole chart (P0.3): every bar label of the chart is written in
 * it, and the unit itself appears once, in the chart's header/axis label — never
 * "R$ 1,3 mi" next to "R$ 571 mil" inside the same chart.
 */
export type MoneyScale = {
  unit: "real" | "thousand" | "million" | "billion";
  /** Reais per unit (1, 1.000, 1.000.000, 1.000.000.000). */
  divisor: number;
  /** "R$", "R$ mil", "R$ milhões", "R$ bilhões". */
  label: string;
  /** Decimal places shared by every label of the chart (chosen from the largest value). */
  fractionDigits: number;
};

const MONEY_UNITS: readonly Omit<MoneyScale, "fractionDigits">[] = [
  { unit: "billion", divisor: 1e9, label: "R$ bilhões" },
  { unit: "million", divisor: 1e6, label: "R$ milhões" },
  { unit: "thousand", divisor: 1e3, label: "R$ mil" },
  { unit: "real", divisor: 1, label: "R$" },
];

/**
 * Chooses the unit of a chart from the LARGEST value of its dataset (integer cents):
 * ≥ R$ 1 bilhão → "R$ bilhões", ≥ R$ 1 milhão → "R$ milhões", ≥ R$ 1 mil → "R$ mil",
 * otherwise "R$". The decimals are chosen once too (largest value < 10 units → 2,
 * < 100 → 1, else 0), so all labels line up. Non-finite values are ignored.
 */
export function moneyScaleFor(valuesCents: readonly number[]): MoneyScale {
  const maxReais = Math.max(0, ...valuesCents.filter(Number.isFinite).map((v) => Math.abs(v))) / 100;
  const unit = MONEY_UNITS.find((u) => maxReais >= u.divisor) ?? MONEY_UNITS[MONEY_UNITS.length - 1];
  const top = maxReais / unit.divisor;
  return { ...unit, fractionDigits: top < 10 ? 2 : top < 100 ? 1 : 0 };
}

/**
 * A value in the chart's unit, without the unit ("1,30", "0,57", "571"). A positive
 * value too small for the chart's precision reads "< 0,01" (never a misleading "0,00").
 */
export function formatInScale(cents: number, scale: MoneyScale): string {
  const digits = scale.fractionDigits;
  const nf = new Intl.NumberFormat(APP_LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const value = cents / 100 / scale.divisor;
  const step = 10 ** -digits;
  if (cents > 0 && value < step / 2) return `< ${nf.format(step)}`;
  return nf.format(value);
}

/** "agora mesmo" / "há 5 minutos" / "há 3 horas" / "há 2 dias". */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMin = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (diffMin < 1) return "agora mesmo";
  if (diffMin < 60) return diffMin === 1 ? "há 1 minuto" : `há ${diffMin} minutos`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return hours === 1 ? "há 1 hora" : `há ${hours} horas`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "há 1 dia" : `há ${days} dias`;
  const months = Math.floor(days / 30);
  return months === 1 ? "há 1 mês" : `há ${months} meses`;
}
