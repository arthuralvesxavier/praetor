/**
 * Process risk derived from its claims (pedidos). Pure and client-safe (no I/O).
 *
 * Rules (product owner):
 * - risk is assessed PER CLAIM; only CONFIRMED claims count (claims suggested by
 *   the preliminary analysis count only after a person confirms them);
 * - classification of the process = worst classification among the claims with
 *   an assessment in force (remote < possible < probable);
 * - provision = Σ (claim base × claim %) over the assessed claims WITH a base;
 *   assessed claims without a base are "não quantificado" and are listed, never
 *   summed as zero;
 * - the equivalent process percentage is the weighted rate
 *   Σ(base × %) / Σ base (null when no assessed claim is quantified);
 * - the percentage RECORDED on a derived process assessment is that weighted
 *   rate only when every counted assessed claim is quantified. Otherwise it is
 *   the organization percentage of the derived classification, and a mix of
 *   quantified and unquantified claims is flagged for review
 *   (`derivedProcessRate`): the weighted rate would treat the unquantified
 *   claims as zero. Which percentage the official provision should use is a
 *   product owner decision still open (see docs/dev/MODULE_CONTRACTS.md, claims).
 */
import { formatBp } from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS, type ClaimStatus, type LossProbability } from "@/domain/enums";
import { formatMoneyCents } from "@/lib/format";

export const CLASSIFICATION_RANK: Record<LossProbability, number> = { remote: 0, possible: 1, probable: 2 };

export function worseClassification(a: LossProbability | null, b: LossProbability | null): LossProbability | null {
  if (a === null) return b;
  if (b === null) return a;
  return CLASSIFICATION_RANK[b] > CLASSIFICATION_RANK[a] ? b : a;
}

export type DerivationAssessment = {
  id: string;
  classification: LossProbability;
  percentageBp: number;
  /** Null = not quantified. */
  baseAmountCents: number | null;
  /** `YYYY-MM-DD` the claim assessment is in force from (dates the derived process assessment). */
  effectiveFrom?: string;
};

export type DerivationClaim = {
  id: string;
  description: string;
  status: ClaimStatus;
  /** Assessment in force today (null = not assessed). */
  assessment: DerivationAssessment | null;
};

export type DerivedClaimRef = { id: string; description: string };

export type ClaimsRiskDerivation = {
  /** Worst classification among counted assessed claims; null when none is assessed. */
  classification: LossProbability | null;
  /** Claims that carry the worst classification. */
  worstClaims: DerivedClaimRef[];
  /** Σ(base × %) of the quantified assessed claims; null when none is quantified. */
  provisionCents: number | null;
  /** Σ base of the quantified assessed claims (0 when none). */
  quantifiedBaseCents: number;
  /** Weighted percentage (bp) = provision / Σ base; null when Σ base is 0 or nothing is quantified. */
  percentageBp: number | null;
  /** Assessed and quantified (counted in the sum). */
  quantified: (DerivedClaimRef & { baseAmountCents: number; percentageBp: number; provisionCents: number })[];
  /** Assessed but without a base: "não quantificado" (never zero). */
  unquantified: DerivedClaimRef[];
  /** Confirmed claims without an assessment in force. */
  unassessed: DerivedClaimRef[];
  /** Claims suggested by the preliminary analysis still waiting for a person (not counted). */
  pendingConfirmation: DerivedClaimRef[];
  /** Stable id of the counted assessments in force (detects a change after an override). */
  fingerprint: string;
};

function applyBp(cents: number, bp: number): number {
  return Math.round((cents * bp) / 10_000);
}

/**
 * Effective date (`YYYY-MM-DD`) of a process assessment derived from the claims:
 * the latest `effectiveFrom` among the COUNTED claim assessments in force (the
 * derived result only holds once all of them are in force), so a claim
 * assessment backdated into a closing window also dates the derived process
 * classification there (monthly close gate). Never earlier than the official
 * process assessment in force (`inForceEffectiveFrom`): the derived record must
 * become the one in force, which is the greatest effective date (ties go to the
 * latest recorded). Never after `today`; `today` when no counted assessment is dated.
 */
