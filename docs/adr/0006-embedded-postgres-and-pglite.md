# ADR-0006 — PostgreSQL embarcado no desenvolvimento e PGlite nos testes

- **Status**: aceita
- **Data**: 2026-10

## Contexto

O projeto deve rodar em qualquer máquina de desenvolvimento (inclusive Windows) sem Docker ou PostgreSQL instalado, e os testes precisam de um PostgreSQL real (índices parciais, `SKIP LOCKED`, busca textual em português, jsonb), rápido e isolado.

## Decisão

- **Desenvolvimento**: `npm run db:dev` (`scripts/db-dev.ts`) usa o pacote `embedded-postgres`, com binários reais do PostgreSQL, na porta 54329 e dados em `.data/postgres`. A conexão padrão de `DATABASE_URL` aponta para ele.
- **Testes**: `tests/helpers/db.ts` cria um **PGlite** (PostgreSQL compilado para WASM) em memória, aplica todas as migrações de `drizzle/` e o instala com `setDatabase()`. Cada arquivo de teste tem seu banco isolado e não precisa de servidor.
- **Produção**: PostgreSQL gerenciado ou próprio (ver [OPERATIONS.md](../OPERATIONS.md)). O banco embarcado não é usado.

## Consequências

- `npm install` + `npm run db:dev` bastam para começar. `npm run test` roda em CI sem serviços.
- Mesmas migrações em todos os ambientes. O mesmo dialeto SQL garante que testes de regras de acesso exercitem SQL real.
- PGlite roda em processo único, com versão e extensões próprias. Diferenças sutis de comportamento ou desempenho em relação ao servidor são possíveis, por isso testes de carga devem usar PostgreSQL de verdade.
- O primeiro `db:dev` baixa e inicializa o cluster (alguns segundos).

## Alternativas consideradas

- **Docker Compose**: padrão de mercado, mas exige Docker (barreira no Windows corporativo).
- **SQLite nos testes**: dialeto diferente e sem `SKIP LOCKED`/tsvector.
- **Testcontainers**: PostgreSQL real nos testes, mas exige Docker e é mais lento.
