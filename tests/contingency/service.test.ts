import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  addValuation,
  bulkApproveValuations,
  countPendingValuations,
  getContingencyOverview,
  getPortfolioExposure,
  getPositionAt,
  getProcessContingencySummary,
  getReviewItem,
  getValuationTimeline,
  listReviewQueue,
  listValuations,
  proposeValuation,
  registerExtinction,
  reviewValuation,
} from "@/modules/contingency/service";
import { createGuarantee, deleteGuarantee, listGuarantees, setGuaranteeStatus } from "@/modules/contingency/guarantee-service";
import {
  addRiskAssessment,
  approveRiskProposal,
  listRiskAssessments,
  rejectRiskProposal,
  suggestRiskAssessment,
} from "@/modules/contingency/risk-service";
import { RISK_SUGGESTION_PREFIX } from "@/modules/contingency/rules";
import type { AuthContext } from "@/server/auth/context";
import {
  auditLogs,
  documentVersions,
  documents,
  legalProcesses,
  organizations,
  processValuations,
} from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let f: Fixture;
const today = todayISO();
const d = (days: number) => addDaysISO(today, days);
let seq = 0;

async function insertProcess(overrides: Partial<typeof legalProcesses.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      number: `${String(seq).padStart(7, "0")}-11.2026.5.10.0001`,
      title: `Reclamação trabalhista fictícia ${seq}`,
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

async function valuationRow(id: string) {
  const [row] = await f.db.select().from(processValuations).where(eq(processValuations.id, id));
  return row;
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
  f = await setupFixture("cont");
});

afterAll(async () => {
  await f?.teardown();
});

describe("summary and exposure (RN-02, RN-03, RN-04, RN-07)", () => {
  it("never sums claim and liquidated; null liquidated means not assessed and exposure is an estimate", async () => {
    const id = await insertProcess({ claimAmountCents: 1_000_000, lossProbability: "possible" });
    const s = await getProcessContingencySummary(f.ctx.manager, id);
    expect(s.claimCents).toBe(1_000_000);
    expect(s.liquidatedCents).toBeNull();
    expect(s.percentageBp).toBe(5_000); // org parameter for "possível"
    expect(s.exposure).toEqual({ exposureCents: 500_000, isEstimate: true, basis: "claim_weighted" });
    expect(s.provision.isEstimate).toBe(true);
    expect(s.provision.provisionCents).toBe(500_000);
  });

  it("portfolio totals keep unknown values counted, not zero", async () => {
    const { totals, rows } = await getPortfolioExposure(f.ctx.manager);
    expect(totals.count).toBe(rows.length);
    expect(totals.liquidatedUnknown).toBeGreaterThan(0);
    const overview = await getContingencyOverview(f.ctx.manager);
    expect(overview.totals.count).toBe(totals.count);
    expect(overview.byClassification.reduce((s, c) => s + c.bucket.count, 0)).toBe(totals.count);
  });
});

