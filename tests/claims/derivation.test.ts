import { describe, expect, it } from "vitest";
import {
  claimsFingerprint,
  derivationOpinion,
  deriveProcessRisk,
  derivedEffectiveFrom,
  derivedProcessBp,
  derivedProcessRate,
  derivedRateNeedsReview,
  differsFromInForce,
  worseClassification,
  type DerivationClaim,
} from "@/modules/claims/derivation";

function claim(
  id: string,
  status: DerivationClaim["status"],
  assessment: DerivationClaim["assessment"] = null,
  description = `Pedido ${id}`,
): DerivationClaim {
  return { id, description, status, assessment };
}

const a = (id: string, classification: "remote" | "possible" | "probable", percentageBp: number, baseAmountCents: number | null) => ({
  id,
  classification,
  percentageBp,
  baseAmountCents,
});

describe("worseClassification", () => {
  it("orders remote < possible < probable and ignores null", () => {
    expect(worseClassification("remote", "possible")).toBe("possible");
    expect(worseClassification("probable", "possible")).toBe("probable");
    expect(worseClassification(null, "remote")).toBe("remote");
    expect(worseClassification("remote", null)).toBe("remote");
    expect(worseClassification(null, null)).toBeNull();
  });
});

describe("deriveProcessRisk", () => {
  it("classification = worst claim; provision = Σ base × %", () => {
    const d = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "probable", 10_000, 10_000_000)),
      claim("B", "confirmed", a("b1", "possible", 5_000, 5_000_000)),
      claim("C", "confirmed", a("c1", "remote", 0, 2_000_000)),
    ]);
    expect(d.classification).toBe("probable");
    expect(d.worstClaims.map((c) => c.id)).toEqual(["A"]);
    expect(d.provisionCents).toBe(10_000_000 + 2_500_000);
    expect(d.quantifiedBaseCents).toBe(17_000_000);
    expect(d.percentageBp).toBe(Math.round((12_500_000 * 10_000) / 17_000_000));
    expect(d.quantified.map((q) => q.provisionCents)).toEqual([10_000_000, 2_500_000, 0]);
  });

  it("lists assessed claims without base as unquantified (never summed as zero)", () => {
    const d = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "possible", 5_000, 1_000_000)),
      claim("B", "confirmed", a("b1", "probable", 10_000, null)),
    ]);
    expect(d.classification).toBe("probable");
    expect(d.unquantified.map((c) => c.id)).toEqual(["B"]);
    expect(d.provisionCents).toBe(500_000);
    expect(d.quantifiedBaseCents).toBe(1_000_000);
    expect(d.percentageBp).toBe(5_000);
  });

  it("returns null provision and weighted percentage when no assessed claim is quantified", () => {
    const d = deriveProcessRisk([claim("A", "confirmed", a("a1", "possible", 5_000, null))]);
    expect(d.classification).toBe("possible");
    expect(d.provisionCents).toBeNull();
    expect(d.percentageBp).toBeNull();
    expect(derivedProcessBp(d, () => 4_200)).toBe(4_200);
  });

  it("excludes claims suggested by the preliminary analysis until confirmed", () => {
    const pendingAssessed = claim("P", "pending_confirmation", a("p1", "probable", 10_000, 9_000_000));
    const d = deriveProcessRisk([claim("A", "confirmed", a("a1", "remote", 0, 1_000_000)), pendingAssessed]);
    expect(d.classification).toBe("remote");
    expect(d.provisionCents).toBe(0);
    expect(d.pendingConfirmation.map((c) => c.id)).toEqual(["P"]);
    const confirmed = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "remote", 0, 1_000_000)),
      { ...pendingAssessed, status: "confirmed" },
    ]);
    expect(confirmed.classification).toBe("probable");
    expect(confirmed.provisionCents).toBe(9_000_000);
  });

  it("ignores dismissed claims and lists confirmed claims without assessment", () => {
    const d = deriveProcessRisk([
      claim("A", "confirmed"),
      claim("D", "dismissed", a("d1", "probable", 10_000, 5_000_000)),
    ]);
    expect(d.classification).toBeNull();
    expect(d.unassessed.map((c) => c.id)).toEqual(["A"]);
    expect(d.provisionCents).toBeNull();
    expect(derivedProcessBp(d, () => 1)).toBeNull();
  });
});

