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
 * - Ties on the same date (e.g. official values of different instances from
 *   one import) are broken deterministically: most recently reviewed
 *   (`reviewedAt`, else `createdAt`), then `createdAt`, then `id` — the same
 *   order as `syncProcessMirrors`.
 * - Valor da causa REMOVED (process field null, claim history present but no
 *   `official` claim valuation): the claim is null (never zero) on dates
 *   from today on, so current positions and the open competência carry no
 *   estimate on a deleted value. LIMITATION: the removal date is not recorded
 *   (that needs a schema change), so positions/previews of PAST dates still
 *   show the last value that was official on them.
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
import { toISODate, todayISO } from "@/lib/format";

/** Tiebreakers of rows sharing the same date (optional: older callers may not load them). */
type Tiebreak = { createdAt: Date; reviewedAt?: Date | null; id?: string };

export type PositionValuation = Tiebreak & {
  kind: ValuationKind;
  amountCents: number;
  baseDate: string;
  status: ValuationStatus;
};

export type PositionRisk = Tiebreak & {
  classification: LossProbability;
  percentageBp: number;
  effectiveFrom: string;
  status: ValuationStatus;
};

/**
 * "Has history" flags. Computed from the given rows by default; callers that
 * load rows with a date bound (monthly snapshot) pass them precomputed over
 * the WHOLE history, so the record fallback is not used by mistake.
 */
export type PositionHistory = {
  /** Some claim valuation is or was official (any base date). */
  claim: boolean;
  /** Some claim valuation is official now. */
  claimOfficial: boolean;
  /** Some liquidated valuation is or was official (any base date). */
  liquidated: boolean;
  /** Some official risk assessment exists (any effective date). */
  risk: boolean;
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

/** The row in force between two candidates: later date, then most recently reviewed, then created, then id. */
function later<T extends Tiebreak>(a: T, b: T, dateOf: (r: T) => string): T {
  const da = dateOf(a);
  const db = dateOf(b);
  if (da !== db) return da > db ? a : b;
  const ra = (a.reviewedAt ?? a.createdAt).getTime();
  const rb = (b.reviewedAt ?? b.createdAt).getTime();
  if (ra !== rb) return ra > rb ? a : b;
  const ca = a.createdAt.getTime();
  const cb = b.createdAt.getTime();
  if (ca !== cb) return ca > cb ? a : b;
  return (a.id ?? "") >= (b.id ?? "") ? a : b;
}

export function historyOf(valuations: readonly PositionValuation[], risks: readonly PositionRisk[]): PositionHistory {
  const inHistory = (kind: ValuationKind) => valuations.some((v) => v.kind === kind && HISTORY_STATUSES.includes(v.status));
  return {
    claim: inHistory("claim"),
    claimOfficial: valuations.some((v) => v.kind === "claim" && v.status === "official"),
    liquidated: inHistory("liquidated"),
    risk: risks.some((r) => r.status === "official"),
  };
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
  /** Precomputed history flags (see `PositionHistory`); default: computed from `valuations`/`risks`. */
  history?: PositionHistory;
  /** Today's date (YYYY-MM-DD, São Paulo); injectable for tests. */
  today?: string;
}): ProcessPosition {
  const { date, process: p, valuations, risks, guarantees, params } = input;
  const history = input.history ?? historyOf(valuations, risks);
  const today = input.today ?? todayISO();
  let fallback = false;

  let claim = valuationAt(valuations, "claim", date);
  let claimCents: number | null = claim?.amountCents ?? null;
  if (!history.claim && p.claimAmountCents !== null) {
    claimCents = p.claimAmountCents;
    fallback = true;
  } else if (history.claim && !history.claimOfficial && p.claimAmountCents === null && date >= today) {
    // Valor da causa removido: no official value and an empty record. From today on the claim is
    // NOT INFORMED (null, never zero) and no estimate is computed on it (RN-03, RN-07).
    claim = null;
    claimCents = null;
  }

  const liquidated = valuationAt(valuations, "liquidated", date);
  let liquidatedCents: number | null = liquidated?.amountCents ?? null;
  if (!history.liquidated && p.liquidatedAmountCents !== null) {
    liquidatedCents = p.liquidatedAmountCents;
    fallback = true;
  }

  const risk = riskAt(risks, date);
  let classification: LossProbability | null = risk?.classification ?? null;
  let percentageBp: number | null = risk?.percentageBp ?? null;
  if (!history.risk && (p.lossProbability !== null || p.riskPercentageBp !== null)) {
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
