/**
 * P0.6 "painel": regressions of the dashboard fixes, against PGlite with the REAL
 * contingency, alerts, briefs and intake services (nothing mocked).
 *
 * - P1.8 net exposure of the portfolio: apurado − linked guarantees, never negative,
 *   deductions by guarantee kind add up to the deducted guarantees, estimate apart;
 * - deferred 11 (RN-10): the previous closing reads the stored items of the closed
 *   competência, including processes deleted after the close, with the scope rules;
 * - deferred 14: SQL aggregation (previous closing, scoped `visible` query) gives the
 *   same figures as the in-memory reference;
 * - deferred 9: alert counts only for the modules the role can read (same as the bell);
 * - deferred 10/15: briefs awaiting review exclude superseded versions and each figure
 *   equals the list it links to; intake figures equal `/entrada?status=`.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addToBucket, emptyBucket, type MoneyBucket } from "@/domain/contingency";
import { addDaysISO, todayISO } from "@/lib/format";
import { countOpenAlerts } from "@/modules/alerts/service";
import { listCaseBriefs } from "@/modules/briefs/service";
import { getPortfolioExposure } from "@/modules/contingency/service";
import type { BiFilters } from "@/modules/dashboard/bi-filters";
import { bucketFromSnapshotItems } from "@/modules/dashboard/portfolio";
import {
  closedCompetenceProcessWhere,
  getFollowUpPanel,
  getPortfolioPanel,
  type PortfolioData,
} from "@/modules/dashboard/portfolio-service";
import { listIntakes } from "@/modules/intake/service";
import { canViewScopedRecord } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import {
  alerts,
  caseBriefs,
  caseIntakes,
  deadlines,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processGuarantees,
} from "@/server/db/schema";
import { setupFixture, type Fixture } from "../../helpers/fixtures";

const ALL: BiFilters = { period: "12m", unitId: null, area: null, responsibleId: null, companyId: null };
const today = todayISO();
// Latest closed competência before the current month.
const PREVIOUS_PERIOD = (() => {
  const [y, m] = today.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
})();

let fx: Fixture;
const ids: Record<string, string> = {};
let snapshotId = "";

function contexts(): [string, AuthContext][] {
  return Object.entries(fx.ctx) as [string, AuthContext][];
}

async function panel(ctx: AuthContext, filters: Partial<BiFilters> = {}): Promise<PortfolioData> {
  const r = await getPortfolioPanel(ctx, { ...ALL, ...filters });
  if (r.status !== "ok") throw new Error(`unexpected status ${r.status}`);
  return r.data;
}

function filterSets(): Partial<BiFilters>[] {
  return [
    {},
    { unitId: fx.unitSp },
    { unitId: fx.unitRe },
    { companyId: fx.companyA },
    { area: "civil" },
    { responsibleId: fx.ctx.lawyer.userId },
  ];
}

beforeAll(async () => {
  fx = await setupFixture("p06painel");
  const proc = async (key: string, values: Partial<typeof legalProcesses.$inferInsert>) => {
    const [p] = await fx.db
      .insert(legalProcesses)
      .values({
        organizationId: fx.orgA,
        number: `${key}-0000000.2026.5.10.0001`,
        title: `Processo ${key} (fictício)`,
        court: "TRT10",
        area: "labor",
        phase: "knowledge",
        ...values,
      })
      .returning();
    ids[key] = p.id;
  };
  const lawyer = fx.ctx.lawyer.userId!;
  await proc("A1", {
    unitId: fx.unitSp,
    companyId: fx.companyA,
    responsibleId: lawyer,
    claimAmountCents: 5_000_000,
    liquidatedAmountCents: 1_000_000,
    riskPercentageBp: 10_000,
    lossProbability: "probable",
  });
  await proc("A2", { unitId: fx.unitRe, area: "civil", liquidatedAmountCents: 100_000, riskPercentageBp: 5_000, lossProbability: "possible" });
  await proc("A3", { unitId: fx.unitSp, claimAmountCents: 2_000_000, riskPercentageBp: 5_000, lossProbability: "possible" });
  await proc("A4", { unitId: fx.unitSp, isConfidential: true, liquidatedAmountCents: 9_000_000 });
  await proc("A5", { unitId: fx.unitSp, status: "closed", liquidatedAmountCents: 7_000 });
  await proc("D1", { unitId: fx.unitSp, companyId: fx.companyA, deletedAt: new Date(), liquidatedAmountCents: 40_000 });
  await proc("D2", { unitId: fx.unitSp, isConfidential: true, deletedAt: new Date(), liquidatedAmountCents: 60_000 });
  await proc("F1", { unitId: fx.unitRe, lawFirmId: fx.lawFirmA, liquidatedAmountCents: 500_000 });
  await proc("B1", { organizationId: fx.orgB, unitId: fx.unitB, liquidatedAmountCents: 1 });

  const guarantee = (processId: string, values: Partial<typeof processGuarantees.$inferInsert>) => ({
    organizationId: fx.orgA,
    processId,
    kind: "judicial_deposit" as const,
    amountCents: 100_000,
    ...values,
  });
  await fx.db.insert(processGuarantees).values([
    guarantee(ids.A1, { amountCents: 200_000, depositedAt: addDaysISO(today, -400) }),
    guarantee(ids.A1, { kind: "surety_insurance", amountCents: 300_000, depositedAt: addDaysISO(today, -10) }),
    guarantee(ids.A1, { kind: "appeal_deposit", amountCents: 50_000, status: "released_to_plaintiff" }),
    guarantee(ids.A2, { kind: "bank_guarantee", amountCents: 250_000, depositedAt: addDaysISO(today, -5) }), // above apurado
    guarantee(ids.A3, { kind: "seizure", amountCents: 100_000, depositedAt: addDaysISO(today, -5) }), // reduces the estimate only
    guarantee(ids.A4, { amountCents: 999_000, deletedAt: new Date() }),
  ]);

  // Closed competência with processes later deleted (D1, D2) and one of another organization.
  const params = { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 1, confidenceThreshold: 85 };
  const [snap] = await fx.db
    .insert(portfolioSnapshots)
    .values({
      organizationId: fx.orgA,
      period: PREVIOUS_PERIOD,
      referenceDate: `${PREVIOUS_PERIOD}-28`,
      status: "closed",
      metrics: {} as never,
      params,
      closedAt: new Date(),
    })
    .returning();
  snapshotId = snap.id;
  const item = (key: string, v: Partial<typeof portfolioSnapshotItems.$inferInsert>) => ({
    snapshotId: snap.id,
    organizationId: fx.orgA,
    processId: ids[key],
    number: `${key}-0000000.2026.5.10.0001`,
    ...v,
  });
  await fx.db.insert(portfolioSnapshotItems).values([
    item("A1", { companyId: fx.companyA, unitId: fx.unitSp, claimAmountCents: 5_000_000, liquidatedAmountCents: 900_000, guaranteesCents: 200_000, exposureCents: 700_000, provisionCents: 700_000 }),
    item("A2", { unitId: fx.unitRe, liquidatedAmountCents: 100_000, guaranteesCents: 250_000, exposureCents: 0, provisionCents: 0 }),
    item("A3", { unitId: fx.unitSp, claimAmountCents: 2_000_000, exposureCents: 900_000, exposureIsEstimate: true, provisionCents: 1_000_000, provisionIsEstimate: true }),
    item("A4", { unitId: fx.unitSp, isConfidential: true, liquidatedAmountCents: 9_000_000, exposureCents: 9_000_000 }),
    item("A5", { unitId: fx.unitSp, liquidatedAmountCents: 7_000, exposureCents: 7_000 }), // closed afterwards: still in the closing
    item("D1", { companyId: fx.companyA, unitId: fx.unitSp, liquidatedAmountCents: 40_000, exposureCents: 40_000, provisionCents: 40_000 }),
    item("D2", { unitId: fx.unitSp, isConfidential: true, liquidatedAmountCents: 60_000, exposureCents: 60_000 }),
    item("F1", { unitId: fx.unitRe, guaranteesCents: -5, exposureCents: null }),
  ]);

  // Alerts about a process, a deadline and a preliminary analysis.
  const [deadline] = await fx.db
    .insert(deadlines)
    .values({ organizationId: fx.orgA, title: "Prazo fictício", processId: ids.A1, dueDate: addDaysISO(today, 3), kind: "procedural" })
    .returning();
  const brief = { organizationId: fx.orgA, mode: "demo" as const, provider: "simulated", model: "regras", promptVersion: "v1", inputHash: "h" };
  const content = { contradictions: [], missingDocuments: [], urgencies: [] } as never;
  const briefs = await fx.db
    .insert(caseBriefs)
    .values([
      { ...brief, processId: ids.A1, version: 1, status: "ready_for_review", content }, // superseded by v2
      { ...brief, processId: ids.A1, version: 2, status: "ready_for_review", content },
      { ...brief, processId: ids.A2, version: 1, status: "in_review", content },
      { ...brief, processId: ids.A3, version: 1, status: "ready_for_review", content },
      { ...brief, processId: ids.A3, version: 2, status: "generating" }, // no content yet: supersedes nothing
      { ...brief, processId: ids.A4, version: 1, status: "ready_for_review", content },
    ])
    .returning({ id: caseBriefs.id, processId: caseBriefs.processId, version: caseBriefs.version });
  const briefOf = (key: string, version: number) => briefs.find((b) => b.processId === ids[key] && b.version === version)!.id;
  const alert = (entityType: "legal_process" | "deadline" | "case_brief", entityId: string, key: string, severity: "warning" | "critical" = "warning") => ({
    organizationId: fx.orgA,
    type: "process_needs_verification" as const,
    severity,
    title: "Alerta fictício",
    message: "Mensagem fictícia",
    entityType,
    entityId,
    dedupeKey: key,
  });
  await fx.db.insert(alerts).values([
    alert("legal_process", ids.A1, "p1"),
    { ...alert("deadline", deadline.id, "d1", "critical"), type: "deadline_upcoming" as const },
    { ...alert("case_brief", briefOf("A1", 2), "b1"), type: "brief_pending_review" as const },
  ]);

  // Intakes (effective status = stored status, no brief linked).
  await fx.db.insert(caseIntakes).values([
    { organizationId: fx.orgA, processId: ids.A1, source: "manual", status: "received" },
    { organizationId: fx.orgA, processId: ids.A2, source: "manual", status: "notified" },
    { organizationId: fx.orgA, processId: ids.A3, source: "manual", status: "approved" },
    { organizationId: fx.orgA, processId: ids.F1, source: "manual", status: "failed" },
    { organizationId: fx.orgA, processId: ids.A3, source: "manual", status: "analyzing" },
  ]);
});

afterAll(async () => fx?.teardown());

// ---------------------------------------------------------------------------

describe("previous closing (RN-10, deferred 11 and 14)", () => {
  /** In-memory reference: every stored item, the scope rules without the soft-delete condition, stored company/unit. */
  async function reference(ctx: AuthContext, f: Partial<BiFilters>): Promise<MoneyBucket> {
    const rows = await fx.db
      .select({ it: portfolioSnapshotItems, p: legalProcesses })
      .from(portfolioSnapshotItems)
      .innerJoin(legalProcesses, eq(legalProcesses.id, portfolioSnapshotItems.processId))
      .where(and(eq(portfolioSnapshotItems.snapshotId, snapshotId), eq(portfolioSnapshotItems.organizationId, ctx.organizationId)));
    return bucketFromSnapshotItems(
      rows
        .filter(({ p }) => canViewScopedRecord(ctx, { ...p, deletedAt: null }))
        .filter(({ it }) => (!f.companyId || it.companyId === f.companyId) && (!f.unitId || it.unitId === f.unitId))
        .filter(({ p }) => (!f.area || p.area === f.area) && (!f.responsibleId || p.responsibleId === f.responsibleId))
        .map(({ it }) => it),
    );
  }

  it("keeps processes deleted after the close in the closed figures", async () => {
    const admin = await panel(fx.ctx.admin);
    expect(admin.previous?.period).toBe(PREVIOUS_PERIOD);
    // A1, A2, A3, A4, A5 (closed later), D1 and D2 (deleted later), F1.
    expect(admin.previous?.totals).toMatchObject({
      count: 8,
      liquidatedCents: 900_000 + 100_000 + 9_000_000 + 7_000 + 40_000 + 60_000,
      exposureCents: 700_000 + 0 + 9_000_000 + 7_000 + 40_000 + 60_000,
      exposureEstimateCents: 900_000,
      exposureUnknown: 1,
      provisionCents: 740_000,
      provisionEstimateCents: 1_000_000,
      guaranteesCents: 450_000, // the stored negative value of F1 never subtracts
    });
    // Confidential D2 stays hidden from the executive, D1 (deleted) does not.
    const exec = await panel(fx.ctx.executive);
    expect(exec.previous?.totals.count).toBe(6);
    expect(exec.previous?.totals.liquidatedCents).toBe(900_000 + 100_000 + 7_000 + 40_000);
  });

  it("sums the stored items in SQL with exactly the in-memory result, for every profile and filter", async () => {
    for (const [name, ctx] of contexts()) {
      for (const f of filterSets()) {
        const d = await panel(ctx, f);
        if (ctx.organizationId !== fx.orgA) {
          expect(d.previous).toBeNull(); // organization B has no closed competência
          continue;
        }
        expect({ name, f, totals: d.previous?.totals }).toEqual({ name, f, totals: await reference(ctx, f) });
      }
    }
  });

  it("uses the scope rules of processWhere without the soft-delete condition", async () => {
    const all = await fx.db.select().from(legalProcesses);
    for (const [name, ctx] of contexts()) {
      const viaSql = (await fx.db.select({ id: legalProcesses.id }).from(legalProcesses).where(closedCompetenceProcessWhere(ctx)))
        .map((r) => r.id)
        .sort();
      const inMemory = all
        .filter((p) => canViewScopedRecord(ctx, { ...p, deletedAt: null }))
        .map((p) => p.id)
        .sort();
      expect({ name, ids: viaSql }).toEqual({ name, ids: inMemory });
    }
    // Deleted processes are part of it; the live scope (processWhere) still hides them.
    const adminIds = (await fx.db.select({ id: legalProcesses.id }).from(legalProcesses).where(closedCompetenceProcessWhere(fx.ctx.admin))).map((r) => r.id);
    expect(adminIds).toEqual(expect.arrayContaining([ids.D1, ids.D2]));
  });
});

