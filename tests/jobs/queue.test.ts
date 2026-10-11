import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "../helpers/db";
import type { Database } from "@/server/db/client";
import { jobs, organizations } from "@/server/db/schema";
import {
  backoffMs,
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  recoverStuckJobs,
  safeErrorMessage,
} from "@/server/jobs/queue";
import { AiProviderError } from "@/server/integrations/ai/provider";

let db: Database;
let close: () => Promise<void>;
let orgId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [org] = await db.insert(organizations).values({ name: "Org", slug: "org-q" }).returning();
  orgId = org.id;
});

afterAll(async () => close());

describe("job queue", () => {
  it("deduplicates pending jobs by dedupeKey", async () => {
    const a = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: { routineId: "x" }, dedupeKey: "k1" });
    const b = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: { routineId: "x" }, dedupeKey: "k1" });
    expect(a.deduplicated).toBe(false);
    expect(b).toEqual({ id: a.id, deduplicated: true });
    const c = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {}, dedupeKey: null });
    const d = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {}, dedupeKey: null });
    expect(c.id).not.toBe(d.id);

    // Once completed, the same key can be enqueued again.
    await completeJob(a.id);
    const e = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {}, dedupeKey: "k1" });
    expect(e.deduplicated).toBe(false);
    expect(e.id).not.toBe(a.id);
    await db.delete(jobs);
  });

  it("claims due jobs once, incrementing attempts", async () => {
    const due = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {}, dedupeKey: "due" });
    await enqueueJob({
      type: "routine.run",
      organizationId: orgId,
      payload: {},
      dedupeKey: "future",
      runAt: new Date(Date.now() + 3600_000),
    });
    const claimed = await claimJobs("w1", 10);
    expect(claimed.map((j) => j.id)).toEqual([due.id]);
    expect(claimed[0].status).toBe("running");
    expect(claimed[0].attempts).toBe(1);
    expect(claimed[0].lockedBy).toBe("w1");
    expect(await claimJobs("w2", 10)).toHaveLength(0);
    await db.delete(jobs);
  });

  it("claims only one organization's jobs when asked to", async () => {
    const [other] = await db.insert(organizations).values({ name: "Outra", slug: "org-q-other" }).returning();
    const mine = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {}, dedupeKey: "mine" });
    const theirs = await enqueueJob({ type: "routine.run", organizationId: other.id, payload: {}, dedupeKey: "theirs" });
    const claimed = await claimJobs("w1", 10, undefined, { organizationId: orgId });
    expect(claimed.map((j) => j.id)).toEqual([mine.id]);
    const [left] = await db.select().from(jobs).where(eq(jobs.id, theirs.id));
    expect(left.status).toBe("queued");
    await db.delete(jobs);
  });

  it("retries with exponential backoff and goes dead after max attempts", async () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(50)).toBe(30 * 60_000);

    const { id } = await enqueueJob({ type: "analysis.run", organizationId: orgId, payload: {}, maxAttempts: 2 });
    let [job] = await claimJobs("w", 1);
    expect(job.id).toBe(id);
    const before = Date.now();
    const r1 = await failJob(job, new AiProviderError("rate", { retryable: true, userMessage: "Limite excedido." }), true);
    expect(r1.status).toBe("queued");
    expect(r1.runAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000 - 50);
    let [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(row.status).toBe("queued");
    expect(row.lastError).toBe("Limite excedido.");
    expect(await claimJobs("w", 1)).toHaveLength(0); // not due yet

    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
    [job] = await claimJobs("w", 1);
    expect(job.attempts).toBe(2);
    const r2 = await failJob(job, new Error("boom"), true);
    expect(r2.status).toBe("dead");
    [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(row.status).toBe("dead");
    expect(row.lastError).toBe("Erro interno (Error).");
    await db.delete(jobs);
  });

  it("marks non-retryable failures dead immediately", async () => {
    const { id } = await enqueueJob({ type: "analysis.run", organizationId: orgId, payload: {}, maxAttempts: 5 });
    const [job] = await claimJobs("w", 1);
    const r = await failJob(job, new Error("x"), false);
    expect(r.status).toBe("dead");
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(row.status).toBe("dead");
    await db.delete(jobs);
  });

  it("recovers jobs stuck in running", async () => {
    const { id } = await enqueueJob({ type: "routine.run", organizationId: orgId, payload: {} });
    await claimJobs("w", 1);
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(jobs.id, id));
    expect(await recoverStuckJobs()).toBe(1);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(row.status).toBe("queued");
    await db.delete(jobs);
  });

  it("never exposes raw driver messages", () => {
    const err = Object.assign(new Error('insert into x values ("texto sigiloso")'), { code: "23505" });
    expect(safeErrorMessage(err)).toBe("Erro interno (Error 23505).");
  });
});
