-- Reversão de drizzle/0007_correction_index_series.sql (índices de correção e valor atualizado, P1.7).
-- Remove só o que a migração criou. Dados pré-existentes não são perdidos: os valores registrados
-- (process_valuations) continuam intactos (valor original e data-base nunca foram alterados; o valor
-- atualizado nunca foi gravado). Saem apenas a coluna correction_index (índice informado depois desta
-- migração), o gatilho que grava o índice padrão e as tabelas das séries do Banco Central (dados
-- públicos, coletados de novo pela rotina se a migração for reaplicada).
-- Aplique manualmente (psql) e remova a entrada 0007 de drizzle.__drizzle_migrations
-- (created_at = 1791776640114) se quiser reaplicar a migração depois.

DROP TRIGGER IF EXISTS "process_valuations_default_correction_index" ON "process_valuations";
DROP FUNCTION IF EXISTS "process_valuations_default_correction_index"();
ALTER TABLE "process_valuations" DROP COLUMN IF EXISTS "correction_index";

DROP TABLE IF EXISTS "index_series_values";
DROP TABLE IF EXISTS "index_series";

ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"ai":{"monthlyTokenBudget":2000000,"maxInputChars":120000,"autoAnalyzeOnUpload":true},"alerts":{"upcomingDeadlineDays":7,"contractExpirationDays":60,"upcomingHearingDays":10,"installmentDueDays":10},"retention":{"closedRecordRetentionDays":1825,"auditLogRetentionDays":1825},"contingency":{"riskPercentages":{"remote":0,"possible":50,"probable":100},"confidenceThreshold":85,"idleGuaranteeDays":180,"rulesVersion":1},"email":{"mode":"simulated","senderName":"Praetor (simulação)","senderAddress":"nao-responda@praetor.invalid","notifyOnBriefReady":true,"notifyOnAssignment":true},"intake":{"autoAssign":true,"autoGenerateBrief":true,"autoNotify":true},"integrations":{"datajud":{"enabled":true,"syncIntervalHours":24,"maxRequestsPerMinute":20,"batchSize":50,"autoApplyPhase":true,"enrichOnIntake":true},"simulatedFeed":{"enabled":false,"intervalMinutes":120}}}'::jsonb;

-- A chave settings -> 'contingency' -> 'defaultCorrectionIndex' gravada nas organizações é ignorada
-- pela versão anterior; não é preciso apagá-la. A rotina index_series_refresh registrada em
-- scheduled_routines fica sem execução na versão anterior (o tipo não existe lá); remova-a se quiser:
--   DELETE FROM "scheduled_routines" WHERE "type" = 'index_series_refresh';
