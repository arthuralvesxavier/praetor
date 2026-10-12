-- Reversão de drizzle/0010_snapshot_close_overrides.sql (fechamento mensal com justificativa, P1.9).
-- Remove só a tabela criada pela migração. Nenhuma tabela pré-existente perde dados: as competências
-- continuam fechadas em portfolio_snapshots (com os itens e as métricas); perde-se apenas o registro
-- das justificativas de fechamento com processos sem classificação de risco. Se precisar guardá-lo,
-- exporte a tabela antes (ex.: \copy snapshot_close_overrides TO 'overrides.csv' CSV HEADER).
-- Aplique manualmente (psql) e remova a entrada 0010 de drizzle.__drizzle_migrations
-- (created_at = 1791778636970) se quiser reaplicar a migração depois.

DROP TABLE IF EXISTS "snapshot_close_overrides";
