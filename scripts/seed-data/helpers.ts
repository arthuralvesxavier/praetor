import { readFileSync } from "node:fs";
import path from "node:path";
import type { Role } from "@/domain/enums";
import { addDaysISO, todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";

/**
 * Small helpers for the demo seed: dates relative to "today" (São Paulo
 * calendar, same as the app), money in cents, document templates and the
 * AuthContext of a seeded user.
 */

const TODAY = todayISO();

/** "YYYY-MM-DD" `days` from today (negative = past). */
export function rel(days: number): string {
  return addDaysISO(TODAY, days);
}

/** Today in "YYYY-MM-DD". */
export function today(): string {
  return TODAY;
}

/** A timestamp `days` from now (negative = past), at the given hour UTC. */
export function relTimestamp(days: number, hourUtc = 13): Date {
  return new Date(`${rel(days)}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`);
}

/** Reais → integer cents (null stays null). */
export function brl(reais: number | null): number | null {
  return reais === null ? null : Math.round(reais * 100);
}

const MONTHS_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

function isoParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

/** "dd/mm/aaaa". */
export function brDate(iso: string): string {
  const [y, m, d] = isoParts(iso);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** "5 de novembro de 2026". */
export function longDate(iso: string): string {
  const [y, m, d] = isoParts(iso);
  return `${d} de ${MONTHS_PT[m - 1]} de ${y}`;
}

const DOCUMENTS_DIR = path.resolve(process.cwd(), "scripts", "seed-data", "documents");

/**
 * Reads a fictional document template and replaces the date placeholders:
 * `{{d:+N}}` → dd/mm/aaaa and `{{e:+N}}` → "d de mês de aaaa", N days from today.
 */
export function renderDocument(fileName: string): string {
  const raw = readFileSync(path.join(DOCUMENTS_DIR, fileName), "utf8");
  return raw.replace(/\{\{([de]):([+-]\d+)\}\}/g, (_m, kind: string, offset: string) => {
    const iso = rel(Number(offset));
    return kind === "d" ? brDate(iso) : longDate(iso);
  });
}

/** Template → upload file (UTF-8 bytes). */
export function documentFile(fileName: string): { name: string; bytes: Uint8Array } {
  return { name: fileName, bytes: new TextEncoder().encode(renderDocument(fileName)) };
}

export type SeededUser = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: Role;
  unitId: string | null;
  /** Law firm of an `external_counsel` user (their row scope). */
  lawFirmId?: string | null;
};

/** The AuthContext a real session of this user would have (services enforce their rules on it). */
export function userContext(user: SeededUser, isDemoOrganization = true): AuthContext {
  return {
    kind: "user",
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    unitId: user.unitId,
    lawFirmId: user.lawFirmId ?? null,
    name: user.name,
    email: user.email,
    isDemoOrganization,
    ipAddress: null,
  };
}
