# Operação

Guia para executar o Praetor fora do ambiente de desenvolvimento. Esta versão é a primeira funcional: revise [SECURITY.md](SECURITY.md#o-que-ainda-precisa-ser-avaliado-antes-de-uso-em-produção) antes de usar dados reais.

## Componentes

| Processo | Comando | Função |
|---|---|---|
| Web | `npm run build` e depois `npm start` (`next start`, porta 3000 ou `PORT`) | Páginas, server actions, upload e download, `/api/health`. |
| Worker | `npm run worker` (`tsx scripts/worker.ts`) | Fila de jobs (análises de IA, extração de texto, rotinas) e agendamento de rotinas. **Obrigatório**: sem ele, análises e extrações ficam "Na fila" e não há alertas. |
| PostgreSQL | gerenciado ou próprio | Todos os dados, a fila e as sessões. |
| Armazenamento | diretório `STORAGE_DIR` | Arquivos enviados (binários das versões de documentos). |

O worker roda TypeScript com `tsx`, que é dependência de desenvolvimento. Instale com `npm ci` (incluindo devDependencies) ou empacote o worker antes do deploy.

## Passo a passo

1. Defina as variáveis de ambiente (tabela abaixo). Em produção, `APP_URL` deve ser a URL `https://` pública, porque isso ativa o cookie `Secure` e a checagem de origem do upload.
2. `npm ci`
3. `npm run db:migrate`: aplica as migrações de `drizzle/`. Rode a cada deploy, **antes** de subir a nova versão.
4. `npm run build`
5. Suba `npm start` e `npm run worker` com um supervisor (systemd, PM2, contêiner) que reinicie em caso de falha. O worker trata SIGINT e SIGTERM e termina o ciclo atual antes de sair.
6. **Não** rode `npm run db:seed` em produção: ele cria organizações e contas **de demonstração** com senha conhecida. `npm run db:seed -- --reset` **apaga todos os dados de todas as organizações** e os arquivos armazenados.
7. Crie a organização real e o primeiro administrador. **Pendente**: não há tela nem script de bootstrap de organização; hoje isso exige um script próprio que insira `organizations` e `users` (senha com `hashPassword` de `src/server/auth/password.ts`).

## Variáveis de ambiente

| Variável | Produção |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Obrigatória. Use TLS (`?sslmode=require`) e um usuário com privilégios mínimos (DDL só para quem aplica migrações). |
| `APP_URL` | URL pública `https://…` |
| `STORAGE_DIR` | Caminho absoluto em volume persistente, com backup e fora do diretório público. |
| `MAX_UPLOAD_MB` | Padrão 20 (máx. 100). Ajuste também o limite de corpo do proxy reverso. |
| `SESSION_TTL_HOURS` | Padrão 12. |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT`, `AI_MAX_OUTPUT_TOKENS` | Ver [AI.md](AI.md). A chave deve vir de um cofre de segredos. Mudanças exigem reiniciar web **e** worker. |
| `WORKER_POLL_INTERVAL_MS` | Padrão 3000. |
| `LOG_LEVEL` | `info` (use `debug` só para diagnóstico). |

Web e worker precisam das **mesmas** variáveis: banco, storage e IA.

## PostgreSQL

- Desenvolvido e testado com PostgreSQL 18 (embarcado) e PGlite. Use PostgreSQL 15 ou superior.
- Recursos usados: `gen_random_uuid()`, `jsonb`, índices únicos parciais, `FOR UPDATE SKIP LOCKED`, busca textual com a configuração `portuguese` (`to_tsvector` e `websearch_to_tsquery`), que existe por padrão.
- Cada processo abre um pool de até 10 conexões (`src/server/db/client.ts`). Dimensione `max_connections` para (instâncias web + workers) × 10, mais a folga.
- Não há índices de texto completo materializados. A busca de perguntas à base calcula `to_tsvector` na hora, o que fica lento com muitos documentos (ver "Escala").
- O banco embarcado (`npm run db:dev`, dados em `.data/postgres`) é **só para desenvolvimento**.

## Migrações

- `npm run db:migrate` aplica, em ordem, os arquivos de `drizzle/` ainda não aplicados (controle na tabela de migrações do Drizzle).
- Gere novas migrações com `npm run db:generate -- --name <mudanca>` e versione o SQL. Nunca edite uma migração aplicada.
- Faça backup antes de migrar em produção.

## Armazenamento e backups

- Os arquivos ficam em `STORAGE_DIR/<organizationId>/<documentId>/<versionId>`, sem extensão. O nome e o MIME estão no banco (`document_versions`).
- O banco referencia os arquivos por `storage_key`. **Faça backup do banco e de `STORAGE_DIR` juntos** (mesma janela) para manter a consistência. Teste a restauração periodicamente.
- Documentos excluídos (exclusão lógica) **mantêm** os arquivos no disco. Não há limpeza automática.
- Com mais de uma instância web, `STORAGE_DIR` precisa ser um volume compartilhado, ou é preciso trocar para um storage de objetos (ver [ARCHITECTURE.md](ARCHITECTURE.md#como-trocar-o-armazenamento-s3-ou-compatível)).
- Criptografia em repouso depende do volume ou disco (não é feita pela aplicação).

## Health check

`GET /api/health` (público, sem dados sensíveis, `Cache-Control: no-store`):

- `200 {"status":"ok","database":"ok"}`
- `503 {"status":"degraded","database":"error"}` quando o banco não responde

Use como readiness/liveness da instância web. O worker não expõe porta: monitore pelo processo e pelos logs (`worker_started`, `job_failed`, `worker_tick_failed`) e pela idade dos jobs `queued` na tabela `jobs`.

## Logs

- JSON por linha em stdout (`debug`/`info`) e stderr (`warn`/`error`), com campos `t`, `level`, `msg` e contexto.
- Chaves sensíveis são redigidas automaticamente (ver [SECURITY.md](SECURITY.md#logs-e-redação)). Mesmo assim, trate os logs como dados internos com acesso restrito.
- Eventos úteis:
  - `auth.login_failed`;
  - `job_succeeded`, `job_failed` (com `outcome: dead` quando esgotou as tentativas), `jobs_recovered`;
  - `routine_completed`, `analysis_run_failed`;
  - `document_upload_failed`, `document_download_failed`, `health_db_failed`.
- O resumo de cada rotina fica em `scheduled_routines.last_status`, visível em Administração → Configurações.

## Escala

- **Web**: sem estado em memória entre requisições, **exceto** o limitador de tentativas de login, que é por processo. Com várias instâncias, cada uma conta separadamente, e um reinício zera os contadores. Atrás de balanceador, repasse `Host`/`X-Forwarded-Host` e `X-Forwarded-For` (o IP vai para a auditoria e para o limitador).
- **Worker**: um worker basta para cargas pequenas. Vários workers são seguros:
  - jobs são reservados com `FOR UPDATE SKIP LOCKED`;
  - rotinas são reservadas avançando `next_run_at` atomicamente;
  - jobs presos em `running` por mais de 15 minutos voltam à fila.

  Análises de IA são executadas em série dentro de cada worker (lotes de até 10 jobs).
- **IA**: o custo é controlado pelo orçamento mensal por organização. Limites de taxa do provedor viram retentativas com backoff.
- **Crescimento de tabelas**: `jobs` concluídos, `audit_logs` e `ai_analyses` não são expurgados nesta versão. Planeje limpeza ou particionamento conforme o volume.
- **Busca**: para muitas versões de documentos, avalie um índice GIN sobre `to_tsvector('portuguese', extracted_text)` (exige migração e ajuste na consulta).

## Fuso horário

Datas de calendário (`YYYY-MM-DD`) não têm fuso. A interface e "hoje" usam `America/Sao_Paulo`, independentemente do fuso do servidor. O período de uso de IA (`ai_usage.period`) é por mês em UTC.

## Checklist rápido de produção

- [ ] `APP_URL` com `https://` e TLS no proxy reverso
- [ ] Banco com TLS, backup automático e restauração testada
- [ ] `STORAGE_DIR` em volume persistente e criptografado, com backup junto do banco
- [ ] Web e worker supervisionados; health check configurado
- [ ] Seed de demonstração **não** executado; organização real e admin criados
- [ ] Chave de IA em cofre; orçamento mensal definido; contrato de tratamento de dados com o fornecedor de IA
- [ ] Itens de [SECURITY.md → O que ainda precisa ser avaliado](SECURITY.md#o-que-ainda-precisa-ser-avaliado-antes-de-uso-em-produção) avaliados
