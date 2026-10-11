# ADR-0004 — Fila de jobs no PostgreSQL em vez de Redis

- **Status**: aceita
- **Data**: 2026-10

## Contexto

Análises de IA, extração de texto e rotinas agendadas precisam rodar fora da requisição, com retentativas, sem duplicidade e de forma consistente com as transações de negócio. Por exemplo, um upload só deve enfileirar a extração se o documento for gravado.

## Decisão

- Tabela `jobs` no próprio PostgreSQL, com `src/server/jobs/queue.ts`:
  - `enqueueJob(input, tx?)` pode participar da transação de negócio;
  - `dedupe_key` com índice único parcial entre jobs pendentes;
  - reserva com `SELECT … FOR UPDATE SKIP LOCKED`, status `running` e `attempts + 1`;
  - backoff exponencial (30 s até 30 min), `max_attempts` (padrão 3) e status `dead` ao esgotar;
  - erros não retentáveis (domínio, payload inválido, `retryable = false`) morrem na hora;
  - recuperação de jobs presos (`running` há mais de 15 min);
  - `last_error` sanitizado.
- Rotinas em `scheduled_routines` por organização, reservadas avançando `next_run_at` atomicamente e executadas como jobs `routine.run`.
- Worker de longa duração (`scripts/worker.ts`), mais `processPendingJobs()` para processar inline (admin, seed, testes).

## Consequências

- Nenhuma infraestrutura extra. Enfileiramento transacional (o job só existe se a mudança for confirmada). Inspeção por SQL.
- Vários workers podem rodar em paralelo com segurança.
- Vazão menor que um broker dedicado e polling (`WORKER_POLL_INTERVAL_MS`). Suficiente para o volume previsto (análises de IA levam segundos ou minutos).
- A tabela cresce e não há limpeza de jobs concluídos ainda (pendente).
- Os handlers precisam ser idempotentes (`runAnalysisJob` e `extractDocumentVersionText` são).

## Alternativas consideradas

- **Redis + BullMQ**: mais vazão e recursos, mas outro serviço para operar e proteger, sem transação com o banco (exigiria outbox).
- **pg-boss / graphile-worker**: maduros e com a mesma ideia, mas a necessidade é pequena e a implementação própria tem cerca de 160 linhas, testada (`tests/jobs/queue.test.ts`). Reavaliar se surgirem requisitos como cron complexo, prioridades ou throttling por fila.
- **Executar no próprio request**: sem retentativas e com timeouts do servidor web.