describe("claimsFingerprint", () => {
  it("is order-independent, ignores non-counted claims and changes with a new assessment", () => {
    const base = [claim("A", "confirmed", a("a1", "remote", 0, 1)), claim("B", "confirmed", a("b1", "possible", 1, 1))];
    expect(claimsFingerprint(base)).toBe(claimsFingerprint([...base].reverse()));
    expect(claimsFingerprint([...base, claim("P", "pending_confirmation", a("p1", "probable", 1, 1))])).toBe(
      claimsFingerprint(base),
    );
    expect(claimsFingerprint([...base, claim("C", "confirmed")])).toBe(claimsFingerprint(base));
    expect(claimsFingerprint([base[0], claim("B", "confirmed", a("b2", "possible", 1, 1))])).not.toBe(claimsFingerprint(base));
  });
});

describe("differsFromInForce", () => {
  it("compares classification and percentage", () => {
    expect(differsFromInForce({ classification: null, percentageBp: null }, null)).toBe(false);
    expect(differsFromInForce({ classification: "possible", percentageBp: 5_000 }, null)).toBe(true);
    expect(differsFromInForce({ classification: "possible", percentageBp: 5_000 }, { classification: "possible", percentageBp: 5_000 })).toBe(
      false,
    );
    expect(differsFromInForce({ classification: "possible", percentageBp: 5_000 }, { classification: "possible", percentageBp: 4_000 })).toBe(
      true,
    );
  });
});

describe("derivedProcessRate (null is not zero)", () => {
  const org = (c: "remote" | "possible" | "probable") => ({ remote: 0, possible: 5_000, probable: 10_000 })[c];

  it("records the weighted rate only when every assessed claim is quantified", () => {
    const d = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "probable", 10_000, 1_000_000)),
      claim("B", "confirmed", a("b1", "remote", 0, 3_000_000)),
    ]);
    expect(derivedProcessRate(d, org)).toEqual({ bp: 2_500, basis: "weighted", weightedBp: 2_500 });
    expect(derivedRateNeedsReview(derivedProcessRate(d, org))).toBe(false);
  });

  it("worst claim unquantified: organization percentage of the classification, never the 0% of the quantified ones", () => {
    // Probe of the review: A probable without value, B remote 0% with R$ 50.000.
    const d = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "probable", 10_000, null)),
      claim("B", "confirmed", a("b1", "remote", 0, 5_000_000)),
    ]);
    expect(d.classification).toBe("probable");
    expect(d.percentageBp).toBe(0);
    const rate = derivedProcessRate(d, org)!;
    expect(rate).toEqual({ bp: 10_000, basis: "organization_unquantified", weightedBp: 0 });
    expect(derivedRateNeedsReview(rate)).toBe(true);
    expect(derivedProcessBp(d, org)).toBe(10_000);
  });

  it("any assessed claim unquantified (not the worst) also uses the organization percentage and is flagged", () => {
    const d = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "possible", 3_000, 2_000_000)),
      claim("B", "confirmed", a("b1", "remote", 0, null)),
    ]);
    expect(derivedProcessRate(d, org)).toEqual({ bp: 5_000, basis: "organization_unquantified", weightedBp: 3_000 });
  });

  it("nothing quantified: organization percentage, not flagged (no claim is counted as zero)", () => {
    const d = deriveProcessRisk([claim("A", "confirmed", a("a1", "possible", 3_000, null))]);
    const rate = derivedProcessRate(d, org)!;
    expect(rate).toEqual({ bp: 5_000, basis: "organization_no_base", weightedBp: null });
    expect(derivedRateNeedsReview(rate)).toBe(false);
  });

  it("suggested claims pending confirmation do not change the rate", () => {
    const d = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "possible", 5_000, 1_000_000)),
      claim("P", "pending_confirmation", a("p1", "probable", 10_000, null)),
    ]);
    expect(derivedProcessRate(d, org)).toEqual({ bp: 5_000, basis: "weighted", weightedBp: 5_000 });
  });

  it("no assessed claim: no rate", () => {
    expect(derivedProcessRate(deriveProcessRisk([claim("A", "confirmed")]), org)).toBeNull();
    expect(derivedRateNeedsReview(null)).toBe(false);
  });
});

