/**
 * Post-import distribution in chunks with progress entries (review group "imports-jobs"),
 * run by the "import.distribute" job (P0.6): a run interrupted mid-way keeps a rollback
 * boundary covering the chunks already recorded, the batch page reports it (running while
 * the job waits for its retry, interrupted once it gave up), and resuming enqueues the job
 * again, which distributes only the rest without hiding other changes made after the commit.
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

// Simulated crash: the N-th progress entry of the distribution fails to be written (process dies there).
const crash = vi.hoisted(() => ({ at: null as number | null, seen: 0 }));
vi.mock("@/server/services/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/audit")>();
  return {
    ...actual,
    recordAudit: vi.fn(async (...args: Parameters<typeof actual.recordAudit>) => {
      if (args[1].action === "import_batch.distribute" && crash.at !== null && crash.seen++ === crash.at) {
        throw new Error("queda simulada do processo");
      }
      return actual.recordAudit(...args);
    }),
  };
});

import { and, count, eq, isNull } from "drizzle-orm";
import { processPendingJobs } from "@/server/jobs/worker";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addComment } from "@/modules/comments/service";
import { DistributionCallout } from "@/modules/imports/components/distribution-callout";
import { assignResponsible } from "@/modules/distribution/service";
import {
  analyzeImport,
  commitImport,
  getImportBatch,
  getRollbackBlockers,
  IMPORT_DISTRIBUTION_CHUNK,
  resumeImportDistribution,
  rollbackImport,
} from "@/modules/imports/service";
import { recordAudit } from "@/server/services/audit";
import { auditLogs, comments, companies, jobs, legalProcesses } from "@/server/db/schema";
import { ConflictError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../../helpers/fixtures";
import { DEMO_CLIENT, row, sheet, validCnj } from "../../imports/helpers";

let fx: Fixture;
let companyId: string;
const calls: string[] = [];
const TOTAL = 2 * IMPORT_DISTRIBUTION_CHUNK + 30;
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

beforeAll(async () => {
  fx = await setupFixture("fixijd");
  const [c] = await fx.db.insert(companies).values({ organizationId: fx.orgA, name: DEMO_CLIENT }).returning();
  companyId = c.id;
  const lawyerId = fx.ctx.lawyer.userId!;
  // Behaves like the real assignment: sets the responsible and audits legal_process.assign in its own transaction.
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
  vi.useRealTimers();
  await fx?.teardown();
});

describe("resumable post-import distribution", () => {
  let batchId: string;

  it("an interrupted run keeps the progress of the recorded chunks", async () => {
    sheets.current = [sheet("Consolidado Geral", Array.from({ length: TOTAL }, (_, i) => row({ number: validCnj(5000 + i), claim: 100 + i })))];
    ({ batchId } = await analyzeImport(fx.ctx.admin, { file: { name: "carteira-ficticia.xlsx", bytes }, companyId, baseDate: "2026-07-31" }));

    crash.at = 1; // chunk 1 recorded, chunk 2 assigned, then the process "dies" while recording it
    const result = await commitImport(fx.ctx.admin, batchId, { baseDate: "2026-07-31", distributeAfterCommit: true });
    expect(result.created).toBe(TOTAL);
    expect(result).toMatchObject({ distribution: null, distributionQueued: true });
    expect(calls).toHaveLength(0); // nothing is distributed inside the commit request
    await processPendingJobs({ organizationId: fx.orgA });
    expect(calls).toHaveLength(2 * IMPORT_DISTRIBUTION_CHUNK);
    crash.at = null;
    // The job failed with a retryable error: back to the queue, with backoff.
    const [job] = await fx.db.select().from(jobs).where(eq(jobs.dedupeKey, `import.distribute:${batchId}`));
    expect(job).toMatchObject({ type: "import.distribute", status: "queued", attempts: 1 });
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());

    const b = await getImportBatch(fx.ctx.admin, batchId);
    expect(b.status).toBe("committed");
    expect(b.distribution).toMatchObject({
      attempted: IMPORT_DISTRIBUTION_CHUNK,
      assigned: IMPORT_DISTRIBUTION_CHUNK,
      failed: 0,
      done: false,
      remaining: TOTAL - IMPORT_DISTRIBUTION_CHUNK,
    });
    expect(b.distributionState).toBe("running"); // the job waits for its retry
    expect(renderToStaticMarkup(createElement(DistributionCallout, { batch: b }))).toContain("Distribuição após a importação em andamento");

    // The job gave up (retries exhausted): interrupted, and the page offers to resume.
    await fx.db.update(jobs).set({ status: "dead", completedAt: new Date() }).where(eq(jobs.id, job.id));
    const later = await getImportBatch(fx.ctx.admin, batchId);
    expect(later.distributionState).toBe("interrupted");
    // The batch page reports it and offers the resume action.
    const html = renderToStaticMarkup(createElement(DistributionCallout, { batch: later }));
    expect(html).toContain("Distribuição após a importação interrompida");
    expect(html).toContain(`${IMPORT_DISTRIBUTION_CHUNK} de ${TOTAL} processos novos já passaram pelas regras`);
    expect(html).toContain("Retomar distribuição");
  });

  it("the rollback boundary covers the recorded chunks; only the unrecorded assignments block it", async () => {
    const firstChunk = new Set(calls.slice(0, IMPORT_DISTRIBUTION_CHUNK));
    const secondChunk = new Set(calls.slice(IMPORT_DISTRIBUTION_CHUNK));
    const blockers = await getRollbackBlockers(fx.ctx.admin, batchId);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.every((b) => secondChunk.has(b.processId) && !firstChunk.has(b.processId))).toBe(true);
    expect(blockers.map((b) => b.processId)).toContain(calls[calls.length - 1]);
    expect(blockers.every((b) => b.reasons.join() === "alterado depois da importação")).toBe(true);
  });

  it("resuming distributes only the processes still without a responsible", async () => {
    // A user comments on an already distributed process before the resume.
    const commented = calls[0];
    await addComment(fx.ctx.manager, { type: "legal_process", id: commented }, "Comentário fictício depois da importação.");

    const before = calls.length;
    const queued = await resumeImportDistribution(fx.ctx.admin, batchId);
    expect(queued.deduplicated).toBe(false);
    // Asking again while the job is pending does not enqueue a second one.
    expect(await resumeImportDistribution(fx.ctx.admin, batchId)).toEqual({ jobId: queued.jobId, deduplicated: true });
    expect((await getImportBatch(fx.ctx.admin, batchId)).distributionState).toBe("running");
    expect(calls).toHaveLength(before); // resuming does not distribute inside the request either
    await processPendingJobs({ organizationId: fx.orgA });
    const resumed = calls.slice(before);
    expect(resumed).toHaveLength(TOTAL - 2 * IMPORT_DISTRIBUTION_CHUNK);
    expect(new Set([...calls]).size).toBe(TOTAL); // nobody was distributed twice
    const [resumeJob] = await fx.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, queued.jobId));
    expect(resumeJob.status).toBe("succeeded");
    const [{ left }] = await fx.db
      .select({ left: count() })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.importBatchId, batchId), isNull(legalProcesses.responsibleId)));
    expect(left).toBe(0);

    const b = await getImportBatch(fx.ctx.admin, batchId);
    expect(b.distributionState).toBe("done");
    expect(b.distribution).toMatchObject({ attempted: TOTAL, assigned: TOTAL, failed: 0, done: true, remaining: 0 });
    await expect(resumeImportDistribution(fx.ctx.admin, batchId)).rejects.toBeInstanceOf(ConflictError);

    // The distribution's own assignments no longer block; the comment made after the commit still does.
    const blockers = await getRollbackBlockers(fx.ctx.admin, batchId);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].processId).toBe(commented);
    expect(blockers[0].reasons).toContain("comentários publicados");
    await expect(rollbackImport(fx.ctx.admin, batchId)).rejects.toBeInstanceOf(ConflictError);

    // Test scaffolding: without that comment (and its audit entry) the whole batch can be undone.
    await fx.db.delete(comments).where(eq(comments.entityId, commented));
    await fx.db.delete(auditLogs).where(and(eq(auditLogs.entityId, commented), eq(auditLogs.action, "comment.create")));
    expect(await getRollbackBlockers(fx.ctx.admin, batchId)).toEqual([]);
    expect(await rollbackImport(fx.ctx.admin, batchId)).toEqual({ removed: TOTAL, restored: 0 });
  });
});
