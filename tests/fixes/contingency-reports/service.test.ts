/**
 * Integration regressions of the "contingency-reports" review group (PGlite):
 *  1. quitação (RN-06) across instances and dates, outcome-based messages/audit;
 *  2. removed valor da causa: no claim/estimate today nor in the open competência;
 *  6. snapshot generation: history bound + unique-violation mapping;
 *  7. simulated extractions are never bulk-approved;
 *  8. deterministic choice among tied official values (mirror = position);
 * 10. batched document options for the /acordos quitação dialog.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

import { and, eq } from "drizzle-orm";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { previousPeriod } from "@/domain/contingency";
import { addDaysISO, todayISO } from "@/lib/format";
import { registerExtinctionAction } from "@/modules/contingency/actions";
import { isUniqueViolation, syncProcessMirrors } from "@/modules/contingency/internal";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { periodOf } from "@/modules/contingency/rules";
import {
  addValuation,
  bulkApproveValuations,
  getPositionAt,
  getProcessContingencySummary,
  getReviewItem,
  listDocumentOptionsForProcesses,
  listReviewQueue,
  proposeValuation,
  registerExtinction,
  reviewValuation,
  SIMULATED_BULK_REFUSAL,
} from "@/modules/contingency/service";
import { createSettlement, listProcessSettlements, setInstallmentPaid, setSettlementStatus } from "@/modules/contingency/settlement-service";
import { generateSnapshot, SNAPSHOT_IN_PROGRESS_MESSAGE, snapshotWriteError } from "@/modules/contingency/snapshot-service";
import { auditLogs, documents, legalProcesses, portfolioSnapshotItems, processValuations } from "@/server/db/schema";
import { ConflictError, ValidationError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../../helpers/fixtures";
import SettlementsPage from "@/app/(app)/acordos/page";

let f: Fixture;
const today = todayISO();
const d = (days: number) => addDaysISO(today, days);
const current = periodOf(today);
const beforePrevious = previousPeriod(previousPeriod(current));
let seq = 0;

async function insertProcess(overrides: Partial<typeof legalProcesses.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      number: `${String(seq).padStart(7, "0")}-33.2026.5.10.0003`,
      title: `Processo fictício de correção ${seq}`,
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      ...overrides,
    })
    .returning({ id: legalProcesses.id });
  return p.id;
}

async function processRow(id: string) {
  const [row] = await f.db.select().from(legalProcesses).where(eq(legalProcesses.id, id));
  return row;
}

async function valuationsOf(processId: string) {
  return f.db.select().from(processValuations).where(eq(processValuations.processId, processId));
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

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeAll(async () => {
  f = await setupFixture("fixcr");
});

afterAll(async () => {
  await f?.teardown();
});

describe("finding 1 — quitação (RN-06) across instances", () => {
  it("refuses a quitação dated before an official liquidated value of another instance (nothing recorded)", async () => {
    const id = await insertProcess({ phase: "enforcement", lossProbability: "probable", riskPercentageBp: 10_000 });
    await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 5_000_000, baseDate: d(-10), instance: "first" });
    const err = await expectError(registerExtinction(f.ctx.manager, id, { baseDate: d(-20) }), ValidationError);
    expect(err.message).toContain("posterior à quitação");
    expect(err.fieldErrors?.baseDate?.[0]).toContain("anterior ao valor liquidado oficial");
    await expectError(registerExtinction(f.ctx.lawyer, id, { baseDate: d(-20) }), ValidationError);
    expect(await valuationsOf(id)).toHaveLength(1);
    expect((await processRow(id)).liquidatedAmountCents).toBe(5_000_000);

    // The action reports the refusal instead of "zerado".
    session.current = f.ctx.manager;
    const res = await registerExtinctionAction(null, form({ processId: id, baseDate: d(-20) }));
    expect(res.ok).toBe(false);
  });

  it("an official quitação supersedes the liquidated values of every instance; mirror, exposure, audit and message agree", async () => {
    const id = await insertProcess({ phase: "enforcement", lossProbability: "probable", riskPercentageBp: 10_000 });
    const first = await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 5_000_000, baseDate: d(-30), instance: "first" });
    const second = await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 3_000_000, baseDate: d(-25), instance: "second" });
    expect((await processRow(id)).liquidatedAmountCents).toBe(3_000_000);

    const ext = await registerExtinction(f.ctx.manager, id, { baseDate: d(-5), note: "Guia de levantamento juntada (fictícia)." });
    expect(ext).toMatchObject({ status: "official", outcome: "zeroed" });
    const rows = await valuationsOf(id);
    expect(rows.filter((r) => r.status === "official").map((r) => r.id)).toEqual([ext.id]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Append-only: superseded, amounts untouched.
    expect(byId.get(first.id)).toMatchObject({ status: "superseded", amountCents: 5_000_000 });
    expect(byId.get(second.id)).toMatchObject({ status: "superseded", amountCents: 3_000_000 });
    expect(byId.get(ext.id)?.reviewedById).toBe(f.ctx.manager.userId);
    expect((await processRow(id)).liquidatedAmountCents).toBe(0);
    const summary = await getProcessContingencySummary(f.ctx.manager, id);
    expect(summary.liquidatedCents).toBe(0);
    expect(summary.exposure.exposureCents).toBe(0);
    const [audit] = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "valuation.extinction")));
    expect(audit.summary).toContain("valor liquidado oficial zerado");
    // History kept: before the payment the position shows the value then in force.
    expect((await getPositionAt(f.ctx.manager, id, d(-20))).liquidatedCents).toBe(3_000_000);

    // A second quitação does not claim to zero anything.
    const again = await registerExtinction(f.ctx.manager, id, { baseDate: d(-1) });
    expect(again.outcome).toBe("already_zero");
    const audits = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "valuation.extinction")));
    expect(audits.some((a) => a.summary.includes("já era R$ 0,00"))).toBe(true);
  });

  it("the action message follows the actual outcome", async () => {
    const id = await insertProcess({ phase: "enforcement" });
    await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 700_000, baseDate: d(-15), instance: "first" });
    session.current = f.ctx.manager;
    const res = await registerExtinctionAction(null, form({ processId: id, baseDate: d(-2) }));
    expect(res).toMatchObject({ ok: true, message: "Quitação registrada: valor liquidado oficial zerado (histórico preservado)." });
    const again = await registerExtinctionAction(null, form({ processId: id, baseDate: d(-1) }));
    expect(again).toMatchObject({ ok: true });
    expect((again as { message?: string }).message).toContain("já era R$ 0,00");
    session.current = f.ctx.lawyer;
    const id2 = await insertProcess();
    const proposed = await registerExtinctionAction(null, form({ processId: id2, baseDate: d(-1) }));
    expect((proposed as { message?: string }).message).toContain("Quitação proposta");
  });

  it("a proposed quitação approved in review also ends other instances; refused if a later official value appeared", async () => {
    const id = await insertProcess({ phase: "enforcement" });
    const first = await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 2_000_000, baseDate: d(-30), instance: "first" });
    const p = await registerExtinction(f.ctx.lawyer, id, { baseDate: d(-3) });
    expect(p).toMatchObject({ status: "proposed", outcome: "proposed" });
    expect((await processRow(id)).liquidatedAmountCents).toBe(2_000_000);
    // Quitações are never bulk-approved.
    const bulk = await bulkApproveValuations(f.ctx.accountant, [p.id]);
    expect(bulk.approved).toBe(0);
    await reviewValuation(f.ctx.accountant, p.id, { decision: "approve", note: "Comprovante conferido." });
    expect((await processRow(id)).liquidatedAmountCents).toBe(0);
    expect((await valuationsOf(id)).find((r) => r.id === first.id)?.status).toBe("superseded");

    const id2 = await insertProcess({ phase: "enforcement" });
    const late = await registerExtinction(f.ctx.lawyer, id2, { baseDate: d(-10) });
    await addValuation(f.ctx.manager, { processId: id2, kind: "liquidated", amountCents: 900_000, baseDate: d(-5), instance: "second" });
    await expectError(reviewValuation(f.ctx.accountant, late.id, { decision: "approve" }), ValidationError);
    expect((await valuationsOf(id2)).find((r) => r.id === late.id)?.status).toBe("proposed");
    expect((await processRow(id2)).liquidatedAmountCents).toBe(900_000);
  });
});

describe("finding 2 — removed valor da causa", () => {
  it("position today and the open competência carry no claim and no estimated provision", async () => {
    const id = await insertProcess();
    await addValuation(f.ctx.manager, { processId: id, kind: "claim", amountCents: 300_000, baseDate: d(-40) });
    await addRiskAssessment(f.ctx.lawyer, id, {
      classification: "probable",
      opinion: "Condenação provável em primeira instância (fictício).",
      effectiveFrom: d(-40),
    });
    let pos = await getPositionAt(f.ctx.manager, id, today);
    expect(pos.claimCents).toBe(300_000);
    expect(pos.provision).toMatchObject({ provisionCents: 300_000, isEstimate: true });

    // Removal as recorded by the process form (recordClaimValuation with amountCents = null):
    // every official claim valuation superseded, nothing inserted, record claim null.
    await f.db
      .update(processValuations)
      .set({ status: "superseded" })
      .where(and(eq(processValuations.processId, id), eq(processValuations.kind, "claim"), eq(processValuations.status, "official")));
    await f.db.update(legalProcesses).set({ claimAmountCents: null }).where(eq(legalProcesses.id, id));

    pos = await getPositionAt(f.ctx.manager, id, today);
    expect(pos.claimCents).toBeNull();
    expect(pos.provision.provisionCents).toBeNull();
    expect(pos.exposure.exposureCents).toBeNull();
    // Documented limitation (no removal date without a schema change): past dates keep the old value.
    expect((await getPositionAt(f.ctx.manager, id, d(-1))).claimCents).toBe(300_000);

    const preview = await generateSnapshot(f.ctx.accountant, current);
    const [item] = await f.db
      .select()
      .from(portfolioSnapshotItems)
      .where(and(eq(portfolioSnapshotItems.snapshotId, preview.id), eq(portfolioSnapshotItems.processId, id)));
    expect(item.claimAmountCents).toBeNull();
    expect(item.provisionCents).toBeNull();
    expect(item.provisionIsEstimate).toBe(false);
  });
});

describe("finding 6 — snapshot generation", () => {
  it("past previews read the history up to the reference date without falling back to today's record", async () => {
    const id = await insertProcess({ claimAmountCents: 700_000, lossProbability: "probable", riskPercentageBp: 10_000 });
    await addValuation(f.ctx.manager, { processId: id, kind: "claim", amountCents: 700_000, baseDate: today });
    await addRiskAssessment(f.ctx.lawyer, id, {
      classification: "probable",
      opinion: "Classificação registrada hoje (fictício).",
      effectiveFrom: today,
    });
    const old = await generateSnapshot(f.ctx.accountant, beforePrevious);
    const [item] = await f.db
      .select()
      .from(portfolioSnapshotItems)
      .where(and(eq(portfolioSnapshotItems.snapshotId, old.id), eq(portfolioSnapshotItems.processId, id)));
    expect(item.claimAmountCents).toBeNull();
    expect(item.classification).toBeNull();
    expect(item.provisionCents).toBeNull();
    // Regenerating the same preview reuses the row.
    expect((await generateSnapshot(f.ctx.accountant, beforePrevious)).id).toBe(old.id);
  });

  it("maps a unique violation of a concurrent first generation to a pt-BR conflict", () => {
    const dbError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      name: "DrizzleQueryError",
      cause: { code: "23505" },
    });
    expect(isUniqueViolation(dbError)).toBe(true);
    const mapped = snapshotWriteError(dbError);
    expect(mapped).toBeInstanceOf(ConflictError);
    expect((mapped as Error).message).toBe(SNAPSHOT_IN_PROGRESS_MESSAGE);
    const other = Object.assign(new Error("x"), { cause: { code: "23503" } });
    expect(snapshotWriteError(other)).toBe(other);
  });
});

describe("finding 7 — simulated extractions and bulk approval", () => {
  it("refuses simulated rows in bulk with a reason; single approval by an identified reviewer works", async () => {
    const id = await insertProcess();
    const sim = await proposeValuation(f.ctx.admin, {
      processId: id,
      kind: "claim",
      amountCents: 450_000,
      baseDate: d(-2),
      source: "simulation",
      confidence: 90,
      reason: "Extração simulada (demonstração).",
    });
    const sheet = await proposeValuation(f.ctx.admin, {
      processId: id,
      kind: "liquidated",
      amountCents: 120_000,
      baseDate: d(-2),
      source: "spreadsheet",
      confidence: 95,
    });
    const res = await bulkApproveValuations(f.ctx.accountant, [sim.id, sheet.id]);
    expect(res.approved).toBe(1);
    expect(res.refused).toEqual([{ id: sim.id, reason: SIMULATED_BULK_REFUSAL }]);
    expect((await valuationsOf(id)).find((v) => v.id === sim.id)?.status).toBe("proposed");

    const queue = await listReviewQueue(f.ctx.accountant, { confidence: "alta" });
    expect(queue.items.find((i) => i.id === sim.id)?.bulkEligible).toBe(false);
    expect((await getReviewItem(f.ctx.accountant, sim.id)).valuation.bulkEligible).toBe(false);

    await reviewValuation(f.ctx.accountant, sim.id, { decision: "approve", note: "Conferido no documento." });
    const approved = (await valuationsOf(id)).find((v) => v.id === sim.id)!;
    expect(approved.status).toBe("official");
    expect(approved.reviewedById).toBe(f.ctx.accountant.userId);
  });
});

describe("finding 8 — deterministic choice among tied official values", () => {
  it("mirror and position pick the most recently reviewed value, then the id", async () => {
    const id = await insertProcess();
    const created = new Date(Date.now() - 3_600_000);
    const at = (minutes: number) => new Date(created.getTime() + minutes * 60_000);
    const common = {
      organizationId: f.orgA,
      processId: id,
      kind: "liquidated" as const,
      baseDate: d(-3),
      source: "spreadsheet" as const,
      status: "official" as const,
      createdAt: created,
      reviewedById: f.ctx.manager.userId,
    };
    const [a, b] = await f.db
      .insert(processValuations)
      .values([
        { ...common, amountCents: 111_000, instance: "first", reviewedAt: at(30) },
        { ...common, amountCents: 222_000, instance: "second", reviewedAt: at(10) },
      ])
      .returning();
    const check = async (expected: number) => {
      await syncProcessMirrors(f.orgA, id, f.db);
      expect((await processRow(id)).liquidatedAmountCents).toBe(expected);
      expect((await getPositionAt(f.ctx.manager, id, today)).liquidatedCents).toBe(expected);
    };
    await check(111_000);
    await f.db.update(processValuations).set({ reviewedAt: at(60) }).where(eq(processValuations.id, b.id));
    await check(222_000);
    // Same review moment: the greater id, identically in SQL (mirror) and in memory (position).
    await f.db.update(processValuations).set({ reviewedAt: at(90) }).where(eq(processValuations.processId, id));
    await check(a.id > b.id ? 111_000 : 222_000);
  });
});

describe("finding 10 — document options for the /acordos quitação dialog", () => {
  it("returns visible documents of visible processes only, batched by process", async () => {
    const visible = await insertProcess();
    const secret = await insertProcess({ isConfidential: true });
    const [internal] = await f.db
      .insert(documents)
      .values({ organizationId: f.orgA, title: "Comprovante de pagamento (fictício)", category: "other", processId: visible, confidentiality: "internal" })
      .returning();
    const [restricted] = await f.db
      .insert(documents)
      .values({ organizationId: f.orgA, title: "Documento restrito (fictício)", category: "other", processId: visible, confidentiality: "restricted" })
      .returning();
    const [secretDoc] = await f.db
      .insert(documents)
      .values({ organizationId: f.orgA, title: "Documento sigiloso (fictício)", category: "other", processId: secret, confidentiality: "internal" })
      .returning();

    const acc = await listDocumentOptionsForProcesses(f.ctx.accountant, [visible, secret, "nao-e-uuid", visible]);
    expect(acc[visible].map((x) => x.id)).toEqual([internal.id]);
    expect(acc[secret]).toBeUndefined();
    const mgr = await listDocumentOptionsForProcesses(f.ctx.manager, [visible, secret]);
    expect(mgr[visible].map((x) => x.id).sort()).toEqual([internal.id, restricted.id].sort());
    expect(mgr[secret].map((x) => x.id)).toEqual([secretDoc.id]);
    expect(await listDocumentOptionsForProcesses(f.ctx.adminB, [visible])).toEqual({});
    expect(await listDocumentOptionsForProcesses(f.ctx.manager, [])).toEqual({});
  });

  it("/acordos renders fulfilled settlements with the quitação dialog", async () => {
    const id = await insertProcess();
    await f.db
      .insert(documents)
      .values({ organizationId: f.orgA, title: "Guia de quitação (fictícia)", category: "other", processId: id, confidentiality: "internal" });
    const { id: settlementId } = await createSettlement(f.ctx.manager, {
      processId: id,
      status: "signed",
      totalAmountCents: 10_000,
      installmentsCount: 1,
      firstDueDate: d(1),
    });
    await setSettlementStatus(f.ctx.manager, settlementId, { status: "homologated" });
    const [s] = await listProcessSettlements(f.ctx.manager, id);
    await setInstallmentPaid(f.ctx.manager, s.installments[0].id, { paid: true, paidAt: today });
    await setSettlementStatus(f.ctx.manager, settlementId, { status: "fulfilled" });

    session.current = f.ctx.manager;
    const html = renderToString((await SettlementsPage({ searchParams: Promise.resolve({ status: "fulfilled" }) })) as ReactElement);
    expect(html).toContain("Registrar quitação");
  });
});
