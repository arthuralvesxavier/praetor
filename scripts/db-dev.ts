/**
 * Starts a local PostgreSQL server for development using the `embedded-postgres`
 * package (real PostgreSQL binaries, no Docker or system install required).
 * Data is persisted in `.data/postgres`. Stop with Ctrl+C.
 *
 * Production must use a managed/hardened PostgreSQL instead (see docs/OPERATIONS.md).
 */
import "dotenv/config";
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { existsSync } from "node:fs";
import path from "node:path";

const url = new URL(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/praetor");
const databaseDir = path.resolve(".data/postgres");
const dbName = url.pathname.replace(/^\//, "") || "praetor";

const user = decodeURIComponent(url.username || "postgres");
const password = decodeURIComponent(url.password || "postgres");
const port = Number(url.port || 54329);

const pg = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
  // UTF-8 regardless of the OS code page (Windows defaults to WIN1252, which
  // rejects characters such as "→" and emoji). Collation: ICU pt-BR.
  initdbFlags: ["--encoding=UTF8", "--locale-provider=icu", "--icu-locale=pt-BR", "--locale=C"],
  onLog: () => {},
});

/** Creates the app database as UTF-8 / ICU pt-BR when missing; warns when an existing one is not UTF-8. */
async function ensureDatabase(): Promise<void> {
  const client = new Client({ host: "127.0.0.1", port, user, password, database: "postgres" });
  await client.connect();
  try {
    const { rows } = await client.query<{ enc: string }>(
      "select pg_encoding_to_char(encoding) as enc from pg_database where datname = $1",
      [dbName],
    );
    if (rows.length === 0) {
      const ident = `"${dbName.replace(/"/g, '""')}"`;
      await client.query(
        `create database ${ident} with template template0 encoding 'UTF8' locale_provider icu icu_locale 'pt-BR' locale 'C'`,
      );
    } else if (rows[0].enc !== "UTF8") {
      console.warn(
        `[db] ATENÇÃO: o banco "${dbName}" usa a codificação ${rows[0].enc}, não UTF-8. Textos com caracteres fora dessa ` +
          "codificação falham ao gravar. Veja docs/OPERATIONS.md (\"Migrar o banco local para UTF-8\").",
      );
    }
  } finally {
    await client.end();
  }
}

async function main() {
  if (!existsSync(path.join(databaseDir, "PG_VERSION"))) {
    console.log(`[db] Inicializando cluster em ${databaseDir}...`);
    await pg.initialise();
  }
  await pg.start();
  await ensureDatabase();
  console.log(`[db] PostgreSQL pronto em 127.0.0.1:${port} (banco "${dbName}"). Ctrl+C para parar.`);
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
