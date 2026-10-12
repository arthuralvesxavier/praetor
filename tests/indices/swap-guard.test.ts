import { describe, expect, it } from "vitest";
import { indexSwapInForceChange, sameBaseDateOtherInstance, type SwapHistoryRow } from "@/modules/indices/swap-guard";

const at = (minute: number) => new Date(Date.UTC(2025, 0, 1, 12, minute));

function row(id: string, over: Partial<SwapHistoryRow> & { instance?: string | null } = {}): SwapHistoryRow & { instance: string | null } {
  return {
    id,
    kind: "liquidated",
    amountCents: 100_000,
    baseDate: "2024-06-30",
    status: "official",
    createdAt: at(0),
    reviewedAt: at(0),
    instance: "first",
    ...over,
  };
}

/** History after swapping `replaced` for a new record `n` reviewed at minute 59. */
function swapped(before: SwapHistoryRow[], replaced: string, extra: Partial<SwapHistoryRow> = {}): SwapHistoryRow[] {
  const old = before.find((r) => r.id === replaced)!;
  return [
    ...before.map((r) => (r.id === replaced ? { ...r, status: "superseded" as const } : r)),
    { ...old, id: "n", status: "official", createdAt: at(59), reviewedAt: at(59), ...extra },
  ];
}

describe("index swap guard (pure)", () => {
  it("accepts a swap of the value in force: only the replaced row becomes the new record", () => {
    const before = [row("old", { baseDate: "2023-12-31", status: "superseded", amountCents: 50_000 }), row("v", { reviewedAt: at(10) })];
    expect(indexSwapInForceChange({ kind: "liquidated", before, after: swapped(before, "v"), replacedId: "v", newId: "n" })).toBeNull();
  });

  it("detects a tie of the base date won by the new record (another instance in force)", () => {
    const before = [row("v", { reviewedAt: at(10) }), row("other", { instance: "second", amountCents: 200_000, reviewedAt: at(20) })];
    const change = indexSwapInForceChange({ kind: "liquidated", before, after: swapped(before, "v"), replacedId: "v", newId: "n" });
    expect(change).toEqual({ date: "2024-06-30", beforeId: "other", afterId: "n" });
    expect(sameBaseDateOtherInstance(before, before[0])?.id).toBe("other");
  });

  it("detects a superseded row of the same instance and base date that decided the positions", () => {
    const before = [row("v", { reviewedAt: at(30) }), row("history", { status: "superseded", amountCents: 120_000, reviewedAt: at(40) })];
    expect(sameBaseDateOtherInstance(before, before[0])).toBeNull();
    const change = indexSwapInForceChange({ kind: "liquidated", before, after: swapped(before, "v"), replacedId: "v", newId: "n" });
    expect(change).toEqual({ date: "2024-06-30", beforeId: "history", afterId: "n" });
  });

  it("detects a change of the value in force of the process record (official rows only)", () => {
    // Synthetic: the official reading is checked even when no position reading moved.
    const before = [row("v", { reviewedAt: at(10) }), row("o", { baseDate: "2024-07-31", instance: "second", reviewedAt: at(20) })];
    const after: SwapHistoryRow[] = [
      { ...before[0], status: "superseded" },
      { ...before[1], status: "superseded" },
      { ...before[0], id: "n", reviewedAt: at(59), createdAt: at(59) },
    ];
    // Positions: "o" (superseded) still decides 2024-07-31; the record value moved from "o" to "n".
    expect(indexSwapInForceChange({ kind: "liquidated", before, after, replacedId: "v", newId: "n" })).toEqual({
      date: null,
      beforeId: "o",
      afterId: "n",
    });
  });

  it("ignores other kinds and other base dates", () => {
    const before = [
      row("v", { reviewedAt: at(10) }),
      row("claim", { kind: "claim", instance: "second", reviewedAt: at(50) }),
      row("older", { instance: "second", baseDate: "2024-01-31", reviewedAt: at(50), status: "superseded" }),
    ];
    expect(indexSwapInForceChange({ kind: "liquidated", before, after: swapped(before, "v"), replacedId: "v", newId: "n" })).toBeNull();
    expect(sameBaseDateOtherInstance(before.filter((r) => r.kind === "liquidated"), before[0])).toBeNull();
  });

  it("treats a missing instance as different from an informed one, and equal to another missing one", () => {
    const v = row("v", { instance: null });
    expect(sameBaseDateOtherInstance([v, row("a", { instance: "first" })], v)?.id).toBe("a");
    expect(sameBaseDateOtherInstance([v, row("b", { instance: null })], v)).toBeNull();
  });
});
