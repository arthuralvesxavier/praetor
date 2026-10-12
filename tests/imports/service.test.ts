import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/distribution/service", () => ({
  decideAssignment: vi.fn(),
  assignResponsible: vi.fn(),
}));

import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import type { AuthContext } from "@/server/auth/context";
import { addComment } from "@/modules/comments/service";
import { assignResponsible } from "@/modules/distribution/service";
import { issuesToCsv } from "@/modules/imports/csv";
import {
  analyzeImport,
  commitImport,
  getImportBatch,
  getRollbackBlockers,
  listAllImportIssues,
  listImportBatches,
  listImportDivergences,
  listImportIssues,
  listImportRows,
  openImportFile,
  rollbackImport,
} from "@/modules/imports/service";
import {
  auditLogs,
  companies,
  importBatches,
  importRows,
  legalProcesses,
  processEvents,
  processInstances,
  processParties,
  processValuations,
} from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { readStreamToBytes } from "@/server/integrations/storage";
import { processPendingJobs } from "@/server/jobs/worker";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import { DEMO_CLIENT, DEMO_FILE_NAME, demoBytes } from "./helpers";

const LONG = 240_000;
const BASE_DATE = "2026-07-29";

let fx: Fixture;
let companyDemo: string;
let bytes: Uint8Array;
let batch1: string;
let batch2: string;
let batch3: string;

