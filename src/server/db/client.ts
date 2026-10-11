import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/server/env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction — services accept either. */
export type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

declare global {
  var __praetorDb: { db: Database; pool?: Pool } | undefined;
}

/**
 * Returns the process-wide database handle. Production/dev use node-postgres;
 * tests inject a PGlite instance with `setDatabase()` (same SQL dialect,
 * same migrations). Cached on globalThis to survive Next.js dev reloads.
 */
export function getDb(): Database {
  if (!globalThis.__praetorDb) {
    const pool = new Pool({ connectionString: env().DATABASE_URL, max: 10 });
    globalThis.__praetorDb = { db: drizzle(pool, { schema }), pool };
  }
  return globalThis.__praetorDb.db;
}

export function setDatabase(db: Database) {
  globalThis.__praetorDb = { db };
}

export async function closeDatabase() {
  await globalThis.__praetorDb?.pool?.end();
  globalThis.__praetorDb = undefined;
}

export { schema };
