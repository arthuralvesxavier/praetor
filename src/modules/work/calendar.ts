import { addDaysISO, todayISO } from "@/lib/format";
import { MONTH_RE } from "./schemas";

/**
 * Month-grid helpers for the deadlines calendar (client-safe, timezone-free:
 * every value is a "YYYY-MM" / "YYYY-MM-DD" calendar string).
 */

export type CalendarDay = { date: string; day: number; inMonth: boolean; weekday: number };

export const WEEKDAY_LABELS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"] as const;
export const WEEKDAY_SHORT_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"] as const;

/** Current month ("YYYY-MM") in the application time zone. */
export function currentMonth(today: string = todayISO()): string {
  return today.slice(0, 7);
}

/** Valid "YYYY-MM" or undefined. */
export function parseMonth(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!MONTH_RE.test(v)) return undefined;
  const year = Number(v.slice(0, 4));
  return year >= 1990 && year <= 2199 ? v : undefined;
}

/** Adds `delta` months to "YYYY-MM". */
export function shiftMonth(month: string, delta: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const year = y + Math.floor(m / 12);
  const mo = ((m % 12) + 12) % 12;
  return `${year}-${String(mo + 1).padStart(2, "0")}`;
}

function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** First and last calendar day of a month. */
export function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayMondayFirst(iso: string): number {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  return (d.getUTCDay() + 6) % 7;
}

/** Weeks (Monday → Sunday) covering the whole month, padded with days of the adjacent months. */
export function buildMonthGrid(month: string): CalendarDay[][] {
  const { from, to } = monthRange(month);
  const start = addDaysISO(from, -weekdayMondayFirst(from));
  const end = addDaysISO(to, 6 - weekdayMondayFirst(to));
  const weeks: CalendarDay[][] = [];
  let week: CalendarDay[] = [];
  for (let date = start; date <= end; date = addDaysISO(date, 1)) {
    week.push({ date, day: Number(date.slice(8, 10)), inMonth: date.startsWith(month), weekday: week.length });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  return weeks;
}
