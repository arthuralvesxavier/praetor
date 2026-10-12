import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { periodReferenceDate, previousPeriod } from "@/domain/contingency";
import { addDaysISO, todayISO } from "@/lib/format";
import { addValuation, proposeValuation } from "@/modules/contingency/service";
import { createGuarantee } from "@/modules/contingency/guarantee-service";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { runMonthlySnapshotRoutine, runPortfolioAlertsRoutine } from "@/modules/contingency/routines";
import {
  createSettlement,
  listProcessSettlements,
  listSettlements,
  listUpcomingInstallments,
  setInstallmentPaid,
  setSettlementStatus,
  updateSettlementNotes,
  updateSettlementTerms,
} from "@/modules/contingency/settlement-service";
import {
  closeSnapshot,
  exportSnapshotCsv,
  generateSnapshot,
  getSnapshot,
  listSnapshots,
} from "@/modules/contingency/snapshot-service";
import { periodOf } from "@/modules/contingency/rules";
import { mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import type { RoutineContext } from "@/server/jobs/routines";
import {
  alerts,
  auditLogs,
  legalProcesses,
  portfolioSnapshotItems,
  processGuarantees,
  processRiskAssessments,
} from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let f: Fixture;
const today = todayISO();
const d = (days: number) => addDaysISO(today, days);
const current = periodOf(today);
const previous = previousPeriod(current);
const beforePrevious = previousPeriod(previous);
let seq = 0;

async function insertProcess(overrides: Partial<typeof legalProcesses.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      number: `${String(seq).padStart(7, "0")}-22.2026.5.10.0002`,
      title: `Processo fictício ${seq}`,
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      ...overrides,
    })
    .returning({ id: legalProcesses.id });
  return p.id;
}

/**
 * Records an official classification (opinion + identified person, through the real service)
 * for every live process of organization A that has none, keeping the classification typed on
 * the record ("remoto" when there is none), in force from `effectiveFrom`.
 */
async function classifyPending(effectiveFrom: string): Promise<void> {
  const pending = await f.db
    .select({ id: legalProcesses.id, loss: legalProcesses.lossProbability })
    .from(legalProcesses)
    .where(
      and(
        eq(legalProcesses.organizationId, f.orgA),
        isNull(legalProcesses.deletedAt),
        notExists(
          f.db
            .select({ one: sql`1` })
            .from(processRiskAssessments)
            .where(and(eq(processRiskAssessments.processId, legalProcesses.id), eq(processRiskAssessments.status, "official"))),
        ),
      ),
    );
  for (const p of pending) {
    await addRiskAssessment(f.ctx.manager, p.id, {
      classification: p.loss ?? "remote",
      opinion: "Parecer fictício de teste para o fechamento mensal.",
      effectiveFrom,
    });
  }
}

