import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRollbackPlan, rollbackMigration, RollbackError, type JournalEntry, type SqlRunner } from "@/server/db/migrations";

/**
 * P0.5 — migração 0012_phase_instance_split (fase e instância separadas) e sua reversão.
 * Banco PGlite migrado ATÉ 0011, dados no modelo antigo, aplica 0012 pelo migrador do drizzle,
 * confere o resultado, reverte com drizzle/down (o mesmo código do `npm run db:rollback`) e
 * confere que os valores originais voltaram. Competências fechadas nunca são tocadas (RN-10).
 */
const TAG = "0012_phase_instance_split";

let client: PGlite;
let partialFolder: string;
const ids: Record<string, string> = {};
let orgId = "";
let snapshotItemId = "";
const analysisIds: Record<string, string> = {};

const runner: SqlRunner = {
  exec: (sql) => client.exec(sql),
  query: async <T>(sql: string, params?: unknown[]) => {
    const res = await client.query<T>(sql, params);
    return { rows: res.rows };
  },
};

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await client.query<T>(sql, params);
  return res.rows[0];
}

async function processRow(key: string) {
  return one<Record<string, unknown>>(`select * from legal_processes where id = $1`, [ids[key]]);
}

/** Tags applied after `tag`, newest first (they are reverted before it: the rollback refuses otherwise). */
async function tagsAfter(tag: string): Promise<string[]> {
  const journal = JSON.parse(await readFile(path.join("drizzle", "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  return journal.entries.slice(at + 1).map((e) => e.tag).reverse();
}

/** Copy of ./drizzle with the journal cut BEFORE `TAG` (the database "before the deploy"). */
async function folderBefore(tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "praetor-mig-"));
  await mkdir(path.join(dir, "meta"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as { entries: JournalEntry[] };
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  const entries = journal.entries.slice(0, cut);
  await writeFile(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) await copyFile(path.join("drizzle", `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

async function insertProcess(key: string, values: Record<string, unknown>) {
  const row = {
    organization_id: orgId,
    number: `00000${10 + Object.keys(ids).length}-00.2025.5.10.0000`,
    title: `Processo ${key} (dados fictícios)`,
    court: "TRT10",
    area: "labor",
    status: "active",
    ...values,
  };
  const cols = Object.keys(row);
  const res = await client.query<{ id: string }>(
    `insert into legal_processes (${cols.map((c) => `"${c}"`).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  ids[key] = res.rows[0].id;
}

async function insertInstance(key: string, instance: string, phase: string | null, isCurrent = false) {
  await client.query(
    `insert into process_instances (organization_id, process_id, instance, court, phase, is_current) values ($1, $2, $3, 'TRT10', $4, $5)`,
    [orgId, ids[key], instance, phase, isCurrent],
  );
}

beforeAll(async () => {
  client = new PGlite();
  partialFolder = await folderBefore(TAG);
  await migrate(drizzle(client), { migrationsFolder: partialFolder });

  orgId = (await one<{ id: string }>(`insert into organizations (name, slug) values ('Org migração fase', 'mig-fase') returning id`)).id;

  // Recursal sem instância, com vínculos de 1º e 3º grau → instância 3º grau (a mais alta), sem verificação.
  await insertProcess("appealLinked", { phase: "appeal", instance: null, phase_detail: "Conhecimento (AIRR) — em tramitação no TST" });
  await insertInstance("appealLinked", "first", "knowledge");
  await insertInstance("appealLinked", "superior", "appeal", true);
  // Recursal sem instância e sem vínculo recursal → 2º grau + verificação.
  await insertProcess("appealBare", { phase: "appeal", instance: null });
  // Recursal com instância já informada (2º grau) → instância mantida, sem verificação.
  await insertProcess("appealSecond", { phase: "appeal", instance: "second" });
  // Acordo em andamento → conhecimento + verificação (marcação ligada pela migração).
  await insertProcess("settlement", { phase: "settlement", instance: "first" });
  // Pré-ajuizamento já marcado para verificação com nota → nota acrescida, marcação mantida.
  await insertProcess("preFiling", { phase: "pre_filing", needs_verification: true, verification_note: "Nota anterior da equipe" });
  // Encerrado (fase antiga) com texto da fonte "Execução — ARQUIVADO" → fase execução; situação intocada.
  await insertProcess("closed", {
    phase: "closed",
    status: "closed",
    closure_reason: "archived",
    closed_at: "2026-07-18",
    instance: "first",
    phase_detail: "Execução — ARQUIVADO def. 2026-07-18",
  });
  // Encerrado (fase antiga) com situação ATIVA: contradição do modelo anterior → conhecimento + verificação.
  await insertProcess("closedActive", { phase: "closed", status: "active", instance: "first" });
  // Encerrado (fase antiga) com situação suspensa → também marcado; arquivado não (situação coerente).
  await insertProcess("closedSuspended", { phase: "closed", status: "suspended", instance: "first" });
  await insertProcess("closedArchived", { phase: "closed", status: "archived", instance: "first" });
  // Já no modelo novo → intocado.
  await insertProcess("untouched", { phase: "liquidation", instance: "first" });
  // Processo no modelo novo com vínculo de instância em fase antiga → só o vínculo migra.
  await insertProcess("linkOnly", { phase: "knowledge", instance: "second" });
  await insertInstance("linkOnly", "second", "appeal", true);

  // Competência FECHADA com item em fase antiga: imutável (RN-10).
  const snap = await one<{ id: string }>(
    `insert into portfolio_snapshots (organization_id, period, reference_date, status, metrics, params, closed_at)
     values ($1, '2026-06', '2026-06-30', 'closed', '{"byPhase":{"appeal":{"count":1}}}'::jsonb, '{}'::jsonb, now()) returning id`,
    [orgId],
  );
  snapshotItemId = (
    await one<{ id: string }>(
      `insert into portfolio_snapshot_items (organization_id, snapshot_id, process_id, number, instance, phase)
       values ($1, $2, $3, '0000010-00.2025.5.10.0000', null, 'appeal') returning id`,
      [orgId, snap.id, ids.appealBare],
    )
  ).id;

  // Análises de IA concluídas: uma usa um processo convertido como fonte, outra só um processo intocado.
  for (const [key, source] of [
    ["migrated", "appealBare"],
    ["unrelated", "untouched"],
  ] as const) {
    analysisIds[key] = (
      await one<{ id: string }>(
        `insert into ai_analyses (organization_id, type, subject_type, subject_id, status, mode, provider, model, prompt_version, input_hash)
         values ($1, 'summary', 'legal_process', $2, 'succeeded', 'demo', 'demo', 'demo', 'v1', $3) returning id`,
        [orgId, ids[source], `hash-${key}`],
      )
    ).id;
    await client.query(
      `insert into ai_analysis_sources (organization_id, analysis_id, ref, source_type, entity_id, label, content_hash)
       values ($1, $2, 'S1', 'legal_process', $3, 'Processo', 'h')`,
      [orgId, analysisIds[key], ids[source]],
    );
  }

  // Deploy: aplica as migrações pendentes (só a 0012) pelo migrador do drizzle.
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (partialFolder) await rm(partialFolder, { recursive: true, force: true });
});

describe("migração 0012_phase_instance_split", () => {
  it("leva toda fase antiga para as três fases e guarda a anterior em legacy_phase", async () => {
    const phases = await client.query<{ phase: string }>(`select distinct phase from legal_processes order by phase`);
    expect(phases.rows.map((r) => r.phase).every((p) => ["knowledge", "liquidation", "enforcement"].includes(p))).toBe(true);
    const links = await client.query<{ phase: string | null; legacy_phase: string | null }>(
      `select phase, legacy_phase from process_instances where process_id = $1`,
      [ids.linkOnly],
    );
    expect(links.rows).toEqual([{ phase: "knowledge", legacy_phase: "appeal" }]);
    expect(await processRow("untouched")).toMatchObject({ phase: "liquidation", legacy_phase: null, needs_verification: false });
  });

  it("recursal vira instância: a mais alta registrada, senão 2º grau com verificação", async () => {
    expect(await processRow("appealLinked")).toMatchObject({
      phase: "knowledge",
      legacy_phase: "appeal",
      instance: "superior",
      legacy_instance_set: true,
      needs_verification: false,
    });
    const bare = await processRow("appealBare");
    expect(bare).toMatchObject({ phase: "knowledge", instance: "second", legacy_instance_set: true, needs_verification: true, legacy_verification_set: true });
    expect(bare.verification_note).toBe("Fase anterior 'Recursal' migrada: conferir fase e instância");
    expect(await processRow("appealSecond")).toMatchObject({ instance: "second", legacy_instance_set: false, needs_verification: false });
  });

  it("acordo e pré-ajuizamento ficam em conhecimento e marcados para verificação", async () => {
    expect(await processRow("settlement")).toMatchObject({
      phase: "knowledge",
      legacy_phase: "settlement",
      instance: "first",
      needs_verification: true,
      legacy_verification_set: true,
      verification_note: "Fase anterior 'Acordo em andamento' migrada: conferir fase e instância",
    });
    expect(await processRow("preFiling")).toMatchObject({
      phase: "knowledge",
      needs_verification: true,
      legacy_verification_set: false,
      verification_note: "Nota anterior da equipe · Fase anterior 'Pré-ajuizamento' migrada: conferir fase e instância",
    });
  });

  it("encerrado continua só como situação; a fase sai do texto da fonte", async () => {
    expect(await processRow("closed")).toMatchObject({
      phase: "enforcement",
      legacy_phase: "closed",
      status: "closed",
      closure_reason: "archived",
      needs_verification: false,
    });
  });

  it("encerrado com situação ainda aberta (ativa ou suspensa) fica marcado para verificação", async () => {
    const note = "Fase anterior 'Encerrado' migrada: conferir fase e instância";
    expect(await processRow("closedActive")).toMatchObject({
      phase: "knowledge",
      legacy_phase: "closed",
      status: "active",
      needs_verification: true,
      legacy_verification_set: true,
      verification_note: note,
    });
    expect(await processRow("closedSuspended")).toMatchObject({ status: "suspended", needs_verification: true, verification_note: note });
    expect(await processRow("closedArchived")).toMatchObject({ phase: "knowledge", status: "archived", needs_verification: false, verification_note: null });
  });

  it("marca como desatualizadas só as análises que usaram um processo convertido", async () => {
    const rows = await client.query<{ id: string; is_stale: boolean; stale_reason: string | null }>(
      `select id, is_stale, stale_reason from ai_analyses where organization_id = $1`,
      [orgId],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(analysisIds.migrated)).toMatchObject({ is_stale: true });
    expect(byId.get(analysisIds.migrated)!.stale_reason).toContain("Fase e instância do processo convertidas");
    expect(byId.get(analysisIds.unrelated)).toMatchObject({ is_stale: false, stale_reason: null });
  });

  it("registra uma auditoria por processo afetado, sem conteúdo", async () => {
    const audits = await client.query<{ entity_id: string; changes: Record<string, unknown>; summary: string; actor_id: string | null }>(
      `select entity_id, changes, summary, actor_id from audit_logs where action = 'legal_process.phase_migration'`,
    );
    const byId = new Map(audits.rows.map((a) => [a.entity_id, a]));
    for (const key of ["appealLinked", "appealBare", "appealSecond", "settlement", "preFiling", "closed", "closedActive", "closedSuspended", "closedArchived", "linkOnly"]) {
      expect(byId.has(ids[key]), key).toBe(true);
    }
    expect(byId.has(ids.untouched)).toBe(false);
    expect(audits.rows).toHaveLength(10);
    expect(byId.get(ids.appealBare)!.changes).toEqual({
      phase: { from: "appeal", to: "knowledge" },
      instance: { from: null, to: "second" },
      needsVerification: { from: false, to: true },
    });
    for (const a of audits.rows) {
      expect(a.actor_id).toBeNull();
      expect(a.summary).not.toContain("dados fictícios");
    }
  });

  it("não toca a competência fechada (RN-10)", async () => {
    const item = await one<{ phase: string }>(`select phase from portfolio_snapshot_items where id = $1`, [snapshotItemId]);
    expect(item.phase).toBe("appeal");
    const snap = await one<{ metrics: { byPhase: Record<string, unknown> } }>(`select metrics from portfolio_snapshots where period = '2026-06'`);
    expect(Object.keys(snap.metrics.byPhase)).toEqual(["appeal"]);
  });

  it("o banco recusa gravar fase do modelo anterior", async () => {
    await expect(client.query(`update legal_processes set phase = 'appeal' where id = $1`, [ids.untouched])).rejects.toThrow(
      /legal_processes_phase_ck/,
    );
    await expect(client.query(`update process_instances set phase = 'closed' where process_id = $1`, [ids.linkOnly])).rejects.toThrow(
      /process_instances_phase_ck/,
    );
  });
});

describe("reversão (npm run db:rollback -- 0012_phase_instance_split --yes)", () => {
  it("recusa reverter migração que não é a última aplicada", async () => {
    const plan = await loadRollbackPlan("0011_bi_views_security_barrier");
    await expect(rollbackMigration(runner, plan)).rejects.toBeInstanceOf(RollbackError);
    await expect(loadRollbackPlan("../etc")).rejects.toBeInstanceOf(RollbackError);
  });

  it("restaura fase, instância e verificação originais e remove a migração do registro", async () => {
    // Later migrations (0013+) are reverted first, newest first, with their own drizzle/down scripts.
    for (const later of await tagsAfter(TAG)) await rollbackMigration(runner, await loadRollbackPlan(later));
    const plan = await loadRollbackPlan(TAG);
    await rollbackMigration(runner, plan);

    expect(await processRow("appealLinked")).toMatchObject({ phase: "appeal", instance: null, needs_verification: false });
    expect(await processRow("appealBare")).toMatchObject({ phase: "appeal", instance: null, needs_verification: false, verification_note: null });
    expect(await processRow("appealSecond")).toMatchObject({ phase: "appeal", instance: "second" });
    expect(await processRow("settlement")).toMatchObject({ phase: "settlement", instance: "first", needs_verification: false, verification_note: null });
    expect(await processRow("preFiling")).toMatchObject({
      phase: "pre_filing",
      needs_verification: true,
      verification_note: "Nota anterior da equipe",
    });
    expect(await processRow("closed")).toMatchObject({ phase: "closed", status: "closed", instance: "first" });
    expect(await processRow("closedActive")).toMatchObject({ phase: "closed", status: "active", needs_verification: false, verification_note: null });
    expect(await processRow("closedSuspended")).toMatchObject({ phase: "closed", status: "suspended", needs_verification: false, verification_note: null });
    expect(await processRow("closedArchived")).toMatchObject({ phase: "closed", status: "archived", needs_verification: false });
    expect(await processRow("untouched")).toMatchObject({ phase: "liquidation", instance: "first" });
    const links = await client.query<{ instance: string; phase: string | null }>(
      `select instance, phase from process_instances where process_id in ($1, $2) order by process_id, instance`,
      [ids.appealLinked, ids.linkOnly],
    );
    expect(links.rows.map((r) => r.phase).sort()).toEqual(["appeal", "appeal", "knowledge"]);

    const cols = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name in ('legal_processes', 'process_instances') and column_name like 'legacy_%'`,
    );
    expect(cols.rows).toEqual([]);
    const applied = await client.query(`select 1 from drizzle.__drizzle_migrations where created_at = $1`, [plan.when]);
    expect(applied.rows).toHaveLength(0);
    // History is never lost: the migration entries stay and the rollback adds its own.
    const audits = await client.query<{ action: string; n: number }>(
      `select action, count(*)::int as n from audit_logs where action like 'legal_process.phase_migration%' group by action order by action`,
    );
    expect(audits.rows).toEqual([
      { action: "legal_process.phase_migration", n: 10 },
      { action: "legal_process.phase_migration_rollback", n: 10 },
    ]);
    const item = await one<{ phase: string }>(`select phase from portfolio_snapshot_items where id = $1`, [snapshotItemId]);
    expect(item.phase).toBe("appeal");
  });

  it("depois da reversão, o migrador reaplica a migração", async () => {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    expect(await processRow("appealBare")).toMatchObject({ phase: "knowledge", instance: "second", legacy_phase: "appeal" });
  });
});
