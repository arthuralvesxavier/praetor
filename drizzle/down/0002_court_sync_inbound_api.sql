-- Reversão de drizzle/0002_court_sync_inbound_api.sql (coleta DataJud e API de entrada).
-- Remove só o que a migração criou. Tabelas e colunas pré-existentes não perdem dados:
-- as movimentações importadas do DataJud continuam em process_events (apenas a coluna
-- external_id, usada para não duplicar, é removida) e os processos continuam intactos
-- (apenas a coluna subjects, preenchida pela coleta, é removida).
-- Aplique manualmente (psql) e remova a entrada 0002 de drizzle.__drizzle_migrations
-- se quiser reaplicar a migração depois.

DROP INDEX IF EXISTS "process_events_external_uq";
ALTER TABLE "process_events" DROP COLUMN IF EXISTS "external_id";
ALTER TABLE "legal_processes" DROP COLUMN IF EXISTS "subjects";

DROP TABLE IF EXISTS "inbound_requests";
DROP TABLE IF EXISTS "api_keys";
DROP TABLE IF EXISTS "court_sync_states";
DROP TABLE IF EXISTS "court_sync_runs";

ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"ai":{"monthlyTokenBudget":2000000,"maxInputChars":120000,"autoAnalyzeOnUpload":true},"alerts":{"upcomingDeadlineDays":7,"contractExpirationDays":60,"upcomingHearingDays":10,"installmentDueDays":10},"retention":{"closedRecordRetentionDays":1825,"auditLogRetentionDays":1825},"contingency":{"riskPercentages":{"remote":0,"possible":50,"probable":100},"confidenceThreshold":85,"idleGuaranteeDays":180,"rulesVersion":1},"email":{"mode":"simulated","senderName":"Praetor (simulação)","senderAddress":"nao-responda@praetor.invalid","notifyOnBriefReady":true,"notifyOnAssignment":true},"intake":{"autoAssign":true,"autoGenerateBrief":true,"autoNotify":true}}'::jsonb;

-- As configurações gravadas em organizations.settings -> 'integrations' são ignoradas pela
-- versão anterior (o merge com os padrões descarta chaves desconhecidas); não é preciso apagá-las.
