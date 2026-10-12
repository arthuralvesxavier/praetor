/** Client-safe types of the indices module (the service re-exports them). */
import type { CorrectionIndex, ValuationKind, ValuationStatus } from "@/domain/enums";
import type { UpdatedValue } from "./math";

export type ValuationUpdate = {
  valuationId: string;
  kind: ValuationKind;
  status: ValuationStatus;
  /** Original amount and base date, as registered (never changed). */
  amountCents: number;
  baseDate: string;
  /** Null = "sem índice informado". */
  correctionIndex: CorrectionIndex | null;
  /** Updated value as of `asOf` (computed now, not stored). */
  updated: UpdatedValue;
};

export type ValuationUpdates = {
  asOf: string;
  items: ValuationUpdate[];
  byId: Record<string, ValuationUpdate>;
};
