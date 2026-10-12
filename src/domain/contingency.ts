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
export function formatBp(bp: number | null | undefined, fallback = "Não informado"): string {
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

/**
 * How many processes of a group carry an amount on each basis. Screens use it to
 * write "Não apurada" / "Sem estimativa" instead of the R$ 0 that a zero-filled sum
 * would suggest (RN-03); a zero is shown only when it was actually calculated.
 */
export type AmountBasisCounts = {
  /** Calculated on the valor apurado (official). */
  official: number;
  /** Calculated on the valor da causa weighted by the risk (estimate, RN-07). */
  estimate: number;
  /** Not calculated: no basis (and, for a provision, no risk classification). */
  none: number;
};

export function emptyBasisCounts(): AmountBasisCounts {
  return { official: 0, estimate: 0, none: 0 };
}

export function addBasisCounts(a: AmountBasisCounts, b: AmountBasisCounts): AmountBasisCounts {
  return { official: a.official + b.official, estimate: a.estimate + b.estimate, none: a.none + b.none };
}

/**
 * Exposure basis of a bucket, exact from its counters: a valor apurado always yields an
 * official exposure, so the processes without basis are a subset of the não apurados.
 */
export function exposureBasisCounts(b: Pick<MoneyBucket, "count" | "liquidatedUnknown" | "exposureUnknown">): AmountBasisCounts {
  const total = Math.max(0, b.count);
  const official = Math.min(total, Math.max(0, total - b.liquidatedUnknown));
  const none = Math.min(total - official, Math.max(0, b.exposureUnknown));
  return { official, estimate: total - official - none, none };
}

/**
 * Provision basis of a bucket whose processes share one classification state. A
 * classified process has a provision exactly when it has an exposure (valor apurado,
 * or valor da causa as an estimate); an unclassified one never has a provision (RN-05).
 * Groups that mix both states need `addProvisionBasis` over their processes.
 */
export function provisionBasisForClass(
  b: Pick<MoneyBucket, "count" | "liquidatedUnknown" | "exposureUnknown">,
  classified: boolean,
): AmountBasisCounts {
  return classified ? exposureBasisCounts(b) : { official: 0, estimate: 0, none: Math.max(0, b.count) };
}

/** Adds one process's provision basis (mutates and returns `counts`). */
export function addProvisionBasis(counts: AmountBasisCounts, item: ExposureInput): AmountBasisCounts {
  const p = provisionFor(item);
  if (p.provisionCents === null) counts.none += 1;
  else if (p.isEstimate) counts.estimate += 1;
  else counts.official += 1;
  return counts;
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