describe("current position (deferred 14: same figures with the scoped SQL query)", () => {
  it("equals the exposure rows of the contingency module narrowed by the filters", async () => {
    const processes = new Map((await fx.db.select().from(legalProcesses)).map((p) => [p.id, p]));
    for (const [name, ctx] of contexts()) {
      if (name === "adminB") continue;
      for (const f of filterSets()) {
        const { rows } = await getPortfolioExposure(ctx, { companyId: f.companyId ?? undefined, unitId: f.unitId ?? undefined });
        const expected = emptyBucket();
        for (const r of rows) {
          const p = processes.get(r.processId)!;
          if (f.area && p.area !== f.area) continue;
          if (f.responsibleId && p.responsibleId !== f.responsibleId) continue;
          addToBucket(expected, {
            liquidatedCents: r.liquidatedCents,
            linkedGuaranteesCents: r.guaranteesCents,
            claimCents: r.claimCents,
            riskPercentageBp: r.percentageBp,
          });
        }
        const d = await panel(ctx, f);
        expect({ name, f, totals: d.totals }).toEqual({ name, f, totals: expected });
      }
    }
  });
});

describe("net exposure of the portfolio (P1.8)", () => {
  it("deducts the linked guarantees per process, never below zero, with the deductions by kind", async () => {
    const d = await panel(fx.ctx.admin);
    // Apurado: A1 1 mi (guarantees 500 mil), A2 100 mil (guarantees 250 mil: zero, excess 150 mil), A4 9 mi, F1 500 mil.
    expect(d.netExposure).toMatchObject({
      coverage: { assessed: 4, total: 5 },
      liquidatedCents: 10_600_000,
      guaranteesCents: 750_000,
      deductedCents: 600_000,
      exposureCents: 10_000_000,
      excess: { cents: 150_000, processes: 1 },
      withGuarantees: 2,
      // A3 has no valor apurado: claim 2 mi × 50% − 100 mil, kept apart as an estimate.
      estimate: { exposureCents: 900_000, processes: 1, guaranteesCents: 100_000, noBasis: 0 },
    });
    expect(d.netExposure.byKind).toEqual([
      { kind: "surety_insurance", count: 1, amountCents: 300_000 },
      { kind: "bank_guarantee", count: 1, amountCents: 250_000 },
      { kind: "judicial_deposit", count: 1, amountCents: 200_000 },
    ]);
    expect(d.netExposure.top.map((t) => [t.processId, t.deductedCents, t.exposureCents])).toEqual([
      [ids.A1, 500_000, 500_000],
      [ids.A2, 100_000, 0],
    ]);
  });

  it("adds up for every profile and filter: by-kind total = guarantees, exposure = official exposure of the totals", async () => {
    for (const [name, ctx] of contexts()) {
      for (const f of filterSets()) {
        const d = await panel(ctx, f);
        const n = d.netExposure;
        const byKind = n.byKind.reduce((s, k) => s + k.amountCents, 0);
        expect({ name, f, byKind, exposure: n.exposureCents, estimate: n.estimate.exposureCents }).toEqual({
          name,
          f,
          byKind: n.guaranteesCents,
          exposure: d.totals.exposureCents,
          estimate: d.totals.exposureEstimateCents,
        });
        expect(n.deductedCents + n.exposureCents).toBe(n.liquidatedCents);
        expect(n.deductedCents + n.excess.cents).toBe(n.guaranteesCents);
        expect(n.coverage).toEqual(d.coverage);
      }
    }
    // The executive does not see the confidential A4.
    expect((await panel(fx.ctx.executive)).netExposure).toMatchObject({ liquidatedCents: 1_600_000, exposureCents: 1_000_000 });
  });
});

