import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// getPortfolioExposure (contingency package) is replaced by a contract-following fake (see ./fake-contingency).
vi.mock("@/modules/contingency/service", async (importOriginal) =>
  // REPORTS_REAL_CONTINGENCY=1 runs the same assertions against the real contingency implementation.
  process.env.REPORTS_REAL_CONTINGENCY ? importOriginal() : (await import("./fake-contingency")).contingencyServiceMock(),
);

import { and, eq } from "drizzle-orm";
import { periodReferenceDate, previousPeriod } from "@/domain/contingency";
import { processPhaseLabel } from "@/domain/enums";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  auditLogs,
  companies,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processGuarantees,
  processValuations,
} from "@/server/db/schema";
import { ForbiddenError, ValidationError } from "@/server/lib/errors";
import { CSV_BOM } from "@/modules/reports/csv";
import { buildReportExport } from "@/modules/reports/export-builders";
import {
  exportReport,
  getAuditLetterReport,
  getExposureReport,
  getMovementReport,
  getPortfolioReport,
  getProvisionReport,
  getResponsiblesReport,
  listReportFilterOptions,
} from "@/modules/reports/service";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let fx: Fixture;
const p: Record<string, string> = {};
let companyA2: string;
const today = todayISO();
const currentPeriod = today.slice(0, 7);
const prevPeriod = previousPeriod(currentPeriod);
const prev2Period = previousPeriod(prevPeriod);

type LpInsert = typeof legalProcesses.$inferInsert;

async function insertProcess(key: string, values: Partial<LpInsert> & { number: string }) {
  const [row] = await fx.db
    .insert(legalProcesses)
    .values({
      organizationId: fx.orgA,
      title: `Processo fictício ${key}`,
      court: "TRT10",
      area: "labor",
      phase: "knowledge",
      ...values,
    })
    .returning({ id: legalProcesses.id });
  p[key] = row.id;
}

