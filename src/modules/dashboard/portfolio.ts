/**
 * Pure aggregation helpers of the executive portfolio panel (client-safe, no I/O).
 *
 * Money rules (RN-02/RN-03/RN-04/RN-05/RN-07):
 * - valor da causa and valor liquidado are aggregated in SEPARATE fields and never added;
 * - null values are counted as "não apurado"/"não informado", never as zero;
 * - exposure and provision come from `addToBucket` (@/domain/contingency), keeping the
 *   official figures apart from the estimates;
 * - closed monthly snapshots are read as stored (RN-10): their items are summed, never recomputed;
 * - official (apurado-based) amounts are shown with their coverage ("valor apurado em X de Y"),
 *   and a set without any valor apurado reads "Sem valor apurado"/"não apurado", never R$ 0;
 * - a null dimension (tribunal, instância, cidade…) is a registration gap, never a chart category.
 */
import {
  addBasisCounts,
  addProvisionBasis,
  addToBucket,
  emptyBasisCounts,
  emptyBucket,
  exposureBasisCounts as domainExposureBasisCounts,
  netExposure,
  type AmountBasisCounts,
  type MoneyBucket,
} from "@/domain/contingency";
import type { GuaranteeKind, LossProbability, ProcessInstance, ProcessPhase } from "@/domain/enums";
import { formatNumber, formatPercent } from "@/lib/format";

/** Groupings of the active portfolio (charts, registration gaps), in display order. Re-exported by `./portfolio-service`. */
export const DIMENSIONS = ["court", "instance", "phase", "city", "company", "unit"] as const;
export type DimensionKey = (typeof DIMENSIONS)[number];

