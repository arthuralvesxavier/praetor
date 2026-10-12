/**
 * Pure aggregation helpers of the executive portfolio panel (client-safe, no I/O).
 *
 * Money rules (RN-02/RN-03/RN-04/RN-05/RN-07):
 * - valor da causa and valor liquidado are aggregated in SEPARATE fields and never added;
 * - null values are counted as "não apurado"/"não informado", never as zero;
 * - exposure and provision come from `addToBucket` (@/domain/contingency), keeping the
 *   official figures apart from the estimates;
 * - closed monthly snapshots are read as stored (RN-10): their items are summed, never recomputed.
 */
import { addToBucket, emptyBucket, type MoneyBucket } from "@/domain/contingency";
import type { LossProbability, ProcessInstance, ProcessPhase } from "@/domain/enums";

/** The fields of a portfolio exposure row (see `PortfolioExposureRow` in the contingency module) used here. */
export type PortfolioRowLike = {
  processId: string;
  number: string;
  companyId: string | null;
  unitId: string | null;
  court: string;
  instance: ProcessInstance | null;
  phase: ProcessPhase;
  city: string | null;
  classification: LossProbability | null;
  percentageBp: number | null;
  claimCents: number | null;
  liquidatedCents: number | null;
  guaranteesCents: number;
};

/** Stored position of a process in a closed monthly snapshot (`portfolio_snapshot_items`). */
export type SnapshotItemLike = {
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  guaranteesCents: number;
  exposureCents: number | null;
  exposureIsEstimate: boolean;
  provisionCents: number | null;
  provisionIsEstimate: boolean;
};

export function addRow(bucket: MoneyBucket, row: PortfolioRowLike): MoneyBucket {
  return addToBucket(bucket, {
    claimCents: row.claimCents,
    liquidatedCents: row.liquidatedCents,
    linkedGuaranteesCents: row.guaranteesCents,
    riskPercentageBp: row.percentageBp,
  });
}

export function bucketOf(rows: readonly PortfolioRowLike[]): MoneyBucket {
  const b = emptyBucket();
  for (const r of rows) addRow(b, r);
  return b;
}

/** Groups rows by a key (null = "não informado"), one bucket per key. */
export function groupRows<K extends string>(
  rows: readonly PortfolioRowLike[],
  keyOf: (r: PortfolioRowLike) => K | null,
): Map<K | null, MoneyBucket> {
  const map = new Map<K | null, MoneyBucket>();
  for (const r of rows) {
    const k = keyOf(r);
    let b = map.get(k);
    if (!b) map.set(k, (b = emptyBucket()));
    addRow(b, r);
  }
  return map;
}

/** Official + estimated exposure of a bucket, used ONLY for ranking (never displayed as one figure). */
export function rankingWeight(b: MoneyBucket): number {
  return b.exposureCents + b.exposureEstimateCents;
}

export type RankedGroup<K> = { key: K | null; bucket: MoneyBucket };

/**
 * Sorts groups by exposure (official + estimate), then by process count; keeps
 * the first `limit` and folds the rest into `others` (null when nothing was folded).
 */
export function rankGroups<K>(
  groups: Map<K | null, MoneyBucket>,
  limit = Number.POSITIVE_INFINITY,
): { top: RankedGroup<K>[]; others: { groups: number; bucket: MoneyBucket } | null } {
  const sorted = [...groups.entries()]
    .map(([key, bucket]) => ({ key, bucket }))
    .sort((a, b) => rankingWeight(b.bucket) - rankingWeight(a.bucket) || b.bucket.count - a.bucket.count);
  if (sorted.length <= limit) return { top: sorted, others: null };
  const rest = sorted.slice(limit);
  return { top: sorted.slice(0, limit), others: { groups: rest.length, bucket: mergeBuckets(rest.map((g) => g.bucket)) } };
}

export function mergeBuckets(buckets: readonly MoneyBucket[]): MoneyBucket {
  const out = emptyBucket();
  for (const b of buckets) {
    out.count += b.count;
    out.claimCents += b.claimCents;
    out.claimUnknown += b.claimUnknown;
    out.liquidatedCents += b.liquidatedCents;
    out.liquidatedUnknown += b.liquidatedUnknown;
    out.guaranteesCents += b.guaranteesCents;
    out.exposureCents += b.exposureCents;
    out.exposureEstimateCents += b.exposureEstimateCents;
    out.exposureUnknown += b.exposureUnknown;
    out.provisionCents += b.provisionCents;
    out.provisionEstimateCents += b.provisionEstimateCents;
  }
  return out;
}

/** Sums the STORED figures of snapshot items (RN-10: a closed period is never recomputed). */
export function bucketFromSnapshotItems(items: readonly SnapshotItemLike[]): MoneyBucket {
  const b = emptyBucket();
  for (const it of items) {
    b.count += 1;
    if (it.claimAmountCents === null) b.claimUnknown += 1;
    else b.claimCents += it.claimAmountCents;
    if (it.liquidatedAmountCents === null) b.liquidatedUnknown += 1;
    else b.liquidatedCents += it.liquidatedAmountCents;
    b.guaranteesCents += Math.max(0, it.guaranteesCents);
    if (it.exposureCents === null) b.exposureUnknown += 1;
    else if (it.exposureIsEstimate) b.exposureEstimateCents += it.exposureCents;
    else b.exposureCents += it.exposureCents;
    if (it.provisionCents !== null) {
      if (it.provisionIsEstimate) b.provisionEstimateCents += it.provisionCents;
      else b.provisionCents += it.provisionCents;
    }
  }
  return b;
}

/** Unique CNJ numbers (RN-09: instances of the same process never add up). */
export function uniqueProcessCount(rows: readonly { number: string }[]): number {
  return new Set(rows.map((r) => r.number)).size;
}

export type Delta = { current: number; previous: number; diff: number; ratio: number | null };

export function delta(current: number, previous: number): Delta {
  return { current, previous, diff: current - previous, ratio: previous === 0 ? null : (current - previous) / previous };
}
