import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { BriefClaim, StoredCaseBrief } from "@/domain/case-brief";
import type { CaseBriefStatus } from "@/domain/enums";
import { caseBriefs, legalProcesses, occurrences, processParties, tasks } from "@/server/db/schema";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/lib/errors";
import { getOccurrence, getOccurrenceStats, listOccurrences } from "@/modules/occurrences/service";
import {
  createActionPlanFromSuggestion,
  createOccurrenceFromSuggestion,
  getPreventiveIntelligence,
  listPreventiveIntelFilterOptions,
} from "@/modules/preventive-intel/service";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let fx: Fixture;
const q: Record<string, string> = {};

type LpInsert = typeof legalProcesses.$inferInsert;

async function insertProcess(key: string, values: Partial<LpInsert> & { number: string }) {
  const [row] = await fx.db
    .insert(legalProcesses)
    .values({
      organizationId: fx.orgA,
      title: `Reclamação trabalhista fictícia ${key}`,
      court: "TRT10",
      area: "labor",
      phase: "knowledge",
      unitId: fx.unitSp,
      ...values,
    })
    .returning({ id: legalProcesses.id });
  q[key] = row.id;
}

async function party(key: string, name: string, role: "plaintiff" | "public_prosecutor" | "defendant", isClient = false) {
  await fx.db.insert(processParties).values({ organizationId: fx.orgA, processId: q[key], name, role, isClient });
}

const claim = (description: string, provenance: BriefClaim["provenance"] = "extracted", amountCents: number | null = null): BriefClaim => ({
  description,
  amountCents,
  provenance,
  citations: [{ ref: "D1", page: 2, excerpt: "trecho fictício" }],
  note: null,
});

