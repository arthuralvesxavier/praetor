/**
 * Who may inform or change the correction index of a valuation (P1.7), and how.
 * Client-safe (no I/O): the interface uses it to decide whether to show
 * "Informar índice" / "Trocar índice"; `setValuationCorrectionIndex` enforces
 * the same rule.
 *
 *   proposed (in review)                 → in place, `contingency:write`; may change until the review
 *   official / superseded, index null    → in place, `contingency:approve` only (identified reviewer), once
 *   official with an index               → NEW RECORD, `contingency:approve` only: a new official
 *                                          valuation with the same amount and base date and the new
 *                                          index supersedes it (append-only, the old row keeps its index)
 *   superseded with an index             → never (history; change the index of the value in force)
 *   rejected                             → never
 *
 * An official value never gets an index from someone who could not have
 * approved it: the index decides the updated value shown next to it.
 */
import type { CorrectionIndex, ValuationStatus } from "@/domain/enums";

export type CorrectionIndexPermission = "contingency:write" | "contingency:approve";

/** Longest note accepted with an index change of an official value (kept in the review note of the new record). */
export const CORRECTION_INDEX_NOTE_MAX = 500;

/**
 * `in_place`: the column of the same row is written (proposed values, or values without index).
 * `new_record`: a new official valuation (same amount and base date, new index) supersedes the row.
 */
export type CorrectionIndexChangeMode = "in_place" | "new_record";

export type CorrectionIndexEditability =
  | { editable: true; mode: "in_place"; permission: CorrectionIndexPermission }
  | { editable: true; mode: "new_record"; permission: "contingency:approve" }
  | { editable: false; reason: "rejected" | "history" };

export function correctionIndexEditability(row: {
  status: ValuationStatus;
  correctionIndex: CorrectionIndex | null;
}): CorrectionIndexEditability {
  if (row.status === "rejected") return { editable: false, reason: "rejected" };
  if (row.status === "proposed") return { editable: true, mode: "in_place", permission: "contingency:write" };
  if (row.correctionIndex === null) return { editable: true, mode: "in_place", permission: "contingency:approve" };
  if (row.status === "official") return { editable: true, mode: "new_record", permission: "contingency:approve" };
  return { editable: false, reason: "history" };
}

/**
 * For the interface: how a profile with these permissions may change the index of
 * this valuation (`null` = it may not; do not show the control).
 */
export function correctionIndexChangeFor(
  row: { status: ValuationStatus; correctionIndex: CorrectionIndex | null },
  perms: { write: boolean; approve: boolean },
): CorrectionIndexChangeMode | null {
  const rule = correctionIndexEditability(row);
  if (!rule.editable) return null;
  // `contingency:approve` without `contingency:write` does not exist in the role matrix; require both anyway.
  const allowed = rule.permission === "contingency:write" ? perms.write : perms.write && perms.approve;
  return allowed ? rule.mode : null;
}

/** Convenience for the interface: true when a profile with these permissions may use "Informar índice" / "Trocar índice". */
export function canEditCorrectionIndex(
  row: { status: ValuationStatus; correctionIndex: CorrectionIndex | null },
  perms: { write: boolean; approve: boolean },
): boolean {
  return correctionIndexChangeFor(row, perms) !== null;
}

/**
 * Index pinned by a review form (hidden field with the index shown to the reviewer):
 * `undefined` = not sent (no check), `null` = "sem índice informado", otherwise the raw
 * value (an unknown value never matches a stored index, so the decision is refused).
 */
export function pinnedCorrectionIndex(raw: FormDataEntryValue | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined || typeof raw !== "string") return undefined;
  return raw === "" ? null : raw;
}
