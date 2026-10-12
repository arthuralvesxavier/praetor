-- P0.5: fase e instância são eixos distintos. Fase = conhecimento, liquidação ou execução;
-- instância = 1º, 2º ou 3º grau. As fases do modelo anterior (pre_filing, appeal, settlement,
-- closed) ficam guardadas em legacy_phase (nada é perdido) e a reversão está em
-- drizzle/down/0012_phase_instance_split.sql (npm run db:rollback -- 0012_phase_instance_split --yes).
-- NÃO toca portfolio_snapshot_items nem competências fechadas (RN-10): os itens congelados
-- continuam com a fase gravada no fechamento e são exibidos com os rótulos do modelo anterior.
-- Uma PRÉVIA calculada antes desta migração fica desatualizada (fase/instância dos itens diferem do
-- processo) e o fechamento exige recalcular (`PreviewStaleness.changed`, contingency/close-gate.ts).
ALTER TABLE "legal_processes" ADD COLUMN "legacy_phase" text;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "legacy_instance_set" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "legacy_verification_set" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "process_instances" ADD COLUMN "legacy_phase" text;--> statement-breakpoint
-- Vínculos de instância: a fase anterior vai para legacy_phase; a nova fase sai do texto da fonte
-- (phase_detail) pela mesma regra do importador (termo inicial Execução/Cumprimento, Liquidação ou
-- Conhecimento; depois o termo em qualquer posição); sem termo reconhecido = Conhecimento.
UPDATE "process_instances" SET
  "legacy_phase" = "phase",
  "phase" = CASE
    WHEN coalesce("phase_detail", '') ~* '^\s*(execu|cumprimento)' THEN 'enforcement'
    WHEN coalesce("phase_detail", '') ~* '^\s*liquida' THEN 'liquidation'
    WHEN coalesce("phase_detail", '') ~* '^\s*conhecimento' THEN 'knowledge'
    WHEN coalesce("phase_detail", '') ~* 'execu[cçÇ][aãÃ]o' THEN 'enforcement'
    WHEN coalesce("phase_detail", '') ~* 'liquida[cçÇ][aãÃ]o' THEN 'liquidation'
    ELSE 'knowledge'
  END
