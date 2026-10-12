/**
 * Builders for court-sync tests (fictitious numbers and records; no network).
 */
import { computeCnjCheckDigit } from "@/domain/cnj";
import type { CourtMovement, CourtMovementComplement, CourtRecord } from "@/server/integrations/courts/types";

/** Valid CNJ number (check digit computed) for any segment/tribunal; origin 9999 by default (inexistent unit: never a real case). */
export function cnjNumber(opts: { seq: number; year?: number; segment?: string; tribunal?: string; origin?: string }): string {
  const sequence = String(opts.seq).padStart(7, "0");
  const year = opts.year ?? 2025;
  const segment = opts.segment ?? "5";
  const tribunal = (opts.tribunal ?? "10").padStart(2, "0");
  const origin = (opts.origin ?? "9999").padStart(4, "0");
  const dd = computeCnjCheckDigit({ sequence, year, segment, tribunal, origin });
  return `${sequence}-${dd}.${year}.${segment}.${tribunal}.${origin}`;
}

export const digitsOf = (n: string) => n.replace(/\D/g, "");

export function mv(code: number | null, name: string, date: string, complements: Partial<CourtMovementComplement>[] = [], time = "12:00:00"): CourtMovement {
  return {
    code,
    name,
    dateTime: `${date}T${time}.000Z`,
    complements: complements.map((c) => ({ code: c.code ?? null, description: c.description ?? "", value: c.value ?? null, name: c.name ?? "" })),
    courtDivision: null,
  };
}

export const hearing = (situacao: string): Partial<CourtMovementComplement> => ({
  code: 15,
  description: "situacao_da_audiencia",
  name: situacao,
});

export const emGrauDeRecurso: Partial<CourtMovementComplement> = { code: 18, description: "motivo_da_remessa", name: "em grau de recurso" };

export function rec(number: string, opts: Partial<CourtRecord> & { movements?: CourtMovement[] } = {}): CourtRecord {
  const grau = opts.grau ?? "G1";
  return {
    source: "datajud",
    alias: opts.alias ?? "trt10",
    tribunal: opts.tribunal ?? "TRT10",
    grau,
    number: digitsOf(number),
    filedAt: opts.filedAt === undefined ? "2025-02-28" : opts.filedAt,
    secrecyLevel: 0,
    courtDivision:
      opts.courtDivision === undefined ? { code: 1, name: "21ª Vara do Trabalho de Brasília - DF", ibgeCode: 5300108 } : opts.courtDivision,
    processClass: opts.processClass === undefined ? { code: 1125, name: "Ação Trabalhista - Rito Sumaríssimo" } : opts.processClass,
    system: "PJe",
    format: "Eletrônico",
    remoteUpdatedAt: opts.remoteUpdatedAt ?? "2026-09-21T19:22:34.950Z",
    subjects: opts.subjects ?? [{ code: 13719, name: "FGTS" }],
    movements: [...(opts.movements ?? [])].sort((a, b) => (a.dateTime < b.dateTime ? -1 : a.dateTime > b.dateTime ? 1 : 0)),
  };
}
