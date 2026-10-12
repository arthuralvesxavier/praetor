import { APP_TIME_ZONE, addDaysISO, toISODate } from "@/lib/format";

/**
 * Wall-clock helpers for hearings (client-safe, no server imports).
 *
 * Hearings are stored as timestamps (`scheduled_at`) but are typed and shown as
 * a calendar date + time in the organization's time zone (America/Sao_Paulo),
 * whatever the time zone of the server or the browser.
 */

export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function zonedFields(d: Date): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = partsFormatter.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Offset (ms) of APP_TIME_ZONE at the given instant: zoned wall time minus UTC. */
function zoneOffsetMs(instant: number): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const f = zonedFields(new Date(whole));
  return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - whole;
}

/** "YYYY-MM-DD" + "HH:MM" typed in America/Sao_Paulo -> the UTC instant. */
export function zonedDateTimeToUtc(date: string, time: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - zoneOffsetMs(wall);
  const second = wall - zoneOffsetMs(first);
  return new Date(second);
}

/** Start (00:00 in America/Sao_Paulo) of a calendar day. */
export function startOfZonedDay(date: string): Date {
  return zonedDateTimeToUtc(date, "00:00");
}

/** Start of the day after `date` (exclusive upper bound of a day range). */
export function endOfZonedDayExclusive(date: string): Date {
  return startOfZonedDay(addDaysISO(date, 1));
}

/** "HH:MM" of a timestamp in America/Sao_Paulo. */
export function formatTime(value: Date): string {
  const f = zonedFields(value);
  return `${String(f.h).padStart(2, "0")}:${String(f.mi).padStart(2, "0")}`;
}

/** Calendar date ("YYYY-MM-DD") and time ("HH:MM") of a timestamp in America/Sao_Paulo (for form defaults). */
export function zonedDateAndTime(value: Date): { date: string; time: string } {
  return { date: toISODate(value), time: formatTime(value) };
}

const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"] as const;

/** "segunda-feira" for a "YYYY-MM-DD" calendar date (timezone-free). */
export function weekdayName(date: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

/** True for a well-formed http(s) URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}
