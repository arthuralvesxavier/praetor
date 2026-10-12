/**
 * P1.9: the close gate is evaluated on the STORED items of the preview (what
 * the close freezes) and a stale preview must be recalculated first, even with
 * a justification (PGlite).
 *
 * - classifications: an official classification in force on the reference
 *   date recorded after the preview, for an item stored with the record
 *   fallback (not NULL); and one recorded concurrently with the calculation
 *   (timestamp before `generatedAt`, values not in the preview).
 * - population: an unclassified item deleted (e.g. import rollback) or closed
 *   before the reference date after the preview; an unclassified process
 *   registered after the preview. The override ids are always a subset of the
 *   closed items, and a "visible"-scope viewer with none of them listed does
 *   not see the org-level justification.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { periodOf } from "@/modules/contingency/rules";
import { closeSnapshot, generateSnapshot, getCloseGate, getSnapshot, getSnapshotStatus } from "@/modules/contingency/snapshot-service";
import type { AuthContext } from "@/server/auth/context";
import {
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processRiskAssessments,
  snapshotCloseOverrides,
} from "@/server/db/schema";
import { ConflictError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

const today = todayISO();
const current = periodOf(today);
const previous = previousPeriod(current);
const JUSTIFICATION = "Processo cadastrado depois da prévia, parecer de risco pendente com o escritório.";

let seq = 0;
async function proc(f: Fixture, organizationId: string, values: Partial<typeof legalProcesses.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId,
      number: `${String(3_300_000 + seq).padStart(7, "0")}-11.2025.5.10.0009`,
      title: `Processo fictício ${seq}`,
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      filedAt: "2025-01-10",
      claimAmountCents: 1_000_000,
      ...values,
    })
    .returning({ id: legalProcesses.id });
  return p.id;
}

async function official(
  f: Fixture,
  organizationId: string,
  processId: string,
  by: AuthContext,
  classification: "remote" | "possible" | "probable",
  effectiveFrom: string,
  at?: Date,
) {
  await f.db.insert(processRiskAssessments).values({
    organizationId,
    processId,
    classification,
    percentageBp: classification === "probable" ? 10000 : classification === "possible" ? 5000 : 0,
    opinion: "Parecer fictício de teste.",
    effectiveFrom,
    status: "official",
    origin: "manual",
    assessedById: by.userId,
    reviewedById: by.userId,
    reviewedAt: at ?? new Date(),
    ...(at ? { createdAt: at } : {}),
  });
}

async function snapshotRow(f: Fixture, organizationId: string) {
  const [s] = await f.db
    .select()
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.organizationId, organizationId), eq(portfolioSnapshots.period, previous)));
  const items = await f.db.select().from(portfolioSnapshotItems).where(eq(portfolioSnapshotItems.snapshotId, s.id));
  return { s, items };
}

async function overrides(f: Fixture, organizationId: string) {
  return f.db.select().from(snapshotCloseOverrides).where(eq(snapshotCloseOverrides.organizationId, organizationId));
}

async function expectStaleRefusal(ctx: AuthContext, justification?: string): Promise<string> {
  try {
    await closeSnapshot(ctx, previous, justification ? { justification } : {});
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictError);
    const message = (err as Error).message;
    expect(message).toContain("Recalcule a prévia");
    expect(message).not.toMatch(/[—–]/);
    return message;
  }
  throw new Error("expected a stale-preview refusal");
}

describe("stale preview: classifications recorded after the calculation", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setupFixture("closestale1");
  });
  afterAll(async () => f?.teardown());

  it("hole 1: an item stored with the record classification and classified officially afterwards blocks the close until recalculated", async () => {
    const ok = await proc(f, f.orgA, { unitId: f.unitSp });
    await official(f, f.orgA, ok, f.ctx.admin, "possible", `${previous}-01`);
    const rec = await proc(f, f.orgA, { unitId: f.unitSp, lossProbability: "remote", riskPercentageBp: 0 });
    await generateSnapshot(f.ctx.accountant, previous);

    const before = await getCloseGate(f.ctx.accountant, previous);
    expect(before.isStale).toBe(false);
    expect(before.items.map((i) => i.processId)).toEqual([rec]);
    expect(before.items[0].recordOnly).toBe(true);
    expect((await snapshotRow(f, f.orgA)).items.find((i) => i.processId === rec)?.classification).toBe("remote");

    // Official "probable" in force on the reference date, recorded after the preview.
    await official(f, f.orgA, rec, f.ctx.admin, "probable", `${previous}-01`);
    const gate = await getCloseGate(f.ctx.accountant, previous);
    expect(gate.count).toBe(0);
    expect(gate.isStale).toBe(true);
    expect(gate.staleness).toEqual({ classified: 1, added: 0, removed: 0, changed: 0 });
    expect(gate.canCloseWithoutJustification).toBe(false);

    expect(await expectStaleRefusal(f.ctx.accountant)).toContain(
      "1 processo teve a classificação de risco oficial registrada depois do cálculo, com vigência até a data-base",
    );
    await expectStaleRefusal(f.ctx.accountant, JUSTIFICATION);
    expect(await getSnapshotStatus(f.orgA, previous)).toBe("preview");
    expect(await overrides(f, f.orgA)).toHaveLength(0);

    await generateSnapshot(f.ctx.accountant, previous);
    const fresh = await getCloseGate(f.ctx.accountant, previous);
    expect(fresh.isStale).toBe(false);
    expect(fresh.count).toBe(0);
    expect(fresh.canCloseWithoutJustification).toBe(true);
    const result = await closeSnapshot(f.ctx.accountant, previous);
    expect(result.override).toBeNull();
    const frozen = (await snapshotRow(f, f.orgA)).items.find((i) => i.processId === rec)!;
    expect(frozen.classification).toBe("probable");
    expect(frozen.percentageBp).toBe(10000);
  });

  it("an official classification missing from the preview with an earlier timestamp (recorded during the calculation) also makes it stale", async () => {
    const p = await proc(f, f.orgB);
    await generateSnapshot(f.ctx.adminB, previous);
    const { s } = await snapshotRow(f, f.orgB);
    // Committed after the calculation read, but stamped before `generatedAt`.
    await official(f, f.orgB, p, f.ctx.adminB, "possible", `${previous}-01`, new Date(s.generatedAt.getTime() - 60_000));

    const gate = await getCloseGate(f.ctx.adminB, previous);
    expect(gate.count).toBe(0);
    expect(gate.isStale).toBe(true);
    expect(gate.staleness).toEqual({ classified: 1, added: 0, removed: 0, changed: 0 });
    await expectStaleRefusal(f.ctx.adminB, JUSTIFICATION);

    await generateSnapshot(f.ctx.adminB, previous);
    expect((await getCloseGate(f.ctx.adminB, previous)).canCloseWithoutJustification).toBe(true);
    expect((await closeSnapshot(f.ctx.adminB, previous)).override).toBeNull();
    expect((await snapshotRow(f, f.orgB)).items[0].classification).toBe("possible");
  });
});

describe("stale preview: population of the reference date changed after the calculation", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setupFixture("closestale2");
  });
  afterAll(async () => f?.teardown());

  it("hole 2: an unclassified item deleted or closed before the reference date blocks the close until recalculated", async () => {
    const ok = await proc(f, f.orgB);
    await official(f, f.orgB, ok, f.ctx.adminB, "possible", `${previous}-01`);
    const gone = await proc(f, f.orgB);
    const moved = await proc(f, f.orgB);
    await generateSnapshot(f.ctx.adminB, previous);
    const before = await getCloseGate(f.ctx.adminB, previous);
    expect(before.isStale).toBe(false);
    expect(before.items.map((i) => i.processId).sort()).toEqual([gone, moved].sort());

    // Soft-deleted after the preview (as an import rollback does while the process is only in a preview).
    await f.db.update(legalProcesses).set({ deletedAt: new Date() }).where(eq(legalProcesses.id, gone));
    let gate = await getCloseGate(f.ctx.adminB, previous);
    expect(gate.isStale).toBe(true);
    expect(gate.staleness).toEqual({ classified: 0, added: 0, removed: 1, changed: 0 });
    expect(gate.items.map((i) => i.processId)).toEqual([moved]);
    expect(await expectStaleRefusal(f.ctx.adminB)).toContain("1 processo da prévia não está mais ativo na data-base");
    await expectStaleRefusal(f.ctx.adminB, JUSTIFICATION);

    // Closure date edited to before the reference date.
    await f.db.update(legalProcesses).set({ status: "closed", closedAt: `${previous}-05` }).where(eq(legalProcesses.id, moved));
    gate = await getCloseGate(f.ctx.adminB, previous);
    expect(gate.staleness).toEqual({ classified: 0, added: 0, removed: 2, changed: 0 });
    expect(gate.count).toBe(0);
    expect(gate.canCloseWithoutJustification).toBe(false);
    await expectStaleRefusal(f.ctx.adminB, JUSTIFICATION);
    expect(await getSnapshotStatus(f.orgB, previous)).toBe("preview");
    expect(await overrides(f, f.orgB)).toHaveLength(0);

    await generateSnapshot(f.ctx.adminB, previous);
    expect((await getCloseGate(f.ctx.adminB, previous)).canCloseWithoutJustification).toBe(true);
    expect((await closeSnapshot(f.ctx.adminB, previous)).override).toBeNull();
    const { items } = await snapshotRow(f, f.orgB);
    expect(items.map((i) => i.processId)).toEqual([ok]);
    const view = await getSnapshot(f.ctx.adminB, previous);
    expect(view?.byClassification.find((b) => b.key === "unclassified")?.bucket.count).toBe(0);
  });

  it("case 3: a process registered after the preview is closed only after recalculation; the override ids are a subset of the closed items", async () => {
    const ok = await proc(f, f.orgA, { unitId: f.unitSp, responsibleId: f.ctx.lawyer.userId });
    await official(f, f.orgA, ok, f.ctx.admin, "possible", `${previous}-01`);
    await generateSnapshot(f.ctx.accountant, previous);
    const late = await proc(f, f.orgA, { unitId: f.unitSp, responsibleId: f.ctx.lawyer.userId });

    const gate = await getCloseGate(f.ctx.accountant, previous);
    expect(gate.count).toBe(0);
    expect(gate.isStale).toBe(true);
    expect(gate.staleness).toEqual({ classified: 0, added: 1, removed: 0, changed: 0 });
    expect(gate.canCloseWithoutJustification).toBe(false);
    expect(await expectStaleRefusal(f.ctx.accountant, JUSTIFICATION)).toContain("1 processo ativo na data-base não está na prévia");
    expect(await overrides(f, f.orgA)).toHaveLength(0);

    await generateSnapshot(f.ctx.accountant, previous);
    const fresh = await getCloseGate(f.ctx.accountant, previous);
    expect(fresh.isStale).toBe(false);
    expect(fresh.items.map((i) => i.processId)).toEqual([late]);

    const result = await closeSnapshot(f.ctx.accountant, previous, { justification: JUSTIFICATION });
    expect(result.override?.unclassifiedCount).toBe(1);
    const [o] = await overrides(f, f.orgA);
    const closedIds = new Set((await snapshotRow(f, f.orgA)).items.map((i) => i.processId));
    expect(o.unclassifiedProcessIds).toEqual([late]);
    expect(o.unclassifiedProcessIds.every((id) => closedIds.has(id))).toBe(true);

    // Scoped notice: the SP lawyer sees the process and the justification; the RE lawyer sees neither.
    const lawyer = await getCloseGate(f.ctx.lawyer, previous);
    expect(lawyer.override?.count).toBe(1);
    expect(lawyer.override?.reason).toBe(JUSTIFICATION);
    expect(lawyer.override?.items.map((i) => i.processId)).toEqual([late]);
    const lawyerRe = await getCloseGate(f.ctx.lawyerRe, previous);
    expect(lawyerRe.override).not.toBeNull();
    expect(lawyerRe.override?.count).toBe(0);
    expect(lawyerRe.override?.reason).toBeNull();
    expect(lawyerRe.override?.items).toEqual([]);
    const admin = await getCloseGate(f.ctx.admin, previous);
    expect(admin.override?.count).toBe(1);
    expect(admin.override?.items.map((i) => i.processId)).toEqual([late]);
  });
});

describe("stale preview: phase or instance changed after the calculation (P0.5)", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setupFixture("closestale3");
  });
  afterAll(async () => f?.teardown());

  it("an item whose phase/instance no longer matches the process, or holds a phase of the previous model, forces a recalculation", async () => {
    const p = await proc(f, f.orgB, { instance: "first" });
    await official(f, f.orgB, p, f.ctx.adminB, "possible", `${previous}-01`);
    await generateSnapshot(f.ctx.adminB, previous);
    expect((await getCloseGate(f.ctx.adminB, previous)).isStale).toBe(false);

    // The record moved to the 2º grau after the preview.
    await f.db.update(legalProcesses).set({ instance: "second" }).where(eq(legalProcesses.id, p));
    const gate = await getCloseGate(f.ctx.adminB, previous);
    expect(gate.isStale).toBe(true);
    expect(gate.staleness).toEqual({ classified: 0, added: 0, removed: 0, changed: 1 });
    expect(await expectStaleRefusal(f.ctx.adminB, JUSTIFICATION)).toContain("1 processo da prévia teve a fase ou a instância alterada");

    // A preview calculated before the 0012 migration: phase of the previous model, instance empty.
    await generateSnapshot(f.ctx.adminB, previous);
    expect((await getCloseGate(f.ctx.adminB, previous)).isStale).toBe(false);
    const { s } = await snapshotRow(f, f.orgB);
    await f.db
      .update(portfolioSnapshotItems)
      .set({ phase: "appeal", instance: null })
      .where(and(eq(portfolioSnapshotItems.snapshotId, s.id), eq(portfolioSnapshotItems.processId, p)));
    expect((await getCloseGate(f.ctx.adminB, previous)).staleness).toEqual({ classified: 0, added: 0, removed: 0, changed: 1 });
    await expectStaleRefusal(f.ctx.adminB);
    expect(await getSnapshotStatus(f.orgB, previous)).toBe("preview");

    // Recalculated: the closed competência freezes the current phase and instance.
    await generateSnapshot(f.ctx.adminB, previous);
    expect((await closeSnapshot(f.ctx.adminB, previous)).override).toBeNull();
    const frozen = (await snapshotRow(f, f.orgB)).items.find((i) => i.processId === p)!;
    expect(frozen).toMatchObject({ phase: "knowledge", instance: "second" });
  });
});