export function derivedEffectiveFrom(
  claims: readonly DerivationClaim[],
  inForceEffectiveFrom: string | null,
  today: string,
): string {
  let latest: string | null = null;
  for (const c of claims) {
    const from = c.status === "confirmed" ? c.assessment?.effectiveFrom : undefined;
    if (from && (latest === null || from > latest)) latest = from;
  }
  if (latest === null) return today;
  if (inForceEffectiveFrom !== null && inForceEffectiveFrom > latest) latest = inForceEffectiveFrom;
  return latest > today ? today : latest;
}

/** Identity of the counted claim assessments in force ("" when none). Order-independent. */
export function claimsFingerprint(claims: readonly DerivationClaim[]): string {
  return claims
    .filter((c) => c.status === "confirmed" && c.assessment)
    .map((c) => `${c.id}:${c.assessment!.id}`)
    .sort()
    .join(",");
}

export function deriveProcessRisk(claims: readonly DerivationClaim[]): ClaimsRiskDerivation {
  let classification: LossProbability | null = null;
  const quantified: ClaimsRiskDerivation["quantified"] = [];
  const unquantified: DerivedClaimRef[] = [];
  const unassessed: DerivedClaimRef[] = [];
  const pendingConfirmation: DerivedClaimRef[] = [];
  let provision = 0;
  let base = 0;

  for (const c of claims) {
    const ref = { id: c.id, description: c.description };
    if (c.status === "pending_confirmation") {
      pendingConfirmation.push(ref);
      continue;
    }
    if (c.status !== "confirmed") continue;
    if (!c.assessment) {
      unassessed.push(ref);
      continue;
    }
    const a = c.assessment;
    classification = worseClassification(classification, a.classification);
    if (a.baseAmountCents === null) {
      unquantified.push(ref);
      continue;
    }
    const p = applyBp(a.baseAmountCents, a.percentageBp);
    provision += p;
    base += a.baseAmountCents;
    quantified.push({ ...ref, baseAmountCents: a.baseAmountCents, percentageBp: a.percentageBp, provisionCents: p });
  }

  const worstClaims =
    classification === null
      ? []
      : claims
          .filter((c) => c.status === "confirmed" && c.assessment?.classification === classification)
          .map((c) => ({ id: c.id, description: c.description }));

  return {
    classification,
    worstClaims,
    provisionCents: quantified.length ? provision : null,
    quantifiedBaseCents: base,
    percentageBp: base > 0 ? Math.round((provision * 10_000) / base) : null,
    quantified,
    unquantified,
    unassessed,
    pendingConfirmation,
    fingerprint: claimsFingerprint(claims),
  };
}

/**
 * Where the percentage recorded on a derived process assessment comes from.
 * - `weighted`: every counted assessed claim is quantified, so the weighted
 *   rate Σ(base × %) / Σ base is used;
 * - `organization_no_base`: no counted assessed claim has a base greater than
 *   zero, so the organization percentage of the derived classification is used;
 * - `organization_unquantified`: some counted assessed claims are quantified and
 *   others are not. The weighted rate would count the unquantified ones as zero
 *   (null is not zero), so the organization percentage of the derived
 *   classification is used and the result is FLAGGED FOR REVIEW.
 */
export type DerivedRateBasis = "weighted" | "organization_no_base" | "organization_unquantified";

export type DerivedRate = {
  /** Percentage (bp) recorded on the derived process assessment. */
  bp: number;
  basis: DerivedRateBasis;
  /** Weighted rate of the quantified claims, for information (null when Σ base is 0). */
  weightedBp: number | null;
};

/** Percentage recorded on a derived process assessment and its basis (null without a derived classification). */
export function derivedProcessRate(d: ClaimsRiskDerivation, orgPercentBp: (c: LossProbability) => number): DerivedRate | null {
  if (d.classification === null) return null;
  if (d.unquantified.length === 0 && d.percentageBp !== null) {
    return { bp: d.percentageBp, basis: "weighted", weightedBp: d.percentageBp };
  }
  return {
    bp: orgPercentBp(d.classification),
    basis: d.unquantified.length > 0 && d.quantified.length > 0 ? "organization_unquantified" : "organization_no_base",
    weightedBp: d.percentageBp,
  };
}

