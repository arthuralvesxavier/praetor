/**
 * Link between an occurrence and the preventive-intelligence indicator that
 * originated it (client-safe, pure). There is no schema column for it: the
 * occurrence facts end with a readable footer that carries a stable marker
 *
 *   Origem: inteligência preventiva [ref: pi:<indicator-key>]
 *
 * so the origin survives edits of the rest of the text and can be searched.
 */

export const PREVENTIVE_ORIGIN_LABEL = "Origem: inteligência preventiva";

/** Indicator keys: lowercase letters, digits, "-" and ":" (e.g. "conciliacao:trt10"). */
const KEY_RE = /^[a-z0-9][a-z0-9:-]{0,79}$/;
const MARKER_RE = /\[ref: pi:([a-z0-9][a-z0-9:-]{0,79})\]/;
const INDICATOR_LINE_RE = /^Indicador:\s*(.+)$/m;

/** Substring present in every occurrence created from an indicator (used in ILIKE searches). */
export const PREVENTIVE_MARKER_PREFIX = "[ref: pi:";

export function isPreventiveIndicatorKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function preventiveOriginMarker(key: string): string {
  if (!isPreventiveIndicatorKey(key)) throw new RangeError(`Chave de indicador inválida: ${key}`);
  return `[ref: pi:${key}]`;
}

export type PreventiveOrigin = {
  /** Stable indicator key, e.g. "jornada" or "conciliacao:trt10". */
  key: string;
  /** "Indicador: …" line written when the occurrence was created (null when it was edited out). */
  indicator: string | null;
};

/** Reads the origin footer from the facts of an occurrence (null when it was not created from an indicator). */
export function parsePreventiveOrigin(facts: string | null | undefined): PreventiveOrigin | null {
  if (!facts) return null;
  const m = MARKER_RE.exec(facts);
  if (!m) return null;
  const line = INDICATOR_LINE_RE.exec(facts);
  return { key: m[1], indicator: line ? line[1].trim() : null };
}
