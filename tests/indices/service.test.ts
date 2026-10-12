import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { addMonths, monthOfDate } from "@/modules/indices/math";
import {
  computeValuationUpdates,
  describeIndexRefresh,
  getDefaultCorrectionIndex,
  getIndexSeriesOverview,
  getValuationUpdates,
  refreshIndexSeries,
  setValuationCorrectionIndex,
  updateDefaultCorrectionIndex,
} from "@/modules/indices/service";
import { updateContingencySettings, getOrganizationSettings } from "@/modules/admin/service";
import {
  addValuation,
  bulkApproveValuations,
  CORRECTION_INDEX_CHANGED_MESSAGE,
  getPositionAt,
  getProcessContingencySummary,
  getReviewItem,
  listReviewQueue,
  listValuations,
  proposeValuation,
  reviewValuation,
} from "@/modules/contingency/service";
import { syncProcessMirrors } from "@/modules/contingency/internal";
import { systemContext } from "@/server/auth/context";
import {
  auditLogs,
  indexSeries,
  indexSeriesValues,
  legalProcesses,
  processValuations,
  scheduledRoutines,
} from "@/server/db/schema";
import { setSgsClientForTesting, SgsError, type SgsClient, type SgsMonthlyPoint } from "@/server/integrations/bcb";
import { ensureDefaultRoutines, runRoutine } from "@/server/jobs/routines";
import { todayISO } from "@/lib/format";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";
import ipcaFixture from "./fixtures/sgs-433-ipca-2024-01-a-2025-06.json";
import trFixture from "./fixtures/sgs-7811-tr-2025-01-a-2025-06.json";

let f: Fixture;

function toPoints(json: { data: string; valor: string }[]): SgsMonthlyPoint[] {
  return json.map((p) => {
    const [, mm, yyyy] = p.data.split("/");
    return { month: `${yyyy}-${mm}`, rate: p.valor };
  });
}

/** Fake SGS client (no network): fixed points per SGS code, optional failure per code, call log. */
class FakeSgs implements SgsClient {
  readonly name = "fake";
  calls: { sgsCode: number; from: string; to: string }[] = [];
  failures = new Map<number, SgsError>();
  constructor(public data: Record<number, SgsMonthlyPoint[]>) {}
  async fetchMonthly(sgsCode: number, from: string, to: string): Promise<SgsMonthlyPoint[]> {
    this.calls.push({ sgsCode, from, to });
    const failure = this.failures.get(sgsCode);
    if (failure) throw failure;
    // Like the real API, it may return months outside the range (e.g. the current, partial month).
    return this.data[sgsCode] ?? [];
  }
}

const IPCA = 433;
const TR = 7811;
const SELIC = 4390;
/** Fixed clock: July 2025, so June 2025 is the last month that can be stored. */
const JULY_2025 = new Date("2025-07-15T15:00:00Z");

async function storedValues() {
  return f.db
    .select()
    .from(indexSeriesValues)
    .orderBy(asc(indexSeriesValues.indexCode), asc(indexSeriesValues.month));
}

async function seriesState(code: string) {
  const [row] = await f.db.select().from(indexSeries).where(eq(indexSeries.code, code as never));
  return row;
}

async function resetSeries() {
  await f.db.delete(indexSeriesValues);
  await f.db.delete(indexSeries);
}

beforeAll(async () => {
  f = await setupFixture("idx");
});

afterEach(() => setSgsClientForTesting(undefined));

afterAll(async () => {
  setSgsClientForTesting(undefined);
  await f.teardown();
});

