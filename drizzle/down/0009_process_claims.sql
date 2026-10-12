-- Reversão de drizzle/0009_process_claims.sql (pedidos do processo e risco por pedido, P1.6).
-- Remove só o que a migração criou: as tabelas process_claim_risk_links, process_claim_assessments e
-- process_claims. Dados pré-existentes não são afetados: as classificações de risco do processo
-- registradas a partir dos pedidos ficam em process_risk_assessments (tabela anterior), com o parecer
-- "Derivado dos pedidos: ..." ou a justificativa da classificação manual; só a ligação com os pedidos
-- e os próprios pedidos deixam de existir. Exporte as tabelas antes se quiser guardar o histórico.
-- Alertas abertos do tipo claims_risk_review continuam na tabela alerts (resolva-os manualmente).
-- Aplique manualmente (psql) e remova a entrada 0009 de drizzle.__drizzle_migrations
-- (created_at = 1791778424297) se quiser reaplicar a migração depois.

DROP TABLE IF EXISTS "process_claim_risk_links";
DROP TABLE IF EXISTS "process_claim_assessments";
DROP TABLE IF EXISTS "process_claims";