/** Percentage (bp) recorded on a derived process assessment (see `derivedProcessRate`). */
export function derivedProcessBp(d: ClaimsRiskDerivation, orgPercentBp: (c: LossProbability) => number): number | null {
  return derivedProcessRate(d, orgPercentBp)?.bp ?? null;
}

/** True when the derived result must be reviewed by a person before it is relied on. */
export function derivedRateNeedsReview(rate: DerivedRate | null): boolean {
  return rate?.basis === "organization_unquantified";
}

/** True when the process assessment in force differs from the derived result. */
export function differsFromInForce(
  derived: { classification: LossProbability | null; percentageBp: number | null },
  inForce: { classification: LossProbability; percentageBp: number } | null,
): boolean {
  if (derived.classification === null) return false;
  if (!inForce) return true;
  return inForce.classification !== derived.classification || inForce.percentageBp !== derived.percentageBp;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

function names(refs: readonly DerivedClaimRef[], max = 5): string {
  const shown = refs.slice(0, max).map((r) => `"${clip(r.description, 80)}"`);
  const rest = refs.length - shown.length;
  return rest > 0 ? `${shown.join("; ")} e mais ${rest}` : shown.join("; ");
}

/**
 * pt-BR opinion of a derived process assessment ("Derivado dos pedidos: ...").
 * No em dash; amounts at their base dates (monetary update not computed).
 */
export function derivationOpinion(d: ClaimsRiskDerivation, rate: DerivedRate | null, actorName: string | null): string {
  if (d.classification === null || rate === null) return "Derivado dos pedidos: nenhum pedido confirmado com avaliação vigente.";
  const parts: string[] = [];
  parts.push(
    `Derivado dos pedidos: classificação ${LOSS_PROBABILITY_LABELS[d.classification]} ` +
      `(pior classificação entre os pedidos avaliados: ${names(d.worstClaims)}).`,
  );
  if (d.provisionCents !== null) {
    parts.push(
      `Provisão pelos pedidos: ${formatMoneyCents(d.provisionCents)}, soma de base × percentual de ` +
        `${d.quantified.length} pedido(s) quantificado(s) (base total ${formatMoneyCents(d.quantifiedBaseCents)}).`,
    );
  } else {
    parts.push("Nenhum pedido avaliado tem valor: provisão pelos pedidos não calculada.");
  }
  if (rate.basis === "weighted") {
    parts.push(`Percentual registrado: ${formatBp(rate.bp)}, ponderado pelos pedidos quantificados.`);
  } else if (rate.basis === "organization_no_base") {
    parts.push(`Percentual registrado: ${formatBp(rate.bp)}, o da organização para a classificação (nenhum pedido avaliado com base maior que zero).`);
  } else {
    parts.push(
      `Percentual registrado: ${formatBp(rate.bp)}, o da organização para a classificação, e não o ponderado dos pedidos ` +
        `quantificados (${formatBp(rate.weightedBp, "não calculado")}), porque há pedido avaliado sem valor e pedido sem valor não vale zero. ` +
        `Classificação marcada para revisão: quantifique os pedidos ou defina a classificação manualmente com justificativa.`,
    );
  }
  if (d.unquantified.length) {
    parts.push(`Não quantificados (fora da soma, não valem zero): ${d.unquantified.length} (${names(d.unquantified)}).`);
  }
  if (d.unassessed.length) parts.push(`Pedidos confirmados sem avaliação: ${d.unassessed.length}.`);
  if (d.pendingConfirmation.length) {
    parts.push(`Pedidos sugeridos aguardando confirmação (não considerados): ${d.pendingConfirmation.length}.`);
  }
  parts.push("Valores na data-base de cada avaliação (atualização monetária não calculada).");
  if (actorName) parts.push(`Registrado a partir da ação de ${actorName}.`);
  return parts.join(" ").slice(0, 4000);
}
