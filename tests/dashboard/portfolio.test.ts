import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { netExposure, provisionFor } from "@/domain/contingency";
import type { BiFilters } from "@/modules/dashboard/bi-filters";
import {
  bucketFromSnapshotItems,
  bucketOf,
  delta,
  groupRows,
  rankGroups,
  uniqueProcessCount,
  type PortfolioRowLike,
} from "@/modules/dashboard/portfolio";
import { getFollowUpPanel, getPortfolioPanel, type PortfolioData } from "@/modules/dashboard/portfolio-service";
import { getPortfolioExposure, type PortfolioExposureRow } from "@/modules/contingency/service";
import { listUpcomingHearings } from "@/modules/hearings/service";
import { getIntakeCounts } from "@/modules/intake/service";
import type { AuthContext } from "@/server/auth/context";
import { alerts, caseBriefs, legalProcesses, portfolioSnapshotItems, portfolioSnapshots } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";

// The contingency, hearings and intake modules are other packages: their cross-module
// functions are mocked so this suite tests the dashboard's own scoping and aggregation.
vi.mock("@/modules/contingency/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/contingency/service")>();
  return { ...actual, getPortfolioExposure: vi.fn() };
});
vi.mock("@/modules/hearings/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/hearings/service")>();
  return { ...actual, listUpcomingHearings: vi.fn() };
});
vi.mock("@/modules/intake/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/intake/service")>();
  return { ...actual, getIntakeCounts: vi.fn() };
});

const TODAY = "2026-10-11";
const ALL: BiFilters = { period: "12m", unitId: null, area: null, responsibleId: null, companyId: null };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function row(overrides: Partial<PortfolioRowLike>): PortfolioRowLike {
  return {
    processId: "p",
    number: "n",
    companyId: null,
    unitId: null,
    court: "TRT10",
    instance: "first",
    phase: "knowledge",
    city: null,
    classification: null,
    percentageBp: null,
    claimCents: null,
    liquidatedCents: null,
    guaranteesCents: 0,
    ...overrides,
  };
}

