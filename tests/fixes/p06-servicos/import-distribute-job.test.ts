/**
 * P0.6 (deferred 8): the post-import distribution runs in the "import.distribute"
 * job, enqueued inside the commit transaction (dedupe key import.distribute:<batch>),
 * as the system, in chunks; a failed run is retried by the queue and resumes from
 * the last chunk recorded; a batch undone before the job runs is left alone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RawSheet } from "@/modules/imports/parser";

const sheets = vi.hoisted(() => ({ current: [] as RawSheet[] }));
vi.mock("@/modules/imports/xlsx", () => ({
  readWorkbook: vi.fn(async () => sheets.current),
  hasZipSignature: () => true,
  UnreadableWorkbookError: class UnreadableWorkbookError extends Error {},
}));
vi.mock("@/modules/distribution/service", () => ({ decideAssignment: vi.fn(), assignResponsible: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requirePageContext: vi.fn(), requireActionContext: vi.fn(), getCurrentUser: vi.fn() }));

// Failure injection: the commit audit, or the N-th distribution progress entry, fails.
const fail = vi.hoisted(() => ({ commit: false, progressAt: null as number | null, seen: 0 }));
vi.mock("@/server/services/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/audit")>();
  return {
    ...actual,
    recordAudit: vi.fn(async (...args: Parameters<typeof actual.recordAudit>) => {
      if (args[1].action === "import_batch.commit" && fail.commit) throw new Error("falha simulada no commit");
      if (args[1].action === "import_batch.distribute" && fail.progressAt !== null && fail.seen++ === fail.progressAt) {
        throw new Error("queda simulada do banco");
      }
      return actual.recordAudit(...args);
    }),
  };
});

import { and, asc, count, eq, isNull } from "drizzle-orm";
import { assignResponsible } from "@/modules/distribution/service";
import { analyzeImport, commitImport, getImportBatch, IMPORT_DISTRIBUTION_CHUNK, rollbackImport, runImportDistributionJob } from "@/modules/imports/service";
import { auditLogs, companies, importBatches, jobs, legalProcesses } from "@/server/db/schema";
import { InvalidJobPayloadError, JOB_HANDLERS } from "@/server/jobs/handlers";
import type { JobRow } from "@/server/jobs/queue";
import { processPendingJobs } from "@/server/jobs/worker";
import { recordAudit } from "@/server/services/audit";
import { setupFixture, type Fixture } from "../../helpers/fixtures";
import { DEMO_CLIENT, row, sheet, validCnj } from "../../imports/helpers";

let fx: Fixture;
let companyId: string;
const calls: string[] = [];
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
let cnjSeq = 7000;

beforeAll(async () => {
  fx = await setupFixture("p06imp");
  const [c] = await fx.db.insert(companies).values({ organizationId: fx.orgA, name: DEMO_CLIENT }).returning();
  companyId = c.id;
  const lawyerId = fx.ctx.lawyer.userId!;
  vi.mocked(assignResponsible).mockImplementation(async (ctx, processId) => {
    await fx.db.transaction(async (tx) => {
      await tx.update(legalProcesses).set({ responsibleId: lawyerId }).where(eq(legalProcesses.id, processId));
      await recordAudit(ctx, { action: "legal_process.assign", entityType: "legal_process", entityId: processId, summary: "Responsável definido (teste)" }, tx);
    });
    calls.push(processId);
    return { userId: lawyerId, userName: "Laura", method: "rule", ruleId: null, ruleName: null, lawFirmId: null, unitId: null, reason: "Regra de teste." };
  });
});

afterAll(async () => {
  await fx?.teardown();
});

async function analyzeBatch(rows: number): Promise<string> {
  sheets.current = [sheet("Consolidado Geral", Array.from({ length: rows }, (_, i) => row({ number: validCnj(cnjSeq + i), claim: 100 + i })))];
  cnjSeq += rows;
  const { batchId } = await analyzeImport(fx.ctx.admin, { file: { name: "carteira-ficticia.xlsx", bytes }, companyId, baseDate: "2026-07-31" });
  return batchId;
}

function jobsOf(batchId: string) {
  return fx.db.select().from(jobs).where(eq(jobs.dedupeKey, `import.distribute:${batchId}`)).orderBy(asc(jobs.createdAt));
}

async function withoutResponsible(batchId: string): Promise<number> {
  const [{ n }] = await fx.db
    .select({ n: count() })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.importBatchId, batchId), isNull(legalProcesses.responsibleId), isNull(legalProcesses.deletedAt)));
  return n;
}

describe("import.distribute job", () => {
  it("is enqueued inside the commit transaction: a failed commit leaves no job behind", async () => {
    const batchId = await analyzeBatch(3);
    fail.commit = true;
    await expect(commitImport(fx.ctx.admin, batchId, { baseDate: "2026-07-31", distributeAfterCommit: true })).rejects.toThrow();
    fail.commit = false;
    expect(await jobsOf(batchId)).toHaveLength(0);
    const [b] = await fx.db.select({ status: importBatches.status }).from(importBatches).where(eq(importBatches.id, batchId));
    expect(b.status).toBe("analyzed");

    const result = await commitImport(fx.ctx.admin, batchId, { baseDate: "2026-07-31", distributeAfterCommit: true });
    expect(result).toMatchObject({ created: 3, distribution: null, distributionQueued: true });
    const [job] = await jobsOf(batchId);
    expect(job).toMatchObject({ type: "import.distribute", organizationId: fx.orgA, status: "queued", payload: { batchId } });
    expect(calls).toHaveLength(0);
    expect((await getImportBatch(fx.ctx.admin, batchId)).distributionState).toBe("running");

    await processPendingJobs({ organizationId: fx.orgA });
    expect(calls).toHaveLength(3);
    expect(await withoutResponsible(batchId)).toBe(0);
    const [done] = await jobsOf(batchId);
    expect(done.status).toBe("succeeded");
    const b2 = await getImportBatch(fx.ctx.admin, batchId);
    expect(b2.distributionState).toBe("done");
    expect(b2.distribution).toMatchObject({ attempted: 3, assigned: 3, failed: 0, done: true });

    // Recorded as the system (automatic), never as the person who confirmed the import.
    const entries = await fx.db
      .select({ actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, batchId), eq(auditLogs.action, "import_batch.distribute")));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.actorId === null)).toBe(true);

    // Running the job body again changes nothing (idempotent).
    const again = await runImportDistributionJob(fx.orgA, batchId);
    expect(again).toMatchObject({ done: true, assigned: 3 });
    expect(calls).toHaveLength(3);
  });

  it("a confirmation without distribution enqueues nothing", async () => {
    const batchId = await analyzeBatch(2);
    const result = await commitImport(fx.ctx.admin, batchId, { baseDate: "2026-07-31", distributeAfterCommit: false });
    expect(result.distributionQueued).toBe(false);
    expect(await jobsOf(batchId)).toHaveLength(0);
    expect((await getImportBatch(fx.ctx.admin, batchId)).distributionState).toBe("none");
  });

  it("a run that stops mid-way is retried by the queue and resumes from the last chunk recorded", async () => {
    const total = IMPORT_DISTRIBUTION_CHUNK + 20;
    const batchId = await analyzeBatch(total);
    calls.length = 0;
    await commitImport(fx.ctx.admin, batchId, { baseDate: "2026-07-31", distributeAfterCommit: true });

    fail.seen = 0;
    fail.progressAt = 1; // chunk 1 recorded; the last chunk is assigned but its progress entry fails
    await processPendingJobs({ organizationId: fx.orgA });
    fail.progressAt = null;
    expect(calls).toHaveLength(total);
    const [retry] = await jobsOf(batchId);
    expect(retry).toMatchObject({ status: "queued", attempts: 1 });
    expect(retry.lastError).toBe("Erro interno (ImportDistributionInterruptedError).");
    const waiting = await getImportBatch(fx.ctx.admin, batchId);
    expect(waiting.distributionState).toBe("running");
    expect(waiting.distribution).toMatchObject({ attempted: IMPORT_DISTRIBUTION_CHUNK, done: false, remaining: 20 });

    // The backoff elapsed: the retry finds every process with a responsible and only records the end.
    await fx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, retry.id));
    await processPendingJobs({ organizationId: fx.orgA });
    expect(calls).toHaveLength(total); // nobody distributed twice
    const [finished] = await jobsOf(batchId);
    expect(finished.status).toBe("succeeded");
    const b = await getImportBatch(fx.ctx.admin, batchId);
    expect(b.distributionState).toBe("done");
    expect(b.distribution).toMatchObject({ attempted: total, assigned: total, done: true, remaining: 0 });
  });

  it("a batch undone before the job runs is left alone", async () => {
    const batchId = await analyzeBatch(4);
    calls.length = 0;
    await commitImport(fx.ctx.admin, batchId, { baseDate: "2026-07-31", distributeAfterCommit: true });
    expect(await rollbackImport(fx.ctx.admin, batchId)).toEqual({ removed: 4, restored: 0 });
    await processPendingJobs({ organizationId: fx.orgA });
    expect(calls).toHaveLength(0);
    const [job] = await jobsOf(batchId);
    expect(job.status).toBe("succeeded");
    const [{ n }] = await fx.db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, batchId), eq(auditLogs.action, "import_batch.distribute")));
    expect(n).toBe(0);
    expect((await getImportBatch(fx.ctx.admin, batchId)).distributionState).toBe("none");
  });

  it("the handler rejects malformed payloads and jobs of another organization", async () => {
    const handler = JOB_HANDLERS["import.distribute"];
    const base = { id: "x", type: "import.distribute", attempts: 1, maxAttempts: 5 } as unknown as JobRow;
    await expect(handler({ ...base, organizationId: fx.orgA, payload: { batchId: "não é id" } })).rejects.toBeInstanceOf(InvalidJobPayloadError);
    await expect(handler({ ...base, organizationId: null, payload: { batchId: fx.orgA } })).rejects.toBeInstanceOf(InvalidJobPayloadError);
    // A batch id of organization A in a job of organization B: nothing is found, nothing is done.
    const batchId = await analyzeBatch(1);
    await commitImport(fx.ctx.admin, batchId, { baseDate: "2026-07-31", distributeAfterCommit: true });
    calls.length = 0;
    expect(await runImportDistributionJob(fx.orgB, batchId)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
