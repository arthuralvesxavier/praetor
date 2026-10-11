/**
 * Restores a backup produced by scripts/db-backup.ts.
 *
 *   npm run db:restore -- .data/backups/<dir> --yes
 *
 * DESTRUCTIVE: truncates every table present in the backup and reloads its
 * rows; replaces STORAGE_DIR with the backed-up files. The target database
 * must have the same or a newer schema (apply migrations first): columns added
 * after the backup are filled with their defaults/NULL.
 */
import "dotenv/config";
import { cp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/praetor";

async function main() {
  const dirArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!dirArg || !process.argv.includes("--yes")) {
    console.error("Uso: npm run db:restore -- <pasta-do-backup> --yes   (apaga os dados atuais)");
    process.exit(2);
  }
  const dir = path.resolve(dirArg);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
    tables: Record<string, { rows: number }>;
    storage: boolean;
  };

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const existing = new Set(
      (await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public'")).rows.map(
        (r) => r.tablename,
      ),
    );
    const tables = Object.keys(manifest.tables).filter((t) => existing.has(t));

    // FK dependency order: parents before children.
    const deps = (
      await client.query<{ child: string; parent: string }>(`
        select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
        from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace`)
    ).rows.map((r) => ({ child: r.child.replace(/"/g, ""), parent: r.parent.replace(/"/g, "") }));
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const visit = (t: string) => {
      if (ordered.includes(t) || visiting.has(t)) return;
      visiting.add(t);
      for (const d of deps) if (d.child === t && d.parent !== t && tables.includes(d.parent)) visit(d.parent);
      visiting.delete(t);
      ordered.push(t);
    };
    tables.forEach(visit);

    await client.query("begin");
    await client.query(`truncate ${ordered.map((t) => `"${t}"`).join(", ")} cascade`);
    for (const t of ordered) {
      const json = await readFile(path.join(dir, "tables", `${t}.json`), "utf8");
      if (json === "[]") continue;
      await client.query(`insert into "${t}" select * from json_populate_recordset(null::"${t}", $1::json)`, [json]);
    }
    await client.query("commit");
    console.log(`[restore] ${ordered.length} tabelas restauradas de ${dir}`);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  if (manifest.storage && existsSync(path.join(dir, "storage"))) {
    const storageDir = path.resolve(process.env.STORAGE_DIR ?? "./storage");
    await rm(storageDir, { recursive: true, force: true });
    await cp(path.join(dir, "storage"), storageDir, { recursive: true });
    console.log(`[restore] arquivos restaurados em ${storageDir}`);
  }
}

main().catch((err) => {
  console.error("[restore] Falha:", err instanceof Error ? err.message : err);
  process.exit(1);
});
