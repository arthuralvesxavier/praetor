/**
 * Import rollback scope and mirrors (review group "imports-jobs"):
 *   - a batch that only PROPOSED a value for an existing process cannot be undone after the
 *     proposal was approved/corrected (the official value used to be deleted silently);
 *   - an unreviewed proposal is removed by the rollback and the mirrors are recomputed;
 *   - import updates and rollbacks keep provisionAmountCents in sync;
 *   - a process included in a CLOSED competência blocks the rollback (RN-10);
 *   - processes closed by the import without a date get the base date as closedAt;
 *   - the issues CSV export is audited (counts and filters only);
 *   - analysis limits (rows; decompressed size).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RawSheet } from "@/modules/imports/parser";

// The reader returns synthetic sheets; with `null` the real reader runs (zip limit test).
const sheets = vi.hoisted(() => ({ current: null as RawSheet[] | null }));
vi.mock("@/modules/imports/xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/imports/xlsx")>();
  return { ...actual, readWorkbook: vi.fn(async (bytes: Uint8Array) => sheets.current ?? actual.readWorkbook(bytes)) };
});
vi.mock("@/modules/imports/limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/imports/limits")>()),
  MAX_IMPORT_ROWS: 5,
}));
vi.mock("@/modules/distribution/service", () => ({ decideAssignment: vi.fn(), assignResponsible: vi.fn() }));

import { and, count, eq } from "drizzle-orm";
import { todayISO } from "@/lib/format";
import { actionLabel } from "@/modules/admin/history-format";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { reviewValuation } from "@/modules/contingency/service";
import { closeSnapshot, generateSnapshot } from "@/modules/contingency/snapshot-service";
import {
  analyzeImport,
  commitImport,
  getRollbackBlockers,
  listAllImportIssues,
  listImportIssues,
  rollbackImport,
} from "@/modules/imports/service";
import { auditLogs, companies, importBatches, legalProcesses, processInstances, processValuations } from "@/server/db/schema";
import { ConflictError, ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";
import { DEMO_CLIENT, row, sheet, validCnj } from "../../imports/helpers";
import { craftZip, MB } from "./zip-helpers";

let fx: Fixture;
let companyId: string;
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const VALUATIONS_REASON = "valores lançados ou conferidos depois da importação";

async function importRows(rows: Parameters<typeof sheet>[1], baseDate: string, fileName = "carteira-ficticia.xlsx"): Promise<string> {
  sheets.current = [sheet("Consolidado Geral", rows)];
  const { batchId } = await analyzeImport(fx.ctx.admin, { file: { name: fileName, bytes }, companyId, baseDate });
  await commitImport(fx.ctx.admin, batchId, { baseDate, distributeAfterCommit: false });
  return batchId;
}

async function processByNumber(number: string) {
  const [p] = await fx.db.select().from(legalProcesses).where(and(eq(legalProcesses.organizationId, fx.orgA), eq(legalProcesses.number, number)));
  return p;
}

async function batchValuations(batchId: string, processId: string) {
  const rows = await fx.db
    .select()
    .from(processValuations)
    .where(and(eq(processValuations.importBatchId, batchId), eq(processValuations.processId, processId)));
  return rows.map((v) => [v.kind, v.amountCents, v.status]).sort();
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection");
}

beforeAll(async () => {
  fx = await setupFixture("fixij");
  const [c] = await fx.db.insert(companies).values({ organizationId: fx.orgA, name: DEMO_CLIENT }).returning();
  companyId = c.id;
});

afterAll(async () => {
  await fx?.teardown();
});

describe("rollback of a batch that only proposed a value for an existing process", () => {
  it("is blocked once the proposal was approved — the official value is never deleted silently", async () => {
    const cnj = validCnj(801);
    await importRows([row({ number: cnj, claim: 1500 })], "2026-06-30");
    const p = await processByNumber(cnj);
    expect(p.claimAmountCents).toBe(150_000);

    const b2 = await importRows([row({ number: cnj, claim: 2000 })], "2026-07-31");
    expect(await batchValuations(b2, p.id)).toEqual([["claim", 200_000, "proposed"]]);
    // Before any review the batch can still be undone.
    expect(await getRollbackBlockers(fx.ctx.admin, b2)).toEqual([]);

    const [proposal] = await fx.db.select().from(processValuations).where(eq(processValuations.importBatchId, b2));
    await reviewValuation(fx.ctx.admin, proposal.id, { decision: "approve", note: null });
    expect((await processByNumber(cnj)).claimAmountCents).toBe(200_000);

    const blockers = await getRollbackBlockers(fx.ctx.admin, b2);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ processId: p.id, number: cnj });
    expect(blockers[0].reasons).toContain(VALUATIONS_REASON);
    const err = await rejection(rollbackImport(fx.ctx.admin, b2));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain(cnj);

    // Nothing was removed: the approved value stays official and the mirror keeps it.
    expect(await batchValuations(b2, p.id)).toEqual([["claim", 200_000, "official"]]);
    expect((await processByNumber(cnj)).claimAmountCents).toBe(200_000);
    const [batch] = await fx.db.select({ status: importBatches.status }).from(importBatches).where(eq(importBatches.id, b2));
    expect(batch.status).toBe("committed");
  });

  it("is blocked when the proposal was corrected (the corrected row carries the batch id)", async () => {
    const cnj = validCnj(802);
    await importRows([row({ number: cnj, claim: 1000 })], "2026-06-30");
    const p = await processByNumber(cnj);
    const b2 = await importRows([row({ number: cnj, claim: 1800 })], "2026-07-31");
    const [proposal] = await fx.db.select().from(processValuations).where(eq(processValuations.importBatchId, b2));
    await reviewValuation(fx.ctx.admin, proposal.id, { decision: "correct", correctedAmountCents: 170_000, note: null });

    const blockers = await getRollbackBlockers(fx.ctx.admin, b2);
    expect(blockers.map((b) => b.processId)).toEqual([p.id]);
    expect(await rejection(rollbackImport(fx.ctx.admin, b2))).toBeInstanceOf(ConflictError);
    expect(await batchValuations(b2, p.id)).toEqual([
      ["claim", 170_000, "official"],
      ["claim", 180_000, "rejected"],
    ]);
    expect((await processByNumber(cnj)).claimAmountCents).toBe(170_000);
  });
});

describe("mirrors on import update and rollback (provisionAmountCents)", () => {
  it("recomputes the provision when the import sets the claim, and again on each rollback", async () => {
    const cnj = validCnj(803);
    const pid = await makeProcess(fx.ctx.admin, { number: cnj, title: "Processo manual fictício", court: "TRT10", area: "labor", phase: "knowledge" });
    await addRiskAssessment(fx.ctx.admin, pid, {
      classification: "probable",
      percentage: 50,
      opinion: "Parecer fictício para o teste dos espelhos de provisão.",
      effectiveFrom: todayISO(),
    });
    let p = await processByNumber(cnj);
    expect(p).toMatchObject({ claimAmountCents: null, riskPercentageBp: 5000, provisionAmountCents: null });

    // Import fills the empty claim with an official value -> provision = 50% of the claim.
    const b1 = await importRows([row({ number: cnj, claim: 1000 })], "2026-06-30");
    p = await processByNumber(cnj);
    expect(p).toMatchObject({ claimAmountCents: 100_000, provisionAmountCents: 50_000 });

    // A later batch only proposes another value: mirrors unchanged; its rollback removes only the proposal.
    const b2 = await importRows([row({ number: cnj, claim: 1200 })], "2026-07-31");
    expect(await batchValuations(b2, pid)).toEqual([["claim", 120_000, "proposed"]]);
    expect(await rollbackImport(fx.ctx.admin, b2)).toEqual({ removed: 0, restored: 1 });
    expect(await batchValuations(b2, pid)).toEqual([]);
    p = await processByNumber(cnj);
    expect(p).toMatchObject({ deletedAt: null, claimAmountCents: 100_000, provisionAmountCents: 50_000 });

    // Undoing the first batch restores the empty claim and the provision follows (null = unknown, not zero).
    expect(await getRollbackBlockers(fx.ctx.admin, b1)).toEqual([]);
    expect(await rollbackImport(fx.ctx.admin, b1)).toEqual({ removed: 0, restored: 1 });
    p = await processByNumber(cnj);
    expect(p).toMatchObject({ deletedAt: null, claimAmountCents: null, provisionAmountCents: null, riskPercentageBp: 5000 });
    expect(await batchValuations(b1, pid)).toEqual([]);
  });
});

describe("set-based update of existing processes and instance links", () => {
  it("applies different column sets per row, scoped to the organization, and the rollback restores them", async () => {
    const a = validCnj(810);
    const b = validCnj(811);
    await importRows([row({ number: a, phase: "Conhecimento", claim: 100 }), row({ number: b, phase: "Conhecimento", city: "Palmas - TO", claim: 200 })], "2026-06-30");
    const before = { a: await processByNumber(a), b: await processByNumber(b) };
    const instancesOf = (pid: string) => fx.db.select().from(processInstances).where(eq(processInstances.processId, pid));
    const instBefore = (await instancesOf(before.a.id))[0];

    // a: phase + division change (process and instance); b: only the city changes.
    const batchId = await importRows(
      [
        row({ number: a, phase: "Liquidação", division: "2ª VARA DO TRABALHO", claim: 100 }),
        row({ number: b, phase: "Conhecimento", city: "Gurupi - TO", claim: 200 }),
      ],
      "2026-07-31",
    );
    const after = { a: await processByNumber(a), b: await processByNumber(b) };
    expect(after.a).toMatchObject({ phase: "liquidation", courtDivision: "2ª VARA DO TRABALHO", city: null });
    expect(after.b).toMatchObject({ phase: "knowledge", city: "Gurupi", state: "TO" });
    expect(after.a.updatedAt.getTime()).toBeGreaterThan(before.a.updatedAt.getTime());
    const instAfter = (await instancesOf(before.a.id))[0];
    expect(instAfter).toMatchObject({ id: instBefore.id, phase: "liquidation", courtDivision: "2ª VARA DO TRABALHO", isCurrent: true });

    expect(await rollbackImport(fx.ctx.admin, batchId)).toEqual({ removed: 0, restored: 2 });
    expect(await processByNumber(a)).toMatchObject({ phase: "knowledge", courtDivision: before.a.courtDivision });
    expect(await processByNumber(b)).toMatchObject({ city: "Palmas", state: "TO" });
    expect((await instancesOf(before.a.id))[0]).toMatchObject({ phase: instBefore.phase, courtDivision: instBefore.courtDivision });
  });
});

describe("processes closed by the import without a closing date", () => {
  it("get the commit base date as closedAt (new and existing processes), with a warning to check", async () => {
    const newCnj = validCnj(804);
    const existingCnj = validCnj(805);
    await makeProcess(fx.ctx.admin, { number: existingCnj, title: "Processo ativo fictício", court: "TRT10", area: "labor", phase: "enforcement" });
    const batchId = await importRows(
      [row({ number: newCnj, phase: "PAGO/EXTINTO", claim: 900, liquidated: 0 }), row({ number: existingCnj, phase: "PAGO/EXTINTO", claim: 500 })],
      "2026-07-31",
    );
    expect(await processByNumber(newCnj)).toMatchObject({ status: "closed", closureReason: "paid_extinct", closedAt: "2026-07-31" });
    expect(await processByNumber(existingCnj)).toMatchObject({ status: "closed", closureReason: "paid_extinct", closedAt: "2026-07-31" });
    const warnings = await listImportIssues(fx.ctx.admin, batchId, { code: "closed_at_assumed" });
    expect(warnings.total).toBe(2);
    expect(warnings.items[0].message).toMatch(/^Data de encerramento não informada: usada a data-base da importação; conferir/);

    // Rollback reopens the existing process exactly as it was.
    expect(await rollbackImport(fx.ctx.admin, batchId)).toEqual({ removed: 1, restored: 1 });
    expect(await processByNumber(existingCnj)).toMatchObject({ status: "active", phase: "enforcement", closedAt: null, closureReason: null });
  });
});

describe("issues CSV export is audited", () => {
  it("writes one import_batch.export_issues entry with filters and count, never cell values", async () => {
    const cnj = validCnj(806);
    const batchId = await importRows([row({ number: cnj, phase: "PAGO/EXTINTO", plaintiff: "PESSOA FICTÍCIA SIGILOSA", claim: 100 })], "2026-07-31");
    const { items } = await listAllImportIssues(fx.ctx.admin, batchId, { level: "warning" });
    expect(items.length).toBeGreaterThan(0);
    const audits = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, batchId), eq(auditLogs.action, "import_batch.export_issues")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "import_batch", actorId: fx.ctx.admin.userId });
    expect(audits[0].metadata).toEqual({ filters: { sheet: null, level: "warning", code: null }, rows: items.length });
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain(cnj);
    expect(serialized).not.toContain("PESSOA FICTÍCIA SIGILOSA");
    expect(actionLabel("import_batch.export_issues")).toBe("Exportação das inconsistências da importação (CSV)");
  });
});

describe("analysis limits", () => {
  it("refuses a spreadsheet with more data lines than the limit", async () => {
    sheets.current = [sheet("Consolidado Geral", Array.from({ length: 6 }, (_, i) => row({ number: validCnj(900 + i), claim: 10 })))];
    const err = await rejection(analyzeImport(fx.ctx.admin, { file: { name: "grande.xlsx", bytes }, companyId }));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors?.file?.[0]).toBe("A planilha tem 6 linhas de dados; o limite por importação é de 5 linhas. Divida o arquivo.");
  });

  it("refuses a small file whose unzipped content would exceed the limit, before unzipping", async () => {
    sheets.current = null;
    const [{ before }] = await fx.db.select({ before: count() }).from(importBatches);
    const bomb = craftZip([{ name: "xl/worksheets/sheet1.xml", uncompressedSize: 300 * MB }]);
    const err = await rejection(analyzeImport(fx.ctx.admin, { file: { name: "bomba.xlsx", bytes: bomb }, companyId }));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors?.file?.[0]).toBe("A planilha descompactada é grande demais (limite de 200 MB). Divida o arquivo.");
    const [{ after }] = await fx.db.select({ after: count() }).from(importBatches);
    expect(after).toBe(before);
  });
});

describe("closed competência (RN-10)", () => {
  it("blocks the rollback of a batch whose process is in a closed snapshot; a preview does not", async () => {
    const cnj = validCnj(807);
    const batchId = await importRows([row({ number: cnj, claim: 700 })], "2026-07-31");
    const p = await processByNumber(cnj);
    const today = todayISO();
    const [y, m] = today.split("-").map(Number);
    const period = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const label = `${period.slice(5, 7)}/${period.slice(0, 4)}`;

    await generateSnapshot(fx.ctx.admin, period);
    expect(await getRollbackBlockers(fx.ctx.admin, batchId)).toEqual([]);

    // The imported processes have no official risk classification (P1.9 close gate): this suite is
    // about the rollback of a closed competência, so it closes with a recorded justification.
    const closed = await closeSnapshot(fx.ctx.admin, period, {
      justification: "Carteira importada para teste de reversão; classificação de risco fora do escopo deste teste.",
    });
    expect(closed.override?.unclassifiedCount).toBeGreaterThan(0);
    const blockers = await getRollbackBlockers(fx.ctx.admin, batchId);
    expect(blockers).toEqual([{ processId: p.id, number: cnj, reasons: [`incluído em competência fechada (${label})`] }]);
    const err = await rejection(rollbackImport(fx.ctx.admin, batchId));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain("competência fechada");
    expect((await processByNumber(cnj)).deletedAt).toBeNull();
  });
});
