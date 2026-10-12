/**
 * P0.6, deferred findings 2, 3, 4 and 16 (valor da causa on the process form).
 *
 * - Only an identified person whose role has contingency:approve makes the valor da causa
 *   OFFICIAL; lawyers, external counsel and analysts (delegated intake context) leave a
 *   PROPOSED claim valuation for the review queue. The proposed amount never reaches the
 *   record (create: null; update: the current value), so it never counts in positions or
 *   exposure, before the review or after a rejection.
 * - An approver's change syncs the mirrors (provision) in the same transaction.
 * - A removal by an approver stamps `cleared_on`; a non-approver cannot remove the value.
 * - A context without a person cannot change the valor da causa.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The intake pipeline calls the briefs and e-mail modules: not needed here.
vi.mock("@/modules/briefs/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/briefs/service")>()),
  requestCaseBrief: vi.fn(async () => ({ briefId: "00000000-0000-4000-8000-0000000000b1", status: "generating" })),
}));
vi.mock("@/modules/emails/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/emails/service")>()),
  sendTemplatedEmail: vi.fn(async () => null),
}));

import { todayISO } from "@/lib/format";
import { getPortfolioExposure, getPositionAt, reviewValuation } from "@/modules/contingency/service";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { buildSimulatedCnj } from "@/modules/intake/simulation";
import { registerIncomingProcess } from "@/modules/intake/service";
import { getProcessDecisionBand } from "@/modules/processes/decision-band-service";
import {
  CLAIM_CHANGE_NEEDS_PERSON,
  CLAIM_REMOVAL_NEEDS_APPROVER,
  canMakeClaimOfficial,
  createProcess,
  currentInstanceClaimFallback,
  exportProcesses,
  getProcess,
  updateProcess,
} from "@/modules/processes/service";
import { auditLogs, legalProcesses, processInstances, processValuations } from "@/server/db/schema";
import { ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
let seq = 0;
const num = () => `${String(9100 + ++seq).padStart(7, "0")}-55.2026.5.10.0001`;

const claims = (processId: string) =>
  f.db
    .select()
    .from(processValuations)
    .where(and(eq(processValuations.processId, processId), eq(processValuations.kind, "claim")))
    .orderBy(asc(processValuations.createdAt));

const record = async (processId: string) =>
  (await f.db.select().from(legalProcesses).where(eq(legalProcesses.id, processId)))[0];

const auditsOf = (processId: string, action: string) =>
  f.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, processId), eq(auditLogs.action, action)))
    .orderBy(asc(auditLogs.createdAt));

beforeAll(async () => {
  f = await setupFixture("p06claim");
});

afterAll(async () => f?.teardown());

describe("who makes the valor da causa official", () => {
  it("approvers are identified people whose role has contingency:approve (delegated contexts by the role)", () => {
    expect(canMakeClaimOfficial(f.ctx.manager)).toBe(true);
    expect(canMakeClaimOfficial(f.ctx.admin)).toBe(true);
    expect(canMakeClaimOfficial(f.ctx.accountant)).toBe(true);
    expect(canMakeClaimOfficial(f.ctx.lawyer)).toBe(false);
    expect(canMakeClaimOfficial(f.ctx.externalCounsel)).toBe(false);
    // Delegated intake context: kind "system" but the analyst's own role decides.
    expect(canMakeClaimOfficial({ ...f.ctx.analyst, kind: "system" })).toBe(false);
    // A system context without a person never makes a value official.
    expect(canMakeClaimOfficial({ ...f.ctx.admin, kind: "system", userId: null })).toBe(false);
  });
});

const lawyerCreate = (claimAmountCents: number) =>
  createProcess(f.ctx.lawyer, {
    number: num(),
    title: "Reclamação fictícia (advogada)",
    court: "TRT10",
    area: "labor",
    phase: "knowledge",
    instance: "first",
    unitId: f.unitSp,
    claimAmountCents,
  });

const probableRisk = (processId: string) =>
  addRiskAssessment(f.ctx.manager, processId, {
    classification: "probable",
    percentage: 100,
    opinion: "Parecer fictício para o teste da provisão.",
    effectiveFrom: todayISO(),
  });

describe("lawyer (no contingency:approve)", () => {
  it("creating with a valor da causa leaves a PROPOSED claim; the record stays without it", async () => {
    const r = await lawyerCreate(80_000_00);
    expect(r.claimValuationStatus).toBe("proposed");
    const vals = await claims(r.id);
    expect(vals).toHaveLength(1);
    expect(vals[0]).toMatchObject({
      status: "proposed",
      amountCents: 80_000_00,
      source: "manual",
      createdById: f.ctx.lawyer.userId,
      reviewedById: null,
      reviewedAt: null,
      baseDate: todayISO(),
      instance: "first",
    });
    // Not on the record nor on the current instance row until a person approves it.
    expect((await record(r.id)).claimAmountCents).toBeNull();
    const [instance] = await f.db.select().from(processInstances).where(eq(processInstances.processId, r.id));
    expect(instance).toMatchObject({ instance: "first", isCurrent: true, claimAmountCents: null });
    const [create] = await auditsOf(r.id, "legal_process.create");
    expect(create.metadata).toMatchObject({ claimValuationId: vals[0].id, claimValuationStatus: "proposed" });
    expect(create.summary).toContain("enviado para conferência");
    expect(create.changes ?? {}).not.toHaveProperty("claimAmountCents");
    const [propose] = await auditsOf(r.id, "valuation.propose");
    expect(propose.metadata).toMatchObject({ valuationId: vals[0].id, source: "manual" });
  });

  it("a proposed value never counts: not before the review, not after a rejection; only after an approval", async () => {
    const r = await lawyerCreate(80_000_00);
    await probableRisk(r.id);
    const today = todayISO();
    const exposureRow = async () => (await getPortfolioExposure(f.ctx.manager, {})).rows.find((x) => x.processId === r.id);

    // Before the review: no claim, no provision, no record fallback, exposure row without a claim.
    expect(await record(r.id)).toMatchObject({ claimAmountCents: null, provisionAmountCents: null });
    const before = await getPositionAt(f.ctx.manager, r.id, today);
    expect(before.claimCents).toBeNull();
    expect(before.usedRecordFallback).toBe(false);
    expect(before.provision.provisionCents).toBeNull();
    expect((await exposureRow())?.claimCents).toBeNull();

    // Rejected: still nothing.
    const [proposal] = await claims(r.id);
    await reviewValuation(f.ctx.manager, proposal.id, { decision: "reject", note: "Valor divergente da inicial (fictício)." });
    expect((await claims(r.id)).map((v) => v.status)).toEqual(["rejected"]);
    expect(await record(r.id)).toMatchObject({ claimAmountCents: null, provisionAmountCents: null });
    expect((await getPositionAt(f.ctx.manager, r.id, today)).claimCents).toBeNull();
    expect((await exposureRow())?.claimCents).toBeNull();

    // A new proposal approved by a person: official, mirrors (provision) synced.
    await updateProcess(f.ctx.lawyer, r.id, { claimAmountCents: 70_000_00 });
    const pending = (await claims(r.id)).find((v) => v.status === "proposed");
    await reviewValuation(f.ctx.manager, pending!.id, { decision: "approve" });
    expect(await record(r.id)).toMatchObject({ claimAmountCents: 70_000_00, provisionAmountCents: 70_000_00 });
    const after = await getPositionAt(f.ctx.manager, r.id, today);
    expect(after.claimCents).toBe(70_000_00);
    expect(after.usedRecordFallback).toBe(false);
    expect((await exposureRow())?.claimCents).toBe(70_000_00);
  });

  it("changing it proposes the new value (review queue) and keeps the official one and the record", async () => {
    const id = await makeProcess(f.ctx.manager, { number: num(), unitId: f.unitSp, instance: "first", claimAmountCents: 100_000_00 });
    const [official] = await claims(id);
    expect(official.status).toBe("official");

    const result = await updateProcess(f.ctx.lawyer, id, { claimAmountCents: 150_000_00, title: "Título revisto (fictício)" });
    expect(result.claimValuation).toMatchObject({ status: "proposed" });
    const vals = await claims(id);
    expect(vals.map((v) => [v.amountCents, v.status])).toEqual([
      [100_000_00, "official"],
      [150_000_00, "proposed"],
    ]);
    expect(vals[1]).toMatchObject({ createdById: f.ctx.lawyer.userId, reviewedById: null, supersedesId: null });
    const row = await record(id);
    expect(row.claimAmountCents).toBe(100_000_00);
    expect(row.title).toBe("Título revisto (fictício)");

    // The update audit lists only what changed on the record; the proposal has its own entry.
    const [update] = await auditsOf(id, "legal_process.update");
    expect(Object.keys(update.changes ?? {})).toEqual(["title"]);
    expect(update.metadata).toMatchObject({ proposedClaimValuationId: vals[1].id });
    const [propose] = await auditsOf(id, "valuation.propose");
    expect(propose.metadata).toMatchObject({ valuationId: vals[1].id, source: "manual" });

    // Same value again: the pending proposal is reused, nothing new is recorded.
    const again = await updateProcess(f.ctx.lawyer, id, { claimAmountCents: 150_000_00 });
    expect(again.claimValuation).toEqual({ id: vals[1].id, status: "proposed" });
    expect(await claims(id)).toHaveLength(2);
    expect(await auditsOf(id, "valuation.propose")).toHaveLength(1);

    // The approval in the review queue makes it official and updates the record (mirror).
    await reviewValuation(f.ctx.manager, vals[1].id, { decision: "approve" });
    expect((await claims(id)).map((v) => v.status)).toEqual(["superseded", "official"]);
    expect((await record(id)).claimAmountCents).toBe(150_000_00);
  });

  it("cannot remove the valor da causa (an approver must)", async () => {
    const id = await makeProcess(f.ctx.manager, { number: num(), unitId: f.unitSp, claimAmountCents: 10_000_00 });
    const err = await updateProcess(f.ctx.lawyer, id, { claimAmountCents: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors?.claimAmountCents).toEqual([CLAIM_REMOVAL_NEEDS_APPROVER]);
    expect((await record(id)).claimAmountCents).toBe(10_000_00);
    expect((await claims(id)).map((v) => v.status)).toEqual(["official"]);
  });
});

describe("external counsel", () => {
  it("a change by the law firm is a proposal, never official (the profile does not make values official)", async () => {
    const id = await makeProcess(f.ctx.manager, { number: num(), lawFirmId: f.lawFirmA, claimAmountCents: 20_000_00 });
    const result = await updateProcess(f.ctx.externalCounsel, id, { claimAmountCents: 99_999_999 });
    expect(result.claimValuation?.status).toBe("proposed");
    const vals = await claims(id);
    expect(vals.map((v) => [v.amountCents, v.status, v.reviewedById])).toEqual([
      [20_000_00, "official", f.ctx.manager.userId],
      [99_999_999, "proposed", null],
    ]);
    expect((await record(id)).claimAmountCents).toBe(20_000_00);
  });
});

describe("context without a person (imports, inbound API)", () => {
  it("cannot change the valor da causa: the record never diverges from the synced mirrors", async () => {
    const id = await makeProcess(f.ctx.manager, { number: num(), unitId: f.unitSp, claimAmountCents: 80_000_00 });
    await probableRisk(id);
    const system = { ...f.ctx.manager, kind: "system" as const, userId: null };
    const err = await updateProcess(system, id, { claimAmountCents: 120_000_00 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors?.claimAmountCents).toEqual([CLAIM_CHANGE_NEEDS_PERSON]);
    expect(await record(id)).toMatchObject({ claimAmountCents: 80_000_00, provisionAmountCents: 80_000_00 });
    // Other fields still change.
    await updateProcess(system, id, { title: "Título ajustado pelo sistema (fictício)" });
    expect((await record(id)).title).toBe("Título ajustado pelo sistema (fictício)");
  });
});

describe("approver: official value with mirrors synced in the same transaction", () => {
  it("the provision follows a new valor da causa (no stale provisionAmountCents)", async () => {
    const id = await makeProcess(f.ctx.manager, { number: num(), unitId: f.unitSp, claimAmountCents: 10_000_00 });
    await probableRisk(id);
    expect((await record(id)).provisionAmountCents).toBe(10_000_00);

    const result = await updateProcess(f.ctx.manager, id, { claimAmountCents: 50_000_00 });
    expect(result.claimValuation?.status).toBe("official");
    const row = await record(id);
    expect(row).toMatchObject({ claimAmountCents: 50_000_00, provisionAmountCents: 50_000_00 });
    const updates = await auditsOf(id, "legal_process.update");
    expect(updates.at(-1)?.changes).toMatchObject({
      claimAmountCents: { from: 10_000_00, to: 50_000_00 },
      provisionAmountCents: { from: 10_000_00, to: 50_000_00 },
    });

    // Removal: no official claim left, removal dated, provision without a base.
    await updateProcess(f.ctx.manager, id, { claimAmountCents: null });
    const vals = await claims(id);
    expect(vals.every((v) => v.status === "superseded")).toBe(true);
    // Only the rows the removal ended carry the date (the first one was replaced by a new value).
    expect(vals.map((v) => v.clearedOn)).toEqual([null, todayISO()]);
    expect(await record(id)).toMatchObject({ claimAmountCents: null, provisionAmountCents: null });
  });
});

describe("intake registered by an analyst (delegated context)", () => {
  it("gets the claim valuation as a proposal by the analyst, like any non-approver", async () => {
    const result = await registerIncomingProcess(f.ctx.analyst, {
      number: buildSimulatedCnj({ seed: 777, year: 2026, tribunal: "10", origin: "0801" }),
      court: "TRT10",
      city: "Palmas",
      state: "TO",
      processClass: "ATOrd",
      area: "labor",
      phase: "knowledge",
      instance: "first",
      unitId: f.unitSp,
      plaintiffName: "Fulano Fictício da Silva",
      defendantName: "Empresa Fictícia A Ltda.",
      claimAmountCents: 45_000_00,
    });
    const vals = await claims(result.processId);
    expect(vals).toHaveLength(1);
    expect(vals[0]).toMatchObject({ status: "proposed", amountCents: 45_000_00, createdById: f.ctx.analyst.userId, reviewedById: null });
    // Like any proposal, the value stays off the record until a person approves it.
    expect((await record(result.processId)).claimAmountCents).toBeNull();
  });

  it("a manager's intake records the official value at once", async () => {
    const result = await registerIncomingProcess(f.ctx.manager, {
      number: buildSimulatedCnj({ seed: 778, year: 2026, tribunal: "10", origin: "0801" }),
      court: "TRT10",
      area: "labor",
      phase: "knowledge",
      instance: "first",
      plaintiffName: "Beltrano Fictício",
      defendantName: "Empresa Fictícia A Ltda.",
      claimAmountCents: 12_000_00,
    });
    const vals = await claims(result.processId);
    expect(vals.map((v) => [v.status, v.reviewedById])).toEqual([["official", f.ctx.manager.userId]]);
  });
});

describe("current instance after the approval of a create-time proposal", () => {
  it("the Instâncias table and the per-instance export show the record's value (computed on read)", async () => {
    const r = await lawyerCreate(64_000_00);
    const before = await getProcess(f.ctx.manager, r.id);
    expect(before.instances[0]).toMatchObject({ isCurrent: true, claimAmountCents: null, claimFromRecordCents: null });

    const [proposal] = await claims(r.id);
    await reviewValuation(f.ctx.manager, proposal.id, { decision: "approve" });
    // The approval fills only the record; the link row keeps its own (empty) value.
    const [row] = await f.db.select().from(processInstances).where(eq(processInstances.processId, r.id));
    expect(row.claimAmountCents).toBeNull();

    const detail = await getProcess(f.ctx.manager, r.id);
    expect(detail.claimAmountCents).toBe(64_000_00);
    expect(detail.instances[0]).toMatchObject({ isCurrent: true, claimAmountCents: null, claimFromRecordCents: 64_000_00 });

    const exported = await exportProcesses(f.ctx.manager, { q: detail.number }, "xlsx");
    const inst = exported.instances.filter((i) => i.processId === r.id);
    expect(inst).toEqual([expect.objectContaining({ instance: "first", isCurrent: true, claimAmountCents: 64_000_00 })]);
  });

  it("only the current instance without its own value falls back to the record", () => {
    expect(currentInstanceClaimFallback({ isCurrent: true, claimAmountCents: null }, 10_00)).toBe(10_00);
    expect(currentInstanceClaimFallback({ isCurrent: true, claimAmountCents: 5_00 }, 10_00)).toBeNull();
    expect(currentInstanceClaimFallback({ isCurrent: false, claimAmountCents: null }, 10_00)).toBeNull();
    expect(currentInstanceClaimFallback({ isCurrent: true, claimAmountCents: null }, null)).toBeNull();
  });
});

describe("simulated valor da causa (intake demonstration)", () => {
  const simulatedCreate = (ctx: typeof f.ctx.lawyer, claimAmountCents: number) =>
    createProcess(
      ctx,
      {
        number: num(),
        title: "Reclamação fictícia (entrada simulada)",
        court: "TRT10",
        area: "labor",
        phase: "knowledge",
        instance: "first",
        unitId: f.unitSp,
        claimAmountCents,
      },
      { claimSource: "simulation" },
    );

  it("a non-approver's simulated value is a proposal labeled as simulated (queue, band, audit)", async () => {
    const analyst = { ...f.ctx.analyst, kind: "system" as const };
    const r = await simulatedCreate(analyst, 33_000_00);
    expect(r.claimValuationStatus).toBe("proposed");
    const vals = await claims(r.id);
    expect(vals).toHaveLength(1);
    expect(vals[0]).toMatchObject({ status: "proposed", source: "simulation", amountCents: 33_000_00, createdById: f.ctx.analyst.userId });
    expect(vals[0].reason).toContain("simulado (demonstração)");
    expect((await record(r.id)).claimAmountCents).toBeNull();

    const [create] = await auditsOf(r.id, "legal_process.create");
    expect(create.summary).toContain("Valor da causa simulado (demonstração)");
    const [propose] = await auditsOf(r.id, "valuation.propose");
    expect(propose.metadata).toMatchObject({ valuationId: vals[0].id, source: "simulation" });
    expect(propose.summary).toContain("simulado (demonstração)");

    const band = await getProcessDecisionBand(f.ctx.manager, r.id);
    expect(band.valuations?.items).toEqual([expect.objectContaining({ id: vals[0].id, simulated: true, source: "simulation" })]);
  });

  it("an approver's simulated value is official, reviewed by the person, and still labeled as simulated", async () => {
    const r = await simulatedCreate(f.ctx.manager, 21_000_00);
    expect(r.claimValuationStatus).toBe("official");
    const vals = await claims(r.id);
    expect(vals.map((v) => [v.status, v.source, v.reviewedById])).toEqual([["official", "simulation", f.ctx.manager.userId]]);
    expect((await record(r.id)).claimAmountCents).toBe(21_000_00);
  });

  it("the default stays a manual value (process form)", async () => {
    const r = await lawyerCreate(9_000_00);
    expect((await claims(r.id)).map((v) => v.source)).toEqual(["manual"]);
  });
});
