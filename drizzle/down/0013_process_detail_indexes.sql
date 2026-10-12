-- Reversão de drizzle/0013_process_detail_indexes.sql (P0.6: ficha do processo).
-- Aplique com: npm run db:rollback -- 0013_process_detail_indexes --yes
-- (roda este arquivo numa transação e remove a entrada 0013 de drizzle.__drizzle_migrations,
-- created_at = 1791792289060, para a migração poder ser reaplicada depois).
--
-- Remove só o que a migração criou:
--   - os índices de filtro da carteira (cidade, classe), de reversão de importação (lote) em
--     legal_processes, process_instances e process_valuations, e o índice da expressão dos dígitos
--     do número CNJ usado pela importação. Índices não guardam dados: nada se perde, só desempenho;
--   - a coluna process_valuations.cleared_on (dia em que o valor da causa foi removido do cadastro).
--     Perde-se apenas essa data: as linhas continuam como estão (status superseded, valores e
--     datas-base intactos), e a posição em datas passadas volta à regra anterior (mostra o último
--     valor oficial naquela data). Exporte a coluna antes se quiser guardá-la, por exemplo:
--       \copy (select id, cleared_on from process_valuations where cleared_on is not null) TO 'cleared_on.csv' CSV HEADER
-- ATENÇÃO: o código a partir do P0.6 grava cleared_on; reverta o código junto.

DROP INDEX IF EXISTS "process_valuations_import_batch_idx";
DROP INDEX IF EXISTS "process_instances_import_batch_idx";
DROP INDEX IF EXISTS "legal_processes_org_number_digits_idx";
DROP INDEX IF EXISTS "legal_processes_import_batch_idx";
DROP INDEX IF EXISTS "legal_processes_org_class_idx";
DROP INDEX IF EXISTS "legal_processes_org_city_idx";
ALTER TABLE "process_valuations" DROP COLUMN IF EXISTS "cleared_on";
