/**
 * Points of the "Evolução do valor" lists of the "Valores e risco" tab. Pure and
 * client-safe.
 *
 * "Trocar índice" (P1.7) supersedes an official value with a new official
 * record of the same kind, amount, base date and instance and another
 * correction index (append-only). It is not a new value: the two records are
 * shown as ONE point with the index change noted, never as a second point with
 * "sem variação".
 */
import type { CorrectionIndex } from "@/domain/enums";

export type ValueSeriesInput = {
  id: string;
  baseDate: string;
  amountCents: number;
  status: string;
  instance: string | null;
};

/** What the timeline needs to know about each valuation (from the valuations list and the updates). */
export type ValueSeriesMeta = {
  supersedesId: string | null;
  correctionIndex: CorrectionIndex | null;
  reviewedAt: Date | null;
};

export type ValueSeriesIndexChange = { from: CorrectionIndex | null; to: CorrectionIndex | null; at: Date | null };

export type ValueSeriesPoint = ValueSeriesInput & { indexChanges: ValueSeriesIndexChange[] };

export function collapseIndexSwaps(
  points: readonly ValueSeriesInput[],
  meta: ReadonlyMap<string, ValueSeriesMeta>,
): ValueSeriesPoint[] {
  const out: ValueSeriesPoint[] = [];
  const slotOf = new Map<string, number>();
  for (const p of points) {
    const m = meta.get(p.id);
    const slot = m?.supersedesId ? slotOf.get(m.supersedesId) : undefined;
    if (m && slot !== undefined) {
      const q = out[slot];
      const qMeta = meta.get(q.id);
      const sameValue =
        q.baseDate === p.baseDate && q.amountCents === p.amountCents && q.instance === p.instance;
      if (qMeta && sameValue && qMeta.correctionIndex !== m.correctionIndex) {
        out[slot] = { ...p, indexChanges: [...q.indexChanges, { from: qMeta.correctionIndex, to: m.correctionIndex, at: m.reviewedAt }] };
        slotOf.set(p.id, slot);
        continue;
      }
    }
    slotOf.set(p.id, out.length);
    out.push({ ...p, indexChanges: [] });
  }
  return out;
}
