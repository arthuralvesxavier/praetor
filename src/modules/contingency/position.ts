/**
 * Position of a process at a date (RF-09 "quanto era o passivo em data
 * passada", RN-05 monthly close). Pure: works on rows already loaded.
 *
 * Rules:
 * - Value history = valuations that are or were official (`official` or
 *   `superseded`); proposals and rejected values never count (RN-11).
 *   The value at a date is the one with the greatest `baseDate <= date`
 *   (ties: the most recently recorded).
 * - Risk in force = OFFICIAL assessment with the greatest `effectiveFrom <= date`.
 * - Guarantees linked at a date: deposited (or recorded) on/before the date and
 *   either still linked or released/returned only after the date (RN-04).
 * - Without any history of a kind, the denormalized process field is used
 *   (initial load / registration without history).
 */
import {
  netExposure,
  percentageForClassification,
  provisionFor,
  type ExposureResult,
  type ProvisionResult,
  type RiskPercentages,
} from "@/domain/contingency";
import type { GuaranteeStatus, LossProbability, ValuationKind, ValuationStatus } from "@/domain/enums";
import { toISODate } from "@/lib/format";

export type PositionValuation = {
  kind: ValuationKind;
  amountCents: number;
  baseDate: string;
  status: ValuationStatus;
  createdAt: Date;
};

export type PositionRisk = {
  classification: LossProbability;
  percentageBp: number;
  effectiveFrom: string;
  status: ValuationStatus;
  createdAt: Date;
};

export type PositionGuarantee = {
  amountCents: number;
  status: GuaranteeStatus;
  depositedAt: string | null;
  statusChangedAt: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export type PositionProcess = {
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  riskPercentageBp: number | null;
  lossProbability: LossProbability | null;
};

export type ProcessPosition = {
  date: string;
  claimCents: number | null;
  claimBaseDate: string | null;
  liquidatedCents: number | null;
  liquidatedBaseDate: string | null;
  linkedGuaranteesCents: number;
  classification: LossProbability | null;
  percentageBp: number | null;
  riskEffectiveFrom: string | null;
  exposure: ExposureResult;
  provision: ProvisionResult;
  /** True when a value came from the process record because there is no history of that kind. */
  usedRecordFallback: boolean;
};

const HISTORY_STATUSES: readonly ValuationStatus[] = ["official", "superseded"];

function later<T extends { createdAt: Date }>(a: T, b: T, dateOf: (r: T) => string): T {
  const da = dateOf(a);
  const db = dateOf(b);
  if (da !== db) return da > db ? a : b;
  return a.createdAt.getTime() >= b.createdAt.getTime() ? a : b;
}

/** Latest official/superseded valuation of `kind` with base date on/before `date`. */
export function valuationAt(rows: readonly PositionValuation[], kind: ValuationKind, date: string): PositionValuation | null {
  let best: PositionValuation | null = null;
  for (const r of rows) {
    if (r.kind !== kind || !HISTORY_STATUSES.includes(r.status) || r.baseDate > date) continue;
    best = best ? later(best, r, (x) => x.baseDate) : r;
  }
  return best;
}

/** Official risk assessment in force on `date`. */
export function riskAt(rows: readonly PositionRisk[], date: string): PositionRisk | null {
  let best: PositionRisk | null = null;
  for (const r of rows) {
    if (r.status !== "official" || r.effectiveFrom > date) continue;
    best = best ? later(best, r, (x) => x.effectiveFrom) : r;
  }
  return best;
}

/** Sum of guarantees linked to the process on `date`. */
export function linkedGuaranteesAt(rows: readonly PositionGuarantee[], date: string): number {
  let total = 0;
  for (const g of rows) {
    if (g.deletedAt) continue;
    const start = g.depositedAt ?? toISODate(g.createdAt);
    if (start > date) continue;
    const stillLinked = g.status === "linked" || (g.statusChangedAt !== null && g.statusChangedAt > date);
    if (stillLinked) total += Math.max(0, g.amountCents);
  }
  return total;
}

/** Sum of guarantees linked NOW (status `linked`, not deleted). */
export function currentLinkedGuarantees(rows: readonly Pick<PositionGuarantee, "amountCents" | "status" | "deletedAt">[]): number {
  return rows.reduce((sum, g) => (g.deletedAt || g.status !== "linked" ? sum : sum + Math.max(0, g.amountCents)), 0);
}

/** Effective risk percentage of a process record (bp mirror, or the org parameter of the classification). */
export function recordRiskBp(p: Pick<PositionProcess, "riskPercentageBp" | "lossProbability">, params: RiskPercentages): number | null {
  if (p.riskPercentageBp !== null) return p.riskPercentageBp;
  return p.lossProbability ? percentageForClassification(params, p.lossProbability) : null;
}

export function positionAt(input: {
  date: string;
  process: PositionProcess;
  valuations: readonly PositionValuation[];
  risks: readonly PositionRisk[];
  guarantees: readonly PositionGuarantee[];
  params: RiskPercentages;
}): ProcessPosition {
  const { date, process: p, valuations, risks, guarantees, params } = input;
  let fallback = false;

  const hasClaimHistory = valuations.some((v) => v.kind === "claim" && HISTORY_STATUSES.includes(v.status));
  const claim = valuationAt(valuations, "claim", date);
  let claimCents: number | null = claim?.amountCents ?? null;
  if (!hasClaimHistory && p.claimAmountCents !== null) {
    claimCents = p.claimAmountCents;
    fallback = true;
  }

  const hasLiquidatedHistory = valuations.some((v) => v.kind === "liquidated" && HISTORY_STATUSES.includes(v.status));
  const liquidated = valuationAt(valuations, "liquidated", date);
  let liquidatedCents: number | null = liquidated?.amountCents ?? null;
  if (!hasLiquidatedHistory && p.liquidatedAmountCents !== null) {
    liquidatedCents = p.liquidatedAmountCents;
    fallback = true;
  }

  const hasRiskHistory = risks.some((r) => r.status === "official");
  const risk = riskAt(risks, date);
  let classification: LossProbability | null = risk?.classification ?? null;
  let percentageBp: number | null = risk?.percentageBp ?? null;
  if (!hasRiskHistory && (p.lossProbability !== null || p.riskPercentageBp !== null)) {
    classification = p.lossProbability;
    percentageBp = recordRiskBp(p, params);
    fallback = true;
  }

  const linkedGuaranteesCents = linkedGuaranteesAt(guarantees, date);
  const exposureInput = { liquidatedCents, linkedGuaranteesCents, claimCents, riskPercentageBp: percentageBp };
  return {
    date,
    claimCents,
    claimBaseDate: claim?.baseDate ?? null,
    liquidatedCents,
    liquidatedBaseDate: liquidated?.baseDate ?? null,
    linkedGuaranteesCents,
    classification,
    percentageBp,
    riskEffectiveFrom: risk?.effectiveFrom ?? null,
    exposure: netExposure(exposureInput),
    provision: provisionFor(exposureInput),
    usedRecordFallback: fallback,
  };
}
