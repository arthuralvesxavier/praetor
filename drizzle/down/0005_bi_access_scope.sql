-- Reversao de drizzle/0005_bi_access_scope.sql (escopo dos usuarios de leitura e marca de mudanca de acessos).
-- Aplique DEPOIS de drizzle/down/0006_bi_reporting_views_v2.sql (as views da 0006 dependem de bi_reader_roles).
-- Remove so o que a migracao criou: a tabela bi_reader_roles (vinculo do usuario praetor_bi com a organizacao,
-- recriado por scripts/bi-setup.ts) e a coluna bi_settings.access_changed_at (estado recalculado pela rotina).
-- Nenhum dado da carteira e perdido.
-- Aplique manualmente (psql) e remova a entrada 0005 de drizzle.__drizzle_migrations
-- (created_at = 1791774421331) se quiser reaplicar a migracao depois.

DROP TABLE IF EXISTS "bi_reader_roles";
ALTER TABLE "bi_settings" DROP COLUMN IF EXISTS "access_changed_at";
