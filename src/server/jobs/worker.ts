import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getDb } from "@/server/db/client";
import { organizations } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { JOB_HANDLERS } from "./handlers";
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  isRetryableError,
  recoverStuckJobs,
  safeErrorMessage,
  type JobRow,
} from "./queue";
import { claimDueRoutines, ensureDefaultRoutines } from "./routines";

/**
 * Background worker: claims queued jobs (FOR UPDATE SKIP LOCKED), runs their
 * handlers, retries with exponential backoff, and schedules due routines.
 * `processPendingJobs` runs the queue inline (admin "processar fila agora",
 * seed, tests); `startWorker` is the long-running loop used by scripts/worker.ts.
 */

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const RECOVER_EVERY_MS = 60_000;
const ENSURE_ROUTINES_EVERY_MS = 60 * 60_000;

async function runJob(job: JobRow): Promise<void> {
  const started = Date.now();
  try {
    const handler = JOB_HANDLERS[job.type];
    if (!handler) throw Object.assign(new Error(`unknown_job_type`), { retryable: false });
    await handler(job);
    await completeJob(job.id);
    logger.info("job_succeeded", { jobId: job.id, type: job.type, attempt: job.attempts, ms: Date.now() - started });
  } catch (err) {
    const retryable = isRetryableError(err);
    const outcome = await failJob(job, err, retryable);
    logger.warn("job_failed", {
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      retryable,
      outcome: outcome.status,
      nextRunAt: outcome.runAt?.toISOString(),
      error: safeErrorMessage(err),
    });
  }
}

/** Claims and runs due jobs until none are left or `limit` jobs were processed. */
export async function processPendingJobs(
  opts: { limit?: number; organizationId?: string } = {},
): Promise<{ processed: number }> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  let processed = 0;
  while (processed < limit) {
    const batch = await claimJobs(WORKER_ID, Math.min(10, limit - processed), undefined, {
      organizationId: opts.organizationId,
    });
    if (!batch.length) break;
    for (const job of batch) {
      await runJob(job);
      processed++;
    }
  }
  return { processed };
}

/** Alias kept for callers that think in "worker ticks". */
export const runWorkerOnce = processPendingJobs;

/** Enqueues a `routine.run` job for every due routine (deduplicated per routine). */
export async function scheduleDueRoutines(): Promise<number> {
  const due = await claimDueRoutines();
  for (const r of due) {
    await enqueueJob({
      type: "routine.run",
      organizationId: r.organizationId,
      payload: { routineId: r.id },
      dedupeKey: `routine:${r.id}`,
      maxAttempts: 3,
    });
  }
  return due.length;
}

/** Makes sure every organization has the default routines (idempotent). */
export async function ensureRoutinesForAllOrganizations(): Promise<void> {
  const orgs = await getDb().select({ id: organizations.id }).from(organizations);
  for (const o of orgs) await ensureDefaultRoutines(o.id);
}

export type WorkerHandle = { stop: () => Promise<void> };

/** Long-running loop. Resolves `stop()` after the current tick finishes. */
export function startWorker(opts: { pollIntervalMs?: number; batchSize?: number } = {}): WorkerHandle {
  const pollMs = opts.pollIntervalMs ?? env().WORKER_POLL_INTERVAL_MS;
  const batchSize = opts.batchSize ?? 10;
  let stopping = false;
  let wake: (() => void) | null = null;
  let lastRecover = 0;
  let lastEnsure = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  const loop = (async () => {
    logger.info("worker_started", { workerId: WORKER_ID, pollMs });
    while (!stopping) {
      let processed = 0;
      try {
        const now = Date.now();
        if (now - lastEnsure >= ENSURE_ROUTINES_EVERY_MS) {
          await ensureRoutinesForAllOrganizations();
          lastEnsure = now;
        }
        if (now - lastRecover >= RECOVER_EVERY_MS) {
          const recovered = await recoverStuckJobs();
          if (recovered) logger.warn("jobs_recovered", { count: recovered });
          lastRecover = now;
        }
        const scheduled = await scheduleDueRoutines();
        if (scheduled) logger.info("routines_scheduled", { count: scheduled });
        processed = (await processPendingJobs({ limit: batchSize })).processed;
      } catch (err) {
        logger.error("worker_tick_failed", { error: safeErrorMessage(err) });
      }
      if (!stopping && processed === 0) await sleep(pollMs);
    }
    logger.info("worker_stopped", { workerId: WORKER_ID });
  })();

  return {
    stop: async () => {
      stopping = true;
      wake?.();
      await loop;
    },
  };
}
