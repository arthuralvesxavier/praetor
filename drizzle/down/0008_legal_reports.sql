-- Reversão de drizzle/0008_legal_reports.sql (fundação dos relatórios jurídicos em PDF).
-- Remove só o que a migração criou: as tabelas legal_reports, legal_report_items,
-- legal_report_sources, legal_report_sequences e process_scenarios, os gatilhos de imutabilidade
-- e o bloco legalReports do valor padrão de organizations.settings. Nenhum dado pré-existente é
-- perdido (nenhuma tabela anterior foi alterada além do valor padrão da coluna settings).
-- Os relatórios e cenários registrados depois da migração saem junto com as tabelas; os PDFs
-- armazenados (STORAGE_DIR/<org>/<relatório>/...) continuam no disco e podem ser apagados à parte.
-- Aplique manualmente (psql) e remova a entrada 0008 de drizzle.__drizzle_migrations
-- (created_at = 1791778309920) se quiser reaplicar a migração depois.

DROP TRIGGER IF EXISTS "process_scenarios_append_only" ON "process_scenarios";
DROP TRIGGER IF EXISTS "legal_report_sources_append_only" ON "legal_report_sources";
DROP TRIGGER IF EXISTS "legal_report_items_append_only" ON "legal_report_items";
DROP TRIGGER IF EXISTS "legal_reports_guard" ON "legal_reports";
DROP FUNCTION IF EXISTS "legal_reports_append_only"();
DROP FUNCTION IF EXISTS "legal_reports_guard"();

DROP TABLE IF EXISTS "legal_report_sources";
DROP TABLE IF EXISTS "legal_report_items";
DROP TABLE IF EXISTS "legal_reports";
DROP TABLE IF EXISTS "legal_report_sequences";
DROP TABLE IF EXISTS "process_scenarios";

ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"ai":{"monthlyTokenBudget":2000000,"maxInputChars":120000,"autoAnalyzeOnUpload":true},"alerts":{"upcomingDeadlineDays":7,"contractExpirationDays":60,"upcomingHearingDays":10,"installmentDueDays":10},"retention":{"closedRecordRetentionDays":1825,"auditLogRetentionDays":1825},"contingency":{"riskPercentages":{"remote":0,"possible":50,"probable":100},"confidenceThreshold":85,"idleGuaranteeDays":180,"rulesVersion":1,"defaultCorrectionIndex":"none"},"email":{"mode":"simulated","senderName":"Praetor (simulação)","senderAddress":"nao-responda@praetor.invalid","notifyOnBriefReady":true,"notifyOnAssignment":true},"intake":{"autoAssign":true,"autoGenerateBrief":true,"autoNotify":true},"integrations":{"datajud":{"enabled":true,"syncIntervalHours":24,"maxRequestsPerMinute":20,"batchSize":50,"autoApplyPhase":true,"enrichOnIntake":true},"simulatedFeed":{"enabled":false,"intervalMinutes":120}}}'::jsonb;

-- A chave settings -> 'legalReports' gravada nas organizações (parâmetros editados) é ignorada pela
-- versão anterior; não é preciso apagá-la. Para removê-la mesmo assim:
--   UPDATE "organizations" SET "settings" = "settings" - 'legalReports';
