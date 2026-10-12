import { describe, expect, it } from "vitest";
import { exposureBreakdown, type ExposureGuaranteeInput } from "@/modules/contingency/components/exposure-breakdown";
import { collapseIndexSwaps, type ValueSeriesMeta } from "@/modules/contingency/components/value-series";

const g = (id: string, amountCents: number, over: Partial<ExposureGuaranteeInput> = {}): ExposureGuaranteeInput => ({
  id,
  kind: "judicial_deposit",
  amountCents,
  status: "linked",
  depositedAt: "2024-06-01",
  ...over,
});

describe("exposureBreakdown (P1.8)", () => {
  it("net exposure = valor apurado − linked guarantees, listing only what was deducted", () => {
    const b = exposureBreakdown(
      { liquidatedCents: 500_000, liquidatedBaseDate: "2024-05-10", linkedGuaranteesCents: 150_000, claimCents: 9_000_000, percentageBp: 5000 },
      [g("a", 100_000, { depositedAt: "2024-07-01" }), g("b", 50_000, { depositedAt: null }), g("c", 30_000, { status: "released_to_plaintiff" }), g("d", 20_000, { depositedAt: "2024-01-01" })],
    );
    expect(b.net).toEqual({
      liquidatedCents: 500_000,
      liquidatedBaseDate: "2024-05-10",
      guaranteesCents: 150_000,
      exposureCents: 350_000,
      guaranteesExceedCents: 0,
    });
    // The valor da causa is never used when there is an apurado value (and never added to it).
    expect(b.estimate).toBeNull();
    expect(b.deductions.map((d) => d.id)).toEqual(["d", "a", "b"]);
  });

  it("never negative: guarantees above the apurado value leave the exposure at zero", () => {
    const b = exposureBreakdown({ liquidatedCents: 100_000, liquidatedBaseDate: null, linkedGuaranteesCents: 130_000, claimCents: null, percentageBp: null }, [
      g("a", 130_000),
    ]);
    expect(b.net).toMatchObject({ exposureCents: 0, guaranteesExceedCents: 30_000 });
  });

  it("an apurado value of zero (quitação) is a value, not 'não apurado'", () => {
    const b = exposureBreakdown({ liquidatedCents: 0, liquidatedBaseDate: "2024-02-10", linkedGuaranteesCents: 0, claimCents: 900_000, percentageBp: 10_000 }, []);
    expect(b.net).toMatchObject({ liquidatedCents: 0, exposureCents: 0 });
    expect(b.estimate).toBeNull();
  });

  it("without an apurado value: no net exposure, the estimate apart (claim × % − guarantees)", () => {
    const b = exposureBreakdown({ liquidatedCents: null, liquidatedBaseDate: null, linkedGuaranteesCents: 100_000, claimCents: 1_000_000, percentageBp: 8000 }, [
      g("a", 100_000),
    ]);
    expect(b.net).toBeNull();
    expect(b.estimate).toEqual({ claimCents: 1_000_000, percentageBp: 8000, weightedCents: 800_000, guaranteesCents: 100_000, exposureCents: 700_000 });
    expect(b.estimateMissing).toBeNull();
  });

  it("says what is missing when neither the net exposure nor the estimate can be computed", () => {
    const none = { liquidatedCents: null, liquidatedBaseDate: null, linkedGuaranteesCents: 0 };
    expect(exposureBreakdown({ ...none, claimCents: null, percentageBp: 5000 }, []).estimateMissing).toEqual({ claim: true, classification: false });
    expect(exposureBreakdown({ ...none, claimCents: 100, percentageBp: null }, []).estimateMissing).toEqual({ claim: false, classification: true });
  });
});

describe("collapseIndexSwaps (value series)", () => {
  const p = (id: string, amountCents: number, baseDate = "2024-05-10", instance: string | null = null) => ({
    id,
    baseDate,
    amountCents,
    status: "official",
    instance,
  });
  const at = new Date("2026-10-01T15:00:00Z");

  it("shows an index swap (and a chain of swaps) as one point with the changes noted", () => {
    const meta = new Map<string, ValueSeriesMeta>([
      ["a", { supersedesId: null, correctionIndex: "ipca_e", reviewedAt: null }],
      ["b", { supersedesId: "a", correctionIndex: "inpc", reviewedAt: at }],
      ["c", { supersedesId: "b", correctionIndex: "none", reviewedAt: at }],
      ["d", { supersedesId: "c", correctionIndex: "none", reviewedAt: at }],
    ]);
    const out = collapseIndexSwaps([p("a", 100), p("b", 100), p("c", 100), p("d", 150, "2024-08-31")], meta);
    expect(out.map((x) => x.id)).toEqual(["c", "d"]);
    expect(out[0].indexChanges).toEqual([
      { from: "ipca_e", to: "inpc", at },
      { from: "inpc", to: "none", at },
    ]);
    expect(out[1].indexChanges).toEqual([]);
  });

  it("keeps real changes apart: another amount, base date or instance, or the same index", () => {
    const meta = new Map<string, ValueSeriesMeta>([
      ["a", { supersedesId: null, correctionIndex: "ipca", reviewedAt: null }],
      ["b", { supersedesId: "a", correctionIndex: "inpc", reviewedAt: at }],
      ["c", { supersedesId: "b", correctionIndex: "inpc", reviewedAt: at }],
      ["d", { supersedesId: null, correctionIndex: "tr", reviewedAt: at }],
    ]);
    const out = collapseIndexSwaps([p("a", 100), p("b", 120), p("c", 120), p("d", 120, "2024-05-10", "second")], meta);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.every((x) => x.indexChanges.length === 0)).toBe(true);
  });
});