describe("derivationOpinion", () => {
  it("starts with 'Derivado dos pedidos:' and has no em dash", () => {
    const d = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "probable", 10_000, 10_000_000), "Horas extras"),
      claim("B", "confirmed", a("b1", "possible", 5_000, null), "Dano moral"),
      claim("C", "confirmed"),
      claim("P", "pending_confirmation"),
    ]);
    const text = derivationOpinion(d, derivedProcessRate(d, () => 10_000), "Laura");
    expect(text.startsWith("Derivado dos pedidos:")).toBe(true);
    expect(text).toContain("Horas extras");
    expect(text).toContain("Não quantificados");
    expect(text).toContain("o da organização para a classificação");
    expect(text).toContain("marcada para revisão");
    expect(text).not.toMatch(/—| – /);
  });

  it("explains the weighted rate and has no em dash even without a weighted rate", () => {
    const weighted = deriveProcessRisk([claim("A", "confirmed", a("a1", "possible", 5_000, 1_000_000))]);
    expect(derivationOpinion(weighted, derivedProcessRate(weighted, () => 5_000), null)).toContain("ponderado pelos pedidos quantificados");
    const zeroBase = deriveProcessRisk([
      claim("A", "confirmed", a("a1", "possible", 5_000, 0)),
      claim("B", "confirmed", a("b1", "probable", 10_000, null)),
    ]);
    const text = derivationOpinion(zeroBase, derivedProcessRate(zeroBase, () => 10_000), null);
    expect(text).toContain("não calculado");
    expect(text).not.toMatch(/—| – /);
  });
});

describe("derivedEffectiveFrom", () => {
  const dated = (id: string, effectiveFrom: string) => ({ ...a(id, "possible", 5_000, 1_000), effectiveFrom });
  const TODAY = "2026-10-12";

  it("is the latest effective date among the counted claim assessments in force", () => {
    const claims = [
      claim("A", "confirmed", dated("a1", "2026-09-15")),
      claim("B", "confirmed", dated("b1", "2026-09-20")),
      claim("C", "confirmed"),
    ];
    expect(derivedEffectiveFrom(claims, null, TODAY)).toBe("2026-09-20");
  });

  it("ignores claims that do not count (suggestions, dismissed)", () => {
    const claims = [
      claim("A", "confirmed", dated("a1", "2026-09-15")),
      claim("S", "pending_confirmation", dated("s1", "2026-10-01")),
      claim("D", "dismissed", dated("d1", "2026-10-05")),
    ];
    expect(derivedEffectiveFrom(claims, null, TODAY)).toBe("2026-09-15");
  });

  it("is never earlier than the official classification in force, never after today", () => {
    const claims = [claim("A", "confirmed", dated("a1", "2026-09-10"))];
    expect(derivedEffectiveFrom(claims, "2026-09-25", TODAY)).toBe("2026-09-25");
    expect(derivedEffectiveFrom(claims, "2026-08-01", TODAY)).toBe("2026-09-10");
    expect(derivedEffectiveFrom([claim("A", "confirmed", dated("a1", "2026-12-01"))], null, TODAY)).toBe(TODAY);
  });

  it("falls back to today without dated counted assessments", () => {
    expect(derivedEffectiveFrom([claim("A", "confirmed", a("a1", "remote", 0, null))], null, TODAY)).toBe(TODAY);
    expect(derivedEffectiveFrom([], "2026-09-01", TODAY)).toBe(TODAY);
  });
});
