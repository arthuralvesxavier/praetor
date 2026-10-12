import { describe, expect, it } from "vitest";
import { isValidCnj, parseCnj } from "@/domain/cnj";
import { describeCriteria, evaluateCriteria, isEmptyCriteria, normalizeCity, normalizeCourt, type ProcessFacts } from "@/modules/distribution/matching";
import { ruleInputSchema, splitList } from "@/modules/distribution/schemas";
import { registerIntakeSchema } from "@/modules/intake/schemas";
import {
  FICTITIOUS_PLAINTIFFS,
  buildSimulatedCnj,
  shortPartyName,
  simulatedClaimCents,
  simulatedPlaintiff,
  tribunalCodeFromCourt,
} from "@/modules/intake/simulation";
import { buildPipelineStages, effectiveIntakeStatus, type PipelineInput } from "@/modules/intake/status";

const facts: ProcessFacts = {
  court: "TRT-10",
  area: "labor",
  companyId: "11111111-1111-1111-1111-111111111111",
  unitId: null,
  state: "TO",
  city: "Palmas - TO",
  instance: "first",
  processClass: "ATOrd",
  claimAmountCents: 5_000_000,
};

describe("distribution matching (pure)", () => {
  it("normalizes the spreadsheet variants of courts and cities", () => {
    expect(normalizeCourt("TRT-10")).toBe("TRT10");
    expect(normalizeCourt("trt 10")).toBe("TRT10");
    expect(normalizeCity("Palmas - TO")).toBe("palmas");
    expect(normalizeCity("Palmas/TO")).toBe("palmas");
    expect(normalizeCity("PALMAS (TO)")).toBe("palmas");
    expect(normalizeCity("São Paulo")).toBe("sao paulo");
  });

  it("empty criteria match any process", () => {
    expect(isEmptyCriteria({})).toBe(true);
    expect(evaluateCriteria({}, facts).matched).toBe(true);
  });

  it("every filled criterion must be satisfied", () => {
    const ok = evaluateCriteria(
      { courts: ["TRT10"], cities: ["Palmas"], states: ["to"], areas: ["labor"], instances: ["first"], processClasses: ["atord"] },
      facts,
    );
    expect(ok.matched).toBe(true);
    expect(ok.matchedOn.join(" ")).toContain("tribunal TRT-10");

    const wrongCourt = evaluateCriteria({ courts: ["TRT2"], areas: ["labor"] }, facts);
    expect(wrongCourt.matched).toBe(false);
    expect(wrongCourt.mismatches[0]).toContain("Tribunal TRT-10 fora da regra");
  });

  it("claim range: null claim never matches a range (null is not zero)", () => {
    expect(evaluateCriteria({ minClaimCents: 1_000_000, maxClaimCents: 9_000_000 }, facts).matched).toBe(true);
    expect(evaluateCriteria({ minClaimCents: 6_000_000 }, facts).matched).toBe(false);
    const nullClaim = evaluateCriteria({ maxClaimCents: 9_000_000 }, { ...facts, claimAmountCents: null });
    expect(nullClaim.matched).toBe(false);
    expect(nullClaim.mismatches[0]).toContain("não informado");
  });

  it("describes criteria in pt-BR", () => {
    const text = describeCriteria(
      { courts: ["TRT10"], areas: ["labor"], minClaimCents: 1_000_000 },
      { companies: {}, units: {} },
    );
    expect(text).toEqual(["Tribunal: TRT10", "Área: Trabalhista", expect.stringContaining("Valor da causa: a partir de")]);
  });

  it("rule schema validates ranges, users and UFs", () => {
    const base = { name: "Regra", priority: 10, method: "fixed" as const, userIds: ["11111111-1111-1111-1111-111111111111"] };
    expect(ruleInputSchema.safeParse(base).success).toBe(true);
    const badRange = ruleInputSchema.safeParse({ ...base, minClaimCents: 500, maxClaimCents: 100 });
    expect(badRange.success).toBe(false);
    expect(ruleInputSchema.safeParse({ ...base, userIds: [] }).success).toBe(false);
    expect(ruleInputSchema.safeParse({ ...base, states: ["Tocantins"] }).success).toBe(false);
    expect(splitList("TRT10, TRT2; TST\nTRT1")).toEqual(["TRT10", "TRT2", "TST", "TRT1"]);
  });
});

describe("intake schema", () => {
  const base = {
    number: "00012345620265100801",
    court: "TRT10",
    area: "labor",
    phase: "knowledge",
    instance: "first",
    plaintiffName: "Fulano de Tal Exemplo",
  };
  it("normalizes the CNJ number and rejects other shapes", () => {
    const ok = registerIntakeSchema.safeParse(base);
    expect(ok.success && ok.data.number).toBe("0001234-56.2026.5.10.0801");
    const bad = registerIntakeSchema.safeParse({ ...base, number: "123" });
    expect(bad.success).toBe(false);
  });
});

