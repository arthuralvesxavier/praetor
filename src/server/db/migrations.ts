/**
 * Reversão de uma migração (`npm run db:rollback -- <tag> --yes`, scripts/db-rollback.ts).
 *
 * Cada migração reversível tem o script `drizzle/down/<tag>.sql`. A reversão:
 *   1. confere que a migração está aplicada e que ela é a ÚLTIMA aplicada (reverter fora de
 *      ordem deixaria o banco num estado que nenhuma versão do código conhece);
 *   2. roda o script de reversão e remove a linha da migração de `drizzle.__drizzle_migrations`,
 *      tudo numa única transação (ou tudo, ou nada);
 *   3. depois disso, `npm run db:migrate` reaplica a migração.
 *
 * Sem dependência de driver: recebe um `SqlRunner` (node-postgres no script, PGlite nos testes).
 * Não importa `next/*` nem o ambiente da aplicação.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MIGRATIONS_SCHEMA = "drizzle";
export const MIGRATIONS_TABLE = "__drizzle_migrations";

export type JournalEntry = { idx: number; tag: string; when: number };

export type RollbackPlan = {
  tag: string;
  /** `when` do journal = `created_at` da linha em drizzle.__drizzle_migrations. */
  when: number;
  downPath: string;
  downSql: string;
};

/** Executor mínimo: `exec` roda um ou mais comandos sem parâmetros; `query` roda um comando com parâmetros. */
export type SqlRunner = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export class RollbackError extends Error {}

const TAG_RE = /^\d{4}_[a-z0-9_]+$/;

/** Lê o journal e o script de reversão da migração `tag` (pasta `migrationsFolder`, padrão ./drizzle). */
export async function loadRollbackPlan(tag: string, migrationsFolder = "drizzle"): Promise<RollbackPlan> {
  if (!TAG_RE.test(tag)) throw new RollbackError(`Nome de migração inválido: "${tag}" (ex.: 0012_phase_instance_split).`);
  const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  const entry = journal.entries.find((e) => e.tag === tag);
  if (!entry) throw new RollbackError(`Migração "${tag}" não existe em ${migrationsFolder}/meta/_journal.json.`);
  const downPath = path.join(migrationsFolder, "down", `${tag}.sql`);
  let downSql: string;
  try {
    downSql = await readFile(downPath, "utf8");
  } catch {
    throw new RollbackError(`A migração "${tag}" não tem script de reversão (${downPath}).`);
  }
  if (!downSql.trim()) throw new RollbackError(`O script de reversão ${downPath} está vazio.`);
  return { tag, when: entry.when, downPath, downSql };
}

/**
 * Reverte a migração do plano numa transação. Recusa (RollbackError) quando ela não está
 * aplicada ou quando há migração aplicada depois dela.
 */
export async function rollbackMigration(runner: SqlRunner, plan: RollbackPlan): Promise<void> {
  const table = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;
  await runner.exec("BEGIN");
  try {
    const { rows } = await runner.query<{ created_at: string | number | null }>(
      `select created_at from ${table} order by created_at desc`,
    );
    const applied = rows.map((r) => Number(r.created_at));
    if (!applied.includes(plan.when)) {
      throw new RollbackError(`A migração "${plan.tag}" não está aplicada neste banco: nada a reverter.`);
    }
    const later = applied.filter((w) => w > plan.when).length;
    if (later > 0) {
      throw new RollbackError(
        `Há ${later} migração(ões) aplicada(s) depois de "${plan.tag}": reverta-as antes, da mais recente para a mais antiga.`,
      );
    }
    await runner.exec(plan.downSql);
    await runner.query(`delete from ${table} where created_at = $1`, [plan.when]);
    await runner.exec("COMMIT");
  } catch (err) {
    await runner.exec("ROLLBACK");
    throw err;
  }
}
