import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { JOB_TYPES, type JobType } from "@/domain/enums";
import { getDb, type DbOrTx } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import { AppError, ValidationError } from "@/server/lib/errors";
import { AiProviderError } from "@/server/integrations/ai/provider";

/**
 * Postgres-backed job queue. Jobs are claimed with `FOR UPDATE SKIP LOCKED`
 * so several workers can run concurrently. A pending (`queued`/`running`) job
 * with the same `dedupeKey` prevents enqueueing the same work twice.
 */

export type JobRow = typeof jobs.$inferSelect;

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
export const STUCK_JOB_TIMEOUT_MS = 15 * 60_000;

const enqueueSchema = z.object({
  type: z.enum(JOB_TYPES),
  organizationId: z.uuid().nullish(),
  payload: z.record(z.string(), z.unknown()),
  dedupeKey: z.string().min(1).max(300).nullish(),
  runAt: z.date().optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

export async function enqueueJob(
  input: {
    type: JobType;
    organizationId?: string | null;
    payload: Record<string, unknown>;
    dedupeKey?: string | null;
    runAt?: Date;
    maxAttempts?: number;
  },
  db: DbOrTx = getDb(),
): Promise<{ id: string; deduplicated: boolean }> {
  const parsed = enqueueSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Tarefa de fila inválida.", z.flattenError(parsed.error).fieldErrors);
  const v = parsed.data;
  const inserted = await db
    .insert(jobs)
    .values({
      type: v.type,
      organizationId: v.organizationId ?? null,
      payload: v.payload,
      dedupeKey: v.dedupeKey ?? null,
      runAt: v.runAt ?? new Date(),
      maxAttempts: v.maxAttempts ?? 3,
    })
    .onConflictDoNothing({
      target: jobs.dedupeKey,
      where: sql`dedupe_key is not null and status in ('queued', 'running')`,
    })
    .returning({ id: jobs.id });
  if (inserted[0]) return { id: inserted[0].id, deduplicated: false };

  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, v.dedupeKey ?? ""), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  if (!existing) throw new Error("job_enqueue_conflict_without_pending_job");
  return { id: existing.id, deduplicated: true };
}

/** Atomically claims up to `limit` due jobs (status -> running, attempts + 1). */
export async function claimJobs(workerId: string, limit: number, db: DbOrTx = getDb()): Promise<JobRow[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, sql`now()`)))
    .orderBy(asc(jobs.runAt), asc(jobs.createdAt))
    .limit(n)
    .for("update", { skipLocked: true });
  const claimed = await db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      lockedAt: sql`now()`,
      lockedBy: workerId.slice(0, 120),
    })
    .where(and(inArray(jobs.id, due), eq(jobs.status, "queued")))
    .returning();
  return claimed.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
}

export async function completeJob(jobId: string, db: DbOrTx = getDb()): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "succeeded", completedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null })
    .where(eq(jobs.id, jobId));
}

/** Exponential backoff: 30s, 60s, 120s... capped at 30 minutes. */
export function backoffMs(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(exp, 20));
}

/**
 * Sanitized error text for logs and `jobs.last_error`. Database driver errors
 * may embed query parameters (which can contain document text), so only
 * messages of our own error types are kept.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof AiProviderError) return error.userMessage;
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
    return `Erro interno (${error.name}${typeof code === "string" ? ` ${code}` : ""}).`;
  }
  return "Erro interno desconhecido.";
}

/** Whether a failed job should be retried. Domain errors (not found, validation...) are permanent. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof AiProviderError) return error.retryable;
  if (error instanceof AppError) return false;
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  if (typeof flag === "boolean") return flag;
  return true;
}

export async function failJob(
  job: Pick<JobRow, "id" | "attempts" | "maxAttempts">,
  error: unknown,
  retryable: boolean,
  db: DbOrTx = getDb(),
): Promise<{ status: "queued" | "dead"; runAt?: Date }> {
  const lastError = safeErrorMessage(error).slice(0, 500);
  if (!retryable || job.attempts >= job.maxAttempts) {
    await db
      .update(jobs)
      .set({ status: "dead", lastError, completedAt: new Date(), lockedAt: null, lockedBy: null })
      .where(eq(jobs.id, job.id));
    return { status: "dead" };
  }
  const runAt = new Date(Date.now() + backoffMs(job.attempts));
  await db
    .update(jobs)
    .set({ status: "queued", lastError, runAt, lockedAt: null, lockedBy: null })
    .where(eq(jobs.id, job.id));
  return { status: "queued", runAt };
}

/** Puts back jobs left `running` by a crashed worker. Returns how many were recovered. */
export async function recoverStuckJobs(db: DbOrTx = getDb(), olderThanMs = STUCK_JOB_TIMEOUT_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null, lastError: "Execução interrompida; tarefa devolvida à fila." })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });
  return rows.length;
}