async function expectRejects<T extends Error>(p: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected ${type.name}`);
}

function analyze(ctx: AuthContext, overrides: Partial<Parameters<typeof analyzeImport>[1]> = {}) {
  return analyzeImport(ctx, { file: { name: DEMO_FILE_NAME, bytes }, companyId: companyDemo, ...overrides });
}

async function countWhere(table: typeof legalProcesses | typeof processInstances | typeof processValuations, where: ReturnType<typeof and>) {
  const [{ n }] = await fx.db.select({ n: count() }).from(table).where(where);
  return n;
}

beforeAll(async () => {
  fx = await setupFixture("imp");
  const [c] = await fx.db.insert(companies).values({ organizationId: fx.orgA, name: DEMO_CLIENT }).returning();
  companyDemo = c.id;
  bytes = await demoBytes();
  vi.mocked(assignResponsible).mockImplementation(async (_ctx, processId) => {
    if (processId.startsWith("0") || processId.startsWith("1")) {
      return { userId: null, userName: null, method: "least_loaded", ruleId: null, ruleName: null, lawFirmId: null, unitId: null, reason: "Nenhum advogado elegível (simulado no teste)." };
    }
    return { userId: fx.ctx.lawyer.userId, userName: "Laura", method: "rule", ruleId: null, ruleName: null, lawFirmId: null, unitId: null, reason: "Regra de teste." };
  });
});

afterAll(async () => {
  await fx?.teardown();
});

describe("permissions (import:run only) and validation", () => {
  it("rejects every role without import:run", async () => {
    const { lawyer, analyst, executive, accountant, auditor, externalCounsel } = fx.ctx;
    for (const ctx of [lawyer, analyst, executive, accountant, auditor, externalCounsel]) {
      await expectRejects(analyze(ctx), ForbiddenError);
      await expectRejects(listImportBatches(ctx), ForbiddenError);
    }
  });

  it("validates the file, the company and the base date", async () => {
    const admin = fx.ctx.admin;
    const notXlsx = await expectRejects(analyze(admin, { file: { name: "carteira.csv", bytes } }), ValidationError);
    expect(notXlsx.fieldErrors?.fileName?.[0]).toMatch(/\.xlsx/);
    const garbage = await expectRejects(
      analyze(admin, { file: { name: "carteira.xlsx", bytes: new TextEncoder().encode("não é planilha") } }),
      ValidationError,
    );
    expect(garbage.fieldErrors?.file?.[0]).toMatch(/Não foi possível ler/);
    const [companyB] = await fx.db.insert(companies).values({ organizationId: fx.orgB, name: "Empresa Fictícia B" }).returning();
    const otherOrg = await expectRejects(analyze(admin, { companyId: companyB.id }), ValidationError);
    expect(otherOrg.fieldErrors?.companyId).toBeDefined();
    const future = await expectRejects(analyze(admin, { baseDate: "2999-01-01" }), ValidationError);
    expect(future.fieldErrors?.baseDate).toBeDefined();
    const unitB = await expectRejects(analyze(admin, { defaultUnitId: fx.unitB }), ValidationError);
    expect(unitB.fieldErrors?.defaultUnitId).toBeDefined();
    const [{ n }] = await fx.db.select({ n: count() }).from(importBatches);
    expect(n).toBe(0);
  });
});

describe("analysis of the demo spreadsheet", () => {
  it(
    "stores the batch, the rows and the original file without touching the portfolio",
    async () => {
      ({ batchId: batch1 } = await analyze(fx.ctx.admin, { distributeAfterCommit: true, defaultUnitId: fx.unitSp }));
      const b = await getImportBatch(fx.ctx.admin, batch1);
      expect(b.status).toBe("analyzed");
      expect(b.stats).toMatchObject({ rowsRead: 2330, processesDetected: 928, toCreate: 928, toUpdate: 0, unchanged: 0, instanceLinks: 237, errors: 0, divergences: 451 });
      expect(b.stats!.warnings).toBeGreaterThan(0);
      expect(b.storedRows).toBe(2334);
      expect(b.baseDate).toBe(BASE_DATE);
      expect(b.baseDateSource).toBe("file");
      expect(b.distributeAfterCommit).toBe(true);
      expect(b.companyName).toBe(DEMO_CLIENT);
      expect(b.defaultUnitName).toBe("São Paulo");
      expect(b.dataSheets).toEqual(["Consolidado Geral", "1º Grau", "2º Grau", "3º Grau (TST)"]);
      expect(b.sheets.find((s) => s.name === "Dashboard")?.role).toBe("ignored");
      expect(b.columnMapping["Consolidado Geral"]?.number).toBe("Nº do Processo");
      expect(b.issueSummary.find((i) => i.code === "total_row")).toMatchObject({ level: "info", rows: 4 });
      expect(b.issueSummary.some((i) => i.code === "cnj_invalid_check_digit")).toBe(true);
      expect(b.issueSummary.some((i) => i.code === "client_not_found")).toBe(false);

      const [{ n }] = await fx.db.select({ n: count() }).from(legalProcesses).where(eq(legalProcesses.organizationId, fx.orgA));
      expect(n).toBe(0);

      const file = await openImportFile(fx.ctx.admin, batch1);
      const stored = await readStreamToBytes(file.stream, 20 * 1024 * 1024);
      expect(stored.byteLength).toBe(bytes.byteLength);

      const [audit] = await fx.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, batch1), eq(auditLogs.action, "import_batch.analyze")));
      expect(audit.metadata).toMatchObject({ rowsRead: 2330, processesDetected: 928 });
      expect(JSON.stringify(audit.metadata)).not.toContain(DEMO_CLIENT);
    },
    LONG,
  );

  it("lists rows, issues and divergences with filters and pagination", async () => {
    const all = await listImportRows(fx.ctx.admin, batch1, { pageSize: 10 });
    expect(all.total).toBe(2334);
    expect(all.items).toHaveLength(10);
    expect(all.items[0]).toMatchObject({ sheet: "Consolidado Geral", rowNumber: 2, hasLiquidatedColumn: true });

    const second = await listImportRows(fx.ctx.admin, batch1, { sheet: "2º Grau", page: 2, pageSize: 100 });
    expect(second.total).toBe(255);
    expect(second.items.every((r) => r.sheet === "2º Grau" && !r.hasLiquidatedColumn)).toBe(true);

    const creates = await listImportRows(fx.ctx.admin, batch1, { action: "create" });
    expect(creates.total).toBe(928);
    const errors = await listImportRows(fx.ctx.admin, batch1, { level: "error" });
    expect(errors.total).toBe(0);

    const totals = await listImportIssues(fx.ctx.admin, batch1, { code: "total_row" });
    expect(totals.total).toBe(4);
    expect(totals.items.map((i) => i.rowNumber).sort((a, b) => a - b)).toEqual([143, 241, 717, 1097]);
    const warnings = await listImportIssues(fx.ctx.admin, batch1, { level: "warning", sheet: "Consolidado Geral", pageSize: 5 });
    expect(warnings.items.every((i) => i.level === "warning" && i.sheet === "Consolidado Geral")).toBe(true);

    const divergences = await listImportDivergences(fx.ctx.admin, batch1, { pageSize: 100 });
    expect(divergences.total).toBe(451);
    expect(divergences.items[0]).toMatchObject({ base: { sheet: "Consolidado Geral" } });
    expect(divergences.items.some((d) => d.valuation === "proposed")).toBe(true);

    const csv = await listAllImportIssues(fx.ctx.admin, batch1, { code: "total_row" });
    const text = issuesToCsv(csv.items);
    expect(text.startsWith("﻿Aba;Linha;Número do processo;Nível;Tipo;Campo;Descrição\r\n")).toBe(true);
    expect(text.trim().split("\r\n")).toHaveLength(5);
  });

  it("keeps batches of another organization invisible", async () => {
    const b = fx.ctx.adminB;
    await expectRejects(getImportBatch(b, batch1), NotFoundError);
    await expectRejects(listImportRows(b, batch1), NotFoundError);
    await expectRejects(listImportIssues(b, batch1), NotFoundError);
    await expectRejects(openImportFile(b, batch1), NotFoundError);
    await expectRejects(commitImport(b, batch1, { baseDate: BASE_DATE }), NotFoundError);
    await expectRejects(rollbackImport(b, batch1), NotFoundError);
    expect((await listImportBatches(b)).total).toBe(0);
    await expectRejects(commitImport(fx.ctx.lawyer, batch1, { baseDate: BASE_DATE }), ForbiddenError);
    await expectRejects(getImportBatch(fx.ctx.admin, "not-a-uuid"), NotFoundError);
  });
});

describe("commit", () => {
  it(
    "creates processes, parties, instance links and valuations in one transaction",
    async () => {
      await expectRejects(commitImport(fx.ctx.manager, batch1, { baseDate: "" }), ValidationError);
      const result = await commitImport(fx.ctx.manager, batch1, { baseDate: BASE_DATE, distributeAfterCommit: true });
      expect(result).toMatchObject({ created: 928, updated: 0, unchanged: 0, instancesCreated: 1165 });
      expect(result.valuationsProposed).toBeGreaterThan(300);

      const orgA = eq(legalProcesses.organizationId, fx.orgA);
      expect(await countWhere(legalProcesses, and(orgA, eq(legalProcesses.importBatchId, batch1)))).toBe(928);
      expect(await countWhere(processInstances, eq(processInstances.importBatchId, batch1))).toBe(1165);
      const [{ parties }] = await fx.db.select({ parties: count() }).from(processParties).where(eq(processParties.organizationId, fx.orgA));
      // Two parties per process, except one process whose line has an empty party cell (reported as party_missing).
      expect(parties).toBe(928 * 2 - 1);
      const [{ events }] = await fx.db.select({ events: count() }).from(processEvents).where(eq(processEvents.organizationId, fx.orgA));
      expect(events).toBe(0); // movements are never invented

      const [p] = await fx.db.select().from(legalProcesses).where(and(orgA, eq(legalProcesses.number, "1998501-50.2025.5.18.0211")));
      expect(p).toMatchObject({
        title: `JULIANA LOPES GOMES x ${DEMO_CLIENT}`,
        court: "TRT18",
        instance: "second",
        area: "labor",
        city: "Formosa",
        claimAmountCents: 154159805,
        liquidatedAmountCents: null,
        dataOrigin: "imported",
        companyId: companyDemo,
        unitId: fx.unitSp,
        status: "active",
      });
      expect(p.externalSource).toBe(`Planilha ${DEMO_FILE_NAME} · Consolidado Geral linha 763`);
      const partiesOfP = await fx.db.select().from(processParties).where(eq(processParties.processId, p.id));
      expect(partiesOfP.find((x) => x.isClient)?.name).toBe(DEMO_CLIENT);
      const vals = await fx.db.select().from(processValuations).where(eq(processValuations.processId, p.id));
      const official = vals.find((v) => v.status === "official")!;
      expect(official).toMatchObject({ kind: "claim", amountCents: 154159805, source: "spreadsheet", baseDate: BASE_DATE, reviewedById: fx.ctx.manager.userId, importBatchId: batch1 });
      const proposed = vals.find((v) => v.status === "proposed")!;
      expect(proposed).toMatchObject({ kind: "claim", reviewedById: null, baseDate: BASE_DATE });
      expect(proposed.reason).toMatch(/^Divergência entre abas: 2º Grau/);

      const closed = await fx.db
        .select({ closureReason: legalProcesses.closureReason, closedAt: legalProcesses.closedAt })
        .from(legalProcesses)
        .where(and(orgA, eq(legalProcesses.status, "closed")));
      expect(closed.length).toBeGreaterThan(50);
      expect(closed.every((c) => c.closureReason === "paid_extinct" || c.closureReason === "archived")).toBe(true);
      const [{ verify }] = await fx.db
        .select({ verify: count() })
        .from(legalProcesses)
        .where(and(orgA, eq(legalProcesses.needsVerification, true), eq(legalProcesses.status, "active")));
      expect(verify).toBeGreaterThan(0);

      const b = await getImportBatch(fx.ctx.admin, batch1);
      expect(b.status).toBe("committed");
      expect(b.committedByName).toBe("Gustavo Gestor");
      expect(b.baseDateSource).toBe("user");
      const rows = await fx.db
        .select({ n: count() })
        .from(importRows)
        .where(and(eq(importRows.batchId, batch1), isNotNull(importRows.processId)));
      expect(rows[0].n).toBe(2330);

      // Distribution after commit: enqueued with the commit ("import.distribute" job), never run in the request.
      expect(result).toMatchObject({ distribution: null, distributionQueued: true });
      expect(vi.mocked(assignResponsible)).not.toHaveBeenCalled();
      expect(b.distributionState).toBe("running");
      await processPendingJobs({ organizationId: fx.orgA });
      // Errors are reported per process, never thrown.
      expect(vi.mocked(assignResponsible)).toHaveBeenCalledTimes(928);
      const distributed = await getImportBatch(fx.ctx.admin, batch1);
      expect(distributed.distributionState).toBe("done");
      expect(distributed.distribution).toMatchObject({ attempted: 928, done: true });
      expect(distributed.distribution!.assigned + distributed.distribution!.failed).toBe(928);
      expect(distributed.distribution!.failures[0]?.message).toContain("simulado no teste");

      const [audit] = await fx.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, batch1), eq(auditLogs.action, "import_batch.commit")));
      expect(audit.metadata).toMatchObject({ created: 928, updated: 0, instancesCreated: 1165, baseDate: BASE_DATE });

      await expectRejects(commitImport(fx.ctx.manager, batch1, { baseDate: BASE_DATE }), ConflictError);
    },
    LONG,
  );

  it(
    "re-importing the same file creates no duplicate process, instance or valuation (RNF-04)",
    async () => {
      const before = {
        processes: await countWhere(legalProcesses, eq(legalProcesses.organizationId, fx.orgA)),
        instances: await countWhere(processInstances, eq(processInstances.organizationId, fx.orgA)),
        valuations: await countWhere(processValuations, eq(processValuations.organizationId, fx.orgA)),
      };
      ({ batchId: batch2 } = await analyze(fx.ctx.manager));
      const analyzed = await getImportBatch(fx.ctx.manager, batch2);
      expect(analyzed.stats).toMatchObject({ processesDetected: 928, toCreate: 0, toUpdate: 0, unchanged: 928, instanceLinks: 0 });
      expect(analyzed.sameFileBatches.map((s) => s.id)).toContain(batch1);
      const divergences = await listImportDivergences(fx.ctx.manager, batch2, { pageSize: 100 });
      expect(divergences.items.filter((d) => d.field === "claimAmount").every((d) => d.valuation === "existing")).toBe(true);

      const result = await commitImport(fx.ctx.manager, batch2, { baseDate: BASE_DATE });
      expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 928, instancesCreated: 0, valuationsOfficial: 0, valuationsProposed: 0, distribution: null, distributionQueued: false });
      expect(await countWhere(legalProcesses, eq(legalProcesses.organizationId, fx.orgA))).toBe(before.processes);
      expect(await countWhere(processInstances, eq(processInstances.organizationId, fx.orgA))).toBe(before.instances);
      expect(await countWhere(processValuations, eq(processValuations.organizationId, fx.orgA))).toBe(before.valuations);
    },
    LONG,
  );
});

describe("rollback", () => {
  it(
    "undoes a batch that created nothing, then the original batch",
    async () => {
      expect(await rollbackImport(fx.ctx.admin, batch2)).toEqual({ removed: 0, restored: 0 });
      expect((await getImportBatch(fx.ctx.admin, batch2)).status).toBe("rolled_back");

      expect(await getRollbackBlockers(fx.ctx.admin, batch1)).toEqual([]);
      const result = await rollbackImport(fx.ctx.admin, batch1);
      expect(result).toEqual({ removed: 928, restored: 0 });
      const orgA = eq(legalProcesses.organizationId, fx.orgA);
      expect(await countWhere(legalProcesses, and(orgA, isNull(legalProcesses.deletedAt)))).toBe(0);
      expect(await countWhere(legalProcesses, and(orgA, isNotNull(legalProcesses.deletedAt)))).toBe(928);
      expect(await countWhere(processInstances, eq(processInstances.importBatchId, batch1))).toBe(0);
      expect(await countWhere(processValuations, eq(processValuations.importBatchId, batch1))).toBe(0);
      const b = await getImportBatch(fx.ctx.admin, batch1);
      expect(b.status).toBe("rolled_back");
      expect(b.rolledBackAt).not.toBeNull();
      await expectRejects(rollbackImport(fx.ctx.admin, batch1), ConflictError);
      await expectRejects(commitImport(fx.ctx.admin, batch1, { baseDate: BASE_DATE }), ConflictError);
    },
    LONG,
  );

  it(
    "refuses to undo when a process changed after the import, listing it",
    async () => {
      ({ batchId: batch3 } = await analyze(fx.ctx.admin));
      expect((await getImportBatch(fx.ctx.admin, batch3)).stats).toMatchObject({ toCreate: 928 });
      await commitImport(fx.ctx.admin, batch3, { baseDate: BASE_DATE, distributeAfterCommit: false });
      const [p] = await fx.db
        .select({ id: legalProcesses.id, number: legalProcesses.number })
        .from(legalProcesses)
        .where(and(eq(legalProcesses.importBatchId, batch3), isNull(legalProcesses.deletedAt)))
        .limit(1);
      await addComment(fx.ctx.manager, { type: "legal_process", id: p.id }, "Comentário fictício após a importação.");

      const blockers = await getRollbackBlockers(fx.ctx.admin, batch3);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toMatchObject({ processId: p.id, number: p.number });
      const err = await expectRejects(rollbackImport(fx.ctx.admin, batch3), ConflictError);
      expect(err.message).toContain(p.number);
      expect(await countWhere(legalProcesses, and(eq(legalProcesses.importBatchId, batch3), isNull(legalProcesses.deletedAt)))).toBe(928);
      expect((await getImportBatch(fx.ctx.admin, batch3)).status).toBe("committed");
    },
    LONG,
  );

  it("lists the batches of the organization, newest first", async () => {
    const list = await listImportBatches(fx.ctx.manager);
    expect(list.items.map((i) => i.id)).toEqual([batch3, batch2, batch1]);
    expect(list.items[0]).toMatchObject({ fileName: DEMO_FILE_NAME, companyName: DEMO_CLIENT, status: "committed", createdByName: "Ana Admin" });
  });
});
