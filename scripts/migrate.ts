/** Applies pending SQL migrations from ./drizzle to DATABASE_URL. */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/praetor" });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("[migrate] Migrações aplicadas.");
}

main().catch((err) => {
  console.error("[migrate] Falha:", err);
  process.exit(1);
});