describe("simulation helpers (pure)", () => {
  it("builds CNJ numbers with a correct check digit, deterministic per seed", () => {
    const a = buildSimulatedCnj({ seed: 3, year: 2026, tribunal: "10", origin: "0801" });
    const b = buildSimulatedCnj({ seed: 3, year: 2026, tribunal: "10", origin: "0801" });
    const c = buildSimulatedCnj({ seed: 3, salt: 1, year: 2026, tribunal: "10", origin: "0801" });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    for (const n of [a, c]) {
      expect(isValidCnj(n)).toBe(true);
      const parts = parseCnj(n)!;
      expect(parts.segment).toBe("5");
      expect(parts.tribunal).toBe("10");
      expect(parts.year).toBe(2026);
      expect(parts.origin).toBe("0801");
    }
  });

  it("derives the tribunal code only from labor courts", () => {
    expect(tribunalCodeFromCourt("TRT10")).toBe("10");
    expect(tribunalCodeFromCourt("TRT-2")).toBe("02");
    expect(tribunalCodeFromCourt("TST")).toBeNull();
    expect(tribunalCodeFromCourt("TJSP")).toBeNull();
  });

  it("claim values stay in a realistic range and names are from the fictitious list", () => {
    for (let seed = 1; seed < 50; seed++) {
      const cents = simulatedClaimCents(seed);
      expect(Number.isInteger(cents)).toBe(true);
      expect(cents).toBeGreaterThanOrEqual(1_800_000);
      expect(cents).toBeLessThanOrEqual(32_000_000);
      expect(FICTITIOUS_PLAINTIFFS).toContain(simulatedPlaintiff(seed));
    }
    expect(shortPartyName("EMPRESA MODELO TESTE LTDA (e outros)")).toBe("EMPRESA MODELO TESTE LTDA");
  });
});

describe("intake status (pure)", () => {
  it("effective status reflects the brief without overriding failures", () => {
    expect(effectiveIntakeStatus("notified", "in_review")).toBe("in_review");
    expect(effectiveIntakeStatus("notified", "approved")).toBe("approved");
    expect(effectiveIntakeStatus("notified", "ready_for_review")).toBe("notified");
    expect(effectiveIntakeStatus("failed", "approved")).toBe("failed");
    expect(effectiveIntakeStatus("received", null)).toBe("received");
  });

  const base: PipelineInput = {
    status: "received",
    receivedAt: new Date("2026-10-01T12:00:00Z"),
    createdByName: "Ana",
    source: "manual",
    assignedToName: null,
    assignedAt: null,
    assignmentMethod: null,
    assignmentReason: null,
    briefId: null,
    lastEmailId: null,
    steps: [{ status: "received", at: "2026-10-01T12:00:00Z", detail: "Processo registrado.", actorName: "Ana" }],
    errorMessage: null,
    processing: true,
    brief: null,
    email: null,
  };

  it("builds the six stages in order", () => {
    const stages = buildPipelineStages(base);
    expect(stages.map((s) => s.key)).toEqual(["received", "assigned", "analysis", "email", "review", "approval"]);
    expect(stages.map((s) => s.state)).toEqual(["done", "current", "pending", "pending", "pending", "pending"]);
  });

  it("marks the first unfinished stage as failed", () => {
    const stages = buildPipelineStages({
      ...base,
      status: "failed",
      processing: false,
      assignedToName: "Laura",
      assignedAt: new Date(),
      assignmentMethod: "least_loaded",
      assignmentReason: "Menor carga.",
      errorMessage: "E-mail: falha",
      briefId: "b",
      brief: {
        status: "ready_for_review",
        version: 1,
        generatedAt: new Date(),
        lastEditedAt: null,
        lastEditedByName: null,
        approvedAt: null,
        approvedByName: null,
        rejectedAt: null,
        rejectedByName: null,
      },
    });
    expect(stages.find((s) => s.key === "analysis")?.state).toBe("done");
    expect(stages.find((s) => s.key === "email")?.state).toBe("failed");
    expect(stages.find((s) => s.key === "email")?.detail).toBe("E-mail: falha");
  });

  it("approved brief completes review and approval", () => {
    const stages = buildPipelineStages({
      ...base,
      status: "notified",
      processing: false,
      assignedToName: "Laura",
      assignedAt: new Date(),
      assignmentMethod: "rule",
      briefId: "b",
      lastEmailId: "e",
      email: { createdAt: new Date(), toName: "Laura" },
      brief: {
        status: "approved",
        version: 2,
        generatedAt: new Date(),
        lastEditedAt: new Date(),
        lastEditedByName: "Laura",
        approvedAt: new Date(),
        approvedByName: "Laura",
        rejectedAt: null,
        rejectedByName: null,
      },
    });
    expect(stages.every((s) => s.state === "done")).toBe(true);
    expect(stages.find((s) => s.key === "email")?.detail).toContain("Nenhuma mensagem foi enviada");
  });
});
