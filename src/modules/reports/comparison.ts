/**
 * Amounts compared with a previous competência (pure, client-safe). Null is not zero
 * (RN-03): an amount exists only when at least one process of the group was calculated on
 * that basis, and a variation exists only when both sides exist. A group without processes,
 * or where nothing was apurado, is never compared as if it were R$ 0.
 */
import { exposureBasisCounts, type AmountBasisCounts, type MoneyBucket } from "@/domain/contingency";
import type { PreviousPosition, ProvisionAmounts } from "./types";

/** Amount apurado (official) and estimated of a group; null where nothing was calculated. */
export type BasisAmounts = { official: number | null; estimate: number | null };

/** `cents` when some process carries it, null otherwise; without counts (legacy data) the sum is kept. */
function amountOn(cents: number, count: number | undefined): number | null {
  return count === undefined || count > 0 ? cents : null;
}

/** Difference between two amounts, or null when one side was not calculated. */
export function variationOf(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : current - previous;
}

/** Exposure of a current group (exact basis from the bucket counters). */
export function exposureAmounts(b: MoneyBucket): BasisAmounts {
  const basis = exposureBasisCounts(b);
  return {
    official: basis.official > 0 ? b.exposureCents : null,
    estimate: basis.estimate > 0 ? b.exposureEstimateCents : null,
  };
}

/** Exposure of a group in the previous competência ("sem processos" there reads null, not R$ 0). */
export function previousExposureAmounts(p: PreviousPosition): BasisAmounts {
  if (p.processCount === 0) return { official: null, estimate: null };
  return {
    official: amountOn(p.exposureCents, p.exposureBasis?.official),
    estimate: amountOn(p.exposureEstimateCents, p.exposureBasis?.estimate),
  };
}

/** Provision of a group (current or previous) from its stored amounts and basis counts. */
export function provisionAmountsOn(a: ProvisionAmounts, basis: AmountBasisCounts | undefined, processCount: number): BasisAmounts {
  if (processCount === 0) return { official: null, estimate: null };
  return {
    official: amountOn(a.provisionCents, basis?.official),
    estimate: amountOn(a.provisionEstimateCents, basis?.estimate),
  };
}
