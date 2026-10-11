import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { setDatabase, type Database } from "@/server/db/client";
import * as schema from "@/server/db/schema";

/**
 * Creates an isolated in-memory PostgreSQL (PGlite) with all migrations
 * applied and installs it as the process database. Call in `beforeAll`.
 */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: "./drizzle" });
  // PGlite and node-postgres drizzle instances share the same query API.
  const db = pgliteDb as unknown as Database;
  setDatabase(db);
  return { db, close: () => client.close() };
}
