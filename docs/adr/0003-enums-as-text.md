# ADR-0003 — Enums como colunas `text` + validação com zod

- **Status**: aceita
- **Data**: 2026-10

## Contexto

O domínio tem muitos conjuntos fechados de valores (status, áreas, fases, categorias, níveis de risco, tipos de análise…), que vão evoluir com o produto. Tipos `ENUM` do PostgreSQL exigem migração para adicionar valores e são difíceis de renomear ou remover.

## Decisão

- Valores definidos uma vez em `src/domain/enums.ts` como arrays `as const`, com tipo derivado e mapa de rótulos pt-BR (`*_LABELS`). Ids em inglês, rótulos em português.
- Colunas `text` tipadas no Drizzle com `.$type<T>()`. Sem `CREATE TYPE`.
- Os serviços validam a entrada com `z.enum(VALUES)` (ver `schemas.ts` de cada módulo), e a UI gera opções com `optionsFromLabels(LABELS)` (`src/lib/options.ts`).

## Consequências

- Adicionar valor: só código, sem migração.
- Renomear ou remover valor: exige migração de dados (`UPDATE`), registrada em `drizzle/`.
- O banco não impede valores inválidos inseridos por fora da aplicação. A garantia está nos serviços, que são a única via de escrita, e em testes.
- Os rótulos ficam no mesmo arquivo que os valores, o que facilita revisar traduções.

## Alternativas consideradas

- **`pgEnum`**: integridade no banco, mas migrações frequentes e dolorosas.
- **Tabelas de domínio (lookup tables)**: flexíveis para configuração por organização, mas mais joins e complexidade sem necessidade atual.
- **`CHECK` constraints**: integridade no banco, mas mudam a cada novo valor. Reavaliar para colunas críticas quando o domínio estabilizar.
