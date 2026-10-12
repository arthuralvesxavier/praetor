import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq, isNull } from "drizzle-orm";
import { PREVENTIVE_MARKER_PREFIX } from "@/modules/occurrences/preventive-origin";
import { deleteOccurrence, updateOccurrence } from "@/modules/occurrences/service";
import { createOccurrenceFromSuggestion, getPreventiveIntelligence } from "@/modules/preventive-intel/service";
import { occurrences, tasks } from "@/server/db/schema";
import {
  demoClosePlan,
  preventiveOccurrencePending,
  preventiveOccurrenceRecorded,
  preventivePlanToResume,
  seedPreventiveOccurrence,
} from "../../scripts/seed-data/v2/one-time";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

/**
 * Steps of the v2 seed that happen once in the life of the demo organization
 * (scripts/seed-data/v2/one-time.ts): the preventive occurrence and the
 * monthly closes. A person's later actions (resolving or removing the
 * occurrence, revoking the demo API key and running the seed again in a later
 * month) must never make the seed create a second occurrence or close a month.
 */

describe("monthly closes of the demo (pure)", () => {
  const ACCOUNTANT = "acc";

  it("the first v2 seed closes the two months before the current one", () => {
    expect(demoClosePlan({ current: "2026-10", closed: [], accountantId: ACCOUNTANT })).toEqual(["2026-08", "2026-09"]);
    expect(demoClosePlan({ current: "2026-01", closed: [], accountantId: null })).toEqual(["2025-11", "2025-12"]);
  });

  it("a later run (e.g. after revoking the demo API key) never closes the month that just ended", () => {
    const closed = [
      { period: "2026-08", closedById: ACCOUNTANT },
      { period: "2026-09", closedById: ACCOUNTANT },
    ];
    expect(demoClosePlan({ current: "2026-10", closed, accountantId: ACCOUNTANT })).toEqual([]);
    expect(demoClosePlan({ current: "2026-11", closed, accountantId: ACCOUNTANT })).toEqual([]);
    expect(demoClosePlan({ current: "2027-03", closed, accountantId: ACCOUNTANT })).toEqual([]);
    // Accounting closed October itself: still nothing for the seed.
    expect(demoClosePlan({ current: "2026-12", closed: [...closed, { period: "2026-10", closedById: "someone" }], accountantId: ACCOUNTANT })).toEqual([]);
  });

  it("only finishes the pair of a first run that stopped between the two closes", () => {
    const half = [{ period: "2026-08", closedById: ACCOUNTANT }];
    expect(demoClosePlan({ current: "2026-10", closed: half, accountantId: ACCOUNTANT })).toEqual(["2026-09"]);
    expect(demoClosePlan({ current: "2026-11", closed: half, accountantId: ACCOUNTANT })).toEqual(["2026-09"]);
    // Never the current month, nor a pair started by somebody else.
    expect(demoClosePlan({ current: "2026-09", closed: half, accountantId: ACCOUNTANT })).toEqual([]);
    expect(demoClosePlan({ current: "2026-10", closed: [{ period: "2026-08", closedById: "someone" }], accountantId: ACCOUNTANT })).toEqual([]);
    expect(demoClosePlan({ current: "2026-10", closed: half, accountantId: null })).toEqual([]);
  });
});

describe("preventive occurrence of the demo", () => {
  let fx: Fixture;

  const counts = async () => ({
    occurrences: (await fx.db.select({ n: count() }).from(occurrences).where(eq(occurrences.organizationId, fx.orgA)))[0].n,
    tasks: (await fx.db.select({ n: count() }).from(tasks).where(eq(tasks.organizationId, fx.orgA)))[0].n,
  });

  beforeAll(async () => {
    fx = await setupFixture("seedp");
    // Active labor processes in the knowledge phase in the same court: the conciliation suggestion shows up.
    for (let i = 0; i < 4; i++) {
      await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, area: "labor", responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 50_000_00 });
    }
  });

  afterAll(async () => {
    await fx.teardown();
  });

  it("creates one occurrence with its action plan from an active suggestion", async () => {
    expect(await preventiveOccurrenceRecorded(fx.orgA)).toBe(false);
    expect(await preventiveOccurrencePending(fx.ctx.manager)).toBe(true);
    const r = await seedPreventiveOccurrence(fx.ctx.manager);
    if (r.status !== "created") throw new Error(`expected an occurrence, got ${r.status}`);
    expect(r.tasks).toBeGreaterThan(0);
    const rows = await fx.db.select().from(occurrences).where(eq(occurrences.organizationId, fx.orgA));
    expect(rows).toHaveLength(1);
    expect(rows[0].facts).toContain(PREVENTIVE_MARKER_PREFIX);
    expect(await preventiveOccurrencePending(fx.ctx.manager)).toBe(false);
  });

  it("does not create a second one after a person resolves the occurrence", async () => {
    const [occ] = await fx.db.select().from(occurrences).where(and(eq(occurrences.organizationId, fx.orgA), isNull(occurrences.deletedAt)));
    await updateOccurrence(fx.ctx.manager, occ.id, { status: "resolved" });
    const before = await counts();
    expect(await preventiveOccurrencePending(fx.ctx.manager)).toBe(false);
    expect(await seedPreventiveOccurrence(fx.ctx.manager)).toEqual({ status: "already_recorded" });
    expect(await counts()).toEqual(before);
  });

  it("does not create a second one after a person removes the occurrence", async () => {
    const [occ] = await fx.db.select().from(occurrences).where(and(eq(occurrences.organizationId, fx.orgA), isNull(occurrences.deletedAt)));
    await deleteOccurrence(fx.ctx.admin, occ.id);
    expect((await fx.db.select().from(occurrences).where(eq(occurrences.id, occ.id)))[0].deletedAt).not.toBeNull();
    const before = await counts();
    expect(await preventiveOccurrenceRecorded(fx.orgA)).toBe(true);
    expect(await seedPreventiveOccurrence(fx.ctx.manager)).toEqual({ status: "already_recorded" });
    expect(await counts()).toEqual(before);
  });
});

