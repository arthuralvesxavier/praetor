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

/** Compact BRL ("R$ 1,2 mi") from integer cents, for KPI cards. */
export function formatCompactMoneyCents(cents: number): string {
  return new Intl.NumberFormat(APP_LOCALE, {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
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