describe("valuations: append-only, review and mirrors (RN-08, RN-11, RF-09)", () => {
  it("users with contingency:approve register official values; mirrors and provision follow", async () => {
    const id = await insertProcess({ claimAmountCents: 2_000_000, phase: "enforcement" });
    // Process without unit: visible to the SP lawyer, who records the legal risk opinion.
    await addRiskAssessment(f.ctx.lawyer, id, {
      classification: "probable",
      opinion: "Condenação mantida em segunda instância (fictício).",
      effectiveFrom: d(-30),
    });
    const risks = await listRiskAssessments(f.ctx.manager, id);
    expect(risks).toHaveLength(1);
    const r = await addValuation(f.ctx.accountant, {
      processId: id,
      kind: "liquidated",
      amountCents: 800_000,
      baseDate: d(-10),
      instance: "first",
      reason: "Cálculo homologado (fictício).",
    });
    expect(r.status).toBe("official");
    const v = await valuationRow(r.id);
    expect(v.reviewedById).toBe(f.ctx.accountant.userId);
    const p = await processRow(id);
    expect(p.liquidatedAmountCents).toBe(800_000);
    expect(p.claimAmountCents).toBe(2_000_000); // RN-02: untouched, never summed
    expect(p.lossProbability).toBe("probable");
    expect(p.riskPercentageBp).toBe(10_000);
    expect(p.provisionAmountCents).toBe(800_000);
    const audit = await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "valuation.create")));
    expect(audit).toHaveLength(1);
  });

  it("lawyers propose values for review; nothing changes until a reviewer approves (RN-11)", async () => {
    const id = await insertProcess({ claimAmountCents: 500_000 });
    const r = await addValuation(f.ctx.lawyer, { processId: id, kind: "liquidated", amountCents: 300_000, baseDate: d(-5) });
    expect(r.status).toBe("proposed");
    expect((await processRow(id)).liquidatedAmountCents).toBeNull();
    expect(await countPendingValuations(f.ctx.manager)).toBeGreaterThan(0);

    await expectError(reviewValuation(f.ctx.lawyer, r.id, { decision: "approve" }), ForbiddenError);
    await reviewValuation(f.ctx.manager, r.id, { decision: "approve", note: "Conferido com a planilha." });
    const v = await valuationRow(r.id);
    expect(v.status).toBe("official");
    expect(v.reviewedById).toBe(f.ctx.manager.userId);
    expect((await processRow(id)).liquidatedAmountCents).toBe(300_000);
    await expectError(reviewValuation(f.ctx.manager, r.id, { decision: "reject", note: "x" }), ConflictError);
  });

  it("a newer official value supersedes the previous one; an older approved value enters the history", async () => {
    const id = await insertProcess();
    const a = await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 100_000, baseDate: d(-60), instance: "first" });
    const b = await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 150_000, baseDate: d(-20), instance: "first" });
    expect((await valuationRow(a.id)).status).toBe("superseded");
    expect((await valuationRow(b.id)).status).toBe("official");
    expect((await valuationRow(b.id)).supersedesId).toBe(a.id);
    const old = await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 120_000, baseDate: d(-40), instance: "first" });
    expect(old.status).toBe("superseded");
    expect((await processRow(id)).liquidatedAmountCents).toBe(150_000);
    // Append-only: amounts never changed.
    expect((await valuationRow(a.id)).amountCents).toBe(100_000);

    const at = await getPositionAt(f.ctx.manager, id, d(-30));
    expect(at.liquidatedCents).toBe(120_000);
    const before = await getPositionAt(f.ctx.manager, id, d(-90));
    expect(before.liquidatedCents).toBeNull();
    const timeline = await getValuationTimeline(f.ctx.manager, id);
    expect(timeline.find((s) => s.kind === "liquidated")?.points.map((p) => p.amountCents)).toEqual([100_000, 120_000, 150_000]);
  });

  it("correct = original rejected + new official value; reject needs a reason", async () => {
    const id = await insertProcess();
    const p1 = await proposeValuation(f.ctx.admin, {
      processId: id,
      kind: "liquidated",
      amountCents: 999_00,
      baseDate: d(-3),
      source: "spreadsheet",
      confidence: 60,
      reason: "Divergência entre abas da planilha (fictícia).",
    });
    const res = await reviewValuation(f.ctx.accountant, p1.id, { decision: "correct", correctedAmountCents: 1_234_56, note: "Conferido na peça." });
    expect(res.status).toBe("rejected");
    expect(res.correctedStatus).toBe("official");
    const original = await valuationRow(p1.id);
    expect(original.status).toBe("rejected");
    expect(original.amountCents).toBe(999_00);
    const corrected = await valuationRow(res.correctedValuationId!);
    expect(corrected.amountCents).toBe(1_234_56);
    expect(corrected.reviewedById).toBe(f.ctx.accountant.userId);
    expect((await processRow(id)).liquidatedAmountCents).toBe(1_234_56);

    const p2 = await proposeValuation(f.ctx.admin, { processId: id, kind: "claim", amountCents: 10, baseDate: d(-1), source: "manual" });
    const err = await expectError(reviewValuation(f.ctx.manager, p2.id, { decision: "reject" }), ValidationError);
    expect(err.fieldErrors?.note).toBeDefined();
    await reviewValuation(f.ctx.manager, p2.id, { decision: "reject", note: "Valor sem lastro." });
    expect((await valuationRow(p2.id)).status).toBe("rejected");
  });

  it("bulk approval only for confidence at or above the threshold (RN-11)", async () => {
    const id = await insertProcess();
    const high = await proposeValuation(f.ctx.admin, { processId: id, kind: "claim", amountCents: 700_000, baseDate: d(-2), source: "simulation", confidence: 92 });
    const low = await proposeValuation(f.ctx.admin, { processId: id, kind: "liquidated", amountCents: 200_000, baseDate: d(-2), source: "simulation", confidence: 40 });
    const none = await proposeValuation(f.ctx.admin, { processId: id, kind: "fees", amountCents: 5_000, baseDate: d(-2), source: "manual" });
    const result = await bulkApproveValuations(f.ctx.accountant, [high.id, low.id, none.id]);
    expect(result.approved).toBe(1);
    expect(result.refused.map((r) => r.id).sort()).toEqual([low.id, none.id].sort());
    expect(result.refused.find((r) => r.id === low.id)?.reason).toContain("abaixo do mínimo de 85%");
    expect((await valuationRow(high.id)).status).toBe("official");
    expect((await valuationRow(high.id)).reviewedById).toBe(f.ctx.accountant.userId);
    expect((await valuationRow(low.id)).status).toBe("proposed");
    expect((await processRow(id)).claimAmountCents).toBe(700_000);
    await expectError(bulkApproveValuations(f.ctx.lawyer, [low.id]), ForbiddenError);
  });

  it("system context can propose but never make values official", async () => {
    const id = await insertProcess();
    const sys: AuthContext = { ...f.ctx.admin, kind: "system", userId: null };
    const p = await proposeValuation(sys, { processId: id, kind: "liquidated", amountCents: 1, baseDate: d(-1), source: "simulation", confidence: 99 });
    expect((await valuationRow(p.id)).status).toBe("proposed");
    await expectError(bulkApproveValuations(sys, [p.id]), ValidationError);
  });

  it("refuses future base dates and documents of another process", async () => {
    const id = await insertProcess();
    const other = await insertProcess();
    await expectError(addValuation(f.ctx.manager, { processId: id, kind: "claim", amountCents: 1, baseDate: d(5) }), ValidationError);
    const [doc] = await f.db
      .insert(documents)
      .values({ organizationId: f.orgA, title: "Planilha de cálculos (fictícia)", category: "other", processId: other })
      .returning();
    const err = await expectError(
      addValuation(f.ctx.manager, { processId: id, kind: "claim", amountCents: 1, baseDate: d(-1), source: "document", documentId: doc.id }),
      ValidationError,
    );
    expect(err.fieldErrors?.documentId?.[0]).toContain("deste processo");
  });

  it("extinction by payment = liquidated 0 with reason Quitação; history kept (RN-06)", async () => {
    const id = await insertProcess({ phase: "enforcement" });
    const a = await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 400_000, baseDate: d(-30) });
    const ext = await registerExtinction(f.ctx.manager, id, { baseDate: d(-1), note: "Guia de quitação juntada." });
    expect(ext.status).toBe("official");
    const v = await valuationRow(ext.id);
    expect(v.amountCents).toBe(0);
    expect(v.kind).toBe("liquidated");
    expect(v.reason?.startsWith("Quitação")).toBe(true);
    expect((await processRow(id)).liquidatedAmountCents).toBe(0);
    const all = await listValuations(f.ctx.manager, id);
    expect(all.map((x) => x.id)).toContain(a.id);
    expect((await getPositionAt(f.ctx.manager, id, d(-10))).liquidatedCents).toBe(400_000);

    const id2 = await insertProcess();
    const proposed = await registerExtinction(f.ctx.lawyer, id2, { baseDate: d(-1) });
    expect(proposed.status).toBe("proposed");
  });
});

