/**
 * Client-safe presentation maps of the contingency module (tones of the v2
 * statuses). Kept local because `@/lib/tones` is a shared file.
 */
import type {
  GuaranteeStatus,
  InstallmentStatus,
  LossProbability,
  SettlementStatus,
  SnapshotStatus,
  ValuationStatus,
} from "@/domain/enums";
import type { Tone } from "@/lib/tones";

export const VALUATION_STATUS_TONES: Record<ValuationStatus, Tone> = {
  proposed: "warning",
  official: "success",
  rejected: "danger",
  superseded: "neutral",
};

/** Short labels for dense tables (full labels are in `VALUATION_STATUS_LABELS`). */
export const VALUATION_STATUS_SHORT: Record<ValuationStatus, string> = {
  proposed: "Proposto",
  official: "Oficial",
  rejected: "Rejeitado",
  superseded: "Substituído",
};

export const GUARANTEE_STATUS_TONES: Record<GuaranteeStatus, Tone> = {
  linked: "info",
  released_to_plaintiff: "neutral",
  returned_to_company: "success",
};

export const SETTLEMENT_STATUS_TONES: Record<SettlementStatus, Tone> = {
  proposal: "neutral",
  negotiating: "info",
  signed: "primary",
  homologated: "primary",
  fulfilled: "success",
  breached: "danger",
  cancelled: "neutral",
};

export const INSTALLMENT_STATUS_TONES: Record<InstallmentStatus, Tone> = {
  pending: "warning",
  paid: "success",
  cancelled: "neutral",
};

export const SNAPSHOT_STATUS_TONES: Record<SnapshotStatus, Tone> = {
  preview: "warning",
  closed: "success",
};

export const SNAPSHOT_STATUS_SHORT: Record<SnapshotStatus, string> = {
  preview: "Prévia",
  closed: "Fechada",
};

export const LOSS_PROBABILITY_TONES: Record<LossProbability, Tone> = {
  remote: "success",
  possible: "warning",
  probable: "danger",
};

/** Label used whenever a liquidated value is null (RN-03). */
export const NOT_ASSESSED = "Não apurado";
/** Label used whenever a claim value is null. */
export const NOT_INFORMED = "Não informado";
/** Key used in snapshot breakdowns for null dimensions. */
export const NONE_KEY = "__none__";
