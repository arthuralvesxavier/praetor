/**
 * Prepara o banco para o Power BI (docs/POWER_BI.md), de forma idempotente:
 *
 *   1. cria (ou atualiza a senha de) um usuário somente leitura (`praetor_bi` por
 *      padrão), com acesso APENAS ao schema `bi` (views da camada governada) e às
 *      linhas de UMA organização (registrada em `bi_reader_roles`);
 *   2. confere que o usuário não consegue criar objetos (o PostgreSQL anterior à 15
 *      dá essa permissão a todos no schema public) nem ler as tabelas do sistema e,
 *      se conseguir, desfaz tudo;
 *   3. copia os rótulos pt-BR para `bi_labels` e recalcula a tabela de acessos
 *      (`bi.acesso`) de todas as organizações.
 *
 * Uso (desenvolvimento ou instalação própria, com o usuário dono do banco):
 *
 *   BI_DB_PASSWORD='senha-forte' npx tsx scripts/bi-setup.ts
 *
 * Banco com várias organizações: um usuário de leitura por organização.
 *
 *   BI_DB_PASSWORD='senha-a' npx tsx scripts/bi-setup.ts --org=<id da organização A>
 *   BI_DB_PASSWORD='senha-b' npx tsx scripts/bi-setup.ts --org=<id da organização B> --role=praetor_bi_<nome curto>
 *
 * O script recusa mover um usuário que já lê uma organização para outra (o conjunto
 * de dados do Power BI que usa esse usuário passaria a importar a outra carteira).
 * Para mover de propósito: --reassign.
 *
 * Em bancos gerenciados (RDS, Azure Database, Cloud SQL...), o passo 1 pode exigir
 * o administrador do banco: ele pode executar os comandos impressos com --print.
 *
 *   npx tsx scripts/bi-setup.ts --print     -> só mostra os comandos (senha mascarada)
 *
 * Pré-requisito: migrações aplicadas (npm run db:migrate). Rode de novo (para cada
 * usuário de leitura) depois de atualizar o Praetor: views recriadas por uma
 * migração recebem a permissão de novo.
 */
import "dotenv/config";
import { Client } from "pg";
import { refreshBiAccess } from "@/modules/bi/access";
import { syncBiLabels } from "@/modules/bi/labels";
import {
  BI_DB_ROLE,
  biPrivilegeCheckSql,
  biPrivilegeProblems,
  biPrivilegeWarnings,
  biReaderMappingProblem,
  biReaderMappingSql,
  biRoleProblem,
  biSetupStatements,
  chooseBiOrganization,
} from "@/modules/bi/setup-sql";
import { closeDatabase, getDb } from "@/server/db/client";
import { organizations } from "@/server/db/schema";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/praetor";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() || null : null;
}

type PrivilegeRow = {
  server_version_num: number | string;
  can_create_in_public: boolean;
  can_create_schema: boolean;
  can_read_tables: boolean;
  can_create_temp: boolean;
};

function fail(message: string): never {
  console.error(`[bi-setup] ${message}`);
  process.exit(1);
}