describe("review queue (TE-04)", () => {
  it("lists proposed values with confidence filters and shows the cited page with the excerpt", async () => {
    const id = await insertProcess();
    const text = "Petição inicial fictícia.\fCálculo de liquidação: total devido R$ 45.678,90 em 01/09/2026.\fFim.";
    const offsets = [0, text.indexOf("Cálculo"), text.indexOf("Fim")];
    const [doc] = await f.db
      .insert(documents)
      .values({ organizationId: f.orgA, title: "Cálculo de liquidação (fictício)", category: "other", processId: id, confidentiality: "internal" })
      .returning();
    const [version] = await f.db
      .insert(documentVersions)
      .values({
        organizationId: f.orgA,
        documentId: doc.id,
        versionNumber: 1,
        fileName: "calculo.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: "x",
        storageKey: "k",
        extractionStatus: "succeeded",
        extractedText: text,
        pageOffsets: offsets,
        pageCount: 3,
      })
      .returning();
    await f.db.update(documents).set({ currentVersionId: version.id, currentVersionNumber: 1 }).where(eq(documents.id, doc.id));

    const p = await proposeValuation(f.ctx.admin, {
      processId: id,
      kind: "liquidated",
      amountCents: 4_567_890,
      baseDate: d(-1),
      source: "simulation",
      documentId: doc.id,
      page: 2,
      excerpt: "total devido R$ 45.678,90",
      confidence: 95,
    });
    const high = await listReviewQueue(f.ctx.accountant, { confidence: "alta" });
    expect(high.items.some((i) => i.id === p.id && i.bulkEligible)).toBe(true);
    const low = await listReviewQueue(f.ctx.accountant, { confidence: "baixa" });
    expect(low.items.some((i) => i.id === p.id)).toBe(false);
    const bySource = await listReviewQueue(f.ctx.accountant, { source: "spreadsheet" });
    expect(bySource.items.some((i) => i.id === p.id)).toBe(false);

    const item = await getReviewItem(f.ctx.accountant, p.id);
    expect(item.document?.visible).toBe(true);
    expect(item.document?.page).toBe(2);
    const h = item.document!.highlight!;
    expect(item.document!.pageText!.slice(h.start, h.end)).toBe("total devido R$ 45.678,90");
    expect(item.document!.pageText).not.toContain("Petição inicial");

    // A restricted document is not shown (nor its excerpt) to the accountant.
    await f.db.update(documents).set({ confidentiality: "restricted" }).where(eq(documents.id, doc.id));
    const hidden = await getReviewItem(f.ctx.accountant, p.id);
    expect(hidden.document?.visible).toBe(false);
    expect(hidden.document?.pageText).toBeNull();
    expect(hidden.valuation.excerpt).toBeNull();
    const listed = await listValuations(f.ctx.accountant, id);
    expect(listed[0].excerpt).toBeNull();
  });
});

