/**
 * Court sync against a FakeCourtProvider (no network) on PGlite: batching by
 * tribunal, movement dedupe, fill-empty-only, forward-only phase, instance
 * from "Remessa em grau de recurso", no automatic closure, alerts, backoff,
 * failure alert, inactive collection, permissions, routine and settings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { addDaysISO, todayISO } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { runCourtSyncRoutine, runSimulatedFeedRoutine } from "@/modules/court-sync/routines";
import {
  FAILURE_ALERT_MIN_HOURS,
  aliasesWithPendingSync,
  continuationStep,
  getCourtSyncHealth,
  getProcessCourtSyncPanel,
  listDueAliases,
  lookupCourtRecord,
  requestPortfolioSync,
  runCourtSync,
  syncProcessNow,
  updateCourtIntegrationSettings,
  type CourtSyncRunResult,
} from "@/modules/court-sync/service";
import { resolveProcessVerification } from "@/modules/processes/service";
import {
  alerts,
  auditLogs,
  caseIntakes,
  courtSyncRuns,
  courtSyncStates,
  jobs,
  legalProcesses,
  organizations,
  processEvents,
  processInstances,
} from "@/server/db/schema";
import { FakeCourtProvider } from "@/server/integrations/courts/fake";
import { setCourtProviderForTesting } from "@/server/integrations/courts";
import { CourtProviderError } from "@/server/integrations/courts/types";
import { ForbiddenError, NotFoundError } from "@/server/lib/errors";
import type { RoutineContext } from "@/server/jobs/routines";
import { makeProcess, runJobs, setupFixture, type Fixture } from "../helpers/fixtures";
import { cnjNumber, digitsOf, emGrauDeRecurso, hearing, mv, rec } from "./helpers";

let f: Fixture;
const fake = new FakeCourtProvider();
const today = todayISO();
const d = (days: number) => addDaysISO(today, -days);

const nA = cnjNumber({ seq: 101, tribunal: "10" });
const nB = cnjNumber({ seq: 102, tribunal: "10" });
const nC = cnjNumber({ seq: 103, segment: "8", tribunal: "26" });
const nD = cnjNumber({ seq: 104, segment: "1", tribunal: "00", origin: "0000" });
const nE = cnjNumber({ seq: 105, tribunal: "02" });
const nF = cnjNumber({ seq: 106, tribunal: "10" });
const nG = cnjNumber({ seq: 107, tribunal: "10" });

let pA: string, pB: string, pC: string, pD: string, pE: string, pF: string;

async function processRow(id: string) {
  const [row] = await f.db.select().from(legalProcesses).where(eq(legalProcesses.id, id));
  return row;
}
async function eventCount(id: string): Promise<number> {
  const [{ n }] = await f.db.select({ n: sql<number>`count(*)::int` }).from(processEvents).where(eq(processEvents.processId, id));
  return Number(n);
}
async function stateOf(id: string) {
  const [row] = await f.db.select().from(courtSyncStates).where(eq(courtSyncStates.processId, id));
  return row;
}
async function openAlerts(type: string, entityId?: string) {
  return f.db
    .select()
    .from(alerts)
    .where(and(eq(alerts.organizationId, f.orgA), eq(alerts.type, type as never), sql`${alerts.resolvedAt} is null`, entityId ? eq(alerts.entityId, entityId) : undefined));
}
async function routineContext(): Promise<RoutineContext> {
  const org = await loadOrganization(f.orgA);
  return { organizationId: f.orgA, isDemo: org.isDemo, settings: org.settings, config: {}, today };
}

beforeAll(async () => {
  f = await setupFixture("cs");
  setCourtProviderForTesting(fake);
  const admin = f.ctx.admin;
  pA = await makeProcess(admin, { number: nA, court: "TRT10", area: "labor", phase: "knowledge", processClass: "ATOrd", city: "Palmas", state: "TO" });
  pB = await makeProcess(admin, { number: nB, court: "TRT10", area: "labor", phase: "enforcement" });
  pC = await makeProcess(admin, { number: nC, court: "TJSP", area: "civil", phase: "knowledge" });
  pD = await makeProcess(admin, { number: nD, court: "STF", area: "other", phase: "knowledge" });
  pE = await makeProcess(admin, { number: nE, court: "TRT2", area: "labor", phase: "knowledge" });
  pF = await makeProcess(admin, { number: nF, court: "TRT10", area: "labor", phase: "knowledge" });

  fake.add(
    "trt10",
    rec(nA, {
      movements: [
        mv(26, "Distribuição", d(200)),
        mv(12747, "Inicial", d(190), [hearing("designada")]),
        mv(60, "Expedição de documento", d(180), [], "13:56:09"),
        mv(60, "Expedição de documento", d(180), [], "13:56:09"),
        mv(848, "Trânsito em julgado", d(31)),
        mv(11384, "Liquidação iniciada", d(30)),
        mv(12747, "Inicial", d(10), [hearing("designada")], "15:00:00"),
        mv(123, "Remessa", d(5), [emGrauDeRecurso]),
      ],
    }),
    rec(nA, {
      grau: "G2",
      courtDivision: { code: 9, name: "Gabinete Fictício", ibgeCode: null },
      processClass: { code: 1009, name: "Recurso Ordinário Trabalhista" },
      filedAt: d(5),
      movements: [mv(26, "Distribuição", d(4))],
    }),
    rec(nB, { movements: [mv(11384, "Liquidação iniciada", d(20))] }),
    rec(nF, { movements: [mv(11384, "Liquidação iniciada", d(15))] }),
  );
  fake.add("tjsp", rec(nC, { alias: "tjsp", tribunal: "TJSP", courtDivision: { code: 1, name: "2ª Vara Cível de Campinas - SP", ibgeCode: null }, movements: [mv(26, "Distribuição", d(50))] }));
});

afterAll(async () => {
  setCourtProviderForTesting(undefined);
  await f?.teardown();
});

describe("runCourtSync (routine)", () => {
  it("queries one batch per tribunal (origin + TST) and marks unsupported numbers", async () => {
    const summary = await runCourtSync(f.orgA, { trigger: "routine", processIds: [pA, pB, pC, pD, pE] });
    expect(summary.status).toBe("completed");
    const trt10 = fake.calls.filter((c) => c.alias === "trt10");
    expect(trt10).toHaveLength(1);
    expect(trt10[0].numbers.sort()).toEqual([digitsOf(nA), digitsOf(nB)].sort());
    expect(fake.calls.filter((c) => c.alias === "tst").map((c) => c.numbers.length).sort()).toEqual([1, 2]);
    expect(fake.calls.filter((c) => c.alias === "tjsp")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.alias === "trt2")).toHaveLength(1);
    expect(fake.calls[0].opts.maxRequestsPerMinute).toBe(20);
    expect(summary.unsupported).toBe(1);
    expect((await stateOf(pD)).status).toBe("unsupported");
    expect((await stateOf(pE)).status).toBe("not_found");
    expect((await stateOf(pA)).status).toBe("found");
    const runs = await f.db.select().from(courtSyncRuns).where(eq(courtSyncRuns.organizationId, f.orgA));
    expect(runs.map((r) => r.tribunalAlias).sort()).toEqual(["tjsp", "trt10", "trt2"]);
    expect(runs.every((r) => r.status === "succeeded" && r.finishedAt)).toBe(true);
  });

  it("imports each movement once (same code and time = one event) with origin 'imported'", async () => {
    expect(await eventCount(pA)).toBe(8);
    const events = await f.db.select().from(processEvents).where(eq(processEvents.processId, pA));
    expect(events.every((e) => e.origin === "imported" && e.externalSource === "DataJud (CNJ)" && e.externalId)).toBe(true);
    expect(events.find((e) => e.cnjMovementCode === 26 && e.instance === "first")?.type).toBe("filing");
    expect(events.find((e) => e.cnjMovementCode === 26 && e.instance === "second")).toBeTruthy();
    const summary = await runCourtSync(f.orgA, { trigger: "manual", processIds: [pA, pB] });
    expect(summary.runs[0].newMovements).toBe(0);
    expect(await eventCount(pA)).toBe(8);
  });

  it("fills only empty fields and records divergences for verification", async () => {
    const p = await processRow(pA);
    expect(p.courtDivision).toBe("21ª Vara do Trabalho de Brasília - DF");
    expect(p.processClass).toBe("ATOrd");
    expect(p.city).toBe("Palmas");
    expect(p.state).toBe("TO");
    expect(p.filedAt).toBe("2025-02-28");
    expect(p.subjects).toEqual([{ code: 13719, name: "FGTS" }]);
    expect(p.lastMovementAt).toBe(d(4));
    expect(p.needsVerification).toBe(true);
    expect(p.verificationNote).toContain("Cidade informada pelo tribunal: Brasília/DF");
    const c = await processRow(pC);
    expect(c.city).toBe("Campinas");
    expect(c.state).toBe("SP");
  });

  it("phase moves forward only, the instance follows the remessa, nothing is closed", async () => {
    const a = await processRow(pA);
    expect(a.phase).toBe("liquidation");
    expect(a.phase).not.toBe("appeal");
    expect(a.instance).toBe("second");
    expect(a.status).toBe("active");
    expect(a.closedAt).toBeNull();
    expect(a.verificationNote).toContain("Trânsito em julgado");
    const b = await processRow(pB);
    expect(b.phase).toBe("enforcement");
    const instances = await f.db.select().from(processInstances).where(eq(processInstances.processId, pA));
    expect(instances.map((i) => [i.instance, i.isCurrent, i.origin]).sort()).toEqual([
      ["first", false, "imported"],
      ["second", true, "imported"],
    ]);
  });

  it("raises the relevant-movement and designated-hearing alerts (date not informed)", async () => {
    const relevant = await openAlerts("court_movement_relevant", pA);
    expect(relevant).toHaveLength(1);
    expect(relevant[0].message).toContain("nada foi encerrado automaticamente");
    const hearings = await openAlerts("court_hearing_designated", pA);
    expect(hearings).toHaveLength(1);
    expect(hearings[0].message).toContain("Data não informada pelo tribunal: cadastre a partir da intimação");
    expect(hearings[0].dedupeKey).toContain(d(10));
  });

  it("audits every automatic change as 'Sistema · DataJud' without content", async () => {
    const rows = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, pA), eq(auditLogs.action, "legal_process.court_sync")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].actorId).toBeNull();
    expect(rows[0].summary).toContain("Sistema · DataJud");
    expect(rows[0].metadata).toMatchObject({ source: "datajud", actor: "Sistema · DataJud", newMovements: 8 });
    expect(rows[0].changes).toMatchObject({ phase: { from: "knowledge", to: "liquidation" } });
  });

  it("with autoApplyPhase off the phase is kept and an alert asks for a human", async () => {
    await f.db
      .update(organizations)
      .set({ settings: sql`jsonb_set(${organizations.settings}, '{integrations}', ${JSON.stringify({ datajud: { autoApplyPhase: false } })}::jsonb, true)` })
      .where(eq(organizations.id, f.orgA));
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pF] });
    expect((await processRow(pF)).phase).toBe("knowledge");
    const [alert] = await openAlerts("court_movement_relevant", pF);
    expect(alert.message).toContain("aplique manualmente");
    const org = await loadOrganization(f.orgA);
    expect(org.settings.integrations.datajud.enabled).toBe(true); // merged with the defaults
  });
});

describe("failures, backoff and the failure alert", () => {
  it("backs off per process and alerts after repeated failures of a tribunal over hours", async () => {
    fake.fail("trt2", new CourtProviderError("server_error", "O DataJud está indisponível no momento (HTTP 503).", true, 503));
    for (let i = 0; i < 3; i++) {
      const s = await runCourtSync(f.orgA, { trigger: "manual", processIds: [pE] });
      expect(s.runs[0].status).toBe("failed");
    }
    const state = await stateOf(pE);
    expect(state.status).toBe("error");
    expect(state.consecutiveErrors).toBe(3);
    expect(state.lastError).toContain("indisponível");
    expect(state.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 3 * 3_600_000);
    // Three failures within minutes (a short outage, quick retries): nobody is paged yet.
    expect(await openAlerts("court_sync_failed")).toHaveLength(0);

    // The same tribunal still failing hours later: critical alert.
    const failedRuns = await f.db
      .select({ id: courtSyncRuns.id })
      .from(courtSyncRuns)
      .where(and(eq(courtSyncRuns.organizationId, f.orgA), eq(courtSyncRuns.tribunalAlias, "trt2"), eq(courtSyncRuns.status, "failed")))
      .orderBy(asc(courtSyncRuns.startedAt));
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    // Earlier (successful) runs of the tribunal happened before the outage.
    await f.db
      .update(courtSyncRuns)
      .set({ startedAt: hoursAgo(FAILURE_ALERT_MIN_HOURS + 10) })
      .where(and(eq(courtSyncRuns.organizationId, f.orgA), eq(courtSyncRuns.tribunalAlias, "trt2"), sql`${courtSyncRuns.status} <> 'failed'`));
    await f.db.update(courtSyncRuns).set({ startedAt: hoursAgo(FAILURE_ALERT_MIN_HOURS + 2) }).where(eq(courtSyncRuns.id, failedRuns[0].id));
    await f.db.update(courtSyncRuns).set({ startedAt: hoursAgo(FAILURE_ALERT_MIN_HOURS + 1) }).where(eq(courtSyncRuns.id, failedRuns[1].id));
    await f.db.update(courtSyncRuns).set({ startedAt: hoursAgo(FAILURE_ALERT_MIN_HOURS + 0.5) }).where(eq(courtSyncRuns.id, failedRuns[2].id));
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pE] });
    const [alert] = await openAlerts("court_sync_failed");
    expect(alert?.message).toContain("ao longo de");

    fake.fail("trt2", null);
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pE] });
    expect((await stateOf(pE)).consecutiveErrors).toBe(0);
    expect(await openAlerts("court_sync_failed")).toHaveLength(0);
  });
});

describe("inactive collection (no DATAJUD_API_KEY)", () => {
  it("reports 'Coleta inativa' everywhere and changes nothing", async () => {
    setCourtProviderForTesting(null);
    try {
      const before = await eventCount(pA);
      const s = await runCourtSync(f.orgA, { trigger: "routine" });
      expect(s.status).toBe("inactive");
      expect(s.message).toContain("Coleta inativa");
      expect((await syncProcessNow(f.ctx.lawyer, pA)).status).toBe("inactive");
      expect(await runCourtSyncRoutine(await routineContext())).toContain("Coleta inativa");
      expect((await lookupCourtRecord(f.ctx.lawyer, nA)).status).toBe("inactive");
      expect((await getProcessCourtSyncPanel(f.ctx.lawyer, pA)).active).toBe(false);
      expect(await eventCount(pA)).toBe(before);
    } finally {
      setCourtProviderForTesting(fake);
    }
  });
});

describe("user entry points", () => {
  it("manual sync requires court_sync:run and row visibility", async () => {
    await expect(syncProcessNow(f.ctx.executive, pA)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(syncProcessNow(f.ctx.accountant, pA)).rejects.toBeInstanceOf(ForbiddenError);
    const hidden = await makeProcess(f.ctx.admin, { number: cnjNumber({ seq: 120 }), court: "TRT10", area: "labor", phase: "knowledge", unitId: f.unitSp });
    await expect(syncProcessNow(f.ctx.lawyerRe, hidden)).rejects.toBeInstanceOf(NotFoundError);
    await expect(syncProcessNow(f.ctx.adminB, pA)).rejects.toBeInstanceOf(NotFoundError);
    const r = await syncProcessNow(f.ctx.analyst, pA);
    expect(r.status).toBe("found");
    expect(r.message).toContain("nenhuma movimentação nova");
  });

  it("the lookup tool reads without saving", async () => {
    const before = await eventCount(pA);
    const result = await lookupCourtRecord(f.ctx.lawyer, digitsOf(nA));
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.records.map((r) => r.grau)).toEqual(["G1", "G2"]);
    expect(result.existingProcess?.id).toBe(pA);
    expect(await eventCount(pA)).toBe(before);
    expect((await lookupCourtRecord(f.ctx.lawyer, "123")).status).toBe("invalid");
    expect((await lookupCourtRecord(f.ctx.lawyer, nD)).status).toBe("unsupported");
    await expect(lookupCourtRecord(f.ctx.executive, nA)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("panel and health page", async () => {
    const panel = await getProcessCourtSyncPanel(f.ctx.lawyer, pA);
    expect(panel.state?.status).toBe("found");
    expect(panel.importedMovements).toBe(8);
    expect(panel.aliases).toEqual(["trt10", "tst"]);
    await expect(getProcessCourtSyncPanel(f.ctx.adminB, pA)).rejects.toBeInstanceOf(NotFoundError);
    const health = await getCourtSyncHealth(f.ctx.admin);
    expect(health.tribunals.find((t) => t.alias === "trt10")?.lastRun?.status).toBe("succeeded");
    expect(health.unsupported).toBe(1);
    await expect(getCourtSyncHealth(f.ctx.lawyer)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("bounded runs", () => {
  it("a run handles at most `limit` processes and reports the rest as remaining", async () => {
    const since = new Date();
    const s = await runCourtSync(f.orgA, { trigger: "manual", force: true, limit: 1, alias: "trt10" });
    expect(s.status).toBe("completed");
    expect(s.runs[0].checked).toBe(1);
    expect(s.remaining).toBeGreaterThan(0);
    // The continuation skips what was already checked since the start of the run.
    const next = await runCourtSync(f.orgA, { trigger: "manual", force: true, notCheckedSince: since, alias: "trt10" });
    expect(next.status).toBe("completed");
    expect(next.runs[0].checked).toBe(s.remaining);
    expect(next.remaining).toBe(0);
  });
});

describe("routine and job", () => {
  it("the daily routine enqueues one job per tribunal and the job imports", async () => {
    const pG = await makeProcess(f.ctx.admin, { number: nG, court: "TRT10", area: "labor", phase: "knowledge" });
    fake.add("trt10", rec(nG, { movements: [mv(26, "Distribuição", d(3))] }));
    const status = await runCourtSyncRoutine(await routineContext());
    expect(status).toContain("TRT10");
    const queued = await f.db.select().from(jobs).where(and(eq(jobs.organizationId, f.orgA), eq(jobs.type, "court_sync.run")));
    expect(queued.some((j) => (j.payload as { alias?: string }).alias === "trt10")).toBe(true);
    await runJobs();
    expect(await eventCount(pG)).toBe(1);
  });
});

describe("settings and simulated arrivals", () => {
  it("only admins change the integration settings; other settings are kept", async () => {
    const input = {
      enabled: false,
      syncIntervalHours: 12,
      maxRequestsPerMinute: 10,
      batchSize: 25,
      autoApplyPhase: true,
      enrichOnIntake: false,
      simulatedFeedEnabled: true,
      simulatedFeedIntervalMinutes: 60,
    };
    await expect(updateCourtIntegrationSettings(f.ctx.lawyer, input)).rejects.toBeInstanceOf(ForbiddenError);
    const before = await loadOrganization(f.orgA);
    await updateCourtIntegrationSettings(f.ctx.admin, input);
    const after = await loadOrganization(f.orgA);
    expect(after.settings.integrations.datajud).toMatchObject({ enabled: false, syncIntervalHours: 12, batchSize: 25 });
    expect(after.settings.contingency).toEqual(before.settings.contingency);
    expect(after.settings.intake).toEqual(before.settings.intake);
    expect((await runCourtSync(f.orgA, { trigger: "routine" })).status).toBe("disabled");
  });

  it("the simulated feed runs only in demo organizations, once per interval", async () => {
    expect(await runSimulatedFeedRoutine(await routineContext())).toContain("demonstração");
    await f.db.update(organizations).set({ isDemo: true }).where(eq(organizations.id, f.orgA));
    const first = await runSimulatedFeedRoutine(await routineContext());
    expect(first).toContain("Chegada simulada (dados fictícios)");
    const intakes = await f.db.select().from(caseIntakes).where(and(eq(caseIntakes.organizationId, f.orgA), eq(caseIntakes.source, "simulated_feed")));
    expect(intakes).toHaveLength(1);
    expect(await runSimulatedFeedRoutine(await routineContext())).toContain("Próxima chegada simulada");
  });
});

describe("verification: divergences reported once, old closures still flagged", () => {
  it("records court division, class and court divergences on the process and its instances", async () => {
    const a = await processRow(pA);
    expect(a.verificationNote).toContain('[DataJud] Classe: o tribunal informa "Ação Trabalhista - Rito Sumaríssimo" (cadastro: "ATOrd")');
    const nJ = cnjNumber({ seq: 111, tribunal: "10" });
    const pJ = await makeProcess(f.ctx.admin, {
      number: nJ,
      court: "TRT da 10ª Região",
      area: "labor",
      phase: "knowledge",
      courtDivision: "21ª VT de Brasília",
      processClass: "ATSum",
    });
    await f.db.insert(processInstances).values({
      organizationId: f.orgA,
      processId: pJ,
      instance: "second",
      court: "TRT10",
      courtDivision: "Gabinete Cadastrado Diferente",
      processClass: "ROT",
      origin: "manual",
    });
    fake.add(
      "trt10",
      rec(nJ, { movements: [mv(26, "Distribuição", d(60))] }),
      rec(nJ, {
        grau: "G2",
        courtDivision: { code: 9, name: "Gabinete Fictício", ibgeCode: null },
        processClass: { code: 1009, name: "Recurso Ordinário Trabalhista" },
        movements: [mv(26, "Distribuição", d(20))],
      }),
    );
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pJ] });
    const j = await processRow(pJ);
    // Same things written differently are not divergences ("TRT da 10ª Região" = TRT10, "VT" = Vara do Trabalho, ATSum).
    expect(j.verificationNote ?? "").not.toContain("Tribunal");
    expect(j.verificationNote ?? "").not.toContain("Classe");
    expect(j.verificationNote ?? "").not.toContain("Órgão julgador: o tribunal");
    // A different chamber in the 2nd grau is reported; the record is kept.
    expect(j.needsVerification).toBe(true);
    expect(j.verificationNote).toContain(
      '[DataJud] Órgão julgador no 2º grau: o tribunal informa "Gabinete Fictício" (cadastro: "Gabinete Cadastrado Diferente")',
    );
    const [second] = await f.db
      .select()
      .from(processInstances)
      .where(and(eq(processInstances.processId, pJ), eq(processInstances.instance, "second")));
    expect(second.courtDivision).toBe("Gabinete Cadastrado Diferente");
    expect(second.processClass).toBe("ROT");
  });

  it("a divergence resolved by a person does not flag the process again; a new tribunal value does", async () => {
    let a = await processRow(pA);
    expect(a.needsVerification).toBe(true);
    expect(a.verificationNote).toContain("Cidade informada pelo tribunal: Brasília/DF");
    await resolveProcessVerification(f.ctx.admin, pA, { note: "Conferido com a ficha: cadastro mantido." });
    const auditCount = async () =>
      (await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, pA), eq(auditLogs.action, "legal_process.court_sync")))).length;
    const before = await auditCount();

    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pA] });
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pA] });
    a = await processRow(pA);
    expect(a.needsVerification).toBe(false);
    expect(a.verificationNote).toBeNull();
    expect(await auditCount()).toBe(before);

    // The tribunal now informs another filing date: only that divergence is new.
    fake.update("trt10", (r) => r.number === digitsOf(nA) && r.grau === "G1", (r) => ({ ...r, filedAt: "2025-03-03" }));
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pA] });
    a = await processRow(pA);
    expect(a.needsVerification).toBe(true);
    expect(a.verificationNote).toContain("Data de ajuizamento informada pelo tribunal: 03/03/2025 (cadastro: 28/02/2025)");
    expect(a.verificationNote).not.toContain("Cidade informada");
    expect(a.filedAt).toBe("2025-02-28");
    expect(await auditCount()).toBe(before + 1);
    const [last] = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, pA), eq(auditLogs.action, "legal_process.court_sync")))
      .orderBy(sql`${auditLogs.createdAt} desc`)
      .limit(1);
    expect(last.metadata).toMatchObject({ actorLabel: "Sistema · DataJud", divergencesReported: ["G1.filedAt"] });
  });

  it("keeps the note written by a person when DataJud lines are added", async () => {
    const human = "Nota da equipe: conferir a procuração antes da audiência.";
    await f.db.update(legalProcesses).set({ needsVerification: true, verificationNote: human }).where(eq(legalProcesses.id, pA));
    fake.update("trt10", (r) => r.number === digitsOf(nA) && r.grau === "G1", (r) => ({ ...r, filedAt: "2025-03-04" }));
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pA] });
    const a = await processRow(pA);
    expect(a.verificationNote?.startsWith(human)).toBe(true);
    expect(a.verificationNote).toContain("04/03/2025");
  });

  it("never changes the phase of a process out of the active portfolio (closure is a status, not a phase)", async () => {
    await f.db
      .update(organizations)
      .set({ settings: sql`jsonb_set(${organizations.settings}, '{integrations}', ${JSON.stringify({ datajud: { autoApplyPhase: true } })}::jsonb, true)` })
      .where(eq(organizations.id, f.orgA));
    const nP = cnjNumber({ seq: 141, tribunal: "10" });
    const nQ = cnjNumber({ seq: 142, tribunal: "10" });
    const pP = await makeProcess(f.ctx.admin, { number: nP, court: "TRT10", area: "labor", phase: "knowledge" });
    const pQ = await makeProcess(f.ctx.admin, { number: nQ, court: "TRT10", area: "labor", phase: "knowledge" });
    await f.db
      .update(legalProcesses)
      .set({ status: "closed", closureReason: "archived", closedAt: d(40) })
      .where(eq(legalProcesses.id, pP));
    fake.add(
      "trt10",
      rec(nP, { movements: [mv(26, "Distribuição", d(400)), mv(11384, "Liquidação iniciada", d(10))] }),
      rec(nQ, { movements: [mv(26, "Distribuição", d(400)), mv(11384, "Liquidação iniciada", d(10))] }),
    );
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pP, pQ] });
    const p = await processRow(pP);
    expect(p.phase).toBe("knowledge");
    expect(p.status).toBe("closed");
    // Control: the same movement moves an active process forward.
    expect((await processRow(pQ)).phase).toBe("liquidation");
  });

  it("an old closure that is the latest movement is flagged (never closed); an old one followed by others is not", async () => {
    const nH = cnjNumber({ seq: 108, tribunal: "10" });
    const nI = cnjNumber({ seq: 109, tribunal: "10" });
    const pH = await makeProcess(f.ctx.admin, { number: nH, court: "TRT10", area: "labor", phase: "knowledge" });
    const pI = await makeProcess(f.ctx.admin, { number: nI, court: "TRT10", area: "labor", phase: "knowledge" });
    fake.add(
      "trt10",
      rec(nH, { movements: [mv(26, "Distribuição", d(900)), mv(848, "Trânsito em julgado", d(260)), mv(22, "Baixa Definitiva", d(200))] }),
      rec(nI, { movements: [mv(26, "Distribuição", d(900)), mv(848, "Trânsito em julgado", d(300)), mv(51, "Conclusão", d(250))] }),
    );
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pH, pI] });
    const h = await processRow(pH);
    expect(h.status).toBe("active");
    expect(h.closedAt).toBeNull();
    expect(h.needsVerification).toBe(true);
    expect(h.verificationNote).toContain('Baixa definitiva: "Baixa Definitiva"');
    expect(h.verificationNote).not.toContain("Trânsito em julgado");
    const [alert] = await openAlerts("court_movement_relevant", pH);
    expect(alert.message).toContain("nada foi encerrado automaticamente");
    const i = await processRow(pI);
    expect(i.needsVerification).toBe(false);
    expect(await openAlerts("court_movement_relevant", pI)).toHaveLength(0);
    // Checked again: nothing new, no second alert.
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pH] });
    expect(await openAlerts("court_movement_relevant", pH)).toHaveLength(1);
  });

  it("an old baixa followed only by routine movements is still flagged; one followed by a reopening is not", async () => {
    const nL = cnjNumber({ seq: 131, tribunal: "10" });
    const nM = cnjNumber({ seq: 132, tribunal: "10" });
    const pL = await makeProcess(f.ctx.admin, { number: nL, court: "TRT10", area: "labor", phase: "knowledge" });
    const pM = await makeProcess(f.ctx.admin, { number: nM, court: "TRT10", area: "labor", phase: "knowledge" });
    fake.add(
      "trt10",
      rec(nL, { movements: [mv(26, "Distribuição", d(900)), mv(22, "Baixa Definitiva", d(200)), mv(85, "Petição", d(195))] }),
      rec(nM, {
        movements: [mv(26, "Distribuição", d(900)), mv(22, "Baixa Definitiva", d(200)), mv(null, "Desarquivamento", d(190)), mv(85, "Petição", d(185))],
      }),
    );
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pL, pM] });
    const l = await processRow(pL);
    expect(l.status).toBe("active");
    expect(l.closedAt).toBeNull();
    expect(l.needsVerification).toBe(true);
    expect(l.verificationNote).toContain('Baixa definitiva: "Baixa Definitiva"');
    expect(l.verificationNote).toContain("no 1º grau. Conferir se o processo continua na carteira ativa.");
    expect(await openAlerts("court_movement_relevant", pL)).toHaveLength(1);
    const m = await processRow(pM);
    expect(m.needsVerification).toBe(false);
    expect(await openAlerts("court_movement_relevant", pM)).toHaveLength(0);
  });

  it("a tribunal superior outage never erases what it informed: a resolved divergence is not reported again", async () => {
    const nK = cnjNumber({ seq: 133, tribunal: "10" });
    const pK = await makeProcess(f.ctx.admin, { number: nK, court: "TRT10", area: "labor", phase: "knowledge" });
    await f.db.insert(processInstances).values({
      organizationId: f.orgA,
      processId: pK,
      instance: "superior",
      court: "TST",
      courtDivision: "3ª Turma Cadastrada",
      origin: "manual",
    });
    fake.add("trt10", rec(nK, { movements: [mv(26, "Distribuição", d(400))] }));
    fake.add(
      "tst",
      rec(nK, {
        grau: "SUP",
        alias: "tst",
        tribunal: "TST",
        courtDivision: { code: 7, name: "Gabinete Fictício do Ministro", ibgeCode: null },
        processClass: { code: 1032, name: "Recurso de Revista" },
        filedAt: d(100),
        movements: [mv(26, "Distribuição", d(100))],
      }),
    );
    const auditCount = async () =>
      (await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, pK), eq(auditLogs.action, "legal_process.court_sync")))).length;

    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pK] });
    let k = await processRow(pK);
    expect(k.needsVerification).toBe(true);
    expect(k.verificationNote).toContain(
      '[DataJud] Órgão julgador no 3º grau: o tribunal informa "Gabinete Fictício do Ministro" (cadastro: "3ª Turma Cadastrada")',
    );
    await resolveProcessVerification(f.ctx.admin, pK, { note: "Conferido: turma cadastrada mantida." });
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pK] });
    expect((await processRow(pK)).needsVerification).toBe(false);
    const before = await auditCount();

    // The TST fails (timeout) while the TRT answers: the SUP values are kept.
    fake.fail("tst", new CourtProviderError("timeout", "O DataJud não respondeu a tempo.", true));
    const partial = await runCourtSync(f.orgA, { trigger: "manual", processIds: [pK] });
    expect(partial.runs[0].status).toBe("partial");
    let state = await stateOf(pK);
    expect(state.instancesFound.map((i) => i.grau)).toEqual(["G1", "SUP"]);
    const sup = state.instancesFound.find((i) => i.grau === "SUP")!;
    expect(sup.courtDivision).toBe("Gabinete Fictício do Ministro");
    expect(sup.notReturnedSince).toBeTruthy();
    expect(state.instancesFound.find((i) => i.grau === "G1")!.notReturnedSince).toBeUndefined();
    const firstMiss = sup.notReturnedSince;
    // A second miss keeps the date of the first one.
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pK] });
    state = await stateOf(pK);
    expect(state.instancesFound.find((i) => i.grau === "SUP")!.notReturnedSince).toBe(firstMiss);

    // The TST is back with the same value: nothing is reported again.
    fake.fail("tst", null);
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pK] });
    k = await processRow(pK);
    expect(k.needsVerification).toBe(false);
    expect(k.verificationNote).toBeNull();
    expect(await auditCount()).toBe(before);
    state = await stateOf(pK);
    expect(state.instancesFound.find((i) => i.grau === "SUP")!.notReturnedSince).toBeUndefined();

    const panel = await getProcessCourtSyncPanel(f.ctx.admin, pK);
    expect(panel.state?.instancesFound.map((i) => i.grau)).toEqual(["G1", "SUP"]);
  });
});

describe("valid CNJ only", () => {
  it("a number with a wrong check digit is never queried and says why; once corrected it is checked again", async () => {
    const valid = cnjNumber({ seq: 112, tribunal: "10" });
    const dd = Number(valid.slice(8, 10));
    const wrong = `${valid.slice(0, 8)}${String((dd + 1) % 100).padStart(2, "0")}${valid.slice(10)}`;
    const pBad = await makeProcess(f.ctx.admin, { number: wrong, court: "TRT10", area: "labor", phase: "knowledge" });
    fake.add("trt10", rec(valid, { movements: [mv(26, "Distribuição", d(15))] }));
    const callsBefore = fake.calls.length;
    const s = await runCourtSync(f.orgA, { trigger: "manual", processIds: [pBad] });
    expect(s.unsupported).toBe(1);
    expect(fake.calls.slice(callsBefore).some((c) => c.numbers.includes(digitsOf(wrong)))).toBe(false);
    const state = await stateOf(pBad);
    expect(state.status).toBe("unsupported");
    expect(state.lastError).toContain("dígito verificador");
    expect(state.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 7 * 86_400_000);
    const lookup = await lookupCourtRecord(f.ctx.lawyer, wrong);
    expect(lookup.status).toBe("invalid");
    expect(lookup.message).toContain("dígito verificador");
    expect((await syncProcessNow(f.ctx.lawyer, pBad)).status).toBe("unsupported");

    // Someone corrects the number: the next run checks it without waiting 30 days.
    await f.db.update(legalProcesses).set({ number: valid }).where(eq(legalProcesses.id, pBad));
    await runCourtSync(f.orgA, { trigger: "manual", alias: "trt10" });
    expect((await stateOf(pBad)).status).toBe("found");
    expect(await eventCount(pBad)).toBe(1);
  });
});

describe("backoff and job chains", () => {
  it("a process in error waits for its whole backoff (no early slack)", async () => {
    const settings = (await loadOrganization(f.orgA)).settings.integrations.datajud;
    fake.fail("trt2", new CourtProviderError("server_error", "O DataJud está indisponível no momento (HTTP 503).", true, 503));
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [pE] });
    fake.fail("trt2", null);
    // 30 minutes left of the backoff: within the slack of healthy processes, still not due.
    await f.db
      .update(courtSyncStates)
      .set({ nextCheckAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(courtSyncStates.processId, pE));
    expect((await listDueAliases(f.orgA, settings)).some((g) => g.alias === "trt2")).toBe(false);
    // A healthy process in the same situation is due (the jobs run a little after the routine).
    await f.db.update(courtSyncStates).set({ consecutiveErrors: 0, status: "found" }).where(eq(courtSyncStates.processId, pE));
    expect((await listDueAliases(f.orgA, settings)).some((g) => g.alias === "trt2")).toBe(true);
  });

  it("a tribunal job does not continue its chain after a run that failed entirely", () => {
    const run = (status: CourtSyncRunResult["status"]): CourtSyncRunResult => ({
      alias: "trt2",
      runId: "00000000-0000-0000-0000-000000000000",
      status,
      checked: 400,
      found: status === "failed" ? 0 : 400,
      notFound: 0,
      newMovements: 0,
      phaseChanges: 0,
      errors: status === "failed" ? 400 : 0,
      errorMessage: null,
    });
    const summary = (status: CourtSyncRunResult["status"], remaining = 100) =>
      ({ status: "completed", message: "", runs: [run(status)], unsupported: 0, remaining }) as const;
    const payload = { alias: "trt2", trigger: "routine" as const };
    expect(continuationStep({ ...summary("succeeded"), runs: [run("succeeded")] }, payload)).toBe(1);
    expect(continuationStep({ ...summary("partial"), runs: [run("partial")] }, { ...payload, continuation: 3 })).toBe(4);
    expect(continuationStep({ ...summary("failed"), runs: [run("failed")] }, payload)).toBeNull();
    expect(continuationStep({ ...summary("succeeded", 0), runs: [run("succeeded")] }, payload)).toBeNull();
    expect(continuationStep({ ...summary("succeeded"), runs: [run("succeeded")] }, { ...payload, continuation: 50 })).toBeNull();
  });

  it("the admin's full sync is not swallowed by a queued routine job, and the routine skips busy tribunals", async () => {
    await updateCourtIntegrationSettings(f.ctx.admin, {
      enabled: true,
      syncIntervalHours: 24,
      maxRequestsPerMinute: 20,
      batchSize: 50,
      autoApplyPhase: true,
      enrichOnIntake: true,
      simulatedFeedEnabled: false,
      simulatedFeedIntervalMinutes: 120,
    });
    await f.db.update(courtSyncStates).set({ nextCheckAt: new Date(Date.now() - 60_000) }).where(eq(courtSyncStates.processId, pA));
    await runCourtSyncRoutine(await routineContext());
    const queuedJobs = () =>
      f.db.select().from(jobs).where(and(eq(jobs.organizationId, f.orgA), eq(jobs.type, "court_sync.run"), eq(jobs.status, "queued")));
    expect((await queuedJobs()).some((j) => (j.payload as { alias?: string }).alias === "trt10")).toBe(true);

    const r = await requestPortfolioSync(f.ctx.admin);
    expect(r.jobs).toBeGreaterThan(0);
    const manualTrt10 = (await queuedJobs()).find((j) => {
      const p = j.payload as { alias?: string; force?: boolean; trigger?: string };
      return p.alias === "trt10" && p.force === true && p.trigger === "manual";
    });
    expect(manualTrt10).toBeTruthy();
    expect((await aliasesWithPendingSync(f.orgA)).has("trt10")).toBe(true);
    expect(await runCourtSyncRoutine(await routineContext())).toContain("consulta em andamento");
    await runJobs();
    expect((await aliasesWithPendingSync(f.orgA)).size).toBe(0);
  });
});
