/**
 * Review fix "briefs-work-forms" (preventive intelligence): recurring claims
 * read only the latest usable version (ready for review, in review or
 * approved) of each process — older versions' claims are not counted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BriefClaim, StoredCaseBrief } from "@/domain/case-brief";
import type { CaseBriefStatus } from "@/domain/enums";
import { getPreventiveIntelligence } from "@/modules/preventive-intel/service";
import { caseBriefs, legalProcesses } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../../helpers/fixtures";

let fx: Fixture;
const p: Record<string, string> = {};

const claim = (description: string): BriefClaim => ({
  description,
  amountCents: null,
  provenance: "extracted",
  citations: [{ ref: "D1", page: 1, excerpt: "trecho fictício" }],
  note: null,
});

function content(claims: BriefClaim[]): StoredCaseBrief {
  return {
    headline: "Análise demonstrativa (fictícia)",
    identification: [],
    factsSummary: [],
    timeline: [],
    claims,
    amounts: [],
    evidence: [],
    plaintiffArguments: [],
    defendantArguments: [],
    contradictions: [],
    missingDocuments: [],
    theses: [],
    risks: [],
    urgencies: [],
    nextSteps: [],
    possibleDeadlines: [],
    gaps: [],
    limitations: [],
    promptInjectionSuspected: false,
    systemNotices: [],
  };
}

async function brief(key: string, version: number, status: CaseBriefStatus, claims: BriefClaim[] | null) {
  await fx.db.insert(caseBriefs).values({
    organizationId: fx.orgA,
    processId: p[key],
    version,
    status,
    mode: "demo",
    provider: "simulado",
    model: "simulado",
    promptVersion: "teste",
    inputHash: "teste",
    content: claims ? content(claims) : null,
    originalContent: claims ? content(claims) : null,
  });
}

beforeAll(async () => {
  fx = await setupFixture("bwfpi");
  for (const [key, number] of [
    ["a", "0000201-11.2025.5.10.0001"],
    ["b", "0000202-11.2025.5.10.0001"],
  ] as const) {
    const [row] = await fx.db
      .insert(legalProcesses)
      .values({ organizationId: fx.orgA, number, title: `Processo fictício ${key}`, court: "TRT10", area: "labor", phase: "knowledge", unitId: fx.unitSp })
      .returning({ id: legalProcesses.id });
    p[key] = row.id;
  }
  // a: v1 approved (older) → v2 ready for review (latest).
  await brief("a", 1, "approved", [claim("Adicional de insalubridade em grau máximo"), claim("Adicional noturno")]);
  await brief("a", 2, "ready_for_review", [claim("Horas extras além da 8ª diária")]);
  // b: v1 in review → v2 rejected (not usable) → v3 still generating (no content): v1 is the latest usable one.
  await brief("b", 1, "in_review", [claim("Pagamento de horas extras")]);
  await brief("b", 2, "rejected", [claim("Adicional de periculosidade")]);
  await brief("b", 3, "generating", null);
});

afterAll(async () => {
  await fx?.teardown();
});

describe("recurring claims use the latest usable version of each process", () => {
  it("ignores claims of older versions", async () => {
    const r = await getPreventiveIntelligence(fx.ctx.admin);
    const c = r.recurringClaims;
    expect(c.briefsConsidered).toBe(2);
    expect(c.claimsConsidered).toBe(2);
    expect(c.rows.map((row) => row.key)).toEqual(["horas_extras"]);
    expect(c.rows[0].processCount).toBe(2);
    expect(c.rows.some((row) => row.key === "insalubridade_periculosidade" || row.key === "adicional_noturno")).toBe(false);
  });
});