beforeAll(async () => {
  fx = await setupFixture("rep");
  const [c2] = await fx.db.insert(companies).values({ organizationId: fx.orgA, name: "Empresa Fictícia B Ltda." }).returning();
  companyA2 = c2.id;
  const lawyerSp = fx.ctx.lawyer.userId!;
  const lawyerRe = fx.ctx.lawyerRe.userId!;

  await insertProcess("p1", {
    number: "0000001-11.2025.5.10.0001",
    unitId: fx.unitSp,
    companyId: fx.companyA,
    court: "TRT10",
    city: "Palmas - TO",
    phase: "knowledge",
    instance: "first",
    claimAmountCents: 10_000_000,
    liquidatedAmountCents: null,
    lossProbability: "possible",
    riskPercentageBp: 5000,
    responsibleId: lawyerSp,
  });
  await insertProcess("p2", {
    number: "0000002-11.2025.5.10.0001",
    unitId: fx.unitSp,
    companyId: fx.companyA,
    court: "TRT10",
    city: "Palmas/TO",
    phase: "enforcement",
    instance: "first",
    claimAmountCents: 2_000_000,
    liquidatedAmountCents: 3_000_000,
    lossProbability: "probable",
    riskPercentageBp: 10000,
    responsibleId: lawyerSp,
    lawFirmId: fx.lawFirmA,
  });
  await insertProcess("p3", {
    number: "0000003-11.2025.5.02.0001",
    unitId: fx.unitRe,
    companyId: companyA2,
    court: "TRT2",
    city: "São Paulo",
    phase: "liquidation",
    instance: "second",
    claimAmountCents: null,
    liquidatedAmountCents: 1_000_000,
    responsibleId: lawyerRe,
    needsVerification: true,
  });
  await insertProcess("p4", {
    number: "0000004-11.2025.5.10.0001",
    court: "TRT10",
    city: "Palmas",
    phase: "knowledge",
    claimAmountCents: 500_000,
    liquidatedAmountCents: null,
    lawFirmId: fx.lawFirmA,
  });
  await insertProcess("p5", {
    number: "0000005-11.2025.5.00.0001",
    unitId: fx.unitSp,
    companyId: fx.companyA,
    court: "TST",
    phase: "knowledge",
    instance: "superior",
    claimAmountCents: 7_000_000,
    liquidatedAmountCents: 7_000_000,
    lossProbability: "probable",
    riskPercentageBp: 10000,
    isConfidential: true,
  });
  await insertProcess("p6", {
    number: "0000006-11.2025.5.02.0001",
    unitId: fx.unitSp,
    companyId: fx.companyA,
    court: "TRT2",
    phase: "enforcement",
    status: "closed",
    closedAt: today,
    closureReason: "paid_extinct",
    claimAmountCents: 1_000_000,
    liquidatedAmountCents: 0,
  });
  await insertProcess("p7", {
    number: "0000007-11.2025.5.02.0001",
    unitId: fx.unitRe,
    companyId: companyA2,
    court: "TRT2",
    phase: "knowledge",
    claimAmountCents: 300_000,
    liquidatedAmountCents: null,
    lossProbability: "remote",
    riskPercentageBp: 0,
    responsibleId: lawyerSp,
  });
  // Organization B (isolation).
  await fx.db.insert(legalProcesses).values({
    organizationId: fx.orgB,
    number: "0000001-11.2025.5.10.0001",
    title: "Processo da organização B",
    court: "TRT10",
    area: "labor",
    phase: "knowledge",
    claimAmountCents: 99_000_000,
  });

  await fx.db.insert(processGuarantees).values({
    organizationId: fx.orgA,
    processId: p.p2,
    kind: "judicial_deposit",
    amountCents: 1_000_000,
    status: "linked",
  });

  // Closed snapshots: prevPeriod (target) and prev2Period (previous closed); a preview of the current month.
  const params = { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 1, confidenceThreshold: 85 };
  const metrics = {} as never;
  const [sPrev] = await fx.db
    .insert(portfolioSnapshots)
    .values({
      organizationId: fx.orgA,
      period: prevPeriod,
      referenceDate: periodReferenceDate(prevPeriod),
      status: "closed",
      metrics,
      params,
      closedAt: new Date(),
      closedById: fx.ctx.accountant.userId,
    })
    .returning();
  const [sPrev2] = await fx.db
    .insert(portfolioSnapshots)
    .values({
      organizationId: fx.orgA,
      period: prev2Period,
      referenceDate: periodReferenceDate(prev2Period),
      status: "closed",
      metrics,
      params,
      closedAt: new Date(),
    })
    .returning();
  await fx.db.insert(portfolioSnapshots).values({
    organizationId: fx.orgA,
    period: currentPeriod,
    referenceDate: periodReferenceDate(currentPeriod),
    status: "preview",
    metrics,
    params,
  });

  const item = (
    snapshotId: string,
    key: string,
    v: Partial<typeof portfolioSnapshotItems.$inferInsert> & { number: string },
  ) => ({
    organizationId: fx.orgA,
    snapshotId,
    processId: p[key],
    guaranteesCents: 0,
    ...v,
  });
  await fx.db.insert(portfolioSnapshotItems).values([
    item(sPrev.id, "p1", {
      number: "0000001-11.2025.5.10.0001",
      court: "TRT10",
      city: "Palmas",
      phase: "knowledge",
      unitId: fx.unitSp,
      companyId: fx.companyA,
      classification: "possible",
      percentageBp: 5000,
      claimAmountCents: 8_000_000,
      exposureCents: 4_000_000,
      exposureIsEstimate: true,
      provisionCents: 4_000_000,
      provisionIsEstimate: true,
    }),
    item(sPrev.id, "p2", {
      number: "0000002-11.2025.5.10.0001",
      court: "TRT10",
      city: "Palmas",
      phase: "liquidation",
      unitId: fx.unitSp,
      companyId: fx.companyA,
      classification: "probable",
      percentageBp: 10000,
      claimAmountCents: 2_000_000,
      liquidatedAmountCents: 3_000_000,
      exposureCents: 3_000_000,
      provisionCents: 3_000_000,
    }),
    item(sPrev.id, "p6", {
      number: "0000006-11.2025.5.02.0001",
      court: "TRT2",
      phase: "enforcement",
      unitId: fx.unitSp,
      companyId: fx.companyA,
      classification: "probable",
      percentageBp: 10000,
      liquidatedAmountCents: 500_000,
      exposureCents: 500_000,
      provisionCents: 500_000,
    }),
    item(sPrev.id, "p5", {
      number: "0000005-11.2025.5.00.0001",
      court: "TST",
      phase: "appeal",
      unitId: fx.unitSp,
      companyId: fx.companyA,
      isConfidential: true,
      classification: "probable",
      percentageBp: 10000,
      liquidatedAmountCents: 7_000_000,
      exposureCents: 7_000_000,
      provisionCents: 7_000_000,
    }),
    item(sPrev2.id, "p1", {
      number: "0000001-11.2025.5.10.0001",
      court: "TRT10",
      unitId: fx.unitSp,
      companyId: fx.companyA,
      classification: "possible",
      percentageBp: 5000,
      claimAmountCents: 8_000_000,
      exposureCents: 4_000_000,
      exposureIsEstimate: true,
      provisionCents: 4_000_000,
      provisionIsEstimate: true,
    }),
    item(sPrev2.id, "p2", {
      number: "0000002-11.2025.5.10.0001",
      court: "TRT10",
      unitId: fx.unitSp,
      companyId: fx.companyA,
      classification: "probable",
      percentageBp: 10000,
      liquidatedAmountCents: 2_500_000,
      exposureCents: 2_500_000,
      provisionCents: 2_500_000,
    }),
    item(sPrev2.id, "p3", {
      number: "0000003-11.2025.5.02.0001",
      court: "TRT2",
      unitId: fx.unitRe,
      companyId: companyA2,
      classification: "remote",
      percentageBp: 0,
      liquidatedAmountCents: 1_000_000,
      exposureCents: 1_000_000,
      provisionCents: 0,
    }),
  ]);

  // Valuations: an old official value superseded by a new one in the period; a proposed one; a confidential one.
  const longAgo = new Date(Date.now() - 40 * 86_400_000);
  const [old] = await fx.db
    .insert(processValuations)
    .values({
      organizationId: fx.orgA,
      processId: p.p2,
      kind: "liquidated",
      amountCents: 2_500_000,
      baseDate: addDaysISO(today, -40),
      source: "manual",
      status: "superseded",
      reviewedById: fx.ctx.accountant.userId,
      reviewedAt: longAgo,
      createdAt: longAgo,
    })
    .returning();
  await fx.db.insert(processValuations).values([
    {
      organizationId: fx.orgA,
      processId: p.p2,
      kind: "liquidated",
      amountCents: 3_000_000,
      baseDate: today,
      source: "document",
      status: "official",
      supersedesId: old.id,
      reviewedById: fx.ctx.accountant.userId,
      reviewedAt: new Date(),
    },
    {
      organizationId: fx.orgA,
      processId: p.p1,
      kind: "liquidated",
      amountCents: 4_200_000,
      baseDate: today,
      source: "simulation",
      status: "proposed",
      confidence: 60,
    },
    {
      organizationId: fx.orgA,
      processId: p.p5,
      kind: "liquidated",
      amountCents: 7_000_000,
      baseDate: today,
      source: "manual",
      status: "official",
      reviewedById: fx.ctx.admin.userId,
      reviewedAt: new Date(),
    },
  ]);

  // Audit trail: a phase change, a status change to suspended, a create (ignored) and a closure status (listed by date instead).
  await fx.db.insert(auditLogs).values([
    {
      organizationId: fx.orgA,
      actorId: fx.ctx.admin.userId,
      action: "legal_process.update",
      entityType: "legal_process",
      entityId: p.p1,
      summary: "x",
      changes: { phase: { from: "pre_filing", to: "knowledge" } },
    },
    {
      organizationId: fx.orgA,
      actorId: fx.ctx.admin.userId,
      action: "legal_process.update",
      entityType: "legal_process",
      entityId: p.p7,
      summary: "x",
      changes: { status: { from: "active", to: "suspended" } },
    },
    {
      organizationId: fx.orgA,
      actorId: fx.ctx.admin.userId,
      action: "legal_process.create",
      entityType: "legal_process",
      entityId: p.p4,
      summary: "x",
      changes: { phase: { from: null, to: "knowledge" } },
    },
    {
      organizationId: fx.orgA,
      actorId: fx.ctx.admin.userId,
      action: "legal_process.update",
      entityType: "legal_process",
      entityId: p.p6,
      summary: "x",
      changes: { status: { from: "active", to: "closed" } },
    },
    {
      organizationId: fx.orgA,
      actorId: fx.ctx.admin.userId,
      action: "legal_process.update",
      entityType: "legal_process",
      entityId: p.p5,
      summary: "x",
      changes: { phase: { from: "knowledge", to: "appeal" } },
    },
    {
      // P0.5 data migration: a reclassification of the model, not a procedural phase change.
      organizationId: fx.orgA,
      actorId: null,
      action: "legal_process.phase_migration",
      entityType: "legal_process",
      entityId: p.p3,
      summary: "x",
      changes: { phase: { from: "appeal", to: "knowledge" } },
    },
  ]);
});

