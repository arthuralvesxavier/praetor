import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { StoredCaseBrief } from "@/domain/case-brief";
import { authenticateApiKey, hashApiKey } from "@/modules/api-keys/service";
import { API_KEY_PATTERN } from "@/modules/api-keys/schemas";
import { createClaim, getProcessClaims, removeClaim, updateClaim } from "@/modules/claims/service";
import {
  apiKeys,
  caseBriefs,
  indexSeriesValues,
  legalProcesses,
  processClaimAssessments,
  processClaimRiskLinks,
  processClaims,
  processRiskAssessments,
  processScenarios,
  scheduledRoutines,
} from "@/server/db/schema";
import { setSgsClientForTesting, SgsError, type SgsClient, type SgsMonthlyPoint } from "@/server/integrations/bcb";
import {
  CLAIM_FICTITIOUS_SUFFIX,
  CLAIM_TEMPLATES,
  DEMO_API_KEY,
  SCENARIO_COMMENT,
  claimDescription,
} from "../../scripts/seed-data/v2/aurora-v2";
import {
  assessmentDates,
  claimAmountCents,
  demoApiKeyPending,
  ensureDemoApiKey,
  indexSeriesRefreshPending,
  pickClaimTargets,
  planDemoClaims,
  planDemoScenarios,
  refreshIndexSeriesOnce,
  resumableTemplate,
  seedDemoClaims,
  seedDemoScenarios,
  suggestClaimsFromLatestBriefs,
  templateOf,
  type ClaimCandidate,
} from "../../scripts/seed-data/v2/extras";
import { makeProcess, setupFixture, today, type Fixture } from "../helpers/fixtures";

/**
 * Demo steps added to the v2 seed (scripts/seed-v2.ts, scripts/seed-data/v2/extras.ts):
 * each one must only ADD what is missing and do nothing the second time.
 */

let fx: Fixture;
const processIds: string[] = [];

async function candidates(): Promise<ClaimCandidate[]> {
  return fx.db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      status: legalProcesses.status,
      phase: legalProcesses.phase,
      instance: legalProcesses.instance,
      claim: legalProcesses.claimAmountCents,
      responsibleId: legalProcesses.responsibleId,
    })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.organizationId, fx.orgA), inArray(legalProcesses.id, processIds), isNull(legalProcesses.deletedAt)))
    .orderBy(asc(legalProcesses.number));
}

async function rowCounts() {
  const n = async (t: typeof processClaims | typeof processClaimAssessments | typeof processRiskAssessments | typeof processScenarios | typeof apiKeys) =>
    (await fx.db.select({ n: count() }).from(t))[0].n;
  return {
    claims: await n(processClaims),
    assessments: await n(processClaimAssessments),
    risks: await n(processRiskAssessments),
    scenarios: await n(processScenarios),
    apiKeys: await n(apiKeys),
  };
}

const lawyerFor = () => fx.ctx.lawyer;

beforeAll(async () => {
  fx = await setupFixture("seedx");
  for (let i = 0; i < 8; i++) {
    processIds.push(
      await makeProcess(fx.ctx.manager, {
        unitId: fx.unitSp,
        area: "labor",
        responsibleId: fx.ctx.lawyer.userId,
        claimAmountCents: 100_000_00 + i * 10_000_00,
        instance: i < 6 ? "first" : "second",
        filedAt: "2026-03-02",
      }),
    );
  }
});

afterEach(() => setSgsClientForTesting(undefined));

afterAll(async () => {
  setSgsClientForTesting(undefined);
  await fx.teardown();
});

