/**
 * Job queue robustness (review group "imports-jobs"): jobs are claimed one at a
 * time (lockedAt = start of each execution) and completion/failure only apply
 * while the execution still holds the job.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRow } from "@/server/jobs/queue";

const seen = vi.hoisted(() => ({ statuses: [] as { running: string; others: { id: string; status: string; lockedAt: Date | null }[] }[] }));
vi.mock("@/server/jobs/handlers", async () => {
  const { getDb } = await import("@/server/db/client");
  const { jobs } = await import("@/server/db/schema");
  return {
    JOB_HANDLERS: {
      "routine.run": async (job: JobRow) => {
        const rows = await getDb().select({ id: jobs.id, status: jobs.status, lockedAt: jobs.lockedAt }).from(jobs);
        seen.statuses.push({ running: job.id, others: rows.filter((r) => r.id !== job.id) });
      },
    },
  };
});

import { eq } from "drizzle-orm";
import { createTestDatabase } from "../../helpers/db";
import type { Database } from "@/server/db/client";
import { jobs, organizations } from "@/server/db/schema";
import { claimJobs, completeJob, enqueueJob, failJob, recoverStuckJobs } from "@/server/jobs/queue";
import { processPendingJobs } from "@/server/jobs/worker";

let db: Database;
let close: () => Promise<void>;
let orgId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [org] = await db.insert(organizations).values({ name: "Org fila", slug: "org-fila-lease" }).returning();
  orgId = org.id;
});

afterAll(async () => close());

async function jobRow(id: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row;
}

describe("claiming one job at a time", () => {
  it("claimJobs honors the limit (never locks more jobs than it returns)", async () => {
    for (let i = 0; i < 3; i++) await enqueueJob({ type: "routine.run", organizationId: orgId, payload: { n: i } });
    const claimed = await claimJobs("w-limit", 1);
    expect(claimed).toHaveLength(1);
    const rows = await db.select({ status: jobs.status }).from(jobs);
    expect(rows.filter((r) => r.status === "running")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(2);
    expect(await claimJobs("w-limit", 2)).toHaveLength(2);
    await db.delete(jobs);
  });

  it("leaves the next jobs queued (not locked) while a job runs", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await enqueueJob({ type: "routine.run", organizationId: orgId, payload: { n: i }, runAt: new Date(Date.now() - (10 - i) * 1000) })).id);
    }
    const { processed } = await processPendingJobs({ limit: 10 });
    expect(processed).toBe(3);
    expect(seen.statuses.map((s) => s.running)).toEqual(ids);
    for (const [index, s] of seen.statuses.entries()) {
      const later = s.others.filter((o) => ids.indexOf(o.id) > index);
      // Siblings are not claimed in advance, so their lockedAt cannot age while this one runs.
      expect(later.every((o) => o.status === "queued" && o.lockedAt === null)).toBe(true);
    }
    for (const id of ids) expect((await jobRow(id)).status).toBe("succeeded");
    await db.delete(jobs);
  });
});

describe("lease of a claimed job", () => {
  it("a late finish of an execution recovered as stuck does not overwrite the new execution", async () => {
    const { id } = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {} });
    const [first] = await claimJobs("worker-a", 1);
    expect(first).toMatchObject({ id, lockedBy: "worker-a", attempts: 1 });

    // worker-a hangs; the job is recovered and claimed again by worker-b.
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(jobs.id, id));
    expect(await recoverStuckJobs()).toBe(1);
    const [second] = await claimJobs("worker-b", 1);
    expect(second).toMatchObject({ id, lockedBy: "worker-b", attempts: 2 });

    // worker-a finally finishes (or fails): ignored, the row still belongs to worker-b.
    expect(await completeJob(id, undefined, { lockedBy: first.lockedBy, attempts: first.attempts })).toBe(false);
    expect(await failJob(first, new Error("tarde demais"), true)).toEqual({ status: "ignored" });
    expect(await jobRow(id)).toMatchObject({ status: "running", lockedBy: "worker-b", attempts: 2 });

    // worker-b's own completion applies.
    expect(await completeJob(id, undefined, { lockedBy: second.lockedBy, attempts: second.attempts })).toBe(true);
    expect(await jobRow(id)).toMatchObject({ status: "succeeded", lockedBy: null });
    await db.delete(jobs);
  });

  it("the same worker id cannot finish an older claim of a re-claimed job (attempts is the fence)", async () => {
    const { id } = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {} });
    const [first] = await claimJobs("same-worker", 1);
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(jobs.id, id));
    await recoverStuckJobs();
    const [second] = await claimJobs("same-worker", 1);
    expect(await failJob(first, new Error("x"), false)).toEqual({ status: "ignored" });
    expect((await jobRow(id)).status).toBe("running");
    expect(await failJob(second, new Error("x"), false)).toEqual({ status: "dead" });
    await db.delete(jobs);
  });

  it("keeps the unconditional form for callers without a lease", async () => {
    const { id } = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {}, dedupeKey: "sem-lease" });
    expect(await completeJob(id)).toBe(true);
    expect((await jobRow(id)).status).toBe("succeeded");
    await db.delete(jobs);
  });
});
