/**
 * Starts a local PostgreSQL server for development using the `embedded-postgres`
 * package (real PostgreSQL binaries, no Docker or system install required).
 * Data is persisted in `.data/postgres`. Stop with Ctrl+C.
 *
 * Production must use a managed/hardened PostgreSQL instead (see docs/OPERATIONS.md).
 */
import "dotenv/config";
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const url = new URL(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/praetor");
const databaseDir = path.resolve(".data/postgres");
const dbName = url.pathname.replace(/^\//, "") || "praetor";

const pg = new EmbeddedPostgres({
  databaseDir,
  user: decodeURIComponent(url.username || "postgres"),
  password: decodeURIComponent(url.password || "postgres"),
  port: Number(url.port || 54329),
  persistent: true,
  onLog: () => {},
});

async function main() {
  if (!existsSync(path.join(databaseDir, "PG_VERSION"))) {
    console.log(`[db] Inicializando cluster em ${databaseDir}...`);
    await pg.initialise();
  }
  await pg.start();
  await pg.createDatabase(dbName).catch(() => {
    /* already exists */
  });
  console.log(`[db] PostgreSQL pronto em 127.0.0.1:${url.port || 54329} (banco "${dbName}"). Ctrl+C para parar.`);
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("[db] Encerrando PostgreSQL...");
  await pg.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(async (err) => {
  console.error("[db] Falha ao iniciar o PostgreSQL:", err);
  await pg.stop().catch(() => {});
  process.exit(1);
});
setInterval(() => {}, 1 << 30);
