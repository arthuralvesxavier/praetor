import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBuckets, mondayOf, parseBiFilters, periodRange, processesHref, type BiFilters } from "@/modules/dashboard/bi-filters";
import { getBiData } from "@/modules/dashboard/bi-service";
import { legalProcesses } from "@/server/db/schema";
import { daysFromToday, makeDeadline, makeOccurrence, makeProcess, setupFixture, today, type Fixture } from "../helpers/fixtures";

const ALL: BiFilters = { period: "12m", unitId: null, area: null, responsibleId: null, companyId: null };

describe("BI filters (pure)", () => {
  it("parses URL params and falls back to 12 months", () => {
    expect(parseBiFilters({})).toEqual(ALL);
    expect(parseBiFilters({ periodo: "nope", area: "x", unidade: "not-an-id" })).toEqual(ALL);
    expect(parseBiFilters({ periodo: "90d", area: "labor" })).toMatchObject({ period: "90d", area: "labor" });
  });

  it("computes ranges, previous ranges and buckets", () => {
    const r12 = periodRange("12m", "2026-10-11");
    expect(r12).toMatchObject({ start: "2025-11-01", end: "2026-10-11", granularity: "month" });
    expect(buildBuckets(r12)).toHaveLength(12);
    expect(buildBuckets(r12)[0]).toMatchObject({ key: "2025-11-01", end: "2025-11-30" });

    const r30 = periodRange("30d", "2026-10-11");
    expect(r30).toMatchObject({ start: "2026-09-12", granularity: "week" });
    expect(r30.previous).toEqual({ start: "2026-08-13", end: "2026-09-11" });
    const weeks = buildBuckets(r30);
    expect(weeks[0].key).toBe(mondayOf("2026-09-12"));
    expect(weeks.every((w) => new Date(`${w.key}T12:00:00Z`).getUTCDay() === 1)).toBe(true);

    expect(periodRange("ytd", "2026-10-11").start).toBe("2026-01-01");
    expect(periodRange("all", "2026-10-11", "2019-03-15").start).toBe("2023-11-01"); // capped to 36 months
    expect(periodRange("all", "2026-10-11", null).previous).toBeNull();
  });

  it("builds drill-down links that keep the dimension filters", () => {
    const f: BiFilters = { period: "90d", unitId: "11111111-1111-1111-1111-111111111111", area: "labor", responsibleId: null, companyId: null };
    expect(processesHref(f, { status: "active", risco: "high" })).toBe(
      "/processos?status=active&area=labor&risco=high&unidade=11111111-1111-1111-1111-111111111111",
    );
  });
});

