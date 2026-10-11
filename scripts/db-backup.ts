/**
 * Full logical backup of the application database + uploaded files.
 *
 *   npm run db:backup                 -> .data/backups/<timestamp>/
 *   npm run db:backup -- --label pre-v2
 *
 * Output: one JSON file per table (rows as JSON, types preserved by Postgres'
 * row_to_json), a copy of STORAGE_DIR, and manifest.json with row counts,
 * applied migrations and sha256 of every file. Restore with scripts/db-restore.ts.
 *
 * This is a development/demo safety net taken before structural changes. In
 * production use the database's native backups (pg_dump / managed snapshots),
 * see docs/OPERATIONS.md.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/praetor";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const pool = new Pool({ connectionString: url });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = arg("label")?.replace(/[^\w-]/g, "") ?? "";
  const dir = path.resolve(".data/backups", label ? `${stamp}_${label}` : stamp);
  await mkdir(path.join(dir, "tables"), { recursive: true });

  const tables = (
    await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    )
  ).rows.map((r) => r.tablename);

  const manifest: {
    createdAt: string;
    database: string;
    migrations: unknown[];
    tables: Record<string, { rows: number; sha256: string }>;
    storage: boolean;
  } = { createdAt: new Date().toISOString(), database: new URL(url).pathname.slice(1), migrations: [], tables: {}, storage: false };

  try {
    manifest.migrations = (await pool.query("select id, hash, created_at from drizzle.__drizzle_migrations order by id")).rows;
  } catch {
    /* migrations table may not exist on a fresh database */
  }

  for (const t of tables) {
    const { rows } = await pool.query<{ data: unknown[] }>(
      `select coalesce(json_agg(t), '[]'::json) as data from "${t}" t`,
    );
    const json = JSON.stringify(rows[0].data);
    await writeFile(path.join(dir, "tables", `${t}.json`), json);
    manifest.tables[t] = { rows: rows[0].data.length, sha256: createHash("sha256").update(json).digest("hex") };
  }
  await pool.end();

  const storageDir = path.resolve(process.env.STORAGE_DIR ?? "./storage");
  if (existsSync(storageDir)) {
    await cp(storageDir, path.join(dir, "storage"), { recursive: true });
    manifest.storage = true;
  }
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const total = Object.values(manifest.tables).reduce((a, t) => a + t.rows, 0);
  console.log(`[backup] ${tables.length} tabelas, ${total} linhas${manifest.storage ? " + arquivos" : ""} -> ${dir}`);
  // Sanity check: manifest readable
  JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
}

main().catch((err) => {
  console.error("[backup] Falha:", err instanceof Error ? err.message : err);
  process.exit(1);
});
