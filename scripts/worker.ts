/**
 * Background worker entrypoint (`npm run worker`, also started by `npm run dev`).
 * Runs queued jobs (AI analyses, text extraction, routines) and schedules due
 * routines. Waits for the database to come up instead of crashing.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDatabase, getDb } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { startWorker, type WorkerHandle } from "@/server/jobs/worker";

const RETRY_MS = 5000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(isStopping: () => boolean): Promise<boolean> {
  let attempt = 0;
  while (!isStopping()) {
    try {
      await getDb().execute(sql`select 1`);
      return true;
    } catch (err) {
      attempt++;
      logger.warn("worker_waiting_for_database", {
        attempt,
        retryInMs: RETRY_MS,
        error: err instanceof Error ? err.name : "unknown",
      });
      await closeDatabase().catch(() => undefined);
      await wait(RETRY_MS);
    }
  }
  return false;
}

async function main() {
  let stopping = false;
  let handle: WorkerHandle | null = null;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("worker_shutdown", { signal });
    try {
      await handle?.stop();
    } finally {
      await closeDatabase().catch(() => undefined);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (!(await waitForDatabase(() => stopping))) return;
  handle = startWorker();
}

main().catch((err) => {
  logger.error("worker_crashed", { error: err instanceof Error ? { name: err.name, message: err.message } : String(err) });
  process.exit(1);
});