describe("claims step: selection and values (pure)", () => {
  const mk = (i: number, extra: Partial<ClaimCandidate> = {}): ClaimCandidate => ({
    id: `p${i}`,
    number: String(i).padStart(7, "0"),
    status: "active",
    phase: "knowledge",
    instance: "first",
    claim: 1_000_00,
    responsibleId: null,
    ...extra,
  });

  it("picks about 4 in 5 at the 1st grau, skips processes with claims and never picks inactive, other phases or no valor da causa", () => {
    const list = [
      ...Array.from({ length: 10 }, (_, i) => mk(i)),
      ...Array.from({ length: 5 }, (_, i) => mk(20 + i, { instance: "second" })),
      mk(30, { status: "closed" }),
      mk(31, { phase: "enforcement" }),
      mk(32, { claim: null }),
    ];
    const { resume, fresh } = pickClaimTargets(list, { seeded: new Set(), withClaims: new Set(["p0", "p1"]), target: 5 });
    expect(resume).toEqual([]);
    expect(fresh).toHaveLength(5);
    expect(fresh.filter((c) => c.instance === "second")).toHaveLength(1);
    for (const c of fresh) expect(["p0", "p1", "p30", "p31", "p32"]).not.toContain(c.id);
    expect(new Set(fresh.map((c) => c.id)).size).toBe(5);
  });

  it("counts the processes already seeded toward the target and resumes them", () => {
    const list = Array.from({ length: 6 }, (_, i) => mk(i));
    const r = pickClaimTargets(list, { seeded: new Set(["p2", "p3"]), withClaims: new Set(["p2", "p3"]), target: 2 });
    expect(r.resume.map((c) => c.id)).toEqual(["p2", "p3"]);
    expect(r.fresh).toEqual([]);
  });

  it("splits the valor da causa in whole reais and keeps an unquantified claim null (never zero)", () => {
    expect(claimAmountCents(203_562_85, 0.3)).toBe(61_069_00);
    expect(claimAmountCents(100_000_00, null)).toBeNull();
    expect(claimAmountCents(null, 0.5)).toBeNull();
  });

  it("dates the assessments inside the current month, in order, never after today", () => {
    const dates = assessmentDates(4, "2026-10-12");
    expect(dates).toEqual(["2026-10-04", "2026-10-06", "2026-10-08", "2026-10-10"]);
    expect(assessmentDates(3, "2026-10-02")).toEqual(["2026-10-01", "2026-10-01", "2026-10-01"]);
  });

  it("identifies the template of a resumed process by its first claim, even when descriptions repeat across templates", () => {
    const firsts = CLAIM_TEMPLATES.map((t) => claimDescription(t.items[0]));
    expect(new Set(firsts).size).toBe(CLAIM_TEMPLATES.length);
    for (const t of CLAIM_TEMPLATES) {
      const rows = t.items.map((i) => ({ description: claimDescription(i) }));
      expect(templateOf(rows)?.key).toBe(t.key);
      expect(templateOf(rows.slice(0, 1))?.key).toBe(t.key);
    }
    // A claim shared by several templates alone does not identify one; a claim of another template = edited by a person.
    expect(templateOf([{ description: claimDescription({ description: "Horas extras e reflexos" }) }])).toBeNull();
    const rescisao = CLAIM_TEMPLATES[0];
    expect(templateOf([{ description: claimDescription(rescisao.items[0]) }, { description: "Pedido de outra pessoa" }])).toBeNull();
  });
});