/** The fields of a portfolio exposure row (see `PortfolioExposureRow` in the contingency module) used here. */
export type PortfolioRowLike = {
  processId: string;
  number: string;
  /** Only used by the net exposure detail (P1.8); optional for callers that do not show it. */
  title?: string;
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

/** Groups rows by a key (null = field not informed, see `splitUnknownKey`), one bucket per key. */
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

/** Provision basis of one row (RN-05: no risk classification, no provision; no valor apurado, an estimate). */
function addRowProvisionBasis(counts: AmountBasisCounts, row: PortfolioRowLike): AmountBasisCounts {
  return addProvisionBasis(counts, {
    liquidatedCents: row.liquidatedCents,
    linkedGuaranteesCents: row.guaranteesCents,
    claimCents: row.claimCents,
    riskPercentageBp: row.percentageBp,
  });
}

/**
 * How many processes of a set have a provision on the valor apurado, on the valor da causa
 * (estimate) or none. A group that mixes classified and unclassified processes cannot be read
 * from its bucket: a valor apurado without classification has no provision (RN-03/RN-05).
 */
export function provisionBasisOf(rows: readonly PortfolioRowLike[]): AmountBasisCounts {
  const counts = emptyBasisCounts();
  for (const r of rows) addRowProvisionBasis(counts, r);
  return counts;
}

/** `provisionBasisOf` per group (same keys as `groupRows`). */
export function groupProvisionBasis<K extends string>(
  rows: readonly PortfolioRowLike[],
  keyOf: (r: PortfolioRowLike) => K | null,
): Map<K | null, AmountBasisCounts> {
  const map = new Map<K | null, AmountBasisCounts>();
  for (const r of rows) {
    const k = keyOf(r);
    let c = map.get(k);
    if (!c) map.set(k, (c = emptyBasisCounts()));
    addRowProvisionBasis(c, r);
  }
  return map;
}

/** One informed group of a dimension: its money and the provision basis of its processes. */
export type DimensionGroup<K> = { key: K; bucket: MoneyBucket; provisionBasis: AmountBasisCounts };

/**
 * A dimension of the portfolio: informed groups ranked by exposure (the first `limit`), the rest
 * folded into `others` and the processes without the field in `missing` (registration gap).
 * Each group carries its provision basis, so the table reads "Não calculada" / "Sem valor
 * apurado" instead of a R$ 0 that was never calculated.
 */
export function dimensionGroups<K extends string>(
  rows: readonly PortfolioRowLike[],
  keyOf: (r: PortfolioRowLike) => K | null,
  limit = Number.POSITIVE_INFINITY,
): {
  top: DimensionGroup<K>[];
  others: { groups: number; bucket: MoneyBucket; provisionBasis: AmountBasisCounts } | null;
  missing: MoneyBucket | null;
} {
  const basis = groupProvisionBasis(rows, keyOf);
  const { known, missing } = splitUnknownKey(groupRows(rows, keyOf));
  const ranked = rankGroups(known, limit);
  const basisOf = (k: K) => basis.get(k) ?? emptyBasisCounts();
  const topKeys = new Set(ranked.top.map((g) => g.key));
  return {
    top: ranked.top.map((g) => ({ key: g.key, bucket: g.bucket, provisionBasis: basisOf(g.key) })),
    others: ranked.others
      ? {
          ...ranked.others,
          provisionBasis: [...known.keys()]
            .filter((k) => !topKeys.has(k))
            .reduce((acc, k) => addBasisCounts(acc, basisOf(k)), emptyBasisCounts()),
        }
      : null,
    missing,
  };
}

/**
 * Splits a grouping into informed keys and the null key. Charts show only the
 * informed values; the processes without the field are returned apart as a
 * registration gap ("pendência de cadastro"), never as a "Não informado" category.
 */
export function splitUnknownKey<K>(groups: ReadonlyMap<K | null, MoneyBucket>): {
  known: Map<K, MoneyBucket>;
  missing: MoneyBucket | null;
} {
  const known = new Map<K, MoneyBucket>();
  let missing: MoneyBucket | null = null;
  for (const [key, bucket] of groups) {
    if (key === null) missing = bucket;
    else known.set(key, bucket);
  }
  return { known, missing };
}

/** Official + estimated exposure of a bucket, used ONLY for ranking (never displayed as one figure). */
export function rankingWeight(b: MoneyBucket): number {
  return b.exposureCents + b.exposureEstimateCents;
}

export type RankedGroup<K> = { key: K; bucket: MoneyBucket };

/**
 * Sorts groups by exposure (official + estimate), then by process count; keeps
 * the first `limit` and folds the rest into `others` (null when nothing was folded).
 */
export function rankGroups<K>(
  groups: ReadonlyMap<K, MoneyBucket>,
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

/** Coverage of the official liquidated value ("valor apurado") over a set of processes. */
export type LiquidatedCoverage = {
  /** Processes with an official liquidated value (zero included: zero is a value). */
  assessed: number;
  /** Processes in the set. */
  total: number;
  /** `assessed / total`; null when the set is empty. */
  ratio: number | null;
};

/**
 * RN-03: a null liquidated value is "não apurado" and is never covered; zero is
 * a value and is. Built from a bucket, so a closed snapshot's coverage is read
 * from its stored items (RN-10), never recomputed.
 */
export function liquidatedCoverage(b: Pick<MoneyBucket, "count" | "liquidatedUnknown">): LiquidatedCoverage {
  const total = Math.max(0, b.count);
  const assessed = Math.min(total, Math.max(0, total - b.liquidatedUnknown));
  return { assessed, total, ratio: total === 0 ? null : assessed / total };
}

/** How the exposure of a bucket's processes was obtained (RN-04/RN-07). */
export type ExposureBasisCounts = {
  /** Valor apurado − garantias (official). */
  official: number;
  /** No valor apurado: valor da causa × % de risco − garantias (estimate). */
  estimate: number;
  /** No valor apurado and no claim value or risk classification: no basis, never zero. */
  none: number;
};

/**
 * Splits a bucket's processes by exposure basis, so a group without any valor apurado
 * reads "não apurado" (and one without any estimate, "sem base de cálculo") instead of
 * a R$ 0 that its zero-filled sums would suggest. A liquidated value always yields an
 * official exposure, so the processes without basis are a subset of the não apurados.
 */
export function exposureBasisCounts(b: Pick<MoneyBucket, "count" | "liquidatedUnknown" | "exposureUnknown">): ExposureBasisCounts {
  return domainExposureBasisCounts(b);
}

/** "40%" — never "100%" while a process is missing, nor "0%" when one is covered. */
export function coveragePercent(c: LiquidatedCoverage): string {
  if (c.ratio === null) return "sem processos";
  if (c.assessed > 0 && c.ratio < 0.01) return "menos de 1%";
  if (c.assessed < c.total && c.ratio > 0.99) return "mais de 99%";
  return formatPercent(c.ratio, 0);
}

/** "valor apurado em 2 de 5 processos (40%)" (lower case: callers capitalize when it opens a sentence). */
export function coverageStatement(c: LiquidatedCoverage): string {
  if (c.total === 0) return "nenhum processo na carteira ativa";
  return `valor apurado em ${formatNumber(c.assessed)} de ${formatNumber(c.total)} ${c.total === 1 ? "processo" : "processos"} (${coveragePercent(c)})`;
}

/** Unique CNJ numbers (RN-09: instances of the same process never add up). */
export function uniqueProcessCount(rows: readonly { number: string }[]): number {
  return new Set(rows.map((r) => r.number)).size;
}

export type Delta = { current: number; previous: number; diff: number; ratio: number | null };

export function delta(current: number, previous: number): Delta {
  return { current, previous, diff: current - previous, ratio: previous === 0 ? null : (current - previous) / previous };
}

// ---------------------------------------------------------------------------
// Net exposure of the portfolio (P1.8)
// ---------------------------------------------------------------------------

/** Linked guarantees of the processes with a valor apurado, by kind (SQL aggregate). */
export type GuaranteeKindTotal = { kind: GuaranteeKind; count: number; amountCents: number };

/** A process whose linked guarantees were deducted from its valor apurado. */
export type NetExposureDeduction = {
  processId: string;
  number: string;
  title: string;
  liquidatedCents: number;
  guaranteesCents: number;
  /** What was actually deducted: min(valor apurado, garantias). */
  deductedCents: number;
  exposureCents: number;
};

/**
 * "Exposição líquida" of the active portfolio in scope (RN-04): valor apurado vigente −
 * garantias vinculadas, per process and never negative, summed. Guarantees above the
 * apurado of their own process are not deducted from other processes (`excess`).
 * Without any valor apurado nothing is computed (`coverage.assessed === 0`, "Não apurado").
 * The estimated exposure of the processes without a valor apurado is kept apart (RN-07)
 * and is never added to the net exposure; valor da causa is never added to valor apurado (RN-02).
 */
export type NetExposureSummary = {
  coverage: LiquidatedCoverage;
  /** Σ official liquidated value of the processes that have one (zero included). */
  liquidatedCents: number;
  /** Σ linked guarantees of those processes (gross). */
  guaranteesCents: number;
  /** Σ min(apurado, garantias): what reduced the exposure. */
  deductedCents: number;
  /** Guarantees above the apurado of their process: not deducted, the process stays at zero. */
  excess: { cents: number; processes: number };
  /** Σ max(0, apurado − garantias) = `bucketOf(rows).exposureCents`. */
  exposureCents: number;
  /** Processes with a valor apurado and at least one linked guarantee. */
  withGuarantees: number;
  /** Linked guarantees of the processes with a valor apurado, by kind (largest amount first). */
  byKind: GuaranteeKindTotal[];
  /** Processes with the largest deductions (up to `NET_EXPOSURE_TOP`). */
  top: NetExposureDeduction[];
  /** Processes without a valor apurado: claim × risk − guarantees, an ESTIMATE shown apart. */
  estimate: { exposureCents: number; processes: number; guaranteesCents: number; noBasis: number };
};

export const NET_EXPOSURE_TOP = 5;

export function netExposureSummary(
  rows: readonly PortfolioRowLike[],
  byKind: readonly GuaranteeKindTotal[],
  top = NET_EXPOSURE_TOP,
): NetExposureSummary {
  let liquidatedCents = 0;
  let guaranteesCents = 0;
  let deductedCents = 0;
  let exposureCents = 0;
  let excessCents = 0;
  let excessProcesses = 0;
  let withGuarantees = 0;
  const estimate = { exposureCents: 0, processes: 0, guaranteesCents: 0, noBasis: 0 };
  const deductions: NetExposureDeduction[] = [];
  for (const r of rows) {
    const guarantees = Math.max(0, r.guaranteesCents);
    const e = netExposure({
      liquidatedCents: r.liquidatedCents,
      linkedGuaranteesCents: guarantees,
      claimCents: r.claimCents,
      riskPercentageBp: r.percentageBp,
    });
    if (r.liquidatedCents === null) {
      if (e.exposureCents === null) estimate.noBasis += 1;
      else {
        estimate.processes += 1;
        estimate.exposureCents += e.exposureCents;
        estimate.guaranteesCents += guarantees;
      }
      continue;
    }
    const exposure = e.exposureCents ?? 0;
    const deducted = r.liquidatedCents - exposure;
    liquidatedCents += r.liquidatedCents;
    guaranteesCents += guarantees;
    deductedCents += deducted;
    exposureCents += exposure;
    if (guarantees > 0) {
      withGuarantees += 1;
      deductions.push({
        processId: r.processId,
        number: r.number,
        title: r.title ?? "",
        liquidatedCents: r.liquidatedCents,
        guaranteesCents: guarantees,
        deductedCents: deducted,
        exposureCents: exposure,
      });
    }
    if (guarantees > r.liquidatedCents) {
      excessCents += guarantees - r.liquidatedCents;
      excessProcesses += 1;
    }
  }
  return {
    coverage: liquidatedCoverage({ count: rows.length, liquidatedUnknown: rows.filter((r) => r.liquidatedCents === null).length }),
    liquidatedCents,
    guaranteesCents,
    deductedCents,
    excess: { cents: excessCents, processes: excessProcesses },
    exposureCents,
    withGuarantees,
    byKind: [...byKind].filter((k) => k.count > 0).sort((a, b) => b.amountCents - a.amountCents || a.kind.localeCompare(b.kind)),
    top: deductions
      .sort((a, b) => b.deductedCents - a.deductedCents || a.number.localeCompare(b.number))
      .slice(0, Math.max(0, top)),
    estimate,
  };
}
