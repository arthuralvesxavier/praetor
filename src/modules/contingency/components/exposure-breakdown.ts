/**
 * Breakdown of the net exposure of ONE process for the "Valores e risco" tab and
 * the overview card (P1.8). Pure and client-safe.
 *
 * - Exposição líquida = valor apurado (official liquidated value in force) −
 *   guarantees linked to the process, never negative (RN-04, `netExposure`).
 * - Without an apurado value it is NOT computed (null is not zero, RN-03); the
 *   estimated exposure (valor da causa × % of the classification − linked
 *   guarantees, RN-07) is returned separately and must be labeled "estimado".
 * - Valor da causa and valor apurado are never added together (RN-02).
 */
import { netExposure } from "@/domain/contingency";
import type { GuaranteeKind, GuaranteeStatus } from "@/domain/enums";

export type ExposureSummaryInput = {
  liquidatedCents: number | null;
  liquidatedBaseDate: string | null;
  linkedGuaranteesCents: number;
  claimCents: number | null;
  percentageBp: number | null;
};

export type ExposureGuaranteeInput = {
  id: string;
  kind: GuaranteeKind;
  amountCents: number;
  status: GuaranteeStatus;
  depositedAt: string | null;
};

export type ExposureDeduction = { id: string; kind: GuaranteeKind; amountCents: number; depositedAt: string | null };

export type ExposureBreakdown = {
  /** Null when there is no official apurado value (the net exposure is not computed). */
  net: {
    liquidatedCents: number;
    liquidatedBaseDate: string | null;
    guaranteesCents: number;
    exposureCents: number;
    /** How much the linked guarantees exceed the apurado value (the exposure stays at zero). */
    guaranteesExceedCents: number;
  } | null;
  /** Each linked guarantee deducted (status `linked`), oldest deposit first. */
  deductions: ExposureDeduction[];
  /** Only without an apurado value: claim × % − linked guarantees (an ESTIMATE). */
  estimate: {
    claimCents: number;
    percentageBp: number;
    weightedCents: number;
    guaranteesCents: number;
    exposureCents: number;
  } | null;
  /** Without an apurado value and without an estimate: what is missing to estimate it. */
  estimateMissing: { claim: boolean; classification: boolean } | null;
};

export function exposureBreakdown(s: ExposureSummaryInput, guarantees: readonly ExposureGuaranteeInput[]): ExposureBreakdown {
  const guaranteesCents = Math.max(0, s.linkedGuaranteesCents);
  const deductions = guarantees
    .filter((g) => g.status === "linked")
    .map((g) => ({ id: g.id, kind: g.kind, amountCents: g.amountCents, depositedAt: g.depositedAt }))
    .sort((a, b) => (a.depositedAt ?? "9999-12-31").localeCompare(b.depositedAt ?? "9999-12-31"));
  const exposure = netExposure({
    liquidatedCents: s.liquidatedCents,
    linkedGuaranteesCents: guaranteesCents,
    claimCents: s.claimCents,
    riskPercentageBp: s.percentageBp,
  });

  if (s.liquidatedCents !== null) {
    return {
      net: {
        liquidatedCents: s.liquidatedCents,
        liquidatedBaseDate: s.liquidatedBaseDate,
        guaranteesCents,
        exposureCents: exposure.exposureCents ?? 0,
        guaranteesExceedCents: Math.max(0, guaranteesCents - s.liquidatedCents),
      },
      deductions,
      estimate: null,
      estimateMissing: null,
    };
  }
  if (exposure.basis === "claim_weighted" && s.claimCents !== null && s.percentageBp !== null && exposure.exposureCents !== null) {
    return {
      net: null,
      deductions,
      estimate: {
        claimCents: s.claimCents,
        percentageBp: s.percentageBp,
        weightedCents: Math.round((s.claimCents * s.percentageBp) / 10_000),
        guaranteesCents,
        exposureCents: exposure.exposureCents,
      },
      estimateMissing: null,
    };
  }
  return {
    net: null,
    deductions,
    estimate: null,
    estimateMissing: { claim: s.claimCents === null, classification: s.percentageBp === null },
  };
}