describe("guarantees (RF-10, RN-04)", () => {
  it("only linked guarantees reduce exposure and provision", async () => {
    const id = await insertProcess({ lossProbability: "probable", riskPercentageBp: 10_000 });
    await addValuation(f.ctx.manager, { processId: id, kind: "liquidated", amountCents: 1_000_000, baseDate: d(-10) });
    const g = await createGuarantee(f.ctx.lawyer, id, { kind: "judicial_deposit", amountCents: 300_000, depositedAt: d(-9) });
    let s = await getProcessContingencySummary(f.ctx.manager, id);
    expect(s.linkedGuaranteesCents).toBe(300_000);
    expect(s.exposure.exposureCents).toBe(700_000);
    expect((await processRow(id)).provisionAmountCents).toBe(700_000);

    await setGuaranteeStatus(f.ctx.lawyer, g.id, { status: "released_to_plaintiff", statusChangedAt: d(-1) });
    s = await getProcessContingencySummary(f.ctx.manager, id);
    expect(s.linkedGuaranteesCents).toBe(0);
    expect(s.exposure.exposureCents).toBe(1_000_000);
    expect((await processRow(id)).provisionAmountCents).toBe(1_000_000);
    expect((await getPositionAt(f.ctx.manager, id, d(-5))).linkedGuaranteesCents).toBe(300_000);

    await expectError(setGuaranteeStatus(f.ctx.lawyer, g.id, { status: "released_to_plaintiff" }), ConflictError);
    await expectError(createGuarantee(f.ctx.executive, id, { kind: "seizure", amountCents: 1 }), ForbiddenError);
    await deleteGuarantee(f.ctx.lawyer, g.id);
    expect(await listGuarantees(f.ctx.manager, id)).toHaveLength(0);
  });
});