describe("automatic collection (refreshIndexSeries)", () => {
  it("stores the fetched months, never the current month, and runs idempotently", async () => {
    await resetSeries();
    const fake = new FakeSgs({
      [IPCA]: toPoints(ipcaFixture),
      // The Selic answer includes the current (partial) month: it must not be stored.
      [SELIC]: [
        { month: "2025-05", rate: "1.14" },
        { month: "2025-06", rate: "1.10" },
        { month: "2025-07", rate: "0.55" },
      ],
      [TR]: toPoints(trFixture),
    });
    const sys = systemContext(f.orgA);
    const first = await refreshIndexSeries(sys, { now: JULY_2025, client: fake });
    expect(first.failed).toBe(0);
    expect(first.added).toBe(18 + 2 + 6);
    expect(fake.calls).toHaveLength(5);
    expect(fake.calls[0]).toEqual({ sgsCode: 10764, from: "1994-07", to: "2025-06" });

    const rows = await storedValues();
    expect(rows.filter((r) => r.indexCode === "selic").map((r) => r.month)).toEqual(["2025-05", "2025-06"]);
    const aug = rows.find((r) => r.indexCode === "ipca" && r.month === "2024-08");
    expect(aug).toMatchObject({ ratePercent: "-0.020000", source: "bcb_sgs:433" });
    expect(await seriesState("ipca")).toMatchObject({ lastMonth: "2025-06", lastError: null, sgsCode: 433 });
    expect((await seriesState("inpc")).lastMonth).toBeNull();

    // Same moment again: up-to-date series are not consulted, recent ones are throttled. Nothing changes.
    const second = await refreshIndexSeries(sys, { now: JULY_2025, client: fake });
    expect(second.added).toBe(0);
    expect(fake.calls).toHaveLength(5);
    expect(second.outcomes.find((o) => o.code === "ipca")?.status).toBe("up_to_date");
    expect(second.outcomes.find((o) => o.code === "inpc")?.status).toBe("throttled");
    expect(await storedValues()).toEqual(rows);

    // Forced: only the series with missing months are asked; nothing published → nothing added, nothing rewritten.
    const before = fake.calls.length;
    const forced = await refreshIndexSeries(sys, { now: JULY_2025, client: fake, force: true });
    expect(forced.added).toBe(0);
    expect(fake.calls.slice(before)).toEqual([
      { sgsCode: 10764, from: "1994-07", to: "2025-06" },
      { sgsCode: 188, from: "1994-07", to: "2025-06" },
    ]);
    expect(await storedValues()).toEqual(rows);
  });

  it("never rewrites a stored month (a different value from the source is ignored)", async () => {
    await resetSeries();
    const fake = new FakeSgs({
      [IPCA]: [
        { month: "2024-01", rate: "0.42" },
        { month: "2024-03", rate: "0.16" },
      ],
    });
    await refreshIndexSeries(systemContext(f.orgA), { now: JULY_2025, client: fake });
    // The source now answers other values for the stored months and publishes the missing one.
    fake.data[IPCA] = [
      { month: "2024-01", rate: "9.99" },
      { month: "2024-02", rate: "0.83" },
      { month: "2024-03", rate: "9.99" },
    ];
    const again = await refreshIndexSeries(systemContext(f.orgA), { now: JULY_2025, client: fake, force: true });
    expect(again.outcomes.find((o) => o.code === "ipca")).toMatchObject({ status: "updated", added: 1, gapMonths: [] });
    const rows = (await storedValues()).filter((r) => r.indexCode === "ipca");
    expect(rows.map((r) => `${r.month}=${r.ratePercent}`)).toEqual(["2024-01=0.420000", "2024-02=0.830000", "2024-03=0.160000"]);
  });

  it("records failures per series (shown on the admin card) and clears them on the next success", async () => {
    await resetSeries();
    const fake = new FakeSgs({ [IPCA]: toPoints(ipcaFixture) });
    fake.failures.set(IPCA, new SgsError("server_error", "O Banco Central está indisponível no momento (HTTP 503).", true, 503));
    const run = await refreshIndexSeries(systemContext(f.orgA), { now: JULY_2025, client: fake });
    expect(run.failed).toBe(1);
    expect(await seriesState("ipca")).toMatchObject({
      lastError: "O Banco Central está indisponível no momento (HTTP 503).",
      lastMonth: null,
    });
    // Other series were still consulted (not a communication failure).
    expect(fake.calls.map((c) => c.sgsCode)).toEqual([10764, 433, 188, 4390, 7811]);

    const overview = await getIndexSeriesOverview(f.ctx.admin, JULY_2025);
    expect(overview.lastCompleteMonth).toBe("2025-06");
    expect(overview.series.find((s) => s.code === "ipca")?.health).toBe("failed");
    expect(overview.series.find((s) => s.code === "ipca")?.lastError).toContain("HTTP 503");

    // Within the failure throttle the routine waits; a forced run tries again and clears the error.
    fake.failures.clear();
    const throttled = await refreshIndexSeries(systemContext(f.orgA), { now: JULY_2025, client: fake });
    expect(throttled.outcomes.find((o) => o.code === "ipca")?.status).toBe("throttled");
    await refreshIndexSeries(systemContext(f.orgA), { now: JULY_2025, client: fake, force: true });
    expect(await seriesState("ipca")).toMatchObject({ lastError: null, lastMonth: "2025-06" });
    const after = await getIndexSeriesOverview(f.ctx.admin, JULY_2025);
    expect(after.series.find((s) => s.code === "ipca")).toMatchObject({ health: "ok", monthsStored: 18, firstMonth: "2024-01" });
  });

  it("stops the run on a communication failure (the other series wait for the next run)", async () => {
    await resetSeries();
    const fake = new FakeSgs({});
    fake.failures.set(10764, new SgsError("timeout", "O Banco Central não respondeu em 20 s.", true));
    const run = await refreshIndexSeries(systemContext(f.orgA), { now: JULY_2025, client: fake });
    expect(fake.calls).toHaveLength(1);
    expect(run.outcomes.map((o) => o.status)).toEqual(["failed", "not_attempted", "not_attempted", "not_attempted", "not_attempted"]);
  });

  it("runs as the daily routine `index_series_refresh` (registered, idempotent, failures in the status)", async () => {
    await resetSeries();
    await ensureDefaultRoutines(f.orgA);
    const [routine] = await f.db
      .select()
      .from(scheduledRoutines)
      .where(and(eq(scheduledRoutines.organizationId, f.orgA), eq(scheduledRoutines.type, "index_series_refresh")));
    expect(routine).toMatchObject({ enabled: true, intervalMinutes: 1440 });

    const fake = new FakeSgs({ [IPCA]: toPoints(ipcaFixture) });
    fake.failures.set(TR, new SgsError("http_error", "O Banco Central recusou a consulta (HTTP 400).", false, 400));
    setSgsClientForTesting(fake);
    const out = await runRoutine(routine.id);
    expect(out?.status).toContain("Meses novos: IPCA (18 meses, até 06/2025).");
    expect(out?.status).toContain("Falha em TR (primeiro dia do mês): O Banco Central recusou a consulta (HTTP 400).");
    const count = (await storedValues()).length;
    const calls = fake.calls.length;

    // Second run right after: nothing consulted again, nothing stored again.
    const again = await runRoutine(routine.id);
    expect(again?.status).toContain("Consultadas há pouco");
    expect(fake.calls.length).toBe(calls);
    expect((await storedValues()).length).toBe(count);
  });

  it("waits for the confirmation day before storing the Selic of the previous month (accumulated during the month)", async () => {
    await resetSeries();
    const sys = systemContext(f.orgA);
    // 2026-11-01 00:30 in São Paulo (a Sunday; 11/02 is a holiday): the Selic of 10/2026 is still partial at the source.
    const nov1 = new Date("2026-11-01T03:30:00Z");
    const fake = new FakeSgs({
      [SELIC]: [
        { month: "2026-09", rate: "1.08" },
        { month: "2026-10", rate: "1.04" },
      ],
      [IPCA]: [
        { month: "2026-09", rate: "0.48" },
        { month: "2026-10", rate: "0.20" },
      ],
    });
    await refreshIndexSeries(sys, { now: nov1, client: fake });
    expect(fake.calls.find((c) => c.sgsCode === SELIC)).toEqual({ sgsCode: SELIC, from: "1994-07", to: "2026-09" });
    expect(fake.calls.find((c) => c.sgsCode === IPCA)).toEqual({ sgsCode: IPCA, from: "1994-07", to: "2026-10" });
    let rows = await storedValues();
    expect(rows.filter((r) => r.indexCode === "selic").map((r) => r.month)).toEqual(["2026-09"]);
    expect(rows.filter((r) => r.indexCode === "ipca").map((r) => r.month)).toEqual(["2026-09", "2026-10"]);

    const early = await getIndexSeriesOverview(f.ctx.admin, new Date("2026-11-05T15:00:00Z"));
    expect(early.series.find((s) => s.code === "selic")).toMatchObject({ lastStorableMonth: "2026-09", health: "ok" });
    expect(early.series.find((s) => s.code === "ipca")).toMatchObject({ lastStorableMonth: "2026-10", health: "ok" });

    // Day 9, even forced: still inside the confirmation window, nothing stored for 10/2026.
    fake.data[SELIC] = [
      { month: "2026-09", rate: "1.08" },
      { month: "2026-10", rate: "1.09" },
    ];
    await refreshIndexSeries(sys, { now: new Date("2026-11-09T15:00:00Z"), client: fake, force: true });
    rows = await storedValues();
    expect(rows.filter((r) => r.indexCode === "selic").map((r) => r.month)).toEqual(["2026-09"]);

    // Day 10: the whole month is published; the final rate is stored (never the partial one).
    await refreshIndexSeries(sys, { now: new Date("2026-11-10T15:00:00Z"), client: fake });
    rows = await storedValues();
    expect(rows.filter((r) => r.indexCode === "selic").map((r) => `${r.month}=${r.ratePercent}`)).toEqual([
      "2026-09=1.080000",
      "2026-10=1.090000",
    ]);
  });

  it("fetches again the months missing in the middle of a series and shows them on the admin card", async () => {
    await resetSeries();
    const sys = systemContext(f.orgA);
    const fake = new FakeSgs({ [IPCA]: toPoints(ipcaFixture) });
    await refreshIndexSeries(sys, { now: JULY_2025, client: fake });
    // A window came back incomplete: 05/2024 and 06/2024 are missing in the middle of the series.
    await f.db
      .delete(indexSeriesValues)
      .where(and(eq(indexSeriesValues.indexCode, "ipca"), inArray(indexSeriesValues.month, ["2024-05", "2024-06"])));
    const overview = await getIndexSeriesOverview(f.ctx.admin, JULY_2025);
    expect(overview.series.find((s) => s.code === "ipca")).toMatchObject({
      health: "gaps",
      gapMonths: ["2024-05", "2024-06"],
      lastMonth: "2025-06",
      monthsStored: 16,
    });

    // The source still lacks them: only the gap is asked again, and the run status says so.
    fake.data[IPCA] = toPoints(ipcaFixture).filter((p) => p.month !== "2024-05" && p.month !== "2024-06");
    const before = fake.calls.length;
    const run = await refreshIndexSeries(sys, { now: JULY_2025, client: fake, force: true });
    expect(fake.calls.slice(before).filter((c) => c.sgsCode === IPCA)).toEqual([{ sgsCode: IPCA, from: "2024-05", to: "2024-06" }]);
    expect(run.outcomes.find((o) => o.code === "ipca")).toMatchObject({ status: "no_new_month", gapMonths: ["2024-05", "2024-06"] });
    expect(describeIndexRefresh(run)).toContain(
      "Meses sem taxa no meio da série (consultados de novo na próxima execução): IPCA (05/2024 a 06/2024).",
    );

    // Published again: the next routine run (after the throttle) fills the gap and rewrites nothing.
    const stored = (await storedValues()).filter((r) => r.indexCode === "ipca");
    fake.data[IPCA] = toPoints(ipcaFixture);
    const filled = await refreshIndexSeries(sys, { now: new Date(JULY_2025.getTime() + 7 * 60 * 60_000), client: fake });
    expect(filled.outcomes.find((o) => o.code === "ipca")).toMatchObject({ status: "updated", added: 2, gapMonths: [] });
    const after = (await storedValues()).filter((r) => r.indexCode === "ipca");
    expect(after).toHaveLength(18);
    for (const row of stored) expect(after.find((r) => r.month === row.month)).toEqual(row);
    const healed = await getIndexSeriesOverview(f.ctx.admin, JULY_2025);
    expect(healed.series.find((s) => s.code === "ipca")).toMatchObject({ health: "ok", gapMonths: [] });
  });

  it("is restricted to admins for people; other profiles cannot trigger or read the collection", async () => {
    const fake = new FakeSgs({});
    await expect(refreshIndexSeries(f.ctx.lawyer, { client: fake })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getIndexSeriesOverview(f.ctx.accountant)).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("index of each valuation and updated value computed on read", () => {
  beforeAll(async () => {
    await resetSeries();
    const fake = new FakeSgs({ [IPCA]: toPoints(ipcaFixture) });
    await refreshIndexSeries(systemContext(f.orgA), { now: JULY_2025, client: fake });
  });

  async function valuation(id: string) {
    const [row] = await f.db.select().from(processValuations).where(eq(processValuations.id, id));
    return row;
  }

  it('new valuations get the organization default ("none" until chosen), through every insert path', async () => {
    expect(await getDefaultCorrectionIndex(f.ctx.admin)).toBe("none");
    const processId = await makeProcess(f.ctx.manager, { claimAmountCents: 500_000 });
    const [claim] = await f.db.select().from(processValuations).where(eq(processValuations.processId, processId));
    expect(claim.kind).toBe("claim");
    expect(claim.correctionIndex).toBe("none");

    await updateDefaultCorrectionIndex(f.ctx.admin, "ipca");
    const official = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 1_000_000,
      baseDate: "2023-12-15",
      source: "manual",
    });
    expect((await valuation(official.id)).correctionIndex).toBe("ipca");
    const proposed = await proposeValuation(f.ctx.lawyer, {
      processId,
      kind: "liquidated",
      amountCents: 2_000_000,
      baseDate: "2024-06-30",
      source: "manual",
    });
    expect((await valuation(proposed.id)).correctionIndex).toBe("ipca");
    // The earlier claim keeps its own index (nothing is rewritten).
    expect((await valuation(claim.id)).correctionIndex).toBe("none");

    // Saving the other contingency parameters keeps the chosen default.
    const c = (await getOrganizationSettings(f.ctx.admin)).settings.contingency;
    await updateContingencySettings(f.ctx.admin, {
      riskRemote: c.riskPercentages.remote,
      riskPossible: c.riskPercentages.possible,
      riskProbable: c.riskPercentages.probable,
      confidenceThreshold: 90,
      idleGuaranteeDays: c.idleGuaranteeDays,
    });
    expect(await getDefaultCorrectionIndex(f.ctx.admin)).toBe("ipca");
    await updateDefaultCorrectionIndex(f.ctx.admin, "none");
  });

  it("computes the updated value on read and never stores it", async () => {
    await updateDefaultCorrectionIndex(f.ctx.admin, "ipca");
    const processId = await makeProcess(f.ctx.manager);
    const { id } = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 1_000_000,
      baseDate: "2023-12-15",
      source: "manual",
    });
    await updateDefaultCorrectionIndex(f.ctx.admin, "none");
    const before = await valuation(id);

    const jan = await getValuationUpdates(f.ctx.lawyer, processId, { asOf: "2025-01-10" });
    expect(jan.byId[id]).toMatchObject({ amountCents: 1_000_000, baseDate: "2023-12-15", correctionIndex: "ipca" });
    expect(jan.byId[id].updated).toMatchObject({ status: "updated", cents: 1_048_313, throughMonth: "2024-12", monthsApplied: 12 });

    // Another reference date gives another value: nothing was frozen.
    const jul = await getValuationUpdates(f.ctx.lawyer, processId, { asOf: "2025-07-01" });
    expect(jul.byId[id].updated.throughMonth).toBe("2025-06");
    expect(jul.byId[id].updated.cents).not.toBe(1_048_313);

    // The stored valuation is untouched and the table has no column for an updated value.
    expect(await valuation(id)).toEqual(before);
    const cols = await f.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'process_valuations'`,
    );
    const names = (cols as unknown as { rows: { column_name: string }[] }).rows.map((r) => r.column_name);
    expect(names).toContain("correction_index");
    expect(names.filter((n) => /updated|atualiz|corrected/.test(n) && n !== "updated_at")).toEqual([]);

    // A missing month → no value, with the months listed (never estimated).
    await f.db
      .delete(indexSeriesValues)
      .where(and(eq(indexSeriesValues.indexCode, "ipca"), eq(indexSeriesValues.month, "2024-05")));
    const gap = await getValuationUpdates(f.ctx.lawyer, processId, { asOf: "2025-01-10" });
    expect(gap.byId[id].updated).toMatchObject({ status: "unavailable", cents: null, missingMonths: ["2024-05"] });
    await f.db.insert(indexSeriesValues).values({ indexCode: "ipca", month: "2024-05", ratePercent: "0.460000", source: "bcb_sgs:433" });
  });

  it('"none" shows the original value; legacy rows stay "sem índice informado"', async () => {
    const processId = await makeProcess(f.ctx.manager);
    const { id } = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 300_000,
      baseDate: "2024-01-10",
      source: "manual",
    });
    const legacy = await addValuation(f.ctx.manager, {
      processId,
      kind: "fees",
      amountCents: 70_000,
      baseDate: "2024-02-10",
      source: "manual",
    });
    // Rows that existed before the migration have no index (the column was added without a default).
    await f.db.update(processValuations).set({ correctionIndex: null }).where(eq(processValuations.id, legacy.id));
    const updates = await getValuationUpdates(f.ctx.lawyer, processId, { asOf: todayISO() });
    expect(updates.byId[id].updated).toMatchObject({ status: "not_corrected", cents: 300_000 });
    expect(updates.byId[legacy.id].updated).toMatchObject({ status: "no_index", cents: null });
  });

  it("follows row visibility and permissions", async () => {
    const processId = await makeProcess(f.ctx.manager, { isConfidential: true });
    await addValuation(f.ctx.manager, { processId, kind: "liquidated", amountCents: 100_000, baseDate: "2024-01-10", source: "manual" });
    expect((await getValuationUpdates(f.ctx.manager, processId)).items).toHaveLength(1);
    // Confidential process not visible to the lawyer, other organization never sees it.
    expect((await getValuationUpdates(f.ctx.lawyer, processId)).items).toEqual([]);
    expect((await getValuationUpdates(f.ctx.adminB, processId)).items).toEqual([]);
    await expect(getValuationUpdates(f.ctx.lawyer, "not-an-id")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("informs the index of a valuation without one, or while it is proposed; never rewrites an official one", async () => {
    const processId = await makeProcess(f.ctx.manager);
    const official = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 400_000,
      baseDate: "2024-03-10",
      source: "manual",
    });
    // Official with an index already: someone who cannot approve values cannot change it.
    await expect(setValuationCorrectionIndex(f.ctx.lawyer, official.id, "ipca")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await valuation(official.id)).correctionIndex).toBe("none");

    // Legacy (null) official value: only someone who can approve informs it, once, in place.
    await f.db.update(processValuations).set({ correctionIndex: null }).where(eq(processValuations.id, official.id));
    await expect(setValuationCorrectionIndex(f.ctx.lawyer, official.id, "inpc")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await valuation(official.id)).correctionIndex).toBeNull();
    const r = await setValuationCorrectionIndex(f.ctx.manager, official.id, "inpc");
    expect(r).toEqual({ processId, changed: true, mode: "in_place", valuationId: official.id });
    expect(await valuation(official.id)).toMatchObject({ correctionIndex: "inpc", amountCents: 400_000, baseDate: "2024-03-10" });
    const [audit] = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "valuation.correction_index_set"), eq(auditLogs.entityId, processId)));
    expect(audit.changes).toEqual({ correctionIndex: { from: null, to: "inpc" } });
    expect(audit.metadata).toEqual({ valuationId: official.id, valuationStatus: "official" });
    expect(audit.actorId).toBe(f.ctx.manager.userId);
    // Informed once: the row itself is never rewritten again (a change creates a new record, see below).
    const again = await setValuationCorrectionIndex(f.ctx.manager, official.id, "tr");
    expect(again.mode).toBe("new_record");
    expect(again.valuationId).not.toBe(official.id);
    expect(await valuation(official.id)).toMatchObject({ correctionIndex: "inpc", status: "superseded" });

    // Proposed: the index may change during the review.
    const proposed = await proposeValuation(f.ctx.lawyer, {
      processId,
      kind: "liquidated",
      amountCents: 450_000,
      baseDate: "2024-04-10",
      source: "manual",
    });
    await setValuationCorrectionIndex(f.ctx.lawyer, proposed.id, "ipca_e");
    await setValuationCorrectionIndex(f.ctx.lawyer, proposed.id, "selic");
    expect((await valuation(proposed.id)).correctionIndex).toBe("selic");
    expect(await setValuationCorrectionIndex(f.ctx.lawyer, proposed.id, "selic")).toEqual({
      processId,
      changed: false,
      mode: null,
      valuationId: proposed.id,
    });

    // Rejected: refused.
    await reviewValuation(f.ctx.manager, proposed.id, { decision: "reject", note: "Teste" });
    await expect(setValuationCorrectionIndex(f.ctx.lawyer, proposed.id, "ipca")).rejects.toBeInstanceOf(ConflictError);

    // Permissions, tenant and input validation.
    await expect(setValuationCorrectionIndex(f.ctx.executive, again.valuationId, "ipca")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setValuationCorrectionIndex(f.ctx.adminB, again.valuationId, "ipca")).rejects.toBeInstanceOf(NotFoundError);
    await expect(setValuationCorrectionIndex(f.ctx.lawyer, again.valuationId, "igpm" as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(setValuationCorrectionIndex(systemContext(f.orgA), again.valuationId, "ipca")).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setValuationCorrectionIndex(f.ctx.manager, again.valuationId, "ipca", { note: "x".repeat(501) }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await valuation(again.valuationId)).correctionIndex).toBe("tr");
  });

  it("official or superseded values without index get one only from someone who can approve", async () => {
    const processId = await makeProcess(f.ctx.manager);
    await f.db.update(legalProcesses).set({ lawFirmId: f.lawFirmA }).where(eq(legalProcesses.id, processId));
    const older = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 400_000,
      baseDate: "2024-03-10",
      source: "manual",
    });
    const newer = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 420_000,
      baseDate: "2024-05-10",
      source: "manual",
    });
    expect((await valuation(older.id)).status).toBe("superseded");
    expect((await valuation(newer.id)).status).toBe("official");
    await f.db
      .update(processValuations)
      .set({ correctionIndex: null })
      .where(inArray(processValuations.id, [older.id, newer.id]));

    // External counsel (own portfolio) and lawyer write values but do not approve them.
    for (const ctx of [f.ctx.externalCounsel, f.ctx.lawyer]) {
      await expect(setValuationCorrectionIndex(ctx, newer.id, "selic")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setValuationCorrectionIndex(ctx, older.id, "selic")).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await valuation(newer.id)).correctionIndex).toBeNull();
    expect((await valuation(older.id)).correctionIndex).toBeNull();

    // Profiles with contingency:approve (accountant, manager) inform it, identified in the audit trail.
    await setValuationCorrectionIndex(f.ctx.accountant, newer.id, "ipca");
    await setValuationCorrectionIndex(f.ctx.manager, older.id, "ipca");
    expect((await valuation(newer.id)).correctionIndex).toBe("ipca");
    expect((await valuation(older.id)).correctionIndex).toBe("ipca");

    // While in review, whoever writes values may still choose (external counsel on its own portfolio).
    const proposed = await proposeValuation(f.ctx.externalCounsel, {
      processId,
      kind: "liquidated",
      amountCents: 430_000,
      baseDate: "2024-06-10",
      source: "manual",
    });
    expect(await setValuationCorrectionIndex(f.ctx.externalCounsel, proposed.id, "inpc")).toEqual({
      processId,
      changed: true,
      mode: "in_place",
      valuationId: proposed.id,
    });
  });

  it("the review correction keeps the index informed during review", async () => {
    const processId = await makeProcess(f.ctx.manager);
    const proposed = await proposeValuation(f.ctx.lawyer, {
      processId,
      kind: "liquidated",
      amountCents: 450_000,
      baseDate: "2024-04-10",
      source: "manual",
    });
    expect((await valuation(proposed.id)).correctionIndex).toBe("none");
    await setValuationCorrectionIndex(f.ctx.lawyer, proposed.id, "ipca_e");
    const res = await reviewValuation(f.ctx.manager, proposed.id, {
      decision: "correct",
      correctedAmountCents: 460_000,
      note: "Ajuste de conferência",
    });
    expect(res.correctedValuationId).toBeTruthy();
    const corrected = await valuation(res.correctedValuationId!);
    expect(corrected).toMatchObject({ status: "official", amountCents: 460_000, baseDate: "2024-04-10", correctionIndex: "ipca_e" });
    expect((await valuation(proposed.id)).status).toBe("rejected");

    // A proposal without index (legacy) corrected: the new value gets the organization default, as any new value.
    await updateDefaultCorrectionIndex(f.ctx.admin, "tr");
    const legacy = await proposeValuation(f.ctx.lawyer, {
      processId,
      kind: "fees",
      amountCents: 50_000,
      baseDate: "2024-04-10",
      source: "manual",
    });
    await f.db.update(processValuations).set({ correctionIndex: null }).where(eq(processValuations.id, legacy.id));
    const res2 = await reviewValuation(f.ctx.manager, legacy.id, { decision: "correct", correctedAmountCents: 55_000, note: "Ajuste" });
    expect((await valuation(res2.correctedValuationId!)).correctionIndex).toBe("tr");
    await updateDefaultCorrectionIndex(f.ctx.admin, "none");
  });

  it("an approver changes the index of an official value with a NEW official record (approver values, valor da causa)", async () => {
    // Values official as soon as they are inserted get the organization default: the approver's own
    // value and the valor da causa of the process form.
    await updateDefaultCorrectionIndex(f.ctx.admin, "ipca_e");
    const processId = await makeProcess(f.ctx.manager, { claimAmountCents: 900_000 });
    const [claim] = await f.db
      .select()
      .from(processValuations)
      .where(and(eq(processValuations.processId, processId), eq(processValuations.kind, "claim")));
    expect(claim).toMatchObject({ status: "official", correctionIndex: "ipca_e" });
    const first = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 1_000_000,
      baseDate: "2023-12-15",
      source: "manual",
    });
    expect(first.status).toBe("official");
    expect((await valuation(first.id)).correctionIndex).toBe("ipca_e");
    await updateDefaultCorrectionIndex(f.ctx.admin, "none");
    const before = await getProcessContingencySummary(f.ctx.manager, processId);

    const res = await setValuationCorrectionIndex(f.ctx.manager, first.id, "ipca", { note: "Índice definido pelo advogado do caso." });
    expect(res).toMatchObject({ processId, changed: true, mode: "new_record" });
    expect(res.valuationId).not.toBe(first.id);
    const old = await valuation(first.id);
    const created = await valuation(res.valuationId);
    // Append-only: the old record keeps its index and becomes history; same amount, base date and provenance.
    expect(old).toMatchObject({ status: "superseded", correctionIndex: "ipca_e", amountCents: 1_000_000, baseDate: "2023-12-15" });
    expect(created).toMatchObject({
      status: "official",
      correctionIndex: "ipca",
      kind: "liquidated",
      amountCents: 1_000_000,
      baseDate: "2023-12-15",
      instance: old.instance,
      source: "manual",
      supersedesId: first.id,
      createdById: f.ctx.manager.userId,
      reviewedById: f.ctx.manager.userId,
      importBatchId: null,
    });
    expect(created.reviewNote).toContain("Troca do índice de atualização: de IPCA-E para IPCA");
    expect(created.reviewNote).toContain("Índice definido pelo advogado do caso.");
    // The totals do not move: the official amount is the same.
    const after = await getProcessContingencySummary(f.ctx.manager, processId);
    expect(after.liquidatedCents).toBe(before.liquidatedCents);
    expect(after.claimCents).toBe(before.claimCents);
    // The new record is updated by its own index (computed on read); the old one keeps its index.
    const updates = await getValuationUpdates(f.ctx.lawyer, processId, { asOf: "2025-01-10" });
    expect(updates.byId[res.valuationId].updated).toMatchObject({ status: "updated", cents: 1_048_313 });
    expect(updates.byId[first.id].correctionIndex).toBe("ipca_e");

    const [audit] = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "valuation.correction_index_replace"), eq(auditLogs.entityId, processId)));
    expect(audit.changes).toEqual({ correctionIndex: { from: "ipca_e", to: "ipca" } });
    expect(audit.metadata).toEqual({ valuationId: first.id, newValuationId: res.valuationId });
    expect(audit.actorId).toBe(f.ctx.manager.userId);

    // History is never rewritten; profiles without approval cannot change an official value.
    await expect(setValuationCorrectionIndex(f.ctx.manager, first.id, "tr")).rejects.toBeInstanceOf(ConflictError);
    await expect(setValuationCorrectionIndex(f.ctx.lawyer, res.valuationId, "tr")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setValuationCorrectionIndex(f.ctx.externalCounsel, res.valuationId, "tr")).rejects.toBeInstanceOf(NotFoundError);
    // Another approver may change the value in force again: one more record, one official value.
    const third = await setValuationCorrectionIndex(f.ctx.accountant, res.valuationId, "none");
    expect(third.mode).toBe("new_record");
    expect(await valuation(res.valuationId)).toMatchObject({ status: "superseded", correctionIndex: "ipca" });
    const listed = await listValuations(f.ctx.manager, processId);
    expect(listed.filter((v) => v.kind === "liquidated" && v.status === "official").map((v) => v.id)).toEqual([third.valuationId]);
    expect(listed.filter((v) => v.kind === "liquidated")).toHaveLength(3);

    // The valor da causa registered by the process form, too.
    const claimSwap = await setValuationCorrectionIndex(f.ctx.manager, claim.id, "inpc");
    expect(claimSwap.mode).toBe("new_record");
    expect(await valuation(claimSwap.valuationId)).toMatchObject({ kind: "claim", status: "official", amountCents: 900_000, correctionIndex: "inpc" });
    expect((await getProcessContingencySummary(f.ctx.manager, processId)).claimCents).toBe(900_000);

    // Default "none" + value registered by an approver: the index can still be informed afterwards.
    const plain = await addValuation(f.ctx.accountant, { processId, kind: "fees", amountCents: 70_000, baseDate: "2024-02-10", source: "manual" });
    expect((await valuation(plain.id)).correctionIndex).toBe("none");
    const informed = await setValuationCorrectionIndex(f.ctx.accountant, plain.id, "ipca");
    expect(await valuation(informed.valuationId)).toMatchObject({ status: "official", correctionIndex: "ipca", amountCents: 70_000 });
  });

  it("never changes the value in force: refuses the swap when another instance shares the base date", async () => {
    const pause = () => new Promise((r) => setTimeout(r, 5));
    await updateDefaultCorrectionIndex(f.ctx.admin, "ipca");
    const processId = await makeProcess(f.ctx.manager);
    // Two official values of the same kind and base date in different instances: the most recently
    // reviewed one (second instance, R$ 2.000) is in force.
    const first = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 100_000,
      baseDate: "2024-06-30",
      instance: "first",
      source: "manual",
    });
    await pause();
    const second = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 200_000,
      baseDate: "2024-06-30",
      instance: "second",
      source: "manual",
    });
    await updateDefaultCorrectionIndex(f.ctx.admin, "none");
    expect([first.status, second.status]).toEqual(["official", "official"]);
    const rowsOf = () => f.db.select().from(processValuations).where(eq(processValuations.processId, processId));
    const auditsOf = () =>
      f.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "valuation.correction_index_replace"), eq(auditLogs.entityId, processId)));
    const today = todayISO();
    expect((await getProcessContingencySummary(f.ctx.manager, processId)).liquidatedCents).toBe(200_000);
    expect((await getPositionAt(f.ctx.manager, processId, today)).liquidatedCents).toBe(200_000);

    await pause();
    const refused = setValuationCorrectionIndex(f.ctx.manager, first.id, "selic");
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(setValuationCorrectionIndex(f.ctx.manager, first.id, "selic")).rejects.toThrow(/outra instância/);
    // Nothing was written: both rows untouched, no new record, no audit; the value in force is the same.
    const rows = await rowsOf();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.id)).toMatchObject({ status: "official", correctionIndex: "ipca" });
    expect(await auditsOf()).toHaveLength(0);
    expect((await getPositionAt(f.ctx.manager, processId, today)).liquidatedCents).toBe(200_000);
    expect(await syncProcessMirrors(f.orgA, processId, f.db)).toBeNull();
    expect((await getProcessContingencySummary(f.ctx.manager, processId)).liquidatedCents).toBe(200_000);
    // The other one is refused too (the tie decides the value in force either way).
    await expect(setValuationCorrectionIndex(f.ctx.manager, second.id, "selic")).rejects.toBeInstanceOf(ConflictError);

    // A SUPERSEDED value of another instance with the same base date still decides past positions.
    await pause();
    const later = await addValuation(f.ctx.manager, {
      processId,
      kind: "liquidated",
      amountCents: 250_000,
      baseDate: "2024-09-30",
      instance: "second",
      source: "manual",
    });
    expect((await rowsOf()).find((r) => r.id === second.id)?.status).toBe("superseded");
    expect((await getPositionAt(f.ctx.manager, processId, "2024-07-31")).liquidatedCents).toBe(200_000);
    await expect(setValuationCorrectionIndex(f.ctx.manager, first.id, "inpc")).rejects.toThrow(/outra instância/);
    expect((await getPositionAt(f.ctx.manager, processId, "2024-07-31")).liquidatedCents).toBe(200_000);

    // A value whose base date is not shared with another instance still swaps, with nothing else moving.
    const swap = await setValuationCorrectionIndex(f.ctx.manager, later.id, "inpc");
    expect(swap.mode).toBe("new_record");
    expect((await getPositionAt(f.ctx.manager, processId, "2024-07-31")).liquidatedCents).toBe(200_000);
    expect((await getPositionAt(f.ctx.manager, processId, today)).liquidatedCents).toBe(250_000);
    expect(await syncProcessMirrors(f.orgA, processId, f.db)).toBeNull();
    expect((await getProcessContingencySummary(f.ctx.manager, processId)).liquidatedCents).toBe(250_000);
  });

  it("rolls the swap back when the new record would win a tie of the same instance (computed before and after)", async () => {
    const processId = await makeProcess(f.ctx.manager);
    const official = await addValuation(f.ctx.manager, {
      processId,
      kind: "claim",
      amountCents: 300_000,
      baseDate: "2024-03-31",
      instance: "first",
      source: "manual",
    });
    // A history row of the same instance and base date reviewed AFTER the official one (not produced by
    // the current flows, inserted here to exercise the second guard): it decides the positions of that date.
    await new Promise((r) => setTimeout(r, 5));
    const reviewedLater = new Date();
    const [history] = await f.db
      .insert(processValuations)
      .values({
        organizationId: f.orgA,
        processId,
        kind: "claim",
        amountCents: 350_000,
        baseDate: "2024-03-31",
        instance: "first",
        source: "manual",
        status: "superseded",
        reviewedById: f.ctx.manager.userId,
        reviewedAt: reviewedLater,
      })
      .returning({ id: processValuations.id });
    const date = "2024-04-15";
    expect((await getPositionAt(f.ctx.manager, processId, date)).claimCents).toBe(350_000);
    const indexBefore = (await valuation(official.id)).correctionIndex;
    await new Promise((r) => setTimeout(r, 5));
    const target = indexBefore === "ipca" ? "inpc" : "ipca";
    await expect(setValuationCorrectionIndex(f.ctx.manager, official.id, target)).rejects.toThrow(/mudaria o valor em vigor/);
    // Rolled back: the official row is still in force with its index, no new record, no audit.
    const rows = await f.db.select().from(processValuations).where(eq(processValuations.processId, processId));
    expect(rows.map((r) => r.id).sort()).toEqual([official.id, history.id].sort());
    expect(rows.find((r) => r.id === official.id)).toMatchObject({ status: "official", correctionIndex: indexBefore });
    const audits = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "valuation.correction_index_replace"), eq(auditLogs.entityId, processId)));
    expect(audits).toHaveLength(0);
    expect((await getPositionAt(f.ctx.manager, processId, date)).claimCents).toBe(350_000);
  });

  it("the review shows the index and refuses a decision when it changed after the screen was loaded", async () => {
    await updateDefaultCorrectionIndex(f.ctx.admin, "ipca_e");
    const processId = await makeProcess(f.ctx.manager);
    const sheet = { baseDate: "2024-02-10", source: "spreadsheet" as const, confidence: 99 };
    const single = await proposeValuation(f.ctx.lawyer, { processId, kind: "liquidated", amountCents: 300_000, ...sheet });
    const bulkA = await proposeValuation(f.ctx.lawyer, { processId, kind: "claim", amountCents: 800_000, ...sheet });
    const bulkB = await proposeValuation(f.ctx.lawyer, { processId, kind: "fees", amountCents: 80_000, ...sheet });
    await updateDefaultCorrectionIndex(f.ctx.admin, "none");

    // The queue and the selected item carry the index; the updated value is computed from the loaded rows.
    const queue = await listReviewQueue(f.ctx.manager, { source: "spreadsheet", pageSize: 100 });
    const shown = new Map(queue.items.map((i) => [i.id, i.correctionIndex]));
    expect(shown.get(single.id)).toBe("ipca_e");
    expect((await getReviewItem(f.ctx.manager, single.id)).valuation.correctionIndex).toBe("ipca_e");
    const updates = await computeValuationUpdates(
      f.ctx.manager,
      queue.items.map((i) => ({ ...i, status: "proposed" as const })),
      { asOf: "2025-01-10" },
    );
    expect(updates.byId[single.id]).toMatchObject({ correctionIndex: "ipca_e", amountCents: 300_000, status: "proposed" });

    // The lawyer changes the index after the reviewer loaded the screen: approval and correction are refused.
    await setValuationCorrectionIndex(f.ctx.lawyer, single.id, "selic");
    await expect(
      reviewValuation(f.ctx.manager, single.id, { decision: "approve" }, { expectedCorrectionIndex: "ipca_e" }),
    ).rejects.toThrow(CORRECTION_INDEX_CHANGED_MESSAGE);
    await expect(
      reviewValuation(f.ctx.manager, single.id, { decision: "correct", correctedAmountCents: 310_000 }, { expectedCorrectionIndex: "ipca_e" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await valuation(single.id)).status).toBe("proposed");
    // With the index actually shown, the approval goes through and the index is final.
    const approved = await reviewValuation(f.ctx.manager, single.id, { decision: "approve" }, { expectedCorrectionIndex: "selic" });
    expect(approved.status).toBe("official");
    expect(await valuation(single.id)).toMatchObject({ status: "official", correctionIndex: "selic", reviewedById: f.ctx.manager.userId });

    // Bulk approval: a row whose index changed since is refused, the others are approved.
    await setValuationCorrectionIndex(f.ctx.lawyer, bulkB.id, "tr");
    const bulk = await bulkApproveValuations(f.ctx.manager, [bulkA.id, bulkB.id], { [bulkA.id]: "ipca_e", [bulkB.id]: "ipca_e" });
    expect(bulk.approved).toBe(1);
    expect(bulk.refused).toEqual([{ id: bulkB.id, reason: CORRECTION_INDEX_CHANGED_MESSAGE }]);
    expect((await valuation(bulkA.id)).status).toBe("official");
    expect(await valuation(bulkB.id)).toMatchObject({ status: "proposed", correctionIndex: "tr" });

    // A rejection does not depend on the index.
    await reviewValuation(f.ctx.manager, bulkB.id, { decision: "reject", note: "Sem lastro." }, { expectedCorrectionIndex: "ipca_e" });
    expect((await valuation(bulkB.id)).status).toBe("rejected");

    // A legacy proposal without index is pinned as null ("sem índice informado").
    const legacy = await proposeValuation(f.ctx.lawyer, { processId, kind: "fees", amountCents: 90_000, baseDate: "2024-03-10", source: "manual" });
    await f.db.update(processValuations).set({ correctionIndex: null }).where(eq(processValuations.id, legacy.id));
    await expect(
      reviewValuation(f.ctx.manager, legacy.id, { decision: "approve" }, { expectedCorrectionIndex: "none" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await reviewValuation(f.ctx.manager, legacy.id, { decision: "approve" }, { expectedCorrectionIndex: null });
    expect(await valuation(legacy.id)).toMatchObject({ status: "official", correctionIndex: null });
  });

  it("changes the organization default only with admin:organization (audited, other organization untouched)", async () => {
    await expect(updateDefaultCorrectionIndex(f.ctx.lawyer, "ipca")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateDefaultCorrectionIndex(f.ctx.admin, "igpm" as never)).rejects.toBeInstanceOf(ValidationError);
    expect(await updateDefaultCorrectionIndex(f.ctx.admin, "tr")).toEqual({ changed: true });
    expect(await updateDefaultCorrectionIndex(f.ctx.admin, "tr")).toEqual({ changed: false });
    const [audit] = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "organization.correction_index_default_update"), eq(auditLogs.organizationId, f.orgA)))
      .orderBy(sql`${auditLogs.createdAt} desc`)
      .limit(1);
    expect(audit.changes).toEqual({ defaultCorrectionIndex: { from: "none", to: "tr" } });
    expect(await getDefaultCorrectionIndex(f.ctx.adminB)).toBe("none");
    await updateDefaultCorrectionIndex(f.ctx.admin, "none");
  });
});

describe("months helper sanity for the routine clock", () => {
  it("the last storable month is the month before today (São Paulo)", () => {
    expect(addMonths(monthOfDate(todayISO(JULY_2025)), -1)).toBe("2025-06");
  });
});
