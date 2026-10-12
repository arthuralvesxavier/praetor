import { describe, expect, it } from "vitest";
import { emptyBucket, addToBucket } from "@/domain/contingency";
import { buildSnapshotCsv, calculationMemo, csvCell, csvMoney, type CsvSnapshotRow } from "@/modules/contingency/csv";
import { positionAt } from "@/modules/contingency/position";
import {
  addMonthsISO,
  canTransitionSettlement,
  findExcerpt,
  isValidPeriod,
  recentPeriods,
  RISK_SUGGESTION_PREFIX,
  ruleSuggestionOpinion,
  slicePageText,
  splitInstallments,
  suggestRiskByRule,
  windowAround,
} from "@/modules/contingency/rules";

describe("splitInstallments", () => {
  it("splits evenly and the last installment absorbs the rounding", () => {
    const plan = splitInstallments(100_000, 3, "2026-01-31");
    expect(plan.map((p) => p.amountCents)).toEqual([33_333, 33_333, 33_334]);
    expect(plan.reduce((s, p) => s + p.amountCents, 0)).toBe(100_000);
    expect(plan.map((p) => p.dueDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(plan.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("handles a single installment and rejects invalid input", () => {
    expect(splitInstallments(5, 1, "2026-05-10")).toEqual([{ number: 1, dueDate: "2026-05-10", amountCents: 5 }]);
    expect(() => splitInstallments(100, 0, "2026-05-10")).toThrow();
    expect(() => splitInstallments(-1, 2, "2026-05-10")).toThrow();
  });

  it("adds months across years with day clamping", () => {
    expect(addMonthsISO("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonthsISO("2024-01-31", 1)).toBe("2024-02-29");
    expect(recentPeriods("2026-02", 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(isValidPeriod("2026-13")).toBe(false);
    expect(isValidPeriod("2026-10")).toBe(true);
  });
});

describe("settlement transitions", () => {
  it("follows proposta → negociação → firmado → homologado → cumprido/descumprido", () => {
    expect(canTransitionSettlement("proposal", "negotiating")).toBe(true);
    expect(canTransitionSettlement("negotiating", "signed")).toBe(true);
    expect(canTransitionSettlement("signed", "homologated")).toBe(true);
    expect(canTransitionSettlement("homologated", "fulfilled")).toBe(true);
    expect(canTransitionSettlement("homologated", "breached")).toBe(true);
    expect(canTransitionSettlement("fulfilled", "breached")).toBe(false);
    expect(canTransitionSettlement("cancelled", "proposal")).toBe(false);
    expect(canTransitionSettlement("proposal", "fulfilled")).toBe(false);
  });
});

describe("suggestRiskByRule (RF-12)", () => {
  const base = { status: "active", phase: "knowledge", instance: "first", closureReason: null, liquidatedCents: null } as const;

  it("knowledge phase without liquidated value → possível", () => {
    expect(suggestRiskByRule(base).classification).toBe("possible");
  });
  it("enforcement or assessed value → provável", () => {
    expect(suggestRiskByRule({ ...base, phase: "enforcement" }).classification).toBe("probable");
    expect(suggestRiskByRule({ ...base, liquidatedCents: 10_000 }).classification).toBe("probable");
  });
  it("closed process or zeroed value → remota", () => {
    expect(suggestRiskByRule({ ...base, status: "closed", closureReason: "paid_extinct" }).classification).toBe("remote");
    expect(suggestRiskByRule({ ...base, liquidatedCents: 0 }).classification).toBe("remote");
  });
  it("opinion is labeled as a non-official rule suggestion", () => {
    const opinion = ruleSuggestionOpinion(suggestRiskByRule(base), 3, "50%");
    expect(opinion.startsWith(RISK_SUGGESTION_PREFIX)).toBe(true);
    expect(opinion).toContain("versão 3");
  });
});

describe("document page slicing (TE-04)", () => {
  const text = "Página um texto.\fPágina dois: valor apurado de R$ 12.345,67 conforme cálculo.\fPágina três.";
  const offsets = [0, text.indexOf("Página dois"), text.indexOf("Página três")];

  it("slices the requested page", () => {
    expect(slicePageText(text, offsets, 2)).toContain("valor apurado");
    expect(slicePageText(text, offsets, 4)).toBeNull();
    expect(slicePageText(text, null, 1)).toBe(text);
    expect(slicePageText(text, null, 2)).toBeNull();
  });

  it("finds the excerpt ignoring case and whitespace", () => {
    const page = slicePageText(text, offsets, 2)!;
    const hit = findExcerpt(page, "VALOR  apurado de R$ 12.345,67");
    expect(hit).not.toBeNull();
    expect(page.slice(hit!.start, hit!.end)).toBe("valor apurado de R$ 12.345,67");
    expect(findExcerpt(page, "inexistente")).toBeNull();
  });

  it("windows long pages around the highlight", () => {
    const long = `${"a".repeat(30_000)}ALVO${"b".repeat(30_000)}`;
    const w = windowAround(long, { start: 30_000, end: 30_004 }, 1000);
    expect(w.text.length).toBe(1000);
    expect(w.text.slice(w.highlight!.start, w.highlight!.end)).toBe("ALVO");
    expect(w.truncatedStart && w.truncatedEnd).toBe(true);
  });
});

describe("positionAt (RF-09 / RN-04 / RN-05)", () => {
  const t = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const params = { remote: 0, possible: 50, probable: 100 };
  const process = { claimAmountCents: 500_000, liquidatedAmountCents: 300_000, riskPercentageBp: 10_000, lossProbability: "probable" as const };
  const valuations = [
    { kind: "liquidated" as const, amountCents: 200_000, baseDate: "2026-01-10", status: "superseded" as const, createdAt: t("2026-01-11") },
    { kind: "liquidated" as const, amountCents: 300_000, baseDate: "2026-03-10", status: "official" as const, createdAt: t("2026-03-11") },
    { kind: "liquidated" as const, amountCents: 999_999, baseDate: "2026-02-10", status: "proposed" as const, createdAt: t("2026-02-11") },
    { kind: "liquidated" as const, amountCents: 888_888, baseDate: "2026-02-15", status: "rejected" as const, createdAt: t("2026-02-16") },
  ];
  const risks = [
    { classification: "possible" as const, percentageBp: 5_000, effectiveFrom: "2026-01-01", status: "official" as const, createdAt: t("2026-01-01") },
    { classification: "probable" as const, percentageBp: 10_000, effectiveFrom: "2026-03-01", status: "official" as const, createdAt: t("2026-03-01") },
  ];
  const guarantees = [
    { amountCents: 50_000, status: "released_to_plaintiff" as const, depositedAt: "2026-01-05", statusChangedAt: "2026-02-20", createdAt: t("2026-01-05"), deletedAt: null },
  ];

  it("uses the value, risk and guarantees in force on the date (proposed/rejected ignored)", () => {
    const feb = positionAt({ date: "2026-02-28", process, valuations, risks, guarantees, params });
    expect(feb.liquidatedCents).toBe(200_000);
    expect(feb.classification).toBe("possible");
    expect(feb.linkedGuaranteesCents).toBe(0); // released on 2026-02-20
    expect(feb.provision.provisionCents).toBe(100_000);

    const feb10 = positionAt({ date: "2026-02-10", process, valuations, risks, guarantees, params });
    expect(feb10.linkedGuaranteesCents).toBe(50_000); // still linked
    expect(feb10.exposure.exposureCents).toBe(150_000);

    const apr = positionAt({ date: "2026-04-30", process, valuations, risks, guarantees, params });
    expect(apr.liquidatedCents).toBe(300_000);
    expect(apr.provision.provisionCents).toBe(300_000);
  });

  it("before any value: liquidated null (RN-03) and claim from the record", () => {
    const dec = positionAt({ date: "2025-12-31", process, valuations, risks, guarantees, params });
    expect(dec.liquidatedCents).toBeNull();
    expect(dec.claimCents).toBe(500_000);
    expect(dec.classification).toBeNull();
    expect(dec.provision.provisionCents).toBeNull();
  });
});

describe("CSV export", () => {
  const row = (over: Partial<CsvSnapshotRow>): CsvSnapshotRow => ({
    number: "0000001-11.2026.5.10.0001",
    companyName: "Empresa; Fictícia",
    unitName: null,
    court: "TRT-10",
    instance: "first",
    phase: "knowledge",
    city: null,
    classification: "possible",
    percentageBp: 5_000,
    claimAmountCents: 1_000_000,
    liquidatedAmountCents: null,
    guaranteesCents: 0,
    exposureCents: 500_000,
    exposureIsEstimate: true,
    provisionCents: 500_000,
    provisionIsEstimate: true,
    ...over,
  });

  it("uses BOM, ';', decimal comma, empty null money and the RN-07 caveat", () => {
    const totals = emptyBucket();
    const rows = [row({}), row({ number: "2", liquidatedAmountCents: 200_000, exposureIsEstimate: false, provisionIsEstimate: false, provisionCents: 100_000, exposureCents: 200_000 })];
    for (const r of rows) {
      addToBucket(totals, { liquidatedCents: r.liquidatedAmountCents, linkedGuaranteesCents: r.guaranteesCents, claimCents: r.claimAmountCents, riskPercentageBp: r.percentageBp });
    }
    const csv = buildSnapshotCsv({
      period: "2026-09",
      referenceDate: "2026-09-30",
      status: "closed",
      params: { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 1, confidenceThreshold: 85 },
      rows,
      totals,
      hiddenCount: 2,
      totalsAreOrganizationWide: true,
    });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("ATENÇÃO (RN-07): 1 processo(s)");
    expect(csv).toContain("2 processo(s) sigiloso(s) não listado(s)");
    const lines = csv.split("\r\n");
    const data = lines.find((l) => l.startsWith("0000001"))!;
    const cells = data.split(";");
    // Value with ';' is quoted, so splitting naively moves columns: check through the quoted field.
    expect(data).toContain('"Empresa; Fictícia"');
    expect(cells).toContain("10000,00");
    expect(data).toContain(";;"); // empty liquidated cell (RN-03)
    expect(csvMoney(null)).toBe("");
    expect(csvMoney(123_456)).toBe("1234,56");
    expect(csvCell('a"b')).toBe('"a""b"');
  });

  it("explains the calculation per process", () => {
    expect(calculationMemo(row({}))).toContain("ESTIMATIVA (RN-07)");
    expect(
      calculationMemo(row({ liquidatedAmountCents: 300_000, guaranteesCents: 100_000, percentageBp: 10_000 })),
    ).toContain("− garantias vinculadas");
    expect(calculationMemo(row({ percentageBp: null }))).toContain("Sem classificação");
  });
});
