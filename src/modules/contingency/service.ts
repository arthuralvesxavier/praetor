/**
 * Contingências: valorações (append-only), garantias, classificação de risco,
 * acordos e fechamento mensal. STUB written by the foundation step — the
 * signatures below are cross-module contracts (docs/dev/MODULE_CONTRACTS.md,
 * "v2 contracts"); the contingency package replaces the bodies.
 */
import type { ExposureResult, MoneyBucket, ProvisionResult } from "@/domain/contingency";
import type {
  LossProbability,
  ProcessInstance,
  ProcessPhase,
  ProcessStatus,
  ValuationKind,
  ValuationSource,
} from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";

export type ProcessContingencySummary = {
  processId: string;
  /** Valor da causa (null = não informado). Never added to the liquidated value (RN-02). */
  claimCents: number | null;
  /** Current official liquidated value (null = não apurado, RN-03). */
  liquidatedCents: number | null;
  liquidatedBaseDate: string | null;
  linkedGuaranteesCents: number;
  classification: LossProbability | null;
  percentageBp: number | null;
  exposure: ExposureResult;
  provision: ProvisionResult;
  /** Proposed valuations waiting for human review. */
  pendingReviewCount: number;
};

/** Requires `contingency:read` and a visible process. */
export async function getProcessContingencySummary(
  _ctx: AuthContext,
  _processId: string,
): Promise<ProcessContingencySummary> {
  throw new Error("not_implemented: getProcessContingencySummary");
}

export type PortfolioExposureFilters = {
  companyId?: string;
  unitId?: string;
  court?: string;
  instance?: ProcessInstance;
  phase?: ProcessPhase;
  city?: string;
  /** Default false: only active portfolio (status active/suspended). */
  includeClosed?: boolean;
};

export type PortfolioExposureRow = {
  processId: string;
  number: string;
  title: string;
  companyId: string | null;
  unitId: string | null;
  court: string;
  instance: ProcessInstance | null;
  phase: ProcessPhase;
  city: string | null;
  status: ProcessStatus;
  classification: LossProbability | null;
  percentageBp: number | null;
  claimCents: number | null;
  liquidatedCents: number | null;
  guaranteesCents: number;
  exposure: ExposureResult;
  provision: ProvisionResult;
};

/** Current position of every VISIBLE process (row visibility applied). Requires `contingency:read`. */
export async function getPortfolioExposure(
  _ctx: AuthContext,
  _filters: PortfolioExposureFilters = {},
): Promise<{ rows: PortfolioExposureRow[]; totals: MoneyBucket }> {
  throw new Error("not_implemented: getPortfolioExposure");
}

export type ProposeValuationInput = {
  processId: string;
  kind: ValuationKind;
  amountCents: number;
  baseDate: string;
  source: ValuationSource;
  instance?: ProcessInstance | null;
  documentId?: string | null;
  documentVersionId?: string | null;
  page?: number | null;
  excerpt?: string | null;
  /** 0–100; values below the org threshold must be reviewed individually (RN-11). */
  confidence?: number | null;
  reason?: string | null;
  briefId?: string | null;
  isEstimate?: boolean;
};

/**
 * Records a PROPOSED valuation (never official) for human review in the
 * review queue (RF-08). Requires `contingency:write` (system context allowed).
 */
export async function proposeValuation(_ctx: AuthContext, _input: ProposeValuationInput): Promise<{ id: string }> {
  throw new Error("not_implemented: proposeValuation");
}
