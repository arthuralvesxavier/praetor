/**
 * Reverte a ÚLTIMA migração aplicada usando o script drizzle/down/<tag>.sql.
 *
 *   npm run db:rollback -- 0012_phase_instance_split --yes
 *
 * Roda o script de reversão e remove a linha da migração de drizzle.__drizzle_migrations numa
 * única transação. Recusa quando a migração não está aplicada ou quando há migração aplicada
 * depois dela. Faça um backup antes (npm run db:backup). Depois, `npm run db:migrate` reaplica.
 */
import "dotenv/config";
import { Pool } from "pg";
import { loadRollbackPlan, rollbackMigration, RollbackError } from "@/server/db/migrations";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/praetor";

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => !a.startsWith("--"));
  if (!tag || !args.includes("--yes")) {
    console.error("Uso: npm run db:rollback -- <tag-da-migração> --yes   (ex.: 0012_phase_instance_split)");
    console.error("Reverte a última migração aplicada com drizzle/down/<tag>.sql. Faça um backup antes (npm run db:backup).");
    process.exit(2);
  }
  const plan = await loadRollbackPlan(tag);
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await rollbackMigration(
      {
        exec: (sql) => client.query(sql),
        query: async <T>(sql: string, params?: unknown[]) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as T[] };
        },
      },
      plan,
    );
    console.log(`[rollback] Migração ${plan.tag} revertida (${plan.downPath}). "npm run db:migrate" a reaplica.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  if (err instanceof RollbackError) {
    console.error(`[rollback] ${err.message}`);
    process.exit(1);
  }
  // Database errors can carry query parameters: log only the name and code.
  const code = (err as { code?: unknown })?.code;
  console.error(`[rollback] Falha: ${(err as Error)?.name ?? "Error"}${code ? ` (código ${String(code)})` : ""}. Nada foi alterado.`);
  process.exit(1);
});
