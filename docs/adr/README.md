# Registros de decisão de arquitetura (ADR)

| # | Decisão |
|---|---|
| [0001](0001-stack.md) | Stack: Next.js 16 + TypeScript + Tailwind + Radix + Drizzle + PostgreSQL |
| [0002](0002-nextjs-rendering-model.md) | Modelo de renderização: `cacheComponents` desativado |
| [0003](0003-enums-as-text.md) | Enums como colunas `text` + zod |
| [0004](0004-postgres-job-queue.md) | Fila de jobs no PostgreSQL em vez de Redis |
| [0005](0005-db-sessions.md) | Sessões opacas no banco em vez de JWT ou biblioteca de autenticação |
| [0006](0006-embedded-postgres-and-pglite.md) | PostgreSQL embarcado no desenvolvimento e PGlite nos testes |
| [0007](0007-ai-provider-abstraction.md) | Abstração de provedor de IA, saída estruturada e modo demonstrativo |
| [0008](0008-local-file-storage.md) | Armazenamento local de arquivos atrás de uma interface |
| [0009](0009-row-visibility-in-services.md) | Visibilidade por linha na camada de serviço (não em Postgres RLS) |
| [0010](0010-simulated-integrations-behind-interfaces.md) | Integrações simuladas atrás de interfaces: análise preliminar e e-mail |
| [0011](0011-append-only-values-risk-vigency-monthly-close.md) | Valores append-only, vigência de risco e fechamento mensal imutável |

Formato: contexto, decisão, consequências e alternativas consideradas. Para mudar uma decisão, crie um novo ADR que substitua o anterior e marque o antigo como "substituída por ADR-NNNN".