describe("portfolio aggregation (pure)", () => {
  it("never adds valor da causa to valor liquidado and counts nulls as unknown (RN-02, RN-03)", () => {
    const b = bucketOf([
      row({ number: "1", claimCents: 1_000, liquidatedCents: null, percentageBp: 5_000 }),
      row({ number: "2", claimCents: 2_000, liquidatedCents: 500, guaranteesCents: 100, percentageBp: 10_000 }),
      row({ number: "3", claimCents: null, liquidatedCents: null }),
    ]);
    expect(b).toMatchObject({
      count: 3,
      claimCents: 3_000,
      claimUnknown: 1,
      liquidatedCents: 500,
      liquidatedUnknown: 2,
      exposureCents: 400, // 500 − 100 (official)
      exposureEstimateCents: 500, // 1.000 × 50% (estimate, kept apart)
      exposureUnknown: 1,
      provisionCents: 400,
      provisionEstimateCents: 500,
    });
  });

  it("reads closed snapshot items as stored (RN-10)", () => {
    const b = bucketFromSnapshotItems([
      {
        claimAmountCents: 10,
        liquidatedAmountCents: null,
        guaranteesCents: 0,
        exposureCents: 7,
        exposureIsEstimate: true,
        provisionCents: 7,
        provisionIsEstimate: true,
      },
      {
        claimAmountCents: null,
        liquidatedAmountCents: 20,
        guaranteesCents: 5,
        exposureCents: 999, // stored value wins: never recomputed
        exposureIsEstimate: false,
        provisionCents: null,
        provisionIsEstimate: false,
      },
    ]);
    expect(b).toMatchObject({ count: 2, claimCents: 10, claimUnknown: 1, liquidatedCents: 20, liquidatedUnknown: 1, exposureCents: 999, exposureEstimateCents: 7, provisionEstimateCents: 7 });
  });

  it("ranks groups, folds the tail into 'Demais' and counts unique CNJs (RN-09)", () => {
    const rows = ["A", "A", "B", "C", "D"].map((city, i) =>
      row({ number: `${i}`, city, liquidatedCents: (i + 1) * 100 }),
    );
    const ranked = rankGroups(groupRows(rows, (r) => r.city), 2);
    expect(ranked.top.map((g) => g.key)).toEqual(["D", "C"]);
    expect(ranked.others).toMatchObject({ groups: 2, bucket: { count: 3 } });
    expect(uniqueProcessCount([{ number: "1" }, { number: "1" }, { number: "2" }])).toBe(2);
    expect(delta(110, 100)).toMatchObject({ diff: 10, ratio: 0.1 });
    expect(delta(5, 0).ratio).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

describe("executive portfolio panel", () => {
  let fx: Fixture;
  const ids: Record<string, string> = {};
  const guarantees = new Map<string, number>();

  /** Deliberately returns EVERY process of EVERY organization: the panel must apply the scope itself. */
  async function unscopedRows(): Promise<PortfolioExposureRow[]> {
    const all = await fx.db.select().from(legalProcesses);
    return all.map((p) => {
      const input = {
        liquidatedCents: p.liquidatedAmountCents,
        linkedGuaranteesCents: guarantees.get(p.id) ?? 0,
        claimCents: p.claimAmountCents,
        riskPercentageBp: p.riskPercentageBp,
      };
      return {
        processId: p.id,
        number: p.number,
        title: p.title,
        companyId: p.companyId,
        unitId: p.unitId,
        court: p.court,
        instance: p.instance,
        phase: p.phase,
        city: p.city,
        status: p.status,
        classification: p.lossProbability,
        percentageBp: p.riskPercentageBp,
        claimCents: p.claimAmountCents,
        liquidatedCents: p.liquidatedAmountCents,
        guaranteesCents: guarantees.get(p.id) ?? 0,
        exposure: netExposure(input),
        provision: provisionFor(input),
      };
    });
  }

  const panel = async (ctx: AuthContext, filters: Partial<BiFilters> = {}): Promise<PortfolioData> => {
    const result = await getPortfolioPanel(ctx, { ...ALL, ...filters }, { today: TODAY });
    if (result.status !== "ok") throw new Error(`unexpected status ${result.status}`);
    return result.data;
  };

  beforeAll(async () => {
    fx = await setupFixture("dashpf");
    const base = { organizationId: fx.orgA, area: "labor" as const, phase: "knowledge" as const };
    const insert = async (key: string, values: Partial<typeof legalProcesses.$inferInsert>) => {
      const [p] = await fx.db
        .insert(legalProcesses)
        .values({ ...base, number: `${key}-0000000.2026.5.10.0001`, title: `Processo ${key} (fictício)`, court: "TRT10", ...values })
        .returning();
      ids[key] = p.id;
    };
    const lawyer = fx.ctx.lawyer.userId!;
    await insert("P1", {
      unitId: fx.unitSp,
      companyId: fx.companyA,
      instance: "first",
      city: "Palmas",
      claimAmountCents: 1_000_000,
      riskPercentageBp: 5_000,
      lossProbability: "possible",
      responsibleId: lawyer,
    });
    await insert("P2", {
      unitId: fx.unitSp,
      companyId: fx.companyA,
      instance: "second",
      phase: "enforcement",
      city: "Palmas",
      claimAmountCents: 2_000_000,
      liquidatedAmountCents: 800_000,
      riskPercentageBp: 10_000,
      lossProbability: "probable",
    });
    await insert("P3", { unitId: fx.unitRe, court: "TRT22", instance: "first", city: "Teresina" });
    await insert("P4", {
      unitId: fx.unitSp,
      companyId: fx.companyA,
      isConfidential: true,
      responsibleId: lawyer,
      claimAmountCents: 50_000_000,
      liquidatedAmountCents: 40_000_000,
      riskPercentageBp: 10_000,
      lossProbability: "probable",
    });
    await insert("P5", { unitId: fx.unitSp, status: "closed", claimAmountCents: 9_999_999 });
    await insert("P7", { unitId: fx.unitSp, deletedAt: new Date(), claimAmountCents: 1 });
    await insert("P8", {
      unitId: fx.unitRe,
      area: "civil",
      lawFirmId: fx.lawFirmA,
      instance: "first",
      claimAmountCents: 300_000,
      riskPercentageBp: 0,
      lossProbability: "remote",
    });
    await insert("P6", { organizationId: fx.orgB, liquidatedAmountCents: 7_777 });
    guarantees.set(ids.P2, 100_000);

    // Closed months (the latest one before the current month is used) and another organization's closing.
    const params = { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 1, confidenceThreshold: 85 };
    const metrics = {} as never;
    const [aug] = await fx.db
      .insert(portfolioSnapshots)
      .values({ organizationId: fx.orgA, period: "2026-08", referenceDate: "2026-08-31", status: "closed", metrics, params })
      .returning();
    const [sep] = await fx.db
      .insert(portfolioSnapshots)
      .values({ organizationId: fx.orgA, period: "2026-09", referenceDate: "2026-09-30", status: "closed", metrics, params, closedAt: new Date() })
      .returning();
    const [octPreview] = await fx.db
      .insert(portfolioSnapshots)
      .values({ organizationId: fx.orgA, period: "2026-10", referenceDate: "2026-10-31", status: "preview", metrics, params })
      .returning();
    const [sepB] = await fx.db
      .insert(portfolioSnapshots)
      .values({ organizationId: fx.orgB, period: "2026-09", referenceDate: "2026-09-30", status: "closed", metrics, params })
      .returning();
    const item = (snapshotId: string, organizationId: string, processId: string, v: Partial<typeof portfolioSnapshotItems.$inferInsert>) => ({
      snapshotId,
      organizationId,
      processId,
      number: "x",
      ...v,
    });
    await fx.db.insert(portfolioSnapshotItems).values([
      item(aug.id, fx.orgA, ids.P2, { exposureCents: 1, exposureIsEstimate: false }),
      item(sep.id, fx.orgA, ids.P1, { companyId: fx.companyA, unitId: fx.unitSp, claimAmountCents: 1_000_000, exposureCents: 400_000, exposureIsEstimate: true, provisionCents: 400_000, provisionIsEstimate: true }),
      item(sep.id, fx.orgA, ids.P2, { companyId: fx.companyA, unitId: fx.unitSp, claimAmountCents: 2_000_000, liquidatedAmountCents: 700_000, exposureCents: 600_000, provisionCents: 600_000 }),
      item(sep.id, fx.orgA, ids.P4, { companyId: fx.companyA, unitId: fx.unitSp, isConfidential: true, exposureCents: 30_000_000, provisionCents: 30_000_000 }),
      item(octPreview.id, fx.orgA, ids.P1, { exposureCents: 123 }),
      item(sepB.id, fx.orgB, ids.P6, { exposureCents: 5_555 }),
    ]);
  });

  afterAll(async () => fx.teardown());

  beforeEach(() => {
    vi.mocked(getPortfolioExposure).mockReset();
    vi.mocked(getPortfolioExposure).mockImplementation(async () => {
      const rows = await unscopedRows();
      return { rows, totals: bucketOf(rows) };
    });
  });

  it("aggregates the active portfolio with official and estimated figures apart (admin)", async () => {
    const d = await panel(fx.ctx.admin);
    expect(d.activeProcesses).toBe(5); // P1, P2, P3, P4, P8 — closed, deleted and B excluded
    expect(d.totals).toMatchObject({
      count: 5,
      claimCents: 53_300_000,
      claimUnknown: 1,
      liquidatedCents: 40_800_000,
      liquidatedUnknown: 3,
      guaranteesCents: 100_000,
      exposureCents: 40_700_000,
      exposureEstimateCents: 500_000,
      exposureUnknown: 1,
      provisionCents: 40_700_000,
      provisionEstimateCents: 500_000,
    });
    const probable = d.byClassification.find((c) => c.key === "probable")!;
    expect(probable.bucket).toMatchObject({ count: 2, provisionCents: 40_700_000 });
    expect(d.byClassification.find((c) => c.key === "unclassified")!.bucket.count).toBe(1);
    expect(d.top.map((t) => t.processId)).toEqual([ids.P4, ids.P2, ids.P1]);
    expect(d.top[2]).toMatchObject({ exposureIsEstimate: true, liquidatedCents: null });

    const court = d.dimensions.court.rows.find((r) => r.key === "TRT10")!;
    expect(court.bucket.count).toBe(4);
    expect(court.href).toBe("/processos?tribunal=TRT10");
    const noInstance = d.dimensions.instance.rows.find((r) => r.key === null)!;
    expect(noInstance).toMatchObject({ label: "Não informado", href: null });
    expect(d.dimensions.company.rows.find((r) => r.key === fx.companyA)).toMatchObject({
      label: "Empresa Fictícia A Ltda.",
      href: `/processos?empresa=${fx.companyA}`,
    });
    expect(d.dimensions.city.rows.map((r) => r.key)).toContain("Palmas");

    // Latest CLOSED month before October (the October preview is ignored).
    expect(d.previous?.period).toBe("2026-09");
    expect(d.previous?.totals).toMatchObject({ count: 3, exposureCents: 30_600_000, exposureEstimateCents: 400_000 });
  });

  it("applies row visibility per role even when the upstream rows are not scoped", async () => {
    const exec = await panel(fx.ctx.executive);
    expect(exec.activeProcesses).toBe(4); // confidential P4 excluded
    expect(exec.totals.exposureCents).toBe(700_000);
    expect(exec.top.map((t) => t.processId)).not.toContain(ids.P4);
    expect(exec.previous?.totals).toMatchObject({ count: 2, exposureCents: 600_000 });

    for (const c of [fx.ctx.accountant, fx.ctx.auditor]) {
      expect((await panel(c)).activeProcesses).toBe(4);
    }

    const lawyerSp = await panel(fx.ctx.lawyer);
    expect(lawyerSp.activeProcesses).toBe(3); // P1, P2 (unit SP) + confidential P4 (responsible)
    const lawyerRe = await panel(fx.ctx.lawyerRe);
    expect(lawyerRe.activeProcesses).toBe(2); // P3, P8
    const firm = await panel(fx.ctx.externalCounsel);
    expect(firm.activeProcesses).toBe(1); // P8 only (law firm A)
    expect(firm.previous?.totals.count).toBe(0);

    const b = await panel(fx.ctx.adminB);
    expect(b.activeProcesses).toBe(1);
    expect(b.totals.liquidatedCents).toBe(7_777);
    expect(b.previous?.totals.exposureCents).toBe(5_555);
  });

  it("narrows by company, unit, area and responsible (and keeps the filters in deep links)", async () => {
    expect((await panel(fx.ctx.admin, { companyId: fx.companyA })).activeProcesses).toBe(3);
    expect(vi.mocked(getPortfolioExposure).mock.calls.at(-1)?.[1]).toEqual({ companyId: fx.companyA });
    const byUnit = await panel(fx.ctx.admin, { unitId: fx.unitRe });
    expect(byUnit.activeProcesses).toBe(2);
    expect(byUnit.dimensions.court.rows.find((r) => r.key === "TRT22")?.href).toBe(`/processos?unidade=${fx.unitRe}&tribunal=TRT22`);
    expect((await panel(fx.ctx.admin, { area: "civil" })).activeProcesses).toBe(1);
    const byResponsible = await panel(fx.ctx.admin, { responsibleId: fx.ctx.lawyer.userId });
    expect(byResponsible.activeProcesses).toBe(2);
    expect(byResponsible.previous?.totals.count).toBe(2); // P1 and P4 in September
    // A foreign id can only narrow, never widen.
    expect((await panel(fx.ctx.admin, { unitId: fx.unitB })).activeProcesses).toBe(0);
  });

  it("reports an unavailable section when the contingency module fails", async () => {
    vi.mocked(getPortfolioExposure).mockRejectedValueOnce(new Error("falha simulada"));
    expect(await getPortfolioPanel(fx.ctx.admin, ALL, { today: TODAY })).toEqual({ status: "error" });
  });

  describe("follow-up cards", () => {
    beforeAll(async () => {
      const alert = (entityId: string, type: "valuation_pending_review" | "hearing_upcoming", severity: "warning" | "critical", key: string) => ({
        organizationId: fx.orgA,
        type,
        severity,
        title: "Alerta fictício",
        message: "Mensagem",
        entityType: "legal_process" as const,
        entityId,
        dedupeKey: key,
      });
      await fx.db.insert(alerts).values([
        alert(ids.P1, "valuation_pending_review", "warning", "a1"),
        alert(ids.P4, "hearing_upcoming", "critical", "a2"),
        { ...alert(ids.P2, "valuation_pending_review", "warning", "a3"), resolvedAt: new Date() },
        { ...alert(ids.P6, "valuation_pending_review", "critical", "b1"), organizationId: fx.orgB },
      ]);
      const brief = { organizationId: fx.orgA, mode: "demo" as const, provider: "simulated", model: "regras", promptVersion: "v1", inputHash: "h" };
      await fx.db.insert(caseBriefs).values([
        { ...brief, processId: ids.P1, version: 1, status: "ready_for_review" },
        { ...brief, processId: ids.P4, version: 1, status: "in_review" },
        { ...brief, processId: ids.P2, version: 1, status: "approved" },
      ]);
    });

    beforeEach(() => {
      vi.mocked(listUpcomingHearings).mockReset();
      vi.mocked(listUpcomingHearings).mockResolvedValue([
        {
          id: "00000000-0000-4000-8000-000000000001",
          processId: "00000000-0000-4000-8000-000000000002",
          processNumber: "0000001-00.2026.5.10.0001",
          processTitle: "Processo fictício",
          kind: "instruction",
          mode: "virtual",
          status: "scheduled",
          scheduledAt: new Date("2026-10-15T13:00:00Z"),
          location: null,
          responsibleName: null,
        },
      ]);
      vi.mocked(getIntakeCounts).mockReset();
      vi.mocked(getIntakeCounts).mockResolvedValue({ received: 1, inProgress: 2, awaitingReview: 3, approved: 4, failed: 0 });
    });

    it("groups open alerts by area within the user's visibility", async () => {
      const admin = await getFollowUpPanel(fx.ctx.admin);
      expect(admin.alerts).toMatchObject({ total: 2, critical: 1 });
      expect(admin.alerts.groups.find((g) => g.key === "portfolio")?.types).toEqual([
        { type: "valuation_pending_review", label: "Valor aguardando conferência", count: 1, critical: 0 },
      ]);
      expect(admin.alerts.groups.find((g) => g.key === "hearings")).toMatchObject({ total: 1, critical: 1 });

      const exec = await getFollowUpPanel(fx.ctx.executive);
      expect(exec.alerts).toMatchObject({ total: 1, critical: 0 }); // the confidential process' alert is hidden
    });

    it("passes the configured hearing window and surfaces intake counts", async () => {
      const d = await getFollowUpPanel(fx.ctx.manager);
      expect(d.upcomingHearingDays).toBe(10);
      expect(vi.mocked(listUpcomingHearings).mock.calls[0]?.[1]).toEqual({ days: 10, limit: 6 });
      expect(d.hearings.status).toBe("ok");
      expect(d.intake).toEqual({ status: "ok", data: { received: 1, inProgress: 2, awaitingReview: 3, approved: 4, failed: 0 } });

      vi.mocked(listUpcomingHearings).mockRejectedValueOnce(new Error("falha simulada"));
      const failing = await getFollowUpPanel(fx.ctx.manager);
      expect(failing.hearings).toEqual({ status: "error" });
      expect(failing.intake.status).toBe("ok");
    });

    it("counts preliminary analyses awaiting review only for brief readers, within visibility", async () => {
      const admin = await getFollowUpPanel(fx.ctx.admin);
      expect(admin.briefs.status === "ok" && admin.briefs.data.total).toBe(2);
      const exec = await getFollowUpPanel(fx.ctx.executive);
      // Executives have no brief:read permission.
      expect(exec.briefs).toEqual({ status: "forbidden" });
      const auditor = await getFollowUpPanel(fx.ctx.auditor);
      expect(auditor.briefs.status === "ok" && auditor.briefs.data.items.map((b) => b.processId)).toEqual([ids.P1]);
      const accountant = await getFollowUpPanel(fx.ctx.accountant);
      expect(accountant.briefs).toEqual({ status: "forbidden" });
    });
  });
});