describe("preventive occurrence of the demo: a run that stopped before the action plan", () => {
  let fx: Fixture;

  const counts = async () => ({
    occurrences: (await fx.db.select({ n: count() }).from(occurrences).where(eq(occurrences.organizationId, fx.orgA)))[0].n,
    tasks: (await fx.db.select({ n: count() }).from(tasks).where(eq(tasks.organizationId, fx.orgA)))[0].n,
  });

  /** What the seed's first action did before the run stopped: only the occurrence, no plan. */
  async function interruptedRun(): Promise<string> {
    const [s] = (await getPreventiveIntelligence(fx.ctx.manager)).suggestions;
    if (!s) throw new Error("expected an active suggestion");
    return (await createOccurrenceFromSuggestion(fx.ctx.manager, s.key)).occurrenceId;
  }

  beforeEach(async () => {
    fx = await setupFixture("seedq");
    for (let i = 0; i < 4; i++) {
      await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, area: "labor", responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 50_000_00 });
    }
  });

  afterEach(async () => {
    await fx.teardown();
  });

  it("adds the missing action plan to the untouched occurrence once, and nothing afterwards", async () => {
    const occurrenceId = await interruptedRun();
    expect(await preventivePlanToResume(fx.orgA)).toMatchObject({ occurrenceId });
    expect(await preventiveOccurrencePending(fx.ctx.manager)).toBe(true);

    const r = await seedPreventiveOccurrence(fx.ctx.manager);
    if (r.status !== "plan_resumed") throw new Error(`expected the plan to be resumed, got ${r.status}`);
    expect(r.tasks).toBeGreaterThan(0);
    const [occ] = await fx.db.select().from(occurrences).where(eq(occurrences.id, occurrenceId));
    expect(occ.status).toBe("action_plan");
    const plan = await fx.db.select().from(tasks).where(and(eq(tasks.occurrenceId, occurrenceId), eq(tasks.kind, "action_plan")));
    expect(plan).toHaveLength(r.tasks);
    expect((await counts()).occurrences).toBe(1);

    const before = await counts();
    expect(await preventivePlanToResume(fx.orgA)).toBeNull();
    expect(await preventiveOccurrencePending(fx.ctx.manager)).toBe(false);
    expect(await seedPreventiveOccurrence(fx.ctx.manager)).toEqual({ status: "already_recorded" });
    expect(await counts()).toEqual(before);
  });

  it("leaves the occurrence alone when a person edited it, even if it is still open", async () => {
    const occurrenceId = await interruptedRun();
    await updateOccurrence(fx.ctx.manager, occurrenceId, { title: "Conciliação: revisão do gestor (dados fictícios)" });
    const before = await counts();
    expect(await preventivePlanToResume(fx.orgA)).toBeNull();
    expect(await preventiveOccurrencePending(fx.ctx.manager)).toBe(false);
    expect(await seedPreventiveOccurrence(fx.ctx.manager)).toEqual({ status: "already_recorded" });
    expect(await counts()).toEqual(before);
  });

  it("leaves the occurrence alone when a person changed its status or removed it", async () => {
    const occurrenceId = await interruptedRun();
    await updateOccurrence(fx.ctx.manager, occurrenceId, { status: "under_analysis" });
    expect(await preventiveOccurrencePending(fx.ctx.manager)).toBe(false);
    await deleteOccurrence(fx.ctx.admin, occurrenceId);
    const before = await counts();
    expect(await seedPreventiveOccurrence(fx.ctx.manager)).toEqual({ status: "already_recorded" });
    expect(await counts()).toEqual(before);
  });
});