async function main() {
  const printOnly = process.argv.includes("--print");
  const reassign = process.argv.includes("--reassign");
  const role = argValue("role") ?? BI_DB_ROLE;
  const password = process.env.BI_DB_PASSWORD ?? "";
  if (!printOnly && password.length < 12) {
    fail(`Defina BI_DB_PASSWORD com pelo menos 12 caracteres (senha do usuário ${role}).`);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  let warnings: string[] = [];
  try {
    const ready = await client.query<{ ok: boolean }>(
      "select exists (select 1 from information_schema.schemata where schema_name = 'bi') and to_regclass('public.bi_reader_roles') is not null as ok",
    );
    if (!ready.rows[0]?.ok) fail("O schema bi (ou a tabela bi_reader_roles) não existe. Rode npm run db:migrate antes.");

    const orgRows = await client.query<{ id: string; name: string; slug: string }>(
      "select id::text as id, name, slug from organizations order by name",
    );
    const org = chooseBiOrganization(orgRows.rows, argValue("org"));
    if (!org.ok) fail(org.message);

    const who = await client.query<{ me: string; database: string }>(
      "select current_user::text as me, current_database()::text as database",
    );
    const existing = await client.query<{ rolsuper: boolean }>("select rolsuper from pg_roles where rolname = $1", [role]);
    const roleProblem = biRoleProblem({
      role,
      currentUser: who.rows[0].me,
      existing: existing.rows[0] ? { isSuperuser: existing.rows[0].rolsuper } : null,
    });
    if (roleProblem) fail(roleProblem);

    const mapped = await client.query<{ organization_id: string }>(biReaderMappingSql(role));
    const mappingProblem = biReaderMappingProblem({
      role,
      currentOrganizationId: mapped.rows[0]?.organization_id ?? null,
      requestedOrganizationId: org.id,
      reassign,
      organizations: orgRows.rows,
    });
    if (mappingProblem) fail(mappingProblem);

    const statements = biSetupStatements({
      role,
      roleExists: existing.rows.length > 0,
      passwordLiteral: printOnly ? "'<senha>'" : client.escapeLiteral(password),
      databaseIdent: client.escapeIdentifier(who.rows[0].database),
      organizationLiteral: client.escapeLiteral(org.id),
      reassign,
    });

    if (printOnly) {
      console.log(statements.map((s) => `${s};`).join("\n"));
      console.log(`-- Em seguida confira: a consulta abaixo deve devolver ${org.id}.`);
      console.log(`${biReaderMappingSql(role)};`);
      console.log("-- E: can_create_in_public, can_create_schema e can_read_tables devem ser false.");
      console.log("-- can_create_temp = true é aceitável (veja docs/POWER_BI.md, seção 5).");
      console.log(`${biPrivilegeCheckSql(role)};`);
      return;
    }

    await client.query("begin");
    try {
      for (const statement of statements) await client.query(statement);
      const after = await client.query<{ organization_id: string }>(biReaderMappingSql(role));
      if (after.rows[0]?.organization_id?.toLowerCase() !== org.id.toLowerCase()) {
        await client.query("rollback");
        fail(
          `O usuário ${role} passou a ler outra organização durante o bi-setup (outra execução simultânea?). Nada foi alterado. ` +
            "Rode de novo.",
        );
      }
      const check = await client.query<PrivilegeRow>(biPrivilegeCheckSql(role));
      const row = check.rows[0];
      const problems = biPrivilegeProblems(
        {
          serverVersionNum: Number(row.server_version_num),
          canCreateInPublic: row.can_create_in_public,
          canCreateSchema: row.can_create_schema,
          canReadTables: row.can_read_tables,
        },
        role,
      );
      if (problems.length > 0) {
        await client.query("rollback");
        for (const problem of problems) console.error(`[bi-setup] ${problem}`);
        fail(`Nada foi alterado: o usuário ${role} não foi criado nem atualizado.`);
      }
      warnings = biPrivilegeWarnings({ canCreateTemp: row.can_create_temp }, role);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    }
    const orgName = orgRows.rows.find((o) => o.id === org.id)?.name ?? org.id;
    console.log(`[bi-setup] Usuário ${role} pronto: leitura somente do schema bi, organização ${orgName}.`);
    for (const warning of warnings) console.warn(`[bi-setup] Aviso: ${warning}`);
  } finally {
    await client.end();
  }

  const labels = await syncBiLabels();
  const orgs = await getDb().select({ id: organizations.id, name: organizations.name }).from(organizations);
  for (const org of orgs) {
    const r = await refreshBiAccess(org.id);
    console.log(`[bi-setup] ${org.name}: ${r.users} usuário(s) ativo(s), ${r.rows} vínculo(s) em bi.acesso.`);
  }
  console.log(`[bi-setup] ${labels} rótulo(s) sincronizado(s). Conexão do Power BI Desktop: banco PostgreSQL, usuário ${role}.`);
  await closeDatabase();
}

main().catch(async (err: unknown) => {
  // Never print the error message: driver errors can echo the statement (with the password).
  const e = err as { name?: string; code?: string };
  console.error(`[bi-setup] Falha (${e?.name ?? "erro"}${e?.code ? ` ${e.code}` : ""}).`);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