describe("risk classification (RF-11, RF-12)", () => {
  it("official assessment records opinion, default percentage and rules version", async () => {
    await f.db
      .update(organizations)
      .set({ settings: { contingency: { riskPercentages: { remote: 0, possible: 40, probable: 100 }, rulesVersion: 2 } } as never })
      .where(eq(organizations.id, f.orgA));
    const id = await insertProcess({ claimAmountCents: 1_000_000 });
    await expectError(
      addRiskAssessment(f.ctx.lawyer, id, { classification: "possible", opinion: "curto", effectiveFrom: d(0) }),
      ValidationError,
    );
    await addRiskAssessment(f.ctx.lawyer, id, {
      classification: "possible",
      opinion: "Tese da reclamada com respaldo documental (fictício).",
      effectiveFrom: d(0),
    });
    const [r] = await listRiskAssessments(f.ctx.manager, id);
    expect(r.percentageBp).toBe(4_000);
    expect(r.rulesVersion).toBe(2);
    expect(r.status).toBe("official");
    expect(r.inForce).toBe(true);
    const p = await processRow(id);
    expect(p.lossProbability).toBe("possible");
    expect(p.riskPercentageBp).toBe(4_000);
    expect(p.provisionAmountCents).toBe(400_000);
    await expectError(
      addRiskAssessment(f.ctx.executive, id, { classification: "remote", opinion: "Parecer de teste fictício.", effectiveFrom: d(0) }),
      ForbiddenError,
    );
    await f.db.update(organizations).set({ settings: {} as never }).where(eq(organizations.id, f.orgA));
  });

  it("rule suggestions are proposed, labeled non-official and change nothing until approved", async () => {
    const id = await insertProcess({ phase: "enforcement", claimAmountCents: 100_000 });
    const s = await suggestRiskAssessment(f.ctx.lawyer, id);
    expect(s.classification).toBe("probable");
    const again = await suggestRiskAssessment(f.ctx.lawyer, id);
    expect(again).toMatchObject({ id: s.id, reused: true });
    const [r] = await listRiskAssessments(f.ctx.manager, id);
    expect(r.status).toBe("proposed");
    expect(r.origin).toBe("system");
    expect(r.opinion.startsWith(RISK_SUGGESTION_PREFIX)).toBe(true);
    expect((await processRow(id)).lossProbability).toBeNull();

    await approveRiskProposal(f.ctx.lawyer, s.id, { note: "De acordo." });
    const [approved] = await listRiskAssessments(f.ctx.manager, id);
    expect(approved.status).toBe("official");
    expect(approved.opinion.startsWith(RISK_SUGGESTION_PREFIX)).toBe(false);
    expect(approved.reviewedByName).toBe(f.ctx.lawyer.name);
    expect((await processRow(id)).lossProbability).toBe("probable");

    const id2 = await insertProcess();
    const s2 = await suggestRiskAssessment(f.ctx.lawyer, id2);
    await rejectRiskProposal(f.ctx.lawyer, s2.id, { note: "Mérito favorável." });
    expect((await listRiskAssessments(f.ctx.manager, id2))[0].status).toBe("rejected");
    await expectError(approveRiskProposal(f.ctx.lawyer, s2.id), ConflictError);
  });
});

describe("visibility and isolation", () => {
  it("accountant sees only non-confidential processes; external counsel only the firm's portfolio", async () => {
    const confidential = await insertProcess({ isConfidential: true, claimAmountCents: 10 });
    const firm = await insertProcess({ lawFirmId: f.lawFirmA, isConfidential: true });
    const plain = await insertProcess();
    await expectError(getProcessContingencySummary(f.ctx.accountant, confidential), NotFoundError);
    await getProcessContingencySummary(f.ctx.accountant, plain);
    await getProcessContingencySummary(f.ctx.externalCounsel, firm);
    await expectError(getProcessContingencySummary(f.ctx.externalCounsel, plain), NotFoundError);

    const exposure = await getPortfolioExposure(f.ctx.externalCounsel);
    expect(exposure.rows.map((r) => r.processId)).toEqual([firm]);
    const acc = await getPortfolioExposure(f.ctx.accountant);
    expect(acc.rows.some((r) => r.processId === confidential)).toBe(false);

    // External counsel proposes values for its firm's process (contingency:write), never official.
    const v = await addValuation(f.ctx.externalCounsel, { processId: firm, kind: "liquidated", amountCents: 50_000, baseDate: d(-1) });
    expect(v.status).toBe("proposed");
    const queue = await listReviewQueue(f.ctx.externalCounsel);
    expect(queue.items.every((i) => i.processId === firm)).toBe(true);
    await expectError(getReviewItem(f.ctx.accountant, v.id), NotFoundError);
  });

  it("another organization never sees or changes organization A data", async () => {
    const id = await insertProcess();
    const v = await addValuation(f.ctx.lawyer, { processId: id, kind: "claim", amountCents: 1_000, baseDate: d(-1) });
    await expectError(getProcessContingencySummary(f.ctx.adminB, id), NotFoundError);
    await expectError(reviewValuation(f.ctx.adminB, v.id, { decision: "approve" }), NotFoundError);
    await expectError(addValuation(f.ctx.adminB, { processId: id, kind: "claim", amountCents: 1, baseDate: d(-1) }), NotFoundError);
    const result = await bulkApproveValuations(f.ctx.adminB, [v.id]);
    expect(result.approved).toBe(0);
    expect((await getPortfolioExposure(f.ctx.adminB)).rows).toHaveLength(0);
    expect((await listReviewQueue(f.ctx.adminB)).total).toBe(0);
    expect((await valuationRow(v.id)).status).toBe("proposed");
  });
});

