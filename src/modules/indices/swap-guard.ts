/**
 * Guard of "Trocar índice" on an official value (P1.7): the new record that
 * carries the new index must never change WHICH value is in force, nor any
 * amount, at any date. Pure (no I/O): `setValuationCorrectionIndex` loads the
 * history of the kind before and after the swap inside its transaction and
 * refuses the swap (rollback) when this returns a change.
 *
 * Two readings are checked, the same ones the rest of the system uses:
 * - position at a date (`valuationAt` of `@/modules/contingency/position`):
 *   official + superseded rows, greatest base date on/before the date, ties
 *   broken by the most recent review; checked at every base date of the kind,
 *   which covers every date (the winner only changes at a base date);
 * - value in force of the process record (`syncProcessMirrors`): OFFICIAL rows
 *   only, same order.
 * The only accepted difference is the swapped row being replaced by the new one.
 */
import type { ValuationKind } from "@/domain/enums";
import { valuationAt, type PositionValuation } from "@/modules/contingency/position";

/** Valuation history row of the swapped kind (official and superseded rows of the process). */
export type SwapHistoryRow = PositionValuation & { id: string };

/** Later than any base date: the record value takes the latest official row whatever its base date. */
const ANY_DATE = "9999-12-31";

export type SwapInForceChange = {
  /** Date whose value in force would change (`null` = the value in force of the process record). */
  date: string | null;
  beforeId: string | null;
  afterId: string | null;
};

/**
 * First reading whose value in force differs between `before` and `after`,
 * other than `replacedId` becoming `newId`; null when nothing changes.
 */
export function indexSwapInForceChange(input: {
  kind: ValuationKind;
  before: readonly SwapHistoryRow[];
  after: readonly SwapHistoryRow[];
  replacedId: string;
  newId: string;
}): SwapInForceChange | null {
  const { kind, before, after, replacedId, newId } = input;
  const expected = (row: SwapHistoryRow | null) => (row === null ? null : row.id === replacedId ? newId : row.id);
  const idOf = (row: SwapHistoryRow | null) => row?.id ?? null;
  const pick = (rows: readonly SwapHistoryRow[], date: string) => valuationAt(rows, kind, date) as SwapHistoryRow | null;

  const dates = [...new Set([...before, ...after].filter((r) => r.kind === kind).map((r) => r.baseDate))].sort();
  for (const date of dates) {
    const b = pick(before, date);
    const a = pick(after, date);
    if (idOf(a) !== expected(b)) return { date, beforeId: idOf(b), afterId: idOf(a) };
  }
  const official = (rows: readonly SwapHistoryRow[]) => rows.filter((r) => r.status === "official");
  const b = pick(official(before), ANY_DATE);
  const a = pick(official(after), ANY_DATE);
  if (idOf(a) !== expected(b)) return { date: null, beforeId: idOf(b), afterId: idOf(a) };
  return null;
}

/**
 * Another value of the same kind and the same base date in a DIFFERENT
 * instance (official or superseded): the new record would win the tie of that
 * base date, so the swap is refused before anything is written.
 */
export function sameBaseDateOtherInstance<T extends { id: string; baseDate: string; instance: string | null }>(
  rows: readonly T[],
  swapped: { id: string; baseDate: string; instance: string | null },
): T | null {
  return rows.find((r) => r.id !== swapped.id && r.baseDate === swapped.baseDate && r.instance !== swapped.instance) ?? null;
}