describe("follow-up cards", () => {
  it("counts alerts only of the modules the role can read, like the header bell (deferred 9)", async () => {
    const admin = await getFollowUpPanel(fx.ctx.admin);
    expect(admin.alerts).toMatchObject({ total: 3, critical: 1 });
    // Accountant: no deadline:read and no brief:read.
    const accountant = await getFollowUpPanel(fx.ctx.accountant);
    expect(accountant.alerts.total).toBe(1);
    expect(accountant.alerts.groups.flatMap((g) => g.types.map((t) => t.type))).toEqual(["process_needs_verification"]);
    // Executive: no brief:read.
    const exec = await getFollowUpPanel(fx.ctx.executive);
    expect(exec.alerts).toMatchObject({ total: 2, critical: 1 });
    expect(exec.alerts.groups.flatMap((g) => g.types.map((t) => t.type))).not.toContain("brief_pending_review");
    for (const [name, ctx] of contexts()) {
      const bell = await countOpenAlerts(ctx);
      const card = (await getFollowUpPanel(ctx)).alerts;
      expect({ name, total: card.total, critical: card.critical }).toEqual({ name, total: bell.total, critical: bell.critical });
    }
  });

  it("counts only the latest version of each preliminary analysis, as the lists it links to (deferred 10/15)", async () => {
    const admin = await getFollowUpPanel(fx.ctx.admin);
    if (admin.briefs.status !== "ok") throw new Error("briefs");
    // A1 v2, A3 v1 (v2 has no content yet) and A4 ready; A2 in review. A1 v1 is superseded.
    expect(admin.briefs.data).toMatchObject({ total: 4, readyForReview: 3, inReview: 1 });
    expect(admin.briefs.data.items.map((b) => b.processId)).not.toContain(undefined);
    expect(admin.briefs.data.items.filter((b) => b.processId === ids.A1)).toHaveLength(1);
    for (const [name, ctx] of contexts()) {
      const s = (await getFollowUpPanel(ctx)).briefs;
      if (s.status !== "ok") continue;
      const ready = await listCaseBriefs(ctx, { status: "ready_for_review" });
      const inReview = await listCaseBriefs(ctx, { status: "in_review" });
      expect({ name, ready: s.data.readyForReview, inReview: s.data.inReview }).toEqual({
        name,
        ready: ready.total,
        inReview: inReview.total,
      });
    }
  });

  it("counts intakes by effective status exactly as /entrada?status= lists them (deferred 15)", async () => {
    for (const [name, ctx] of contexts()) {
      const s = (await getFollowUpPanel(ctx)).intake;
      if (s.status !== "ok") continue;
      const total = async (status: string) => (await listIntakes(ctx, { status: status as never })).total;
      expect({
        name,
        received: s.data.received,
        notified: s.data.notified,
        inReview: s.data.inReview,
        approved: s.data.approved,
        failed: s.data.failed,
      }).toEqual({
        name,
        received: await total("received"),
        notified: await total("notified"),
        inReview: await total("in_review"),
        approved: await total("approved"),
        failed: await total("failed"),
      });
    }
    const admin = await getFollowUpPanel(fx.ctx.admin);
    expect(admin.intake).toEqual({
      status: "ok",
      data: { received: 1, inProgress: 1, notified: 1, inReview: 0, approved: 1, failed: 1 },
    });
  });
});