describe("claims step (database)", () => {
  it("creates claims, assesses them as the responsible lawyer and records the risk derived from them", async () => {
    const r = await seedDemoClaims({ organizationId: fx.orgA, candidates: await candidates(), actorFor: lawyerFor, baseDate: "2026-07-29", today: today(), target: 3 });
    expect(r.processes).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.assessments).toBe(r.claimsCreated);
    expect(r.derivedRecorded).toBeGreaterThanOrEqual(3);

    const rows = await fx.db.select().from(processClaims).where(eq(processClaims.organizationId, fx.orgA));
    expect(new Set(rows.map((c) => c.processId)).size).toBe(3);
    for (const c of rows) {
      expect(c.description.endsWith(CLAIM_FICTITIOUS_SUFFIX)).toBe(true);
      expect(c).toMatchObject({ origin: "manual", status: "confirmed", createdById: fx.ctx.lawyer.userId, correctionIndex: null });
      if (c.claimedAmountCents === null) expect(c.amountBaseDate).toBeNull();
      else expect(c.amountBaseDate).toBe("2026-07-29");
    }
    const links = await fx.db.select().from(processClaimRiskLinks).where(eq(processClaimRiskLinks.organizationId, fx.orgA));
    expect(links.every((l) => l.kind === "derived")).toBe(true);

    // The claims panel shows the derived classification in force.
    const overview = await getProcessClaims(fx.ctx.lawyer, rows[0].processId);
    expect(overview.risk?.inForce?.link).toBe("derived");
    expect(overview.risk?.inForce?.classification).toBe(overview.risk?.derivation.classification);
  });

  it("does nothing the second time (no new claim, assessment or classification)", async () => {
    const before = await rowCounts();
    expect(await planDemoClaims(fx.orgA, await candidates(), 3)).toEqual([]);
    const r = await seedDemoClaims({ organizationId: fx.orgA, candidates: await candidates(), actorFor: lawyerFor, baseDate: "2026-07-29", today: today(), target: 3 });
    expect(r).toMatchObject({ processes: 0, claimsCreated: 0, assessments: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it("completes a process left halfway by an interrupted run and never touches claims written by a person", async () => {
    const seeded = new Set((await fx.db.select({ p: processClaims.processId }).from(processClaims)).map((r) => r.p));
    const free = (await candidates()).filter((c) => !seeded.has(c.id));
    const [partial, personal] = free;
    const template = CLAIM_TEMPLATES[1];
    // Interrupted run: only the first claim of the template, not assessed yet.
    await createClaim(fx.ctx.lawyer, partial.id, { description: claimDescription(template.items[0]), category: template.items[0].category, claimedAmountCents: null });
    // A person's own claim on another process.
    await createClaim(fx.ctx.lawyer, personal.id, { description: "Pedido registrado pela advogada", category: "other", claimedAmountCents: null });

    const r = await seedDemoClaims({ organizationId: fx.orgA, candidates: await candidates(), actorFor: lawyerFor, baseDate: "2026-07-29", today: today(), target: 4 });
    expect(r.processes).toBe(1);
    expect(r.claimsCreated).toBe(template.items.length - 1);
    expect(r.assessments).toBe(template.items.length);
    const own = await fx.db.select().from(processClaims).where(eq(processClaims.processId, partial.id));
    expect(own.map((c) => c.description).sort()).toEqual(template.items.map(claimDescription).sort());
    const untouched = await fx.db.select().from(processClaims).where(eq(processClaims.processId, personal.id));
    expect(untouched).toHaveLength(1);
    expect(await planDemoClaims(fx.orgA, await candidates(), 4)).toEqual([]);
  });
});

describe("scenarios step", () => {
  it("proposes scenarios (origin system) for processes with seed claims, once", async () => {
    const r = await seedDemoScenarios({ organizationId: fx.orgA, isDemo: false, target: 2 });
    expect(r.processes).toBe(2);
    expect(r.scenarios).toBe(4);
    const rows = await fx.db.select().from(processScenarios).where(eq(processScenarios.organizationId, fx.orgA));
    expect(rows.every((s) => s.origin === "system" && s.authorId === null && s.comment === SCENARIO_COMMENT)).toBe(true);
    for (const s of rows) {
      expect(s.description).toContain("(cenário de demonstração)");
      expect(s.percentMin).toBeLessThanOrEqual(s.percentMax);
    }
    expect(await planDemoScenarios(fx.orgA, 2)).toEqual([]);
    expect(await seedDemoScenarios({ organizationId: fx.orgA, isDemo: false, target: 2 })).toEqual({ processes: 0, scenarios: 0 });
    expect((await fx.db.select().from(processScenarios)).length).toBe(4);
  });
});

describe("a person's changes to the seed's claims are never undone by a later run", () => {
  const seedRows = async () =>
    (await fx.db.select().from(processClaims).where(eq(processClaims.organizationId, fx.orgA))).filter((c) =>
      c.description.endsWith(CLAIM_FICTITIOUS_SUFFIX),
    );
  const byProcess = async () => {
    const map = new Map<string, (typeof processClaims.$inferSelect)[]>();
    for (const c of await seedRows()) map.set(c.processId, [...(map.get(c.processId) ?? []), c]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  const rerun = async () =>
    seedDemoClaims({ organizationId: fx.orgA, candidates: await candidates(), actorFor: lawyerFor, baseDate: "2026-07-29", today: today(), target: 4 });

  it("a removed seed claim is not written again (one claim, then every claim of a process)", async () => {
    // `second` has the seed's scenario proposals (scenarios step above), `first` is another seeded process.
    const withScenarios = new Set(
      (await fx.db.select({ p: processScenarios.processId }).from(processScenarios).where(eq(processScenarios.organizationId, fx.orgA))).map((r) => r.p),
    );
    const groups = await byProcess();
    const second = groups.find(([id]) => withScenarios.has(id))?.[1];
    const first = groups.find(([id]) => !withScenarios.has(id))?.[1];
    if (!first || !second) throw new Error("expected seeded processes with and without scenarios");
    await removeClaim(fx.ctx.lawyer, first[first.length - 1].id, { reason: "Pedido não consta da inicial (teste)." });
    const before = await rowCounts();
    expect(await planDemoClaims(fx.orgA, await candidates(), 4)).toEqual([]);
    expect(await rerun()).toMatchObject({ processes: 0, claimsCreated: 0, assessments: 0 });
    expect(await rowCounts()).toEqual(before);

    // Every seed claim of another process removed: it still counts toward the target, no new process is picked.
    for (const c of second) await removeClaim(fx.ctx.lawyer, c.id, { reason: "Pedidos lançados no processo errado (teste)." });
    const after = await rowCounts();
    expect(await planDemoClaims(fx.orgA, await candidates(), 4)).toEqual([]);
    expect(await rerun()).toMatchObject({ processes: 0, claimsCreated: 0, assessments: 0 });
    expect(await rowCounts()).toEqual(after);
    // The seed's scenario proposals still count: none is proposed again.
    expect(await planDemoScenarios(fx.orgA, 2)).toEqual([]);
  });

  it("a seed claim edited by a person (description without the fictitious suffix) is not written again", async () => {
    const live = (await byProcess()).find(([, rows]) => rows.every((r) => r.deletedAt === null));
    if (!live) throw new Error("expected a process with live seed claims");
    for (const c of live[1]) {
      await updateClaim(fx.ctx.lawyer, c.id, {
        description: c.description.replace(` ${CLAIM_FICTITIOUS_SUFFIX}`, " (revisado pela advogada)"),
        category: c.category,
        claimedAmountCents: c.claimedAmountCents,
        amountBaseDate: c.amountBaseDate,
        correctionIndex: c.correctionIndex,
        instance: c.instance,
      });
    }
    const before = await rowCounts();
    expect(await planDemoClaims(fx.orgA, await candidates(), 4)).toEqual([]);
    expect(await rerun()).toMatchObject({ processes: 0, claimsCreated: 0, assessments: 0 });
    expect(await rowCounts()).toEqual(before);
  });

  it("only a process whose claims are all live seed claims of one template is resumed", () => {
    const t = CLAIM_TEMPLATES[0];
    const row = (i: number, extra: { removed?: boolean } = {}) => ({
      id: `c${i}`,
      processId: "p",
      description: claimDescription(t.items[i]),
      status: "confirmed",
      assessed: false,
      removed: false,
      ...extra,
    });
    expect(resumableTemplate([row(0)], 1)?.key).toBe(t.key);
    expect(resumableTemplate([row(0), row(1, { removed: true })], 2)).toBeNull();
    expect(resumableTemplate([row(0)], 2)).toBeNull(); // another claim on the process: a person's or an analysis' work
    expect(resumableTemplate([], 0)).toBeNull();
  });
});

describe("claim suggestions from the preliminary analyses", () => {
  it("brings the claims of the latest applicable brief as pending suggestions, once", async () => {
    const processId = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId });
    const citation = { ref: "D1", page: 2, excerpt: "trecho" };
    const content = {
      headline: "Resumo fictício de teste.",
      identification: [],
      factsSummary: [],
      timeline: [],
      claims: [
        { description: "Horas extras e reflexos", amountCents: 2_000_000, provenance: "extracted", citations: [citation], note: null },
        { description: "Exemplo ilustrativo", amountCents: 10, provenance: "illustrative", citations: [], note: null },
      ],
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
    } as unknown as StoredCaseBrief;
    await fx.db.insert(caseBriefs).values({
      organizationId: fx.orgA,
      processId,
      version: 1,
      status: "ready_for_review",
      mode: "demo",
      provider: "simulated",
      model: "simulacao",
      promptVersion: "test",
      inputHash: "test",
      content,
    });
    const first = await suggestClaimsFromLatestBriefs(fx.orgA, fx.ctx.manager);
    expect(first).toEqual({ briefs: 1, created: 1 });
    const second = await suggestClaimsFromLatestBriefs(fx.orgA, fx.ctx.manager);
    expect(second).toEqual({ briefs: 1, created: 0 });
    const rows = await fx.db.select().from(processClaims).where(eq(processClaims.processId, processId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "ai_suggested", status: "pending_confirmation" });
  });
});

describe("demo API key", () => {
  it("is created once by the administrator, works for the inbound API and only its hash is stored", async () => {
    expect(await demoApiKeyPending(fx.orgA)).toBe(true);
    const r = await ensureDemoApiKey(fx.ctx.admin);
    if (!r.created) throw new Error("expected a new key");
    expect(r.key).toMatch(API_KEY_PATTERN);
    const [row] = await fx.db.select().from(apiKeys).where(eq(apiKeys.organizationId, fx.orgA));
    expect(row).toMatchObject({ name: DEMO_API_KEY.name, keyHash: hashApiKey(r.key), createdById: fx.ctx.admin.userId, revokedAt: null });
    expect(JSON.stringify(row)).not.toContain(r.key);
    expect(row.scopes.sort()).toEqual([...DEMO_API_KEY.scopes].sort());
    const identity = await authenticateApiKey(r.key);
    expect(identity?.organizationId).toBe(fx.orgA);

    expect(await demoApiKeyPending(fx.orgA)).toBe(false);
    const again = await ensureDemoApiKey(fx.ctx.admin);
    expect(again).toEqual({ created: false, keyPrefix: row.keyPrefix });
    expect((await fx.db.select().from(apiKeys)).length).toBe(1);
  });
});

describe("index series collection, once", () => {
  class OfflineSgs implements SgsClient {
    readonly name = "offline";
    calls = 0;
    async fetchMonthly(): Promise<SgsMonthlyPoint[]> {
      this.calls += 1;
      throw new SgsError("network", "Sem conexão com o Banco Central.", true);
    }
  }

  it("runs the routine once; a network failure is recorded and no rate is invented", async () => {
    const offline = new OfflineSgs();
    setSgsClientForTesting(offline);
    expect(await indexSeriesRefreshPending(fx.orgA)).toBe(true);
    const r = await refreshIndexSeriesOnce(fx.orgA);
    expect(r.status).toBe("ran");
    expect(offline.calls).toBeGreaterThan(0);
    expect((await fx.db.select().from(indexSeriesValues)).length).toBe(0);
    const [routine] = await fx.db
      .select()
      .from(scheduledRoutines)
      .where(and(eq(scheduledRoutines.organizationId, fx.orgA), eq(scheduledRoutines.type, "index_series_refresh")));
    expect(routine.lastRunAt).not.toBeNull();
    expect(routine.nextRunAt.getTime()).toBeGreaterThan(Date.now());

    expect(await indexSeriesRefreshPending(fx.orgA)).toBe(false);
    const callsBefore = offline.calls;
    expect((await refreshIndexSeriesOnce(fx.orgA)).status).toBe("already_ran");
    expect(offline.calls).toBe(callsBefore);
  });
});
