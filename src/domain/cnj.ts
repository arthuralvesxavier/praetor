/**
 * Número único de processo (CNJ, Resolução 65/2008): NNNNNNN-DD.AAAA.J.TR.OOOO
 *   NNNNNNN  sequencial            DD  dígito verificador (módulo 97, ISO 7064)
 *   AAAA     ano de ajuizamento    J   segmento do Judiciário (5 = Justiça do Trabalho)
 *   TR       tribunal (00 = tribunal superior no segmento)   OOOO  unidade de origem
 *
 * Client-safe, pure. The check digit is validated, never "fixed": an invalid
 * number is reported as an inconsistency for a person to verify.
 */

export type CnjParts = {
  sequence: string;
  checkDigit: string;
  year: number;
  segment: string;
  tribunal: string;
  origin: string;
};

const CNJ_FORMATTED = /^(\d{7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})$/;

/** Digits only. */
export function cnjDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Formats 20 digits as NNNNNNN-DD.AAAA.J.TR.OOOO; returns null when the input does not have exactly 20 digits. */
export function normalizeCnj(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = cnjDigits(String(raw));
  if (d.length !== 20) return null;
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`;
}

export function parseCnj(value: string | null | undefined): CnjParts | null {
  const normalized = normalizeCnj(value);
  if (!normalized) return null;
  const m = CNJ_FORMATTED.exec(normalized);
  if (!m) return null;
  return { sequence: m[1], checkDigit: m[2], year: Number(m[3]), segment: m[4], tribunal: m[5], origin: m[6] };
}

/** mod 97 of a long numeric string, computed in chunks (no BigInt needed). */
function mod97(numeric: string): number {
  let rest = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    rest = Number(`${rest}${numeric.slice(i, i + 7)}`) % 97;
  }
  return rest;
}

/** Expected check digit for the other 18 digits. */
export function computeCnjCheckDigit(parts: Omit<CnjParts, "checkDigit">): string {
  const base = `${parts.sequence}${String(parts.year).padStart(4, "0")}${parts.segment}${parts.tribunal}${parts.origin}00`;
  return String(98 - mod97(base)).padStart(2, "0");
}

export function isValidCnj(value: string | null | undefined): boolean {
  const parts = parseCnj(value);
  if (!parts) return false;
  return computeCnjCheckDigit(parts) === parts.checkDigit;
}

/**
 * Court acronym derivable from the number for the labor segment (J = 5):
 * TR 00 -> "TST", TR 10 -> "TRT10". Other segments return null (no guessing).
 */
export function laborCourtFromCnj(value: string | null | undefined): string | null {
  const parts = parseCnj(value);
  if (!parts || parts.segment !== "5") return null;
  return parts.tribunal === "00" ? "TST" : `TRT${Number(parts.tribunal)}`;
}