function content(claims: BriefClaim[]): StoredCaseBrief {
  return {
    headline: "Análise demonstrativa",
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

async function brief(key: string, version: number, status: CaseBriefStatus, claims: BriefClaim[]) {
  await fx.db.insert(caseBriefs).values({
    organizationId: fx.orgA,
    processId: q[key],
    version,
    status,
    mode: "demo",
    provider: "simulated",
    model: "demo",
    promptVersion: "test",
    inputHash: `h-${key}-${version}`,
    content: content(claims),
    originalContent: content(claims),
  });
}

beforeAll(async () => {
  fx = await setupFixture("pi");
  await insertProcess("q1", {
    number: "0000101-11.2024.5.10.0001",
    processClass: "ATOrd",
    city: "Palmas - TO",
    courtDivision: "1ª Vara do Trabalho de Palmas",
    claimAmountCents: 1_000_000,
    companyId: fx.companyA,
  });
  await insertProcess("q2", {
    number: "0000102-11.2025.5.10.0001",
    processClass: "ATOrd",
    city: "Palmas/TO",
    courtDivision: "1ª Vara do Trabalho de Palmas",
    claimAmountCents: 2_000_000,
    liquidatedAmountCents: 3_000_000,
    needsVerification: true,
    companyId: fx.companyA,
  });
  await insertProcess("q3", {
    number: "0000103-11.2025.5.10.0001",
    processClass: "ATSum",
    city: "Palmas",
    phase: "enforcement",
    claimAmountCents: 1_000_000,
    liquidatedAmountCents: 1_500_000,
  });
  await insertProcess("q4", {
    number: "0000104-11.2025.5.02.0001",
    court: "TRT2",
    processClass: "ACPCiv",
    city: "Brasília",
    claimAmountCents: null,
  });
  await insertProcess("q5", {
    number: "0000105-11.2023.5.10.0001",
    processClass: "ATOrd",
    status: "closed",
    phase: "knowledge",
    closureReason: "lost_patronage",
    closedAt: "2026-01-10",
  });
  await insertProcess("q6", {
    number: "0000106-11.2025.5.10.0001",
    processClass: "ATOrd",
    city: "Palmas",
    isConfidential: true,
  });
  await insertProcess("q7", {
    number: "0000107-11.2025.5.02.0001",
    court: "TRT2",
    processClass: "ATOrd",
    phase: "liquidation",
    unitId: fx.unitRe,
    claimAmountCents: 1_000_000,
    liquidatedAmountCents: 800_000,
  });
  await fx.db.insert(legalProcesses).values({
    organizationId: fx.orgB,
    number: "0000101-11.2024.5.10.0001",
    title: "Processo da organização B",
    court: "TRT10",
    area: "labor",
    phase: "knowledge",
  });

  await party("q1", "João da Silva", "plaintiff");
  await party("q1", "EMPRESA MODELO TESTE LTDA", "defendant", true);
  await party("q2", "JOAO  DA SILVA", "plaintiff");
  await party("q3", "Maria Souza", "plaintiff");
  await party("q3", "Empresa Cliente", "plaintiff", true);
  await party("q4", "Ministério Público do Trabalho", "public_prosecutor");
  await party("q4", "Empresa Cliente", "plaintiff", true);
  await party("q5", "maria souza", "plaintiff");
  await party("q6", "Pedro Sigiloso", "plaintiff");
  await party("q7", "Pedro Sigiloso", "plaintiff");

  await brief("q1", 1, "approved", [claim("Horas extras e reflexos", "extracted", 500_000), claim("Dano moral", "illustrative")]);
  await brief("q1", 2, "ready_for_review", [claim("Pagamento de horas extras", "extracted", 600_000), claim("Multa do art. 477 da CLT")]);
  await brief("q2", 1, "in_review", [
    claim("Horas extras além da 8ª diária"),
    claim("Indenização por doença ocupacional", "extracted", 1_000_000),
    claim("FGTS + 40%"),
  ]);
  await brief("q3", 1, "rejected", [claim("Horas extras")]);
  await brief("q6", 1, "ready_for_review", [claim("Horas extras habituais")]);
});

afterAll(async () => fx?.teardown());

describe("preventive indicators (calculado a partir da carteira)", () => {
  it("computes recurrence, concentration, phases and closure outcomes over visible processes", async () => {
    const r = await getPreventiveIntelligence(fx.ctx.admin);
    expect(r.totals).toEqual({ all: 7, active: 6, closed: 1 });
    const atord = r.classRecurrence.rows.find((x) => x.label === "ATOrd")!;
    expect(atord.count).toBe(5);
    expect(atord.share).toBeCloseTo(5 / 7);
    expect(r.classRecurrence.basis.processCount).toBe(7);

    const trt10 = r.concentration.byCourt.find((x) => x.label === "TRT10")!;
    expect(trt10.count).toBe(4); // q1, q2, q3, q6 (active)
    expect(trt10.liquidatedCents).toBe(4_500_000);
    expect(trt10.liquidatedUnknown).toBe(2); // RN-03: not added as zero
    expect(r.concentration.byCity.find((x) => x.label === "Palmas")!.count).toBe(4);
    expect(r.concentration.byDivision[0].count).toBe(2);

    expect(r.phaseDistribution.materializedCount).toBe(2); // q3 enforcement, q7 liquidation
    expect(r.phaseDistribution.materializedShare).toBeCloseTo(2 / 6);
    expect(r.phaseDistribution.materializedLiquidatedCents).toBe(2_300_000);

    expect(r.closureOutcomes.rows).toEqual([
      { reason: "lost_patronage", label: "Saída do acervo / perda do patrocínio", group: "lost_patronage", count: 1, share: 1 },
    ]);
    expect(r.filingTrend.rows.map((y) => [y.year, y.count])).toEqual([
      [2023, 1],
      [2024, 1],
      [2025, 5],
    ]);
    const ratio = r.liquidatedRatio.rows.find((x) => x.court === "TRT10")!;
    expect(ratio.processCount).toBe(2);
    expect(ratio.ratio).toBeCloseTo(4_500_000 / 3_000_000);
    expect(r.verification.count).toBe(1);
  });

  it("finds repeat plaintiffs (client excluded), collective actions and risk factors", async () => {
    const r = await getPreventiveIntelligence(fx.ctx.admin);
    // João (q1, q2), Maria (q3, q5), Pedro (q6, q7). "Empresa Cliente" is the client and is ignored.
    expect(r.repeatPlaintiffs.plaintiffCount).toBe(3);
    expect(r.repeatPlaintiffs.processCount).toBe(6);
    const joao = r.repeatPlaintiffs.names.find((n) => n.name === "João da Silva")!;
    expect(joao.processCount).toBe(2);
    expect(joao.href).toBe(`/processos?q=${encodeURIComponent("João da Silva")}&carteira=todas`);
    expect(r.repeatPlaintiffs.names.some((n) => n.name === "Empresa Cliente")).toBe(false);

    expect(r.collectiveActions.count).toBe(1);
    expect(r.collectiveActions.processes[0].reason).toBe("Classe ACPCiv · Ministério Público como parte");

    const keys = r.riskFactors.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["court-concentration", "materialized", "repeat-plaintiffs", "collective", "verification", "class-dominance"]));
    for (const f of r.riskFactors) expect(f.explanation.length).toBeGreaterThan(10);
  });

  it("applies row visibility to every indicator and isolates organizations", async () => {
    const exec = await getPreventiveIntelligence(fx.ctx.executive);
    expect(exec.totals.all).toBe(6); // q6 is confidential
    expect(exec.scope.includesConfidential).toBe(false);
    // Pedro only appears in q7 for the executive: no longer repeated, and his name is never listed.
    expect(exec.repeatPlaintiffs.plaintiffCount).toBe(2);
    expect(exec.repeatPlaintiffs.names.some((n) => n.name === "Pedro Sigiloso")).toBe(false);

    const lawyerRe = await getPreventiveIntelligence(fx.ctx.lawyerRe);
    expect(lawyerRe.totals.all).toBe(1); // q7 only
    expect(lawyerRe.scope.orgWide).toBe(false);
    expect(lawyerRe.repeatPlaintiffs.names).toHaveLength(0);

    const b = await getPreventiveIntelligence(fx.ctx.adminB);
    expect(b.totals.all).toBe(1);
    expect(b.recurringClaims.briefsConsidered).toBe(0);
    await expect(getPreventiveIntelligence(fx.ctx.adminB, { companyId: fx.companyA })).rejects.toBeInstanceOf(ValidationError);
  });

  it("filters by company and tribunal", async () => {
    const byCompany = await getPreventiveIntelligence(fx.ctx.admin, { companyId: fx.companyA });
    expect(byCompany.totals.all).toBe(2);
    const byCourt = await getPreventiveIntelligence(fx.ctx.admin, { court: "TRT2" });
    expect(byCourt.totals.all).toBe(2);
    expect(byCourt.filterSummary).toBe("Tribunal: TRT2");
    const opts = await listPreventiveIntelFilterOptions(fx.ctx.admin);
    expect(opts.courts).toEqual(["TRT10", "TRT2"]);
  });

  it("requires preventive_intel:read", async () => {
    await expect(getPreventiveIntelligence(fx.ctx.accountant)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getPreventiveIntelligence(fx.ctx.auditor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getPreventiveIntelligence(fx.ctx.externalCounsel)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("recurring claims from preliminary analyses (fictitious demo documents)", () => {
  it("uses the latest brief per process, extracted claims only, and excludes sensitive data", async () => {
    const r = await getPreventiveIntelligence(fx.ctx.admin);
    const c = r.recurringClaims;
    expect(c.briefsConsidered).toBe(3); // q1 (v2), q2, q6 — q3 was rejected
    const he = c.rows.find((x) => x.key === "horas_extras")!;
    expect(he.processCount).toBe(3);
    expect(he.withAmount).toBe(1);
    expect(he.amountCents).toBe(600_000);
    expect(c.rows.find((x) => x.key === "verbas_rescisorias")!.processCount).toBe(1);
    expect(c.rows.find((x) => x.key === "fgts")!.processCount).toBe(1);
    expect(c.excludedSensitive).toBe(1);
    expect(JSON.stringify(c)).not.toMatch(/doen[cç]a/i);
    expect(c.rows.some((x) => x.key === "dano_moral")).toBe(false); // only illustrative in an older version

    const exec = await getPreventiveIntelligence(fx.ctx.executive);
    expect(exec.recurringClaims.briefsConsidered).toBe(2);
  });
});

describe("illustrative suggestions", () => {
  it("are triggered by computed indicators", async () => {
    const r = await getPreventiveIntelligence(fx.ctx.admin);
    const keys = r.suggestions.map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "jornada",
        "conciliacao:trt10",
        "passivo-materializado",
        "reclamantes-recorrentes",
        "acoes-coletivas",
        "saneamento-cadastral",
      ]),
    );
    expect(keys).not.toContain("rescisao"); // only one process with rescission/FGTS claims
    const jornada = r.suggestions.find((s) => s.key === "jornada")!;
    expect(jornada.trigger).toContain("3 processos");
    expect(jornada.existingOccurrence).toBeNull();
    // Without the confidential q6 the executive has only 2 knowledge-phase processes in TRT10.
    const exec = await getPreventiveIntelligence(fx.ctx.executive);
    expect(exec.suggestions.map((s) => s.key)).not.toContain("conciliacao:trt10");
  });

  it("creates a preventive occurrence linked back to the indicator, only on explicit request", async () => {
    const before = await fx.db.select().from(occurrences).where(eq(occurrences.organizationId, fx.orgA));
    expect(before).toHaveLength(0); // nothing is created automatically

    const { occurrenceId } = await createOccurrenceFromSuggestion(fx.ctx.admin, "jornada");
    const occ = await getOccurrence(fx.ctx.admin, occurrenceId);
    expect(occ.category).toBe("labor");
    expect(occ.title).toBe("Inteligência preventiva: Revisão dos controles de jornada");
    expect(occ.facts).toContain("[ref: pi:jornada]");
    expect(occ.facts).toContain("Indicador: Pedidos de horas extras ou de intervalos aparecem em 3 processos");
    expect(occ.preventiveOrigin).toEqual({ key: "jornada", indicator: expect.stringContaining("horas extras") });

    const list = await listOccurrences(fx.ctx.admin, { origin: "preventive_intel" });
    expect(list.items.map((o) => o.id)).toEqual([occurrenceId]);
    expect((await getOccurrenceStats(fx.ctx.admin)).fromPreventiveIntel).toBe(1);

    const r = await getPreventiveIntelligence(fx.ctx.admin);
    expect(r.suggestions.find((s) => s.key === "jornada")!.existingOccurrence?.id).toBe(occurrenceId);
    await expect(createOccurrenceFromSuggestion(fx.ctx.admin, "jornada")).rejects.toBeInstanceOf(ConflictError);
  });

  it("creates the action plan as action_plan tasks without duplicates", async () => {
    const first = await createActionPlanFromSuggestion(fx.ctx.admin, "jornada");
    expect(first.createdOccurrence).toBe(false);
    expect(first.created).toBe(3);
    const planTasks = await fx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.occurrenceId, first.occurrenceId), eq(tasks.kind, "action_plan")));
    expect(planTasks).toHaveLength(3);
    expect(planTasks.every((t) => t.organizationId === fx.orgA && t.origin === "manual")).toBe(true);
    expect((await getOccurrence(fx.ctx.admin, first.occurrenceId)).status).toBe("action_plan");

    const again = await createActionPlanFromSuggestion(fx.ctx.admin, "jornada");
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(3);
  });

  it("creates occurrence + plan in one step for an analyst", async () => {
    const r = await createActionPlanFromSuggestion(fx.ctx.analyst, "reclamantes-recorrentes");
    expect(r.createdOccurrence).toBe(true);
    expect(r.created).toBe(3);
    const occ = await getOccurrence(fx.ctx.analyst, r.occurrenceId);
    expect(occ.preventiveOrigin?.key).toBe("reclamantes-recorrentes");
  });

  it("checks permissions, keys and active indicators", async () => {
    await expect(createOccurrenceFromSuggestion(fx.ctx.executive, "acoes-coletivas")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createActionPlanFromSuggestion(fx.ctx.executive, "acoes-coletivas")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createOccurrenceFromSuggestion(fx.ctx.admin, "../x")).rejects.toBeInstanceOf(ValidationError);
    await expect(createOccurrenceFromSuggestion(fx.ctx.admin, "rescisao")).rejects.toBeInstanceOf(ConflictError);
    // Organization B has no such indicator.
    await expect(createOccurrenceFromSuggestion(fx.ctx.adminB, "acoes-coletivas")).rejects.toBeInstanceOf(ConflictError);
    const bOcc = await fx.db.select().from(occurrences).where(eq(occurrences.organizationId, fx.orgB));
    expect(bOcc).toHaveLength(0);
  });
});
