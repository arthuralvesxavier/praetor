import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/server/db/client";
import { logger } from "@/server/lib/logger";

/**
 * Liveness/readiness probe (public, see src/proxy.ts). Exposes no versions,
 * configuration or secrets — only whether the app and its database respond.
 */
export async function GET() {
  await connection(); // always evaluated at request time, never prerendered
  let database: "ok" | "error" = "ok";
  try {
    await getDb().execute(sql`select 1`);
  } catch (error) {
    database = "error";
    logger.error("health_db_failed", { error });
  }
  return Response.json(
    { status: database === "ok" ? "ok" : "degraded", database },
    { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
