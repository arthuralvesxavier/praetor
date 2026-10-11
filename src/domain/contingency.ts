/**
 * Pure contingency rules (client-safe, no I/O). Business rules from the
 * requirements document:
 *
 * RN-02  Valor da causa and valor liquidado are different quantities and are
 *        NEVER added together.
 * RN-03  Null is not zero: a null liquidated value means "not assessed".
 * RN-04  Net exposure = current liquidated value − linked guarantees, never
 *        negative. Without a liquidated value, exposure = claim value weighted
 *        by the risk percentage (− linked guarantees), flagged as an ESTIMATE.
 * RN-05  Provision = applicable base × percentage of the risk classification
 *        in force on the reference date.
 * RN-07  Estimates are always flagged.
 *
 * Percentages are integer basis points (5000 = 50%) to avoid floating point.
 */
import type { LossProbability } from "./enums";

export type RiskPercentages = { remote: number; possible: number; probable: number };

/** Risk parameters used by a monthly snapshot (RNF-14: old reports stay reproducible). */
export type SnapshotParams = {
  /** Whole percentages (0–100) per classification. */
  riskPercentages: RiskPercentages;
  rulesVersion: number;
  confidenceThreshold: number;
};

/** Aggregated money for a group of processes. Unknown (null) values are counted, never treated as zero. */
export type MoneyBucket = {
  count: number;
  claimCents: number;
  /** Processes without valor da causa. */
  claimUnknown: number;
  liquidatedCents: number;
  /** Processes without valor liquidado (not assessed). */
  liquidatedUnknown: number;
  guaranteesCents: number;
  /** Exposure based on official liquidated values. */
  exposureCents: number;
  /** Exposure estimated from claim × risk (RN-04 fallback). */
  exposureEstimateCents: number;
  /** Processes whose exposure cannot be computed (no liquidated value and no risk classification). */
  exposureUnknown: number;
  provisionCents: number;
  provisionEstimateCents: number;
};

export type SnapshotMetrics = {
  totals: MoneyBucket & { confidentialCount: number };
  byCourt: Record<string, MoneyBucket>;
  byInstance: Record<string, MoneyBucket>;
  byPhase: Record<string, MoneyBucket>;
  byCity: Record<string, MoneyBucket>;
  byClassification: Record<string, MoneyBucket>;
  byCompany: Record<string, MoneyBucket>;
  byUnit: Record<string, MoneyBucket>;
};

export const BP_PER_PERCENT = 100;

export function percentToBp(percent: number): number {
  return Math.round(percent * BP_PER_PERCENT);
}

export function bpToPercent(bp: number): number {
  return bp / BP_PER_PERCENT;
}

/** "50%" / "12,5%". */
export function formatBp(bp: number | null | undefined, fallback = "—"): string {
  if (bp === null || bp === undefined) return fallback;
  return `${bpToPercent(bp).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

export function percentageForClassification(params: RiskPercentages, classification: LossProbability): number {
  return percentToBp(params[classification]);
}

function applyBp(cents: number, bp: number): number {
  return Math.round((cents * bp) / 10_000);
}

export type ExposureInput = {
  /** Current official liquidated value; null = not assessed. */
  liquidatedCents: number | null;
  /** Sum of guarantees with status `linked`. */
  linkedGuaranteesCents: number;
  claimCents: number | null;
  /** Risk percentage in force (basis points); null = not classified. */
  riskPercentageBp: number | null;
};

export type ExposureResult = {
  exposureCents: number | null;
  isEstimate: boolean;
  basis: "liquidated" | "claim_weighted" | "none";
};

/** RN-04. */
export function netExposure(input: ExposureInput): ExposureResult {
  const guarantees = Math.max(0, input.linkedGuaranteesCents);
  if (input.liquidatedCents !== null) {
    return { exposureCents: Math.max(0, input.liquidatedCents - guarantees), isEstimate: false, basis: "liquidated" };
  }
  if (input.claimCents !== null && input.riskPercentageBp !== null) {
    const weighted = applyBp(input.claimCents, input.riskPercentageBp);
    return { exposureCents: Math.max(0, weighted - guarantees), isEstimate: true, basis: "claim_weighted" };
  }
  return { exposureCents: null, isEstimate: false, basis: "none" };
}

export type ProvisionResult = {
  provisionCents: number | null;
  /** True when the base is the claim value (no liquidated value): RN-07. */
  isEstimate: boolean;
  base: "net_liquidated" | "claim" | "none";
  baseCents: number | null;
};

/** RN-05: base (net liquidated, or claim value as an estimate) × percentage of the classification in force. */
export function provisionFor(input: ExposureInput): ProvisionResult {
  if (input.riskPercentageBp === null) return { provisionCents: null, isEstimate: false, base: "none", baseCents: null };
  const guarantees = Math.max(0, input.linkedGuaranteesCents);
  if (input.liquidatedCents !== null) {
    const base = Math.max(0, input.liquidatedCents - guarantees);
    return { provisionCents: applyBp(base, input.riskPercentageBp), isEstimate: false, base: "net_liquidated", baseCents: base };
  }
  if (input.claimCents !== null) {
    return {
      provisionCents: applyBp(input.claimCents, input.riskPercentageBp),
      isEstimate: true,
      base: "claim",
      baseCents: input.claimCents,
    };
  }
  return { provisionCents: null, isEstimate: false, base: "none", baseCents: null };
}

export function emptyBucket(): MoneyBucket {
  return {
    count: 0,
    claimCents: 0,
    claimUnknown: 0,
    liquidatedCents: 0,
    liquidatedUnknown: 0,
    guaranteesCents: 0,
    exposureCents: 0,
    exposureEstimateCents: 0,
    exposureUnknown: 0,
    provisionCents: 0,
    provisionEstimateCents: 0,
  };
}

export type BucketItem = ExposureInput;

/** Adds one process to a bucket (mutates and returns it). Nulls are counted as unknown, never as zero. */
export function addToBucket(bucket: MoneyBucket, item: BucketItem): MoneyBucket {
  bucket.count += 1;
  if (item.claimCents === null) bucket.claimUnknown += 1;
  else bucket.claimCents += item.claimCents;
  if (item.liquidatedCents === null) bucket.liquidatedUnknown += 1;
  else bucket.liquidatedCents += item.liquidatedCents;
  bucket.guaranteesCents += Math.max(0, item.linkedGuaranteesCents);
  const exposure = netExposure(item);
  if (exposure.exposureCents === null) bucket.exposureUnknown += 1;
  else if (exposure.isEstimate) bucket.exposureEstimateCents += exposure.exposureCents;
  else bucket.exposureCents += exposure.exposureCents;
  const provision = provisionFor(item);
  if (provision.provisionCents !== null) {
    if (provision.isEstimate) bucket.provisionEstimateCents += provision.provisionCents;
    else bucket.provisionCents += provision.provisionCents;
  }
  return bucket;
}

/** Last day of a `YYYY-MM` period as `YYYY-MM-DD`. */
export function periodReferenceDate(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}

/** `YYYY-MM` of the month before. */
export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