WHERE "phase" IN ('pre_filing', 'appeal', 'settlement', 'closed');--> statement-breakpoint
-- Processos: mesma regra de fase. "Recursal" vira INSTÂNCIA: quando a instância do processo está
-- vazia, recebe a mais alta registrada em process_instances entre 2º e 3º grau (sem vínculo
-- recursal: 2º grau). Pré-ajuizamento, acordo em andamento e recursal sem instância recursal
-- conhecida ficam marcados para verificação. "Encerrado" continua só como situação (status
-- intocado); quando a situação NÃO era encerrada/arquivada (o modelo anterior permitia fase
-- "Encerrado" com situação ativa ou suspensa), a contradição fica marcada para verificação.
-- As colunas legacy_* registram o que a migração mudou, para a reversão.
WITH "target" AS (
  SELECT
    lp."id",
    lp."phase" AS "old_phase",
    lp."status" AS "old_status",
    lp."instance" AS "old_instance",
    lp."needs_verification" AS "old_needs_verification",
    (
      SELECT pi."instance"
      FROM "process_instances" pi
      WHERE pi."process_id" = lp."id" AND pi."instance" IN ('second', 'superior')
      ORDER BY CASE pi."instance" WHEN 'superior' THEN 3 ELSE 2 END DESC
      LIMIT 1
    ) AS "appellate_link"
  FROM "legal_processes" lp
  WHERE lp."phase" IN ('pre_filing', 'appeal', 'settlement', 'closed')
),
"flagged" AS (
  SELECT
    t.*,
    (
      t."old_phase" IN ('pre_filing', 'settlement')
      OR (
        t."old_phase" = 'appeal'
        AND NOT (
          coalesce(t."old_instance", '') IN ('second', 'superior')
          OR (t."old_instance" IS NULL AND t."appellate_link" IS NOT NULL)
        )
      )
      OR (t."old_phase" = 'closed' AND t."old_status" NOT IN ('closed', 'archived'))
    ) AS "flag",
    'Fase anterior ''' || CASE t."old_phase"
      WHEN 'pre_filing' THEN 'Pré-ajuizamento'
      WHEN 'appeal' THEN 'Recursal'
      WHEN 'settlement' THEN 'Acordo em andamento'
      ELSE 'Encerrado'
    END || ''' migrada: conferir fase e instância' AS "note"
  FROM "target" t
)
UPDATE "legal_processes" lp SET
  "legacy_phase" = f."old_phase",
  "phase" = CASE
    WHEN coalesce(lp."phase_detail", '') ~* '^\s*(execu|cumprimento)' THEN 'enforcement'
    WHEN coalesce(lp."phase_detail", '') ~* '^\s*liquida' THEN 'liquidation'
    WHEN coalesce(lp."phase_detail", '') ~* '^\s*conhecimento' THEN 'knowledge'
    WHEN coalesce(lp."phase_detail", '') ~* 'execu[cçÇ][aãÃ]o' THEN 'enforcement'
    WHEN coalesce(lp."phase_detail", '') ~* 'liquida[cçÇ][aãÃ]o' THEN 'liquidation'
    ELSE 'knowledge'
  END,
  "instance" = CASE
    WHEN f."old_phase" = 'appeal' AND f."old_instance" IS NULL THEN coalesce(f."appellate_link", 'second')
    ELSE lp."instance"
  END,
  "legacy_instance_set" = (f."old_phase" = 'appeal' AND f."old_instance" IS NULL),
  "needs_verification" = lp."needs_verification" OR f."flag",
  "legacy_verification_set" = f."flag" AND NOT f."old_needs_verification",
  "verification_note" = CASE
    WHEN NOT f."flag" THEN lp."verification_note"
    WHEN coalesce(lp."verification_note", '') = '' THEN f."note"
    ELSE lp."verification_note" || ' · ' || f."note"
  END
FROM "flagged" f
WHERE lp."id" = f."id";--> statement-breakpoint
-- Uma entrada de auditoria por processo afetado (o próprio registro ou um vínculo de instância).
-- Só códigos e contagens: nenhum conteúdo de documento, título ou nota.
INSERT INTO "audit_logs" ("organization_id", "actor_id", "action", "entity_type", "entity_id", "summary", "changes", "metadata")
SELECT
  lp."organization_id",
  NULL,
  'legal_process.phase_migration',
  'legal_process',
  lp."id",
  CASE
    WHEN lp."legacy_phase" IS NULL THEN 'Fase e instância separadas (migração do modelo): fase dos vínculos de instância convertida.'
    ELSE 'Fase e instância separadas (migração do modelo): fase anterior "' || CASE lp."legacy_phase"
      WHEN 'pre_filing' THEN 'Pré-ajuizamento'
      WHEN 'appeal' THEN 'Recursal'
      WHEN 'settlement' THEN 'Acordo em andamento'
      ELSE 'Encerrado'
    END || '" convertida.'
  END,
  CASE WHEN lp."legacy_phase" IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('phase', jsonb_build_object('from', lp."legacy_phase", 'to', lp."phase")) END
  || CASE WHEN lp."legacy_instance_set" THEN jsonb_build_object('instance', jsonb_build_object('from', NULL, 'to', lp."instance")) ELSE '{}'::jsonb END
  || CASE WHEN lp."legacy_verification_set" THEN jsonb_build_object('needsVerification', jsonb_build_object('from', false, 'to', true)) ELSE '{}'::jsonb END,
  jsonb_build_object(
    'migration', '0012_phase_instance_split',
    'legacyPhase', lp."legacy_phase",
    'instanceLinksMigrated', (SELECT count(*) FROM "process_instances" pi WHERE pi."process_id" = lp."id" AND pi."legacy_phase" IS NOT NULL)
  )
FROM "legal_processes" lp
WHERE lp."legacy_phase" IS NOT NULL
  OR EXISTS (SELECT 1 FROM "process_instances" pi WHERE pi."process_id" = lp."id" AND pi."legacy_phase" IS NOT NULL);--> statement-breakpoint
-- Análises de IA concluídas que usaram um processo convertido como fonte ficam desatualizadas
-- (a fase/instância do registro mudou). A marcação só informa; a reversão não a desfaz.
UPDATE "ai_analyses" a SET
  "is_stale" = true,
  "stale_reason" = 'Fase e instância do processo convertidas para o novo modelo (fase: conhecimento, liquidação ou execução; instância: 1º, 2º ou 3º grau).',
  "stale_since" = now()
WHERE a."status" = 'succeeded'
  AND NOT a."is_stale"
  AND EXISTS (
    SELECT 1
    FROM "ai_analysis_sources" s
    JOIN "legal_processes" lp ON lp."id" = s."entity_id" AND lp."organization_id" = s."organization_id"
    WHERE s."analysis_id" = a."id"
      AND (
        lp."legacy_phase" IS NOT NULL
        OR EXISTS (SELECT 1 FROM "process_instances" pi WHERE pi."process_id" = lp."id" AND pi."legacy_phase" IS NOT NULL)
      )
  );--> statement-breakpoint
ALTER TABLE "legal_processes" ADD CONSTRAINT "legal_processes_phase_ck" CHECK ("legal_processes"."phase" in ('knowledge', 'liquidation', 'enforcement'));--> statement-breakpoint
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_phase_ck" CHECK ("process_instances"."phase" is null or "process_instances"."phase" in ('knowledge', 'liquidation', 'enforcement'));
