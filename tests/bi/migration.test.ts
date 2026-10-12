/**
 * Migrations of the Power BI layer: the governed views exist in the "bi"
 * schema, expose no personal or document columns, and the down scripts
 * remove only what the migrations created.
 */
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BI_DB_ROLE,
  BI_PRIVILEGE_CHECK_SQL,
  biPrivilegeCheckSql,
  biPrivilegeProblems,
  biPrivilegeWarnings,
  biReaderMappingProblem,
  biReaderMappingSql,
  biRoleProblem,
  biSetupStatements,
  chooseBiOrganization,
  isBiReaderRole,
  suggestBiRoleName,
} from "@/modules/bi/setup-sql";
import type { Database } from "@/server/db/client";
import { biSettings, organizations } from "@/server/db/schema";
import { createTestDatabase } from "../helpers/db";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
}, 120_000);

afterAll(async () => {
  await close?.();
});

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

async function runScript(path: string) {
  const text = await readFile(path, "utf8");
  const statements = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

const PERSONAL_OR_CONTENT = /(^|_)(parte|partes|autor|reu|cpf|cnpj|documento|titulo|descricao|texto|trecho|motivo_valor|observacao|nome_parte)(_|$)/;

describe("bi schema migrations", () => {
  it("creates the governed views in the bi schema", async () => {
    const views = await rows<{ table_name: string }>(
      sql`select table_name from information_schema.views where table_schema = 'bi' order by table_name`,
    );
    expect(views.map((v) => v.table_name)).toEqual([
      "acesso",
      "atualizacao",
      "competencias",
      "pendencias",
      "processos",
      "rotulos",
      "valoracoes",
    ]);
  });

  it("exposes no party names, personal documents or document text", async () => {
    const cols = await rows<{ table_name: string; column_name: string }>(
      sql`select table_name, column_name from information_schema.columns where table_schema = 'bi'`,
    );
    expect(cols.length).toBeGreaterThan(40);
    const offending = cols.filter((c) => PERSONAL_OR_CONTENT.test(c.column_name));
    expect(offending).toEqual([]);
    const processos = cols.filter((c) => c.table_name === "processos").map((c) => c.column_name);
    for (const required of [
      "valor_da_causa",
      "valor_apurado",
      "garantias_vinculadas",
      "exposicao_apurada",
      "exposicao_estimada",
      "provisao_apurada",
      "provisao_estimada",
    ]) {
      expect(processos).toContain(required);
    }
    expect(processos).not.toContain("title");
  });

  it("documents that valor_apurado must not be added to valor_da_causa", async () => {
    const [c] = await rows<{ comment: string }>(
      sql`select col_description('bi.processos'::regclass, a.attnum) as comment
          from pg_attribute a where a.attrelid = 'bi.processos'::regclass and a.attname = 'valor_apurado'`,
    );
    expect(c.comment).toContain("Não somar com valor_da_causa");
    expect(c.comment).not.toMatch(/[\u2013\u2014]/);
  });

  it("the praetor_bi role (scripts/bi-setup.ts) reads only the bi schema, and only its organization", async () => {
    const [orgA, orgB] = await db
      .insert(organizations)
      .values([
        { name: "Organização Fictícia A", slug: "bi-mig-a" },
        { name: "Organização Fictícia B", slug: "bi-mig-b" },
      ])
      .returning({ id: organizations.id });
    await db.insert(biSettings).values([{ organizationId: orgA.id }, { organizationId: orgB.id }]);

    const [{ name }] = await rows<{ name: string }>(sql`select current_database() as name`);
    const statements = biSetupStatements({
      roleExists: false,
      passwordLiteral: `'${"senha'de-teste-123".replace(/'/g, "''")}'`,
      databaseIdent: `"${name.replace(/"/g, '""')}"`,
      organizationLiteral: `'${orgA.id}'`,
    });
    expect(statements.join("\n")).not.toMatch(/GRANT [^\n]* ON SCHEMA public/);
    for (const statement of statements) await db.execute(sql.raw(statement));
    // Idempotent: running again with ALTER ROLE works.
    const again = biSetupStatements({
      roleExists: true,
      passwordLiteral: "'outra-senha-123'",
      databaseIdent: `"${name}"`,
      organizationLiteral: `'${orgA.id}'`,
    });
    for (const statement of again) await db.execute(sql.raw(statement));

    // The owner (Praetor itself) sees every organization.
    const all = await rows<{ organization_id: string }>(sql`select organization_id from bi.atualizacao`);
    expect(all.map((r) => r.organization_id).sort()).toEqual([orgA.id, orgB.id].sort());

    const asReader = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => {
      await db.execute(sql.raw(`SET ROLE ${BI_DB_ROLE}`));
      try {
        return await rows<T>(q);
      } finally {
        await db.execute(sql.raw("RESET ROLE"));
      }
    };
    const scoped = await asReader<{ organization_id: string }>(sql`select organization_id from bi.atualizacao`);
    expect(scoped.map((r) => r.organization_id)).toEqual([orgA.id]);
    expect((await asReader<{ n: number }>(sql`select count(*)::int as n from bi.processos`))[0].n).toBe(0);

    await db.execute(sql.raw(`SET ROLE ${BI_DB_ROLE}`));
    try {
      await expect(db.execute(sql`select count(*) from public.legal_processes`)).rejects.toThrow();
      await expect(db.execute(sql`select count(*) from public.bi_process_access`)).rejects.toThrow();
      await expect(db.execute(sql`select count(*) from public.bi_reader_roles`)).rejects.toThrow();
      await expect(db.execute(sql`delete from public.bi_settings`)).rejects.toThrow();
    } finally {
      await db.execute(sql.raw("RESET ROLE"));
    }

    // Without a registered organization the role reads nothing (fails closed).
    await db.execute(sql`delete from public.bi_reader_roles where role_name = ${BI_DB_ROLE}`);
    expect(await asReader(sql`select organization_id from bi.atualizacao`)).toEqual([]);
  });

  it("refuses a setup where praetor_bi could create objects (PostgreSQL before 15)", async () => {
    type Check = {
      server_version_num: number;
      can_create_in_public: boolean;
      can_create_schema: boolean;
      can_read_tables: boolean;
      can_create_temp: boolean;
    };
    const [ok] = await rows<Check>(sql.raw(BI_PRIVILEGE_CHECK_SQL));
    expect(ok.can_create_in_public).toBe(false);
    expect(ok.can_create_schema).toBe(false);
    expect(ok.can_read_tables).toBe(false);
    expect(
      biPrivilegeProblems({
        serverVersionNum: Number(ok.server_version_num),
        canCreateInPublic: false,
        canCreateSchema: false,
        canReadTables: false,
      }),
    ).toEqual([]);
    // TEMPORARY is granted to PUBLIC by default: only a warning (the views are security barriers).
    expect(ok.can_create_temp).toBe(true);
    const warnings = biPrivilegeWarnings({ canCreateTemp: ok.can_create_temp });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("REVOKE TEMPORARY ON DATABASE");
    expect(warnings.join(" ")).not.toMatch(/[\u2013\u2014]/);

    // SELECT on the system tables would make the views return every organization.
    await db.execute(sql.raw("GRANT SELECT ON public.legal_processes TO PUBLIC"));
    try {
      const [reads] = await rows<Check>(sql.raw(BI_PRIVILEGE_CHECK_SQL));
      expect(reads.can_read_tables).toBe(true);
      const problems = biPrivilegeProblems({
        serverVersionNum: 170000,
        canCreateInPublic: false,
        canCreateSchema: false,
        canReadTables: true,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("todas as organizações");
    } finally {
      await db.execute(sql.raw("REVOKE SELECT ON public.legal_processes FROM PUBLIC"));
    }

    // What PUBLIC has by default before PostgreSQL 15.
    await db.execute(sql.raw("GRANT CREATE ON SCHEMA public TO PUBLIC"));
    try {
      const [bad] = await rows<Check>(sql.raw(BI_PRIVILEGE_CHECK_SQL));
      expect(bad.can_create_in_public).toBe(true);
      const problems = biPrivilegeProblems({
        serverVersionNum: 140000,
        canCreateInPublic: true,
        canCreateSchema: false,
        canReadTables: false,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      expect(problems[0]).toContain("anterior à 15");
      expect(problems.join(" ")).not.toMatch(/[\u2013\u2014]/);
    } finally {
      await db.execute(sql.raw("REVOKE CREATE ON SCHEMA public FROM PUBLIC"));
    }
  });

  it("chooses the organization of the read-only role", () => {
    const a = { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "A" };
    const b = { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "B" };
    expect(chooseBiOrganization([a], null)).toEqual({ ok: true, id: a.id });
    expect(chooseBiOrganization([a, b], b.id.toUpperCase())).toEqual({ ok: true, id: b.id });
    const many = chooseBiOrganization([a, b], null);
    expect(many.ok).toBe(false);
    expect(!many.ok && many.message).toContain("--org=");
    expect(chooseBiOrganization([], null).ok).toBe(false);
    expect(chooseBiOrganization([a], b.id).ok).toBe(false);
    expect(!many.ok && many.message).toContain("--role=");
  });

  it("validates reader role names and never targets the Praetor user or a superuser", () => {
    expect(isBiReaderRole("praetor_bi")).toBe(true);
    expect(isBiReaderRole("praetor_bi_aurora_2")).toBe(true);
    for (const bad of ["postgres", "praetor", "praetor_bi_", "praetor_bi_Aurora", "praetor_bi;drop", 'praetor_bi_"x"', `praetor_bi_${"x".repeat(60)}`]) {
      expect(isBiReaderRole(bad), bad).toBe(false);
    }
    expect(suggestBiRoleName("Outra Organização S/A")).toBe("praetor_bi_outra_organizacao_s_a");
    expect(isBiReaderRole(suggestBiRoleName("x".repeat(200)))).toBe(true);
    expect(isBiReaderRole(suggestBiRoleName("---"))).toBe(true);
    expect(() => biSetupStatements({ role: "postgres", roleExists: true, passwordLiteral: "'x'", databaseIdent: '"d"', organizationLiteral: "'o'" })).toThrow();
    expect(() => biPrivilegeCheckSql("x'; drop table y; --")).toThrow();

    expect(biRoleProblem({ role: "postgres", currentUser: "app", existing: null })).toContain("inválido");
    expect(biRoleProblem({ role: "praetor_bi", currentUser: "praetor_bi", existing: { isSuperuser: false } })).toContain("mesmo");
    expect(biRoleProblem({ role: "praetor_bi_x", currentUser: "app", existing: { isSuperuser: true } })).toContain("superusuário");
    expect(biRoleProblem({ role: "praetor_bi", currentUser: "app", existing: { isSuperuser: false } })).toBeNull();
    expect(biRoleProblem({ role: "praetor_bi", currentUser: "app", existing: null })).toBeNull();
  });

  it("a reader role serves one organization: moving it requires --reassign", async () => {
    const [orgA, orgB] = await db
      .insert(organizations)
      .values([
        { name: "Organização Fictícia C", slug: "bi-map-c" },
        { name: "Organização Fictícia D", slug: "bi-map-d" },
      ])
      .returning({ id: organizations.id });
    const orgs = [
      { id: orgA.id, name: "Organização Fictícia C", slug: "bi-map-c" },
      { id: orgB.id, name: "Organização Fictícia D", slug: "bi-map-d" },
    ];
    const role = "praetor_bi_map";
    const [{ name }] = await rows<{ name: string }>(sql`select current_database() as name`);
    const run = async (organizationId: string, opts: { roleExists: boolean; reassign?: boolean }) => {
      for (const statement of biSetupStatements({
        role,
        roleExists: opts.roleExists,
        passwordLiteral: "'senha-de-teste-123'",
        databaseIdent: `"${name}"`,
        organizationLiteral: `'${organizationId}'`,
        reassign: opts.reassign,
      })) {
        await db.execute(sql.raw(statement));
      }
    };
    const mapped = async () => (await rows<{ organization_id: string }>(sql.raw(biReaderMappingSql(role))))[0]?.organization_id ?? null;

    expect(biReaderMappingProblem({ role, currentOrganizationId: null, requestedOrganizationId: orgA.id, reassign: false, organizations: orgs })).toBeNull();
    await run(orgA.id, { roleExists: false });
    expect(await mapped()).toBe(orgA.id);
    // Same organization again: fine (idempotent).
    expect(biReaderMappingProblem({ role, currentOrganizationId: orgA.id, requestedOrganizationId: orgA.id.toUpperCase(), reassign: false, organizations: orgs })).toBeNull();

    // Another organization without --reassign: refused before, and the statements alone never move it.
    const problem = biReaderMappingProblem({ role, currentOrganizationId: orgA.id, requestedOrganizationId: orgB.id, reassign: false, organizations: orgs });
    expect(problem).toContain("Organização Fictícia C");
    expect(problem).toContain("--role=praetor_bi_bi_map_d");
    expect(problem).toContain("--reassign");
    expect(problem).not.toMatch(/[\u2013\u2014]/);
    await run(orgB.id, { roleExists: true });
    expect(await mapped()).toBe(orgA.id);

    // Explicit --reassign moves it.
    expect(biReaderMappingProblem({ role, currentOrganizationId: orgA.id, requestedOrganizationId: orgB.id, reassign: true, organizations: orgs })).toBeNull();
    await run(orgB.id, { roleExists: true, reassign: true });
    expect(await mapped()).toBe(orgB.id);

    await db.execute(sql.raw(`delete from public.bi_reader_roles where role_name = '${role}'`));
    await db.execute(sql.raw(`DROP OWNED BY ${role}`));
    await db.execute(sql.raw(`DROP ROLE ${role}`));
  });

  it("down scripts drop only the BI objects", async () => {
    const barriers = async () =>
      rows<{ n: number }>(
        sql`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'bi' and c.relkind = 'v' and 'security_barrier=true' = any(c.reloptions)`,
      );
    expect((await barriers())[0].n).toBe(7);
    await runScript("drizzle/down/0011_bi_views_security_barrier.sql");
    expect((await barriers())[0].n).toBe(0);
    await runScript("drizzle/down/0006_bi_reporting_views_v2.sql");
    // Back to the 0004 views: no organization scope, counts in bi.atualizacao.
    const restored = await rows<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_schema = 'bi' and table_name = 'atualizacao'`,
    );
    expect(restored.map((c) => c.column_name)).toContain("usuarios");
    const deps = await rows<{ n: number }>(
      sql`select count(*)::int as n from information_schema.view_table_usage where view_schema = 'bi' and table_name = 'bi_reader_roles'`,
    );
    expect(deps[0].n).toBe(0);
    await runScript("drizzle/down/0005_bi_access_scope.sql");
    const scopeTable = await rows<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'bi_reader_roles'`,
    );
    expect(scopeTable[0].n).toBe(0);
    const changedCol = await rows<{ n: number }>(
      sql`select count(*)::int as n from information_schema.columns where table_name = 'bi_settings' and column_name = 'access_changed_at'`,
    );
    expect(changedCol[0].n).toBe(0);
    await runScript("drizzle/down/0004_bi_reporting_views.sql");
    const afterViews = await rows<{ n: number }>(sql`select count(*)::int as n from information_schema.schemata where schema_name = 'bi'`);
    expect(afterViews[0].n).toBe(0);
    await runScript("drizzle/down/0003_bi_tables.sql");
    const tables = await rows<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'bi\\_%'`,
    );
    expect(tables).toEqual([]);
    const kept = await rows<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('legal_processes', 'process_valuations', 'portfolio_snapshot_items')`,
    );
    expect(kept[0].n).toBe(3);
  });
});
