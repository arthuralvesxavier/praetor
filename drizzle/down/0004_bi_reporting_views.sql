-- Reversão de drizzle/0004_bi_reporting_views.sql (camada governada "bi" para o Power BI).
-- Remove somente o schema "bi" e as views que ele contém. Nenhuma tabela é apagada e nenhum
-- dado da carteira é perdido (as views apenas leem as tabelas do schema público).
-- Se o usuário somente leitura praetor_bi tiver sido criado (scripts/bi-setup.ts), ele continua
-- existindo, sem acesso a nada; remova-o com DROP ROLE praetor_bi se quiser.
-- Aplique manualmente (psql) e remova a entrada 0004 de drizzle.__drizzle_migrations
-- (created_at = 1791769709413) se quiser reaplicar a migração depois.

DROP SCHEMA IF EXISTS "bi" CASCADE;
