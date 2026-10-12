import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RawSheet } from "@/modules/imports/parser";

// The reader is replaced by synthetic sheets (the parser and the service run for real).
const sheets: { current: RawSheet[] } = { current: [] };
vi.mock("@/modules/imports/xlsx", () => ({
  readWorkbook: vi.fn(async () => sheets.current),
  hasZipSignature: () => true,
  UnreadableWorkbookError: class UnreadableWorkbookError extends Error {},
}));
vi.mock("@/modules/distribution/service", () => ({
  decideAssignment: vi.fn(),
  assignResponsible: vi.fn(async () => {
    throw new Error("falha simulada");
  }),
}));

import { and, eq, isNull } from "drizzle-orm";
import { analyzeImport, commitImport, getImportBatch, getRollbackBlockers, rollbackImport } from "@/modules/imports/service";
import { companies, legalProcesses, processInstances, processValuations } from "@/server/db/schema";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";
import { DEMO_CLIENT, row, sheet, validCnj } from "./helpers";

let fx: Fixture;
let companyDemo: string;
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const CNJ_EXISTING = validCnj(501);
const CNJ_NEW = validCnj(502);
const CNJ_ORG_B = validCnj(503);

beforeAll(async () => {
  fx = await setupFixture("impu");
  const [c] = await fx.db.insert(companies).values({ organizationId: fx.orgA, name: DEMO_CLIENT }).returning();
  companyDemo = c.id;
});

afterAll(async () => {
  await fx?.teardown();
});

describe("update of existing processes and rollback with restore", () => {
  let existingId: string;
  let batchId: string;

  it("plans an update for the existing number and a creation for the others (same CNJ in another org is ignored)", async () => {
    existingId = await makeProcess(fx.ctx.admin, {
      number: CNJ_EXISTING,
      title: "Processo cadastrado manualmente (fictício)",
      court: "TRT10",
      area: "labor",
      phase: "knowledge",
      claimAmountCents: 100_000,
    });
    await makeProcess(fx.ctx.adminB, { number: CNJ_ORG_B, title: "Processo da organização B", court: "TRT10", area: "labor", phase: "knowledge" });

    sheets.current = [
      sheet("Consolidado Geral", [
        row({ number: CNJ_EXISTING, city: "Palmas - TO", phase: "Liquidação", claim: 1500, liquidated: 200 }),
        row({ number: CNJ_NEW, city: "Palmas", phase: "Conhecimento", claim: 300 }),
        row({ number: CNJ_ORG_B, phase: "Execução", claim: 50 }),
      ]),
    ];
    ({ batchId } = await analyzeImport(fx.ctx.admin, {
      file: { name: "carteira-ficticia.xlsx", bytes },
      companyId: companyDemo,
      baseDate: "2026-06-30",
      distributeAfterCommit: true,
    }));
    const b = await getImportBatch(fx.ctx.admin, batchId);
    expect(b.stats).toMatchObject({ processesDetected: 3, toCreate: 2, toUpdate: 1, unchanged: 0 });
    expect(b.baseDate).toBe("2026-06-30");
    expect(b.baseDateSource).toBe("user");
  });

  it("updates the existing process, keeps its official value and proposes the new one (RN-08)", async () => {
    const result = await commitImport(fx.ctx.admin, batchId, { baseDate: "2026-06-30" });
    expect(result).toMatchObject({ created: 2, updated: 1 });

    const [p] = await fx.db.select().from(legalProcesses).where(eq(legalProcesses.id, existingId));
    expect(p).toMatchObject({
      title: "Processo cadastrado manualmente (fictício)",
      dataOrigin: "manual",
      phase: "liquidation",
      city: "Palmas",
      state: "TO",
      claimAmountCents: 100_000,
      liquidatedAmountCents: 20_000,
      companyId: companyDemo,
      instance: "first",
    });
    const vals = await fx.db.select().from(processValuations).where(and(eq(processValuations.processId, existingId), eq(processValuations.importBatchId, batchId)));
    expect(vals.map((v) => [v.kind, v.amountCents, v.status]).sort()).toEqual([
      ["claim", 150_000, "proposed"],
      ["liquidated", 20_000, "official"],
    ]);
    const inst = await fx.db.select().from(processInstances).where(eq(processInstances.processId, existingId));
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({ instance: "first", origin: "imported", importBatchId: batchId, isCurrent: true, sourceSheet: "Consolidado Geral", sourceRow: 2 });

    // The process of organization B with the same number is untouched and a new one was created in org A.
    const sameNumber = await fx.db.select({ org: legalProcesses.organizationId }).from(legalProcesses).where(eq(legalProcesses.number, CNJ_ORG_B));
    expect(sameNumber.map((x) => x.org).sort()).toEqual([fx.orgA, fx.orgB].sort());

    // Distribution failures are reported per process, never break the commit.
    const b = await getImportBatch(fx.ctx.admin, batchId);
    expect(b.status).toBe("committed");
    expect(b.distribution).toMatchObject({ attempted: 2, assigned: 0, failed: 2 });
    expect(b.distribution!.failures[0].message).toMatch(/Falha inesperada/);
  });

  it("restores the existing process and removes what the batch created", async () => {
    expect(await getRollbackBlockers(fx.ctx.admin, batchId)).toEqual([]);
    expect(await rollbackImport(fx.ctx.admin, batchId)).toEqual({ removed: 2, restored: 1 });

    const [p] = await fx.db.select().from(legalProcesses).where(eq(legalProcesses.id, existingId));
    expect(p).toMatchObject({
      deletedAt: null,
      phase: "knowledge",
      city: null,
      state: null,
      claimAmountCents: 100_000,
      liquidatedAmountCents: null,
      companyId: null,
      instance: null,
    });
    expect(await fx.db.select().from(processInstances).where(eq(processInstances.processId, existingId))).toEqual([]);
    expect(await fx.db.select().from(processValuations).where(eq(processValuations.importBatchId, batchId))).toEqual([]);
    const alive = await fx.db
      .select({ number: legalProcesses.number })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.organizationId, fx.orgA), isNull(legalProcesses.deletedAt)));
    expect(alive.map((x) => x.number)).toEqual([CNJ_EXISTING]);
  });
});
