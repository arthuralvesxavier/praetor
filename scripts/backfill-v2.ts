/**
 * v2 backfill (`npm run db:backfill:v2`): fills the history that records
 * created before v2 lack, for EVERY organization of DATABASE_URL. Idempotent
 * and additive (nothing is deleted or overwritten); running it again changes
 * nothing. See scripts/seed-data/v2/backfill.ts for the rules.
 */
import "dotenv/config";
import "./seed-data/env-setup";
import { sql } from "drizzle-orm";
import { closeDatabase, getDb } from "@/server/db/client";
import { backfillV2, totalsOf } from "./seed-data/v2/backfill";

function log(message: string) {
  console.log(`[backfill-v2] ${message}`);
}

async function main() {
  const db = getDb();
  await db.execute(sql`select 1`);
  const started = Date.now();
  const results = await backfillV2(db);
  for (const r of results) {
    log(
      `${r.name}: ${r.claimValuations} valor(es) da causa registrados no histórico, ` +
        `${r.riskAssessments} classificação(ões) de risco registradas, ${r.mirrorsUpdated} processo(s) com provisão/risco recalculados.`,
    );
  }
  const t = totalsOf(results);
  if (t.claimValuations + t.riskAssessments === 0) {
    log(`Nada a migrar em ${results.length} organização(ões): o histórico da v2 já está completo. Nada foi alterado.`);
  } else {
    log(
      `Total: ${t.claimValuations} valor(es) da causa e ${t.riskAssessments} classificação(ões) de risco ` +
        `em ${results.length} organização(ões), ${t.mirrorsUpdated} processo(s) recalculados.`,
    );
    if (t.withoutCreator > 0) {
      log(`${t.withoutCreator} registro(s) sem pessoa identificada no cadastro original (sem revisor).`);
    }
  }
  log(`Concluído em ${((Date.now() - started) / 1000).toFixed(1)} s.`);
}

main()
  .catch((err) => {
    // Never print driver messages (they may contain query parameters): name and code only.
    const e = err as { name?: string; code?: string; cause?: { code?: string } };
    console.error(`[backfill-v2] Falha: ${e?.name ?? "Erro"}${e?.code ?? e?.cause?.code ? ` (código ${e.code ?? e.cause?.code})` : ""}.`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