async function expectError<T extends Error>(p: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected ${type.name}`);
}

beforeAll(async () => {
  f = await setupFixture("close");
});

afterAll(async () => {
  await f?.teardown();
});

describe("settlements", () => {
  it("creates installments split evenly, follows the state machine and requires paid installments to fulfil", async () => {
    const processId = await insertProcess();
    const { id } = await createSettlement(f.ctx.lawyer, {
      processId,
      status: "negotiating",
      totalAmountCents: 1_000_000,
      installmentsCount: 3,
      firstDueDate: d(5),
      notes: "Proposta fictícia.",
    });
    let [s] = await listProcessSettlements(f.ctx.manager, processId);
    expect(s.installments.map((i) => i.amountCents)).toEqual([333_333, 333_333, 333_334]);
    expect(s.installments[0].dueDate).toBe(d(5));

    await expectError(setSettlementStatus(f.ctx.lawyer, id, { status: "fulfilled" }), ConflictError);
    await updateSettlementTerms(f.ctx.lawyer, id, { totalAmountCents: 600_000, installmentsCount: 2, firstDueDate: d(3) });
    [s] = await listProcessSettlements(f.ctx.manager, processId);
    expect(s.installments.map((i) => i.amountCents)).toEqual([300_000, 300_000]);

    await setSettlementStatus(f.ctx.lawyer, id, { status: "signed" });
    await setSettlementStatus(f.ctx.lawyer, id, { status: "homologated" });
    [s] = await listProcessSettlements(f.ctx.manager, processId);
    expect(s.status).toBe("homologated");
    expect(s.signedAt).toBe(today);
    expect(s.homologatedAt).toBe(today);

    const upcoming = await listUpcomingInstallments(f.ctx.manager, { days: 10 });
    expect(upcoming.items.some((i) => i.settlementId === id)).toBe(true);
    const dueSoon = await listSettlements(f.ctx.manager, { dueSoon: true });
    expect(dueSoon.items.some((i) => i.id === id)).toBe(true);

    await expectError(setSettlementStatus(f.ctx.lawyer, id, { status: "fulfilled" }), ConflictError);
    await setInstallmentPaid(f.ctx.lawyer, s.installments[0].id, { paid: true, paidAt: today });
    await expectError(setInstallmentPaid(f.ctx.lawyer, s.installments[0].id, { paid: true }), ConflictError);
    await expectError(updateSettlementTerms(f.ctx.lawyer, id, { totalAmountCents: 1, installmentsCount: 1, firstDueDate: d(1) }), ConflictError);
    await setInstallmentPaid(f.ctx.lawyer, s.installments[1].id, { paid: true });
    await setSettlementStatus(f.ctx.lawyer, id, { status: "fulfilled" });
    [s] = await listProcessSettlements(f.ctx.manager, processId);
    expect(s.status).toBe("fulfilled");
    expect(s.paidCents).toBe(600_000);
    await expectError(setSettlementStatus(f.ctx.lawyer, id, { status: "breached" }), ConflictError);
    await updateSettlementNotes(f.ctx.lawyer, id, { notes: "Cumprido integralmente (fictício)." });
  });

  it("cancelling cancels pending installments; validation and permissions apply", async () => {
    const processId = await insertProcess();
    await expectError(
      createSettlement(f.ctx.lawyer, { processId, installmentsCount: 2, firstDueDate: d(1) }),
      ValidationError,
    );
    await expectError(createSettlement(f.ctx.executive, { processId }), ForbiddenError);
    await expectError(createSettlement(f.ctx.adminB, { processId }), NotFoundError);
    const { id } = await createSettlement(f.ctx.lawyer, { processId, status: "signed", totalAmountCents: 100, installmentsCount: 2, firstDueDate: d(1) });
    await setSettlementStatus(f.ctx.lawyer, id, { status: "cancelled" });
    const [s] = await listProcessSettlements(f.ctx.manager, processId);
    expect(s.installments.every((i) => i.status === "cancelled")).toBe(true);
    await expectError(setInstallmentPaid(f.ctx.lawyer, s.installments[0].id, { paid: true }), ConflictError);
  });

  it("settlements follow the process visibility", async () => {
    const confidential = await insertProcess({ isConfidential: true });
    await createSettlement(f.ctx.manager, { processId: confidential, totalAmountCents: 1_000 });
    const acc = await listSettlements(f.ctx.accountant);
    expect(acc.items.some((s) => s.processId === confidential)).toBe(false);
    const mgr = await listSettlements(f.ctx.manager);
    expect(mgr.items.some((s) => s.processId === confidential)).toBe(true);
    expect((await listSettlements(f.ctx.adminB)).total).toBe(0);
  });
});

describe("monthly close (RN-05, RN-10, RF-16)", () => {
  let p1: string;
  let p2: string;
  let secret: string;

  beforeAll(async () => {
    // p1: liquidated value with base date in the previous month, probable risk, guarantee.
    p1 = await insertProcess({ claimAmountCents: 5_000_000, number: "1000001-00.2026.5.10.0001" });
    await addRiskAssessment(f.ctx.lawyer, p1, {
      classification: "probable",
      opinion: "Condenação em primeira instância (fictício).",
      effectiveFrom: `${beforePrevious}-01`,
    });
    await addValuation(f.ctx.manager, { processId: p1, kind: "liquidated", amountCents: 1_000_000, baseDate: `${previous}-10` });
    await createGuarantee(f.ctx.manager, p1, { kind: "appeal_deposit", amountCents: 200_000, depositedAt: `${previous}-05` });
    // p2: only claim value and "possível" → estimate (RN-07).
    p2 = await insertProcess({ claimAmountCents: 800_000, lossProbability: "possible", number: "1000002-00.2026.5.10.0001" });
    // Confidential process: org-wide totals only.
    secret = await insertProcess({ claimAmountCents: 100_000, lossProbability: "probable", isConfidential: true, number: "1000003-00.2026.5.10.0001" });
    // P1.9 close gate: every active process needs an OFFICIAL classification in force on the
    // reference date (the record classification does not count), the settlements ones included.
    await classifyPending(`${beforePrevious}-01`);
  });

  it("generates the preview with values on/before the reference date", async () => {
    const r = await generateSnapshot(f.ctx.accountant, previous);
    expect(r.status).toBe("preview");
    const items = await f.db.select().from(portfolioSnapshotItems).where(eq(portfolioSnapshotItems.snapshotId, r.id));
    const i1 = items.find((i) => i.processId === p1)!;
    expect(i1.liquidatedAmountCents).toBe(1_000_000);
    expect(i1.guaranteesCents).toBe(200_000);
    expect(i1.provisionCents).toBe(800_000); // (1.000.000 − 200.000) × 100%
    expect(i1.provisionIsEstimate).toBe(false);
    const i2 = items.find((i) => i.processId === p2)!;
    expect(i2.liquidatedAmountCents).toBeNull();
    expect(i2.provisionCents).toBe(400_000);
    expect(i2.provisionIsEstimate).toBe(true);
    expect(r.metrics.totals.confidentialCount).toBeGreaterThanOrEqual(1);
    expect(r.metrics.byClassification.probable.count).toBeGreaterThanOrEqual(2);

    // The month before the liquidated value: no liquidated value yet.
    const older = await generateSnapshot(f.ctx.accountant, beforePrevious);
    const olderItems = await f.db.select().from(portfolioSnapshotItems).where(eq(portfolioSnapshotItems.snapshotId, older.id));
    expect(olderItems.find((i) => i.processId === p1)!.liquidatedAmountCents).toBeNull();
    expect(olderItems.find((i) => i.processId === p1)!.guaranteesCents).toBe(0);
  });

  it("only snapshot:close closes; a closed period is immutable (RN-10)", async () => {
    await expectError(closeSnapshot(f.ctx.lawyer, previous), ForbiddenError);
    await expectError(generateSnapshot(f.ctx.lawyer, previous), ForbiddenError);
    await expectError(closeSnapshot(f.ctx.accountant, "2099-01"), ValidationError);
    const closed = await closeSnapshot(f.ctx.accountant, previous);
    expect(closed.override).toBeNull(); // every item classified: closed without reservation
    await expectError(closeSnapshot(f.ctx.accountant, previous), ConflictError);
    await expectError(generateSnapshot(f.ctx.manager, previous), ConflictError);

    const before = await f.db
      .select()
      .from(portfolioSnapshotItems)
      .innerJoin(legalProcesses, eq(legalProcesses.id, portfolioSnapshotItems.processId))
      .where(eq(portfolioSnapshotItems.processId, p1));
    // A late value with base date inside the closed period does not change the closed items.
    await addValuation(f.ctx.manager, { processId: p1, kind: "liquidated", amountCents: 1_500_000, baseDate: `${previous}-20` });
    const view = await getSnapshot(f.ctx.manager, previous);
    expect(view?.status).toBe("closed");
    expect(view?.items.find((i) => i.processId === p1)?.liquidatedAmountCents).toBe(1_000_000);
    expect(before.length).toBeGreaterThan(0);
    const audit = await f.db.select().from(auditLogs).where(eq(auditLogs.action, "snapshot.close"));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBe(f.ctx.accountant.userId);
  });

  it("current preview compares with the previous period and lists the movement", async () => {
    await generateSnapshot(f.ctx.manager, current);
    const view = (await getSnapshot(f.ctx.manager, current))!;
    expect(view.previous?.period).toBe(previous);
    expect(view.variation).not.toBeNull();
    const change = view.movement?.provisionChanges.find((c) => c.processId === p1);
    expect(change?.fromCents).toBe(800_000);
    expect(change?.toCents).toBe(1_300_000);
    expect(view.variation!.provisionCents).toBe(view.totals.provisionCents - view.previous!.totals.provisionCents);
  });

  it("row visibility: accountant sees non-confidential items and org-wide totals with the hidden count", async () => {
    const acc = (await getSnapshot(f.ctx.accountant, previous))!;
    expect(acc.scope).toBe("org_wide");
    expect(acc.items.some((i) => i.processId === secret)).toBe(false);
    expect(acc.hiddenCount).toBeGreaterThanOrEqual(1);
    expect(acc.totals.count).toBe(acc.itemsTotal + acc.hiddenCount);

    const ext = (await getSnapshot(f.ctx.externalCounsel, previous))!;
    expect(ext.scope).toBe("visible");
    expect(ext.items).toHaveLength(0);
    expect(ext.totals.count).toBe(0);
    expect((await listSnapshots(f.ctx.externalCounsel))[0].totals).toBeNull();

    const mgr = (await getSnapshot(f.ctx.manager, previous))!;
    expect(mgr.items.some((i) => i.processId === secret)).toBe(true);
    expect(await getSnapshot(f.ctx.adminB, previous)).toBeNull();
  });

  it("CSV for accounting: estimate caveat, hidden confidential note, empty null cells", async () => {
    const { fileName, content } = await exportSnapshotCsv(f.ctx.accountant, previous);
    expect(fileName).toBe(`fechamento-${previous}.csv`);
    expect(content.startsWith("﻿")).toBe(true);
    expect(content).toContain("ATENÇÃO: ");
    expect(content).not.toMatch(/\b(RN|RF|TE)-\d/);
    expect(content).toContain("sigiloso(s) não listado(s)");
    expect(content).not.toContain("1000003-00.2026.5.10.0001");
    expect(content).toContain("1000002-00.2026.5.10.0001");
    await expectError(exportSnapshotCsv(f.ctx.adminB, previous), NotFoundError);
  });

  it("monthly routine refreshes the current preview and never touches closed periods", async () => {
    const settings = mergeOrganizationSettings(null);
    const rc: RoutineContext = { organizationId: f.orgA, isDemo: false, settings, config: {}, today };
    const msg = await runMonthlySnapshotRoutine(rc);
    expect(msg).toContain("Prévia da competência");
    const closedRc = { ...rc, today: periodReferenceDate(previous) };
    expect(await runMonthlySnapshotRoutine(closedRc)).toContain("já fechada");
  });
});

describe("portfolio alerts routine", () => {
  it("creates one alert per condition and resolves alerts when the condition disappears", async () => {
    const enforcement = await insertProcess({ phase: "enforcement" });
    const verify = await insertProcess({ needsVerification: true, verificationNote: "Saiu do acervo — verificar (fictício)." });
    const pendingProc = await insertProcess();
    await proposeValuation(f.ctx.admin, { processId: pendingProc, kind: "claim", amountCents: 1, baseDate: d(-1), source: "manual" });
    await proposeValuation(f.ctx.admin, { processId: pendingProc, kind: "liquidated", amountCents: 2, baseDate: d(-1), source: "manual" });
    const settlementProc = await insertProcess();
    const { id: settlementId } = await createSettlement(f.ctx.manager, {
      processId: settlementProc,
      status: "signed",
      totalAmountCents: 10_000,
      installmentsCount: 2,
      firstDueDate: d(2),
    });
    const guaranteeProc = await insertProcess();
    const g = await createGuarantee(f.ctx.manager, guaranteeProc, { kind: "judicial_deposit", amountCents: 1_000, depositedAt: d(-400) });

    const settings = mergeOrganizationSettings(null);
    const rc: RoutineContext = { organizationId: f.orgA, isDemo: false, settings, config: {}, today };
    const summary = await runPortfolioAlertsRoutine(rc);
    expect(summary).toContain("alerta(s) encerrado(s)");
    const open = await f.db.select().from(alerts).where(and(eq(alerts.organizationId, f.orgA), isNull(alerts.resolvedAt)));
    const byKey = new Map(open.map((a) => [a.dedupeKey, a]));
    expect(byKey.get(`enforcement_without_value:${enforcement}`)?.entityType).toBe("legal_process");
    expect(byKey.get(`process_needs_verification:${verify}`)?.message).toContain("Saiu do acervo");
    expect(open.filter((a) => a.dedupeKey === `valuation_pending_review:${pendingProc}`)).toHaveLength(1);
    expect(byKey.get(`settlement_installment_due:${settlementId}`)?.entityType).toBe("settlement");
    expect(byKey.get(`guarantee_idle:${g.id}`)?.entityType).toBe("guarantee");

    // Condition disappears: value registered for the enforcement process, guarantee returned.
    await addValuation(f.ctx.manager, { processId: enforcement, kind: "liquidated", amountCents: 10, baseDate: d(-1) });
    await f.db.update(processGuarantees).set({ status: "returned_to_company", statusChangedAt: today }).where(eq(processGuarantees.id, g.id));
    await runPortfolioAlertsRoutine(rc);
    const after = await f.db.select().from(alerts).where(and(eq(alerts.organizationId, f.orgA), isNull(alerts.resolvedAt)));
    const keys = new Set(after.map((a) => a.dedupeKey));
    expect(keys.has(`enforcement_without_value:${enforcement}`)).toBe(false);
    expect(keys.has(`guarantee_idle:${g.id}`)).toBe(false);
    expect(keys.has(`process_needs_verification:${verify}`)).toBe(true);
  });
});
