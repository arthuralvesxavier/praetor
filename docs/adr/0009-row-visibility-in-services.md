# ADR-0009 — Visibilidade por linha na camada de serviço (não em Postgres RLS)

- **Status**: aceita
- **Data**: 2026-10

## Contexto

As regras de visibilidade combinam organização, perfil, unidade, confidencialidade, responsável e criador, nível de sigilo do documento, herança pelo registro vinculado (documentos, tarefas, prazos, comentários, alertas) e visibilidade de todas as fontes de uma análise de IA. Elas precisam ser testáveis, legíveis e valer igualmente em páginas, ações, route handlers, jobs e testes.

## Decisão

- Uma única fonte de verdade em TypeScript: `src/server/auth/access.ts`, com builders de condição SQL (`processWhere`, `occurrenceWhere`, `contractWhere`, `documentWhere`, `taskWhere`, `deadlineWhere`, `analysisWhere`, `entityReferenceWhere`, `visible*Ids`) e equivalente em memória (`canViewScopedRecord`).
- **Todo** serviço aplica o builder correspondente em **toda** consulta, com `assertCan` para a permissão de ação. Leituras unitárias usam `id AND escopo` e `NotFoundError`. Ids estrangeiros recebidos são verificados contra a organização e a visibilidade.
- Jobs usam `systemContext(orgId)`: preso à organização, sem escopo por usuário.
- As regras estão documentadas em [SECURITY.md](../SECURITY.md) e cobertas por testes de cada módulo (isolamento entre organizações, unidade, confidencialidade).

## Consequências

- Regras expressas em código tipado, reutilizável em subconsultas (dashboard, busca de IA) e fácil de testar com PGlite.
- **O banco não impõe as regras**: uma consulta que esqueça o builder vaza dados. Mitigações:
  - convenção obrigatória (`AGENTS.md`, `docs/dev/MODULE_CONTRACTS.md`);
  - revisão de código;
  - testes de isolamento por módulo;
  - serviços como única via de acesso a dados.
- Subconsultas `IN (SELECT …)` aninhadas podem pesar com grandes volumes. Avaliar índices e materialização se necessário.

## Alternativas consideradas

- **PostgreSQL Row-Level Security**: defesa em profundidade no banco, mas exige definir o usuário e a organização por conexão ou transação (`SET LOCAL`) com pool compartilhado. As políticas ficam em SQL, longe dos tipos, e mais difíceis de testar e depurar, e as regras compostas (fontes de análise, herança de documentos) ficam complexas. Pode ser adicionado no futuro **além** da camada de serviço, ao menos para o isolamento por `organization_id`.
- **Filtragem em memória após a consulta**: quebra paginação e contagens e corre o risco de carregar dados indevidos.
