import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/db";
import type { Database } from "@/server/db/client";
import { DEFAULT_ORGANIZATION_SETTINGS, organizations } from "@/server/db/schema";

/**
 * Migração 0008 (relatórios jurídicos): aplica no PGlite com as anteriores, os
 * gatilhos de imutabilidade funcionam e a reversão (drizzle/down) remove só o
 * que a migração criou.
 */
let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

describe("migração 0008_legal_reports", () => {
  it("cria as tabelas e o padrão de settings com o bloco legalReports", async () => {
    const tables = await rows<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public' and tablename in ('legal_reports','legal_report_items','legal_report_sources','legal_report_sequences','process_scenarios') order by tablename`,
    );
    expect(tables.map((t) => t.tablename)).toEqual([
      "legal_report_items",
      "legal_report_sequences",
      "legal_report_sources",
      "legal_reports",
      "process_scenarios",
    ]);
    const [org] = await db.insert(organizations).values({ name: "Org migração", slug: "mig-lr" }).returning();
    const [row] = await rows<{ settings: typeof DEFAULT_ORGANIZATION_SETTINGS }>(
      sql`select settings from organizations where id = ${org.id}`,
    );
    expect(row.settings.legalReports).toEqual(DEFAULT_ORGANIZATION_SETTINGS.legalReports);
  });

  it("a reversão remove tabelas, gatilhos e funções e devolve o padrão anterior", async () => {
    const down = readFileSync(path.resolve(process.cwd(), "drizzle/down/0008_legal_reports.sql"), "utf8");
    const statements = down
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(5);
    for (const statement of statements) await db.execute(sql.raw(statement));
    const left = await rows<{ n: number }>(
      sql`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename in ('legal_reports','legal_report_items','legal_report_sources','legal_report_sequences','process_scenarios')`,
    );
    expect(left[0].n).toBe(0);
    const fns = await rows<{ n: number }>(
      sql`select count(*)::int as n from pg_proc where proname in ('legal_reports_guard','legal_reports_append_only')`,
    );
    expect(fns[0].n).toBe(0);
    const [def] = await rows<{ d: string }>(
      sql`select column_default as d from information_schema.columns where table_name = 'organizations' and column_name = 'settings'`,
    );
    expect(def.d).not.toContain("legalReports");
    expect(def.d).toContain("defaultCorrectionIndex");
    // Organizações existentes continuam intactas.
    const orgs = await rows<{ n: number }>(sql`select count(*)::int as n from organizations`);
    expect(orgs[0].n).toBeGreaterThan(0);
  });
});