afterAll(async () => fx?.teardown());

describe("carteira report", () => {
  it("keeps valor da causa and valor liquidado apart and counts unknown values (RN-02 / RN-03)", async () => {
    const r = await getPortfolioReport(fx.ctx.admin);
    const t = r.totals.bucket;
    expect(r.totals.processCount).toBe(6); // p1, p2, p3, p4, p5, p7 (p6 is closed)
    expect(t.claimCents).toBe(10_000_000 + 2_000_000 + 500_000 + 7_000_000 + 300_000);
    expect(t.claimUnknown).toBe(1);
    expect(t.liquidatedCents).toBe(3_000_000 + 1_000_000 + 7_000_000);
    expect(t.liquidatedUnknown).toBe(3);
    expect(t.guaranteesCents).toBe(1_000_000);
    // Official exposure: p2 (3M − 1M guarantee) + p3 1M + p5 7M; estimate: p1 10M × 50% (+ p7 at 0%).
    expect(t.exposureCents).toBe(2_000_000 + 1_000_000 + 7_000_000);
    expect(t.exposureEstimateCents).toBe(5_000_000);
    expect(t.exposureUnknown).toBe(1); // p4: no liquidated value and no classification
    expect(t.provisionCents).toBe(2_000_000 + 7_000_000);
    expect(t.provisionEstimateCents).toBe(5_000_000);
    expect(r.hasEstimates).toBe(true);
    expect(r.scope.includesConfidential).toBe(true);
  });

  it("groups by company, unit and classification", async () => {
    const r = await getPortfolioReport(fx.ctx.admin);
    const a = r.byCompany.find((g) => g.key === fx.companyA)!;
    expect(a.processCount).toBe(3); // p1, p2, p5
    expect(r.byCompany.at(-1)!.label).toBe("Sem empresa informada");
    expect(r.byCompany.at(-1)!.bucket.liquidatedUnknown).toBe(1);
    const re = r.byUnit.find((g) => g.key === fx.unitRe)!;
    expect(re.processCount).toBe(2); // p3, p7
    expect(r.byClassification.map((c) => c.key)).toEqual(["probable", "possible", "remote", "unclassified"]);
    expect(r.byClassification.find((c) => c.key === "unclassified")!.processCount).toBe(2); // p3, p4
  });

  it("filters by company and rejects a company of another organization", async () => {
    const r = await getPortfolioReport(fx.ctx.admin, { companyId: companyA2 });
    expect(r.totals.processCount).toBe(2);
    expect(r.filterSummary).toContain("Empresa Fictícia B");
    await expect(getPortfolioReport(fx.ctx.adminB, { companyId: fx.companyA })).rejects.toBeInstanceOf(ValidationError);
  });

  it("applies row visibility: executive without confidential, lawyer only visible processes", async () => {
    const exec = await getPortfolioReport(fx.ctx.executive);
    expect(exec.totals.processCount).toBe(5);
    expect(exec.scope.orgWide).toBe(true);
    expect(exec.scope.includesConfidential).toBe(false);
    expect(exec.totals.label).toBe("Total da organização (exceto sigilosos)");

    const lawyer = await getPortfolioReport(fx.ctx.lawyer);
    // SP unit (p1, p2), no unit (p4) and own responsibility in RE (p7); not the confidential p5 nor p3 (RE).
    expect(lawyer.totals.processCount).toBe(4);
    expect(lawyer.scope.orgWide).toBe(false);
    expect(lawyer.totals.label).toBe("Total dos processos visíveis para você");

    const accountant = await getPortfolioReport(fx.ctx.accountant);
    expect(accountant.totals.processCount).toBe(5);
  });

  it("isolates organizations and requires report:read", async () => {
    const b = await getPortfolioReport(fx.ctx.adminB);
    expect(b.totals.processCount).toBe(1);
    expect(b.totals.bucket.claimCents).toBe(99_000_000);
    await expect(getPortfolioReport(fx.ctx.externalCounsel)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("exposição report", () => {
  it("compares the current position with the previous month's snapshot", async () => {
    const r = await getExposureReport(fx.ctx.admin);
    expect(r.comparison?.period).toBe(prevPeriod);
    // The closed competência keeps p5 in the former "Recursal" phase (RN-10): explained, never recalculated (P0.5).
    expect(r.comparisonNote).toBe(
      "Na dimensão Fase, a competência de comparação usa fases do modelo anterior à separação entre fase e instância (Recursal): os valores dela não são recalculados.",
    );
    const phases = r.dimensions.find((d) => d.key === "phase")!;
    const legacy = phases.rows.find((g) => g.key === "appeal")!;
    expect(legacy).toMatchObject({ label: "Recursal", processCount: 0 });
    expect(legacy.previous?.processCount).toBe(1);
    expect(phases.rows.find((g) => g.key === "knowledge")!.label).toBe("Conhecimento");
    const courts = r.dimensions.find((d) => d.key === "court")!;
    const trt10 = courts.rows.find((g) => g.label === "TRT10")!;
    expect(trt10.processCount).toBe(3); // p1, p2, p4
    expect(trt10.previous).toEqual({
      processCount: 2,
      exposureCents: 3_000_000,
      exposureEstimateCents: 4_000_000,
      exposureUnknown: 0,
      exposureBasis: { official: 1, estimate: 1, none: 0 },
    });
    // TRT2 had p6 (now closed) in the snapshot and has p3/p7 now.
    const trt2 = courts.rows.find((g) => g.label === "TRT2")!;
    expect(trt2.previous?.processCount).toBe(1);
    const cities = r.dimensions.find((d) => d.key === "city")!;
    expect(cities.rows.find((g) => g.label === "Palmas")!.processCount).toBe(3); // "Palmas - TO", "Palmas/TO", "Palmas"
  });

  it("labels a preview comparison and explains when there is no snapshot", async () => {
    const preview = await getExposureReport(fx.ctx.admin, { period: currentPeriod });
    expect(preview.comparison?.status).toBe("preview");
    expect(preview.comparisonNote).toContain("PRÉVIA");
    const none = await getExposureReport(fx.ctx.admin, { period: "2001-01" });
    expect(none.comparison).toBeNull();
    expect(none.comparisonNote).toContain("Não há fechamento mensal");
    expect(none.dimensions[0].rows.every((row) => row.previous === null)).toBe(true);
  });

  it("does not leak confidential snapshot items to the executive", async () => {
    const r = await getExposureReport(fx.ctx.executive);
    const tst = r.dimensions.find((d) => d.key === "court")!.rows.find((g) => g.label === "TST");
    expect(tst).toBeUndefined();
    expect(r.totals.previous?.processCount).toBe(3); // p1, p2, p6
  });
});

describe("provisão report", () => {
  it("reads the latest CLOSED period and the movement since the previous closed one", async () => {
    const r = await getProvisionReport(fx.ctx.admin);
    expect(r.snapshot?.period).toBe(prevPeriod);
    expect(r.previous?.period).toBe(prev2Period);
    expect(r.closedPeriods).toEqual([prevPeriod, prev2Period]);
    expect(r.totals.current).toEqual({ provisionCents: 3_000_000 + 500_000 + 7_000_000, provisionEstimateCents: 4_000_000 });
    expect(r.hasEstimates).toBe(true);
    const probable = r.byClassification.find((c) => c.key === "probable")!;
    expect(probable.percentageBp).toBe(10000);
    expect(probable.processCount).toBe(3);

    const mv = r.movement!;
    const byKind = Object.fromEntries(mv.rows.map((m) => [m.kind, m]));
    expect(byKind.entered.processCount).toBe(2); // p5, p6
    expect(byKind.entered.provisionCents).toBe(7_500_000);
    expect(byKind.changed.processCount).toBe(1); // p2
    expect(byKind.changed.provisionCents).toBe(500_000);
    expect(byKind.left.processCount).toBe(1); // p3
    expect(byKind.unchanged.processCount).toBe(1); // p1
    // Opening + movements = closing.
    const sum = mv.rows.reduce((acc, m) => acc + m.provisionCents, mv.opening.provisionCents);
    expect(sum).toBe(mv.closing.provisionCents);
  });

  it("never reads a preview period and applies visibility", async () => {
    const preview = await getProvisionReport(fx.ctx.admin, { period: currentPeriod });
    expect(preview.snapshot).toBeNull();
    const exec = await getProvisionReport(fx.ctx.executive);
    expect(exec.totals.current.provisionCents).toBe(3_500_000);
    expect(exec.items.some((i) => i.processId === p.p5)).toBe(false);
  });
});

describe("carta de auditoria", () => {
  it("lists the current position with caveats and signature-ready totals", async () => {
    const r = await getAuditLetterReport(fx.ctx.admin);
    expect(r.source).toBe("current");
    expect(r.baseDate).toBe(today);
    expect(r.rows).toHaveLength(6);
    const p1 = r.rows.find((x) => x.processId === p.p1)!;
    expect(p1.provisionIsEstimate).toBe(true);
    expect(p1.caveats.join(" ")).toContain("Provisão estimada sobre o valor da causa (sem valor liquidado).");
    expect(p1.caveats.join(" ")).toContain("Valor liquidado não apurado");
    const p3 = r.rows.find((x) => x.processId === p.p3)!;
    expect(p3.caveats.join(" ")).toContain("Sem classificação de risco");
    expect(p3.caveats.join(" ")).toContain("conferência interna");
    expect(r.totals.liquidatedUnknown).toBe(3);
    expect(r.generalCaveats.join(" ")).toContain("Não constitui parecer jurídico");
    expect(r.hasEstimates).toBe(true);
  });

  it("reads a closed period from the snapshot and refuses periods that are not closed", async () => {
    const r = await getAuditLetterReport(fx.ctx.admin, { period: prevPeriod });
    expect(r.source).toBe("snapshot");
    expect(r.baseDate).toBe(periodReferenceDate(prevPeriod));
    expect(r.rows.map((x) => x.processId).sort()).toEqual([p.p1, p.p2, p.p5, p.p6].sort());
    // RN-10: the closed competência keeps the phase frozen at the close, even one of the previous model (P0.5).
    const p5 = r.rows.find((x) => x.processId === p.p5)!;
    expect(p5.phase).toBe("appeal");
    expect(processPhaseLabel(p5.phase)).toBe("Recursal");
    expect(buildReportExport(r).sheets[0].rows.find((row) => row[0]?.v === "0000005-11.2025.5.00.0001")?.[5]?.v).toBe("Recursal");
    await expect(getAuditLetterReport(fx.ctx.admin, { period: currentPeriod })).rejects.toBeInstanceOf(ValidationError);
    const exec = await getAuditLetterReport(fx.ctx.executive, { period: prevPeriod });
    expect(exec.rows.some((x) => x.processId === p.p5)).toBe(false);
  });
});

describe("movimentação report", () => {
  it("lists additions, closures with reason, official value changes and phase/status changes", async () => {
    const r = await getMovementReport(fx.ctx.admin, { from: today, to: today });
    expect(r.summary.added).toBe(7);
    expect(r.summary.closed).toBe(1);
    expect(r.summary.closedByReason).toEqual([{ reason: "paid_extinct", label: "Pago / extinto pela satisfação", count: 1 }]);
    const change = r.events.find((e) => e.kind === "value_change" && e.processId === p.p2)!;
    expect(change.previousCents).toBe(2_500_000);
    expect(change.newCents).toBe(3_000_000);
    expect(r.summary.valueChanges).toBe(2); // p2 and p5 (official in the period); the superseded one is from 40 days ago
    expect(r.pendingProposedValuations).toBe(1);
    expect(r.summary.phaseChanges).toBe(2); // p1 and p5; the creation entry is ignored
    expect(r.summary.statusChanges).toBe(1); // p7 suspended; closure of p6 is listed by its closing date
    expect(r.events.find((e) => e.kind === "phase_change" && e.processId === p.p1)!.detail).toBe("Pré-ajuizamento → Conhecimento");
    // History keeps the phases of the previous model with their former labels; the migration entry is not a phase change.
    expect(r.events.find((e) => e.kind === "phase_change" && e.processId === p.p5)!.detail).toBe("Conhecimento → Recursal");
    expect(r.events.some((e) => e.kind === "phase_change" && e.processId === p.p3)).toBe(false);
  });

  it("respects visibility and the period", async () => {
    const exec = await getMovementReport(fx.ctx.executive, { from: today, to: today });
    expect(exec.events.some((e) => e.processId === p.p5)).toBe(false);
    expect(exec.summary.valueChanges).toBe(1);
    const past = await getMovementReport(fx.ctx.admin, { from: "2001-01-01", to: "2001-01-31" });
    expect(past.events).toHaveLength(0);
    await expect(getMovementReport(fx.ctx.admin, { from: today, to: addDaysISO(today, -1) })).rejects.toBeInstanceOf(ValidationError);
    const b = await getMovementReport(fx.ctx.adminB, { from: today, to: today });
    expect(b.events.every((e) => !Object.values(p).includes(e.processId))).toBe(true);
  });
});

describe("responsáveis report", () => {
  it("groups by responsible lawyer and law firm", async () => {
    const r = await getResponsiblesReport(fx.ctx.admin);
    const laura = r.lawyers.find((g) => g.key === fx.ctx.lawyer.userId)!;
    expect(laura.processCount).toBe(3); // p1, p2, p7
    expect(laura.unclassified).toBe(0);
    expect(r.lawyers.at(-1)!.label).toBe("Sem responsável definido");
    expect(r.lawyers.at(-1)!.processCount).toBe(2); // p4, p5
    const firm = r.lawFirms.find((g) => g.key === fx.lawFirmA)!;
    expect(firm.processCount).toBe(2); // p2, p4
    expect(r.totals.unclassified).toBe(2);
  });
});

describe("exports", () => {
  it("exports CSV with BOM, ';', decimal comma and empty unknown cells, and audits without content", async () => {
    const file = await exportReport(fx.ctx.admin, "carteira", {}, "csv");
    expect([...file.body.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM bytes
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(file.body);
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(file.fileName).toMatch(/^relatorio-carteira-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.contentType).toContain("text/csv");
    const lines = text.slice(1).split("\r\n");
    expect(lines[0].split(";")).toContain("Valor da causa (R$)");
    expect(lines[0].split(";")).toContain("Valor liquidado (R$)");
    const total = lines.find((l) => l.startsWith("Total;"))!.split(";");
    expect(total[3]).toBe("198000,00"); // valor da causa
    expect(total[5]).toBe("110000,00"); // valor liquidado — separate column (RN-02)
    const noCompany = lines.find((l) => l.startsWith("Empresa;Sem empresa informada"))!.split(";");
    expect(noCompany[5]).toBe(""); // liquidated unknown -> empty (RN-03)
    expect(noCompany[6]).toBe("1");

    const [audit] = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, fx.orgA), eq(auditLogs.action, "report.export")));
    expect(audit.actorId).toBe(fx.ctx.admin.userId);
    expect(audit.entityType).toBe("organization");
    expect(audit.metadata).toMatchObject({ reportType: "carteira", format: "csv", rowCount: file.rowCount });
    expect(JSON.stringify(audit.metadata)).not.toContain("Processo fictício");
  });

  it("exports XLSX for every report type", async () => {
    for (const type of ["carteira", "exposicao", "provisao", "auditoria", "movimentacao", "responsaveis"] as const) {
      const file = await exportReport(fx.ctx.manager, type, {}, "xlsx");
      expect(Buffer.from(file.body.slice(0, 2)).toString("latin1")).toBe("PK");
      expect(file.fileName.endsWith(".xlsx")).toBe(true);
    }
  });

  it("refuses exports without report:read", async () => {
    await expect(exportReport(fx.ctx.externalCounsel, "carteira", {}, "csv")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lists filter options of the organization only", async () => {
    const opts = await listReportFilterOptions(fx.ctx.admin);
    expect(opts.companies.map((c) => c.id)).toContain(companyA2);
    expect(opts.snapshots.map((s) => s.period)).toEqual([currentPeriod, prevPeriod, prev2Period]);
    const b = await listReportFilterOptions(fx.ctx.adminB);
    expect(b.companies).toHaveLength(0);
    expect(b.snapshots).toHaveLength(0);
  });
});
