-- Reversao de drizzle/0011_bi_views_security_barrier.sql: retira a opcao security_barrier das views do schema "bi".
-- ATENCAO: sem a opcao, um usuario de leitura (praetor_bi) volta a conseguir ver linhas de outra organizacao
-- por meio de uma funcao criada na propria sessao (veja o comentario da migracao). Antes de reverter, REMOVA os
-- usuarios de leitura (DROP OWNED BY <usuario>; DROP ROLE <usuario>;). Nao reverta com usuario de leitura ativo,
-- nem combine com drizzle/down/0006 achando que isso protege: as visoes antigas da 0006 nao filtram organizacao.
-- So altera opcoes das views. Nenhuma tabela ou dado e tocado.
-- Aplique na ordem inversa das migracoes (antes das reversoes de numero menor, como a 0006 do Power BI), manualmente
-- (psql), e remova a entrada 0011 de drizzle.__drizzle_migrations (created_at = 1791778881194) se quiser reaplicar.
ALTER VIEW IF EXISTS "bi"."processos" RESET (security_barrier);
ALTER VIEW IF EXISTS "bi"."competencias" RESET (security_barrier);
ALTER VIEW IF EXISTS "bi"."valoracoes" RESET (security_barrier);
ALTER VIEW IF EXISTS "bi"."pendencias" RESET (security_barrier);
ALTER VIEW IF EXISTS "bi"."acesso" RESET (security_barrier);
ALTER VIEW IF EXISTS "bi"."atualizacao" RESET (security_barrier);
ALTER VIEW IF EXISTS "bi"."rotulos" RESET (security_barrier);