describe("getBiData", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setupFixture("bi");
    const { manager, lawyer, lawyerRe } = fx.ctx;
    await makeProcess(manager, { area: "labor", unitId: fx.unitSp, riskLevel: "high", claimAmountCents: 100_000_00, filedAt: today() });
    await makeProcess(manager, { area: "civil", unitId: fx.unitSp, riskLevel: "low", claimAmountCents: 50_000_00, filedAt: daysFromToday(-40) });
    await makeProcess(manager, { area: "labor", unitId: fx.unitRe, riskLevel: "critical", claimAmountCents: 30_000_00 });
    await makeProcess(manager, {
      area: "tax",
      unitId: fx.unitSp,
      riskLevel: "critical",
      claimAmountCents: 999_000_00,
      isConfidential: true,
      responsibleId: lawyer.userId,
    });
    await makeOccurrence(manager, { unitId: fx.unitSp, riskLevel: "medium" });
    await makeDeadline(manager, { unitId: fx.unitSp, responsibleId: lawyer.userId, dueDate: daysFromToday(-3) });
    await makeDeadline(manager, { unitId: fx.unitRe, responsibleId: lawyerRe.userId, dueDate: daysFromToday(2) });
    // Organization B data must never appear in A's figures.
    await makeProcess(fx.ctx.adminB, { area: "labor", claimAmountCents: 7_777_00 });
  });

  afterAll(async () => fx.teardown());

  it("aggregates only what each role may see", async () => {
    const manager = await getBiData(fx.ctx.manager, ALL);
    expect(manager.kpis.activeProcesses).toBe(4);
    expect(manager.kpis.exposureClaimCents).toBe(1_179_000_00);

    const exec = await getBiData(fx.ctx.executive, ALL);
    expect(exec.kpis.activeProcesses).toBe(3); // confidential excluded
    expect(exec.riskProcesses.critical).toBe(1);
    expect(exec.topExposure.map((p) => p.claimCents)).not.toContain(999_000_00);

    const re = await getBiData(fx.ctx.lawyerRe, ALL);
    expect(re.kpis.activeProcesses).toBe(1);
    expect(re.kpis.overdueDeadlines).toBe(0);
    expect(re.kpis.upcomingDeadlines).toBe(1);

    const b = await getBiData(fx.ctx.adminB, ALL);
    expect(b.kpis.activeProcesses).toBe(1);
    expect(b.kpis.exposureClaimCents).toBe(7_777_00);
  });

  it("narrows by unit, area and responsible without widening scope", async () => {
    const byArea = await getBiData(fx.ctx.manager, { ...ALL, area: "labor" });
    expect(byArea.kpis.activeProcesses).toBe(2);
    expect(byArea.exposureByArea.map((r) => r.key)).toEqual(["labor"]);

    const byUnit = await getBiData(fx.ctx.manager, { ...ALL, unitId: fx.unitRe });
    expect(byUnit.kpis.activeProcesses).toBe(1);
    expect(byUnit.kpis.upcomingDeadlines).toBe(1);
    expect(byUnit.kpis.openOccurrences).toBe(0);

    // A filter pointing at another organization's unit yields nothing (never B's data).
    const foreign = await getBiData(fx.ctx.manager, { ...ALL, unitId: fx.unitB });
    expect(foreign.kpis.activeProcesses).toBe(0);
    const foreignFromB = await getBiData(fx.ctx.adminB, { ...ALL, unitId: fx.unitSp });
    expect(foreignFromB.kpis.activeProcesses).toBe(0);

    const byResponsible = await getBiData(fx.ctx.manager, { ...ALL, responsibleId: fx.ctx.lawyer.userId });
    expect(byResponsible.kpis.overdueDeadlines).toBe(1);
    expect(byResponsible.workload.map((w) => w.userId)).toEqual([fx.ctx.lawyer.userId]);
  });

  it("counts flows inside the period and aligns them with the buckets", async () => {
    const d = await getBiData(fx.ctx.manager, { ...ALL, period: "30d" });
    expect(d.range.granularity).toBe("week");
    expect(d.processFlow.entered).toHaveLength(d.buckets.length);
    expect(d.processFlow.entered.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(d.kpis.newProcesses);
    // filed 40 days ago is outside the last 30 days
    const all = await getBiData(fx.ctx.manager, { ...ALL, period: "all" });
    expect(all.kpis.newProcesses).toBe(4);
    expect(d.kpis.newProcesses).toBe(3);
  });

  it("narrows by company: processes and the deadlines linked to them, never occurrences", async () => {
    const before = await getBiData(fx.ctx.manager, ALL);
    const [labor] = await fx.db
      .select({ id: legalProcesses.id })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.organizationId, fx.orgA), eq(legalProcesses.unitId, fx.unitRe)));
    await fx.db.update(legalProcesses).set({ companyId: fx.companyA }).where(eq(legalProcesses.id, labor.id));

    const byCompany = await getBiData(fx.ctx.manager, { ...ALL, companyId: fx.companyA });
    expect(byCompany.kpis.activeProcesses).toBe(1);
    expect(byCompany.kpis.upcomingDeadlines).toBe(0); // deadlines are not linked to that process
    expect(byCompany.kpis.openOccurrences).toBe(before.kpis.openOccurrences);
    expect(processesHref(byCompany.filters, { tribunal: "TRT10" })).toBe(`/processos?empresa=${fx.companyA}&tribunal=TRT10`);
    expect(parseBiFilters({ empresa: fx.companyA }).companyId).toBe(fx.companyA);
    // Another organization's company id never widens the scope.
    const fromB = await getBiData(fx.ctx.adminB, { ...ALL, companyId: fx.companyA });
    expect(fromB.kpis.activeProcesses).toBe(0);
  });
});
