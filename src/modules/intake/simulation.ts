/**
 * Pure helpers for the DEMO "Simular chegada de processo": deterministic
 * fictitious data (names, numbers, values). Nothing here represents a real
 * case, person or court movement. Client-safe, no I/O.
 */
import { computeCnjCheckDigit, isValidCnj } from "@/domain/cnj";

/** Obviously fictitious plaintiff names (never real people). */
export const FICTITIOUS_PLAINTIFFS = [
  "Fulano de Tal Exemplo",
  "Beltrana Fictícia da Silva",
  "Sicrano Demonstração Souza",
  "Maria Exemplo dos Santos",
  "João Simulado Pereira",
  "Ana Teste de Oliveira",
  "Carlos Fictício Almeida",
  "Juliana Modelo Ribeiro",
  "Pedro Hipotético Costa",
  "Luíza Ilustrativa Martins",
] as const;

export const FALLBACK_COURT = { court: "TRT10", city: "Palmas", state: "TO", processClass: "ATOrd", origin: "0001" } as const;
export const FALLBACK_DEFENDANT = "EMPRESA MODELO TESTE LTDA (dados fictícios)";

export const SIMULATION_LABEL = "Chegada simulada com dados fictícios";
export const SIMULATION_DESCRIPTION =
  "Chegada simulada com dados fictícios. Processo gerado pela demonstração “Simular chegada de processo” para " +
  "mostrar o fluxo de entrada, distribuição, análise preliminar e e-mail (ambos simulados). Não corresponde a " +
  "processo real e nenhum tribunal foi consultado.";

/** mulberry32: small deterministic PRNG (same seed → same sequence). */
export function seededRandom(seed: number): () => number {
  let a = Math.trunc(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tribunal code (TR) of a labor court acronym: "TRT10" / "TRT-2" → "10" / "02"; anything else → null. */
export function tribunalCodeFromCourt(court: string | null | undefined): string | null {
  const m = /^\s*TRT\s*[-–]?\s*(\d{1,2})\b/i.exec(court ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 24) return null;
  return String(n).padStart(2, "0");
}

/**
 * New CNJ number for the labor segment (J = 5) with a correct check digit
 * (computed, never guessed). `salt` changes the sequence when the first
 * candidate already exists.
 */
export function buildSimulatedCnj(opts: { seed: number; salt?: number; year: number; tribunal: string; origin: string }): string {
  const rand = seededRandom(opts.seed * 7919 + (opts.salt ?? 0) * 104729 + 17);
  const sequence = String(1 + Math.floor(rand() * 999_998)).padStart(7, "0");
  const tribunal = opts.tribunal.padStart(2, "0").slice(-2);
  const origin = opts.origin.padStart(4, "0").slice(-4);
  const parts = { sequence, year: opts.year, segment: "5", tribunal, origin };
  const dd = computeCnjCheckDigit(parts);
  const number = `${sequence}-${dd}.${opts.year}.5.${tribunal}.${origin}`;
  if (!isValidCnj(number)) throw new Error("simulated_cnj_invalid");
  return number;
}

/** Claim value in a realistic range for labor claims: R$ 18.000,00 – R$ 320.000,00 (integer cents). */
export function simulatedClaimCents(seed: number): number {
  const rand = seededRandom(seed * 31 + 7);
  const reais = 18_000 + Math.floor(rand() * 302_000);
  const cents = Math.floor(rand() * 100);
  return reais * 100 + cents;
}

export function simulatedPlaintiff(seed: number): string {
  return FICTITIOUS_PLAINTIFFS[Math.abs(Math.trunc(seed)) % FICTITIOUS_PLAINTIFFS.length];
}

/** "EMPRESA MODELO TESTE LTDA (e outros)" → "EMPRESA MODELO TESTE LTDA" (for titles). */
export function shortPartyName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "").trim() || name;
}
