-- Camada "bi" (docs/POWER_BI.md): todas as views passam a ser barreiras de seguranca.
-- O escopo por organizacao das views (drizzle/0006_bi_reporting_views_v2.sql) fica dentro delas. Sem
-- security_barrier, o planejador pode avaliar uma condicao escrita por quem consulta ANTES desse filtro.
-- Como o PostgreSQL da a PUBLIC a permissao TEMPORARY no banco, o usuario de leitura (praetor_bi) consegue
-- criar uma funcao na propria sessao (pg_temp) que recebe cada linha, inclusive de outra organizacao, e a
-- devolve numa mensagem de erro. Com security_barrier, condicoes de quem consulta (que nao sejam
-- LEAKPROOF, marca que so superusuario concede) so rodam depois do filtro da view.
-- Teste: tests/bi/data.test.ts ("a function created by praetor_bi cannot see rows of another organization").
-- Uma migracao futura que recriar uma view do schema bi precisa declarar WITH (security_barrier = true);
-- o mesmo teste confere que todas as views do schema bi tem a opcao.
-- So altera opcoes das views. Nenhuma tabela ou dado e tocado. Reversao: drizzle/down/0011_bi_views_security_barrier.sql.
ALTER VIEW "bi"."processos" SET (security_barrier = true);
--> statement-breakpoint
ALTER VIEW "bi"."competencias" SET (security_barrier = true);
--> statement-breakpoint
ALTER VIEW "bi"."valoracoes" SET (security_barrier = true);
--> statement-breakpoint
ALTER VIEW "bi"."pendencias" SET (security_barrier = true);
--> statement-breakpoint
ALTER VIEW "bi"."acesso" SET (security_barrier = true);
--> statement-breakpoint
ALTER VIEW "bi"."atualizacao" SET (security_barrier = true);
--> statement-breakpoint
ALTER VIEW "bi"."rotulos" SET (security_barrier = true);
