-- Reversão de drizzle/0003_bi_tables.sql (tabelas de apoio dos painéis Power BI).
-- Aplique DEPOIS de drizzle/down/0004_bi_reporting_views.sql (ordem inversa das migrações).
-- Remove só o que a migração criou. Tabelas pré-existentes não perdem dados: as tabelas
-- removidas guardam apenas a configuração dos painéis, a tabela de acessos (recalculada pelo
-- Praetor a partir das regras de visibilidade), o histórico de atualizações do Power BI e os
-- rótulos copiados de src/domain/enums.ts.
-- Aplique manualmente (psql) e remova a entrada 0003 de drizzle.__drizzle_migrations
-- (created_at = 1791769672721) se quiser reaplicar a migração depois.

DROP SCHEMA IF EXISTS "bi" CASCADE;
DROP TABLE IF EXISTS "bi_refresh_runs";
DROP TABLE IF EXISTS "bi_process_access";
DROP TABLE IF EXISTS "bi_settings";
DROP TABLE IF EXISTS "bi_labels";
