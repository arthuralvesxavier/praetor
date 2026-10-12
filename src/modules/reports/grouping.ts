/**
 * Pure grouping helpers for reports and preventive indicators (client-safe).
 * Money math comes from `@/domain/contingency`; this file only groups.
 */
import {
  addProvisionBasis,
  addToBucket,
  emptyBasisCounts,
  emptyBucket,
  type AmountBasisCounts,
  type BucketItem,
  type MoneyBucket,
} from "@/domain/contingency";
import { normalizeCnj } from "@/domain/cnj";
import type { BucketRow } from "./types";

export const NONE_KEY = "__none__";

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Case/accent-insensitive comparison key for free text. */
export function textKey(value: string): string {
  return stripAccents(collapse(value)).toLowerCase();
}

/** CNJ number normalized when it has 20 digits; otherwise the trimmed text (counting unique processes, RN-01). */
export function cnjKey(number: string): string {
  return normalizeCnj(number) ?? collapse(number).toUpperCase();
}

/**
 * City variants such as "Palmas - TO", "Palmas/TO", "Palmas (TO)" and "palmas"
 * share one key. Values that are not cities (e.g. "Cejusc Digital") are kept
 * as written. Returns the display label without the UF suffix.
 */
export function cityGroup(raw: string | null | undefined): { key: string; label: string } {
  const value = collapse(raw ?? "");
  if (!value) return { key: NONE_KEY, label: "Cidade não informada" };
  const base = collapse(value.replace(/\s*(?:[-–/]\s*|\(\s*)([A-Za-z]{2})\s*\)?$/, ""));
  const label = base || value;
  return { key: textKey(label), label };
}

/** "TRT-10", "TRT10" and "trt 10" share one key. */
export function courtGroup(raw: string | null | undefined): { key: string; label: string } {
  const value = collapse(raw ?? "");
  if (!value) return { key: NONE_KEY, label: "Tribunal não informado" };
  return { key: stripAccents(value).toUpperCase().replace(/[^A-Z0-9]/g, "") || value, label: value };
}

/** Vara / órgão julgador, scoped by the tribunal. */
export function divisionGroup(
  court: string | null | undefined,
  division: string | null | undefined,
): { key: string; label: string } {
  const c = courtGroup(court);
  const d = collapse(division ?? "");
  if (!d) return { key: `${c.key}|${NONE_KEY}`, label: `Vara não informada (${c.label})` };
  return { key: `${c.key}|${textKey(d)}`, label: `${d} (${c.label})` };
}

type Group = { key: string; label: string; numbers: Set<string>; bucket: MoneyBucket; provisionBasis: AmountBasisCounts };

/**
 * Accumulates BucketItems into labeled groups. Labels keep the first variant
 * seen; `processCount` counts distinct CNJ numbers.
 */
export class BucketGroups {
  private groups = new Map<string, Group>();

  add(key: string, label: string, number: string, item: BucketItem): void {
    let g = this.groups.get(key);
    if (!g) {
      g = { key, label, numbers: new Set(), bucket: emptyBucket(), provisionBasis: emptyBasisCounts() };
      this.groups.set(key, g);
    }
    g.numbers.add(cnjKey(number));
    addToBucket(g.bucket, item);
    addProvisionBasis(g.provisionBasis, item);
  }

  get size(): number {
    return this.groups.size;
  }

  has(key: string): boolean {
    return this.groups.has(key);
  }

  /** Rows sorted by `sort` (default: processes desc, then label). */
  rows(sort?: (a: BucketRow, b: BucketRow) => number): BucketRow[] {
    const out = [...this.groups.values()].map((g) => ({
      key: g.key,
      label: g.label,
      processCount: g.numbers.size,
      bucket: g.bucket,
      provisionBasis: g.provisionBasis,
    }));
    return out.sort(sort ?? ((a, b) => b.processCount - a.processCount || a.label.localeCompare(b.label, "pt-BR")));
  }
}

/** Single bucket for a set of items (totals row). */
export function totalRow(key: string, label: string, items: { number: string; item: BucketItem }[]): BucketRow {
  const g = new BucketGroups();
  for (const { number, item } of items) g.add(key, label, number, item);
  return g.rows()[0] ?? { key, label, processCount: 0, bucket: emptyBucket(), provisionBasis: emptyBasisCounts() };
}

/** True when any estimate (RN-07) is part of the bucket. */
export function bucketHasEstimates(b: MoneyBucket): boolean {
  return b.exposureEstimateCents > 0 || b.provisionEstimateCents > 0;
}

/** Stored snapshot position (never recomputed: RN-10) added to a bucket. */
export type SnapshotPosition = {
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  guaranteesCents: number;
  exposureCents: number | null;
  exposureIsEstimate: boolean;
  provisionCents: number | null;
  provisionIsEstimate: boolean;
};

export function addSnapshotPosition(bucket: MoneyBucket, p: SnapshotPosition): MoneyBucket {
  bucket.count += 1;
  if (p.claimAmountCents === null) bucket.claimUnknown += 1;
  else bucket.claimCents += p.claimAmountCents;
  if (p.liquidatedAmountCents === null) bucket.liquidatedUnknown += 1;
  else bucket.liquidatedCents += p.liquidatedAmountCents;
  bucket.guaranteesCents += Math.max(0, p.guaranteesCents);
  if (p.exposureCents === null) bucket.exposureUnknown += 1;
  else if (p.exposureIsEstimate) bucket.exposureEstimateCents += p.exposureCents;
  else bucket.exposureCents += p.exposureCents;
  if (p.provisionCents !== null) {
    if (p.provisionIsEstimate) bucket.provisionEstimateCents += p.provisionCents;
    else bucket.provisionCents += p.provisionCents;
  }
  return bucket;
}
