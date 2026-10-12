-- Reversão de drizzle/0012_phase_instance_split.sql (P0.5: fase e instância separadas).
-- Aplique com: npm run db:rollback -- 0012_phase_instance_split --yes
-- (roda este arquivo numa transação e remove a entrada 0012 de drizzle.__drizzle_migrations,
-- created_at = 1791783246230, para a migração poder ser reaplicada depois).
--
-- O que volta ao estado anterior, só nas linhas que a migração mudou (colunas legacy_*):
--   - a fase de legal_processes e de process_instances volta a ser a de legacy_phase;
--   - a instância volta a ficar vazia onde a migração a preencheu (legacy_instance_set);
--   - a nota de verificação perde o trecho "Fase anterior '...' migrada: conferir fase e instância"
--     e a marcação de verificação é desligada onde a migração a ligou (legacy_verification_set).
-- Alterações feitas DEPOIS da migração nesses mesmos campos dessas linhas são revertidas também;
-- a trilha de auditoria guarda tudo (nada é apagado dela) e recebe uma entrada por processo revertido.
-- portfolio_snapshot_items e competências fechadas não foram tocados pela migração e não são tocados aqui.
-- Análises de IA marcadas como desatualizadas pela migração continuam assim (a marcação só informa e a
-- fase do registro mudou de novo com a reversão).
-- ATENÇÃO: o código da aplicação a partir da P0.5 só grava as três fases novas; reverta o código junto.

INSERT INTO "audit_logs" ("organization_id", "actor_id", "action", "entity_type", "entity_id", "summary", "changes", "metadata")
SELECT
  lp."organization_id",
  NULL,
  'legal_process.phase_migration_rollback',
  'legal_process',
  lp."id",
  'Migração de fase e instância revertida: fase do modelo anterior restaurada.',
  CASE WHEN lp."legacy_phase" IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('phase', jsonb_build_object('from', lp."phase", 'to', lp."legacy_phase")) END
  || CASE WHEN lp."legacy_instance_set" THEN jsonb_build_object('instance', jsonb_build_object('from', lp."instance", 'to', NULL)) ELSE '{}'::jsonb END,
  jsonb_build_object('migration', '0012_phase_instance_split', 'legacyPhase', lp."legacy_phase")
FROM "legal_processes" lp
WHERE lp."legacy_phase" IS NOT NULL
  OR EXISTS (SELECT 1 FROM "process_instances" pi WHERE pi."process_id" = lp."id" AND pi."legacy_phase" IS NOT NULL);

ALTER TABLE "legal_processes" DROP CONSTRAINT IF EXISTS "legal_processes_phase_ck";
ALTER TABLE "process_instances" DROP CONSTRAINT IF EXISTS "process_instances_phase_ck";

UPDATE "legal_processes" SET
  "verification_note" = NULLIF(
    replace(
      replace(
        "verification_note",
        ' · Fase anterior ''' || CASE "legacy_phase"
          WHEN 'pre_filing' THEN 'Pré-ajuizamento'
          WHEN 'appeal' THEN 'Recursal'
          WHEN 'settlement' THEN 'Acordo em andamento'
          ELSE 'Encerrado'
        END || ''' migrada: conferir fase e instância',
        ''
      ),
      'Fase anterior ''' || CASE "legacy_phase"
        WHEN 'pre_filing' THEN 'Pré-ajuizamento'
        WHEN 'appeal' THEN 'Recursal'
        WHEN 'settlement' THEN 'Acordo em andamento'
        ELSE 'Encerrado'
      END || ''' migrada: conferir fase e instância',
      ''
    ),
    ''
  ),
  "needs_verification" = CASE WHEN "legacy_verification_set" THEN false ELSE "needs_verification" END
WHERE "legacy_phase" IS NOT NULL AND "verification_note" IS NOT NULL;

UPDATE "legal_processes" SET "needs_verification" = false
WHERE "legacy_verification_set" AND "verification_note" IS NULL;

UPDATE "legal_processes" SET "instance" = NULL WHERE "legacy_instance_set";

UPDATE "legal_processes" SET "phase" = "legacy_phase" WHERE "legacy_phase" IS NOT NULL;

UPDATE "process_instances" SET "phase" = "legacy_phase" WHERE "legacy_phase" IS NOT NULL;

ALTER TABLE "legal_processes" DROP COLUMN IF EXISTS "legacy_verification_set";
ALTER TABLE "legal_processes" DROP COLUMN IF EXISTS "legacy_instance_set";
ALTER TABLE "legal_processes" DROP COLUMN IF EXISTS "legacy_phase";
ALTER TABLE "process_instances" DROP COLUMN IF EXISTS "legacy_phase";
