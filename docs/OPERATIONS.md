# Operação

Guia para executar o Praetor fora do ambiente de desenvolvimento. Esta versão ainda é demonstrativa em pontos importantes: análise preliminar e e-mail são simulados, e a única coleta nos tribunais é a API pública do DataJud (ver [STATUS.md](STATUS.md)). Revise [SECURITY.md](SECURITY.md#o-que-ainda-precisa-ser-avaliado-antes-de-uso-em-produção) antes de usar dados reais.

## Componentes

| Processo | Comando | Função |
|---|---|---|
| Web | `npm run build` e depois `npm start` (`next start`, porta 3000 ou `PORT`) | Páginas, server actions, uploads (documentos e planilhas), downloads e exportações, API de entrada (`/api/v1`), token dos painéis Power BI, `/api/health`. |
| Worker | `npm run worker` (`tsx scripts/worker.ts`) | Fila de jobs e agendamento de rotinas. **Obrigatório**: sem ele, extrações de texto e análises ficam "Na fila", o pipeline da entrada de processos não avança, a distribuição após a importação não roda, nada é consultado no DataJud, os painéis Power BI não são atualizados, as séries de índices não são coletadas e nenhuma rotina de alerta roda. |
| PostgreSQL | gerenciado ou próprio | Todos os dados, a fila, as sessões e o schema `bi` (visões do Power BI). |
| Armazenamento | diretório `STORAGE_DIR` | Arquivos enviados (versões de documentos), planilhas originais das importações e PDFs dos relatórios jurídicos. |

O worker roda TypeScript com `tsx`, que é dependência de desenvolvimento. Instale com `npm ci` (incluindo devDependencies) ou empacote o worker antes do deploy.

### Jobs e rotinas

O worker cria as rotinas que faltam em cada organização ao iniciar e depois a cada hora (`ensureDefaultRoutines`). Intervalos e ativação ficam em Administração, Configurações, Rotinas; o resumo de cada execução fica em `scheduled_routines.last_status`.

| Rotina | Intervalo padrão | O que faz |
|---|---|---|
| `deadline_alerts` | 60 min | Alertas de prazos vencidos, próximos e aguardando validação. |
| `contract_expiration_alerts` | 6 h | Vigência contratual e obrigações. |
| `stale_analysis_refresh` | 24 h | Reanálise de análises desatualizadas (desligada na configuração padrão: `autoRefresh: false`). |
| `retention_review` | 7 dias | Só conta registros elegíveis para revisão de retenção. |
| `hearing_alerts` | 60 min | Alertas e lembretes de audiência (e-mail simulado) para processos da carteira ativa. |
| `portfolio_alerts` | 6 h | Parcelas a vencer, valores aguardando conferência, execução sem valor, garantia parada, processo pendente de conferência. |
| `monthly_snapshot` | 24 h | Atualiza a prévia do mês corrente e abre os alertas de processos sem classificação que impedem o fechamento. **Nunca fecha** uma competência. |
| `court_sync` | 60 min | Enfileira um job `court_sync.run` por tribunal com processos aguardando consulta ao DataJud. Sem `DATAJUD_API_KEY`, só registra "Coleta inativa". |
| `simulated_feed` | 15 min (verificação) | Só em organização de demonstração e quando ligada nas configurações: uma chegada **fictícia** de processo a cada intervalo configurado (padrão 120 min, mínimo 5). Vem desligada. |
| `bi_access_refresh` | 60 min | Recalcula os acessos do Power BI e, quando há motivo, enfileira `bi.refresh` (intervalo mínimo de 60 min, até 8 por dia, uma vez a cada 24 h mesmo sem novidades). Sem credenciais, só recalcula os acessos. |
| `index_series_refresh` | 24 h | Coleta os meses que faltam das séries IPCA-E, IPCA, INPC, Selic e TR na API pública do Banco Central (SGS). |

Jobs: `analysis.run`, `document.extract_text`, `routine.run`, `intake.process` (pipeline da entrada), `case_brief.generate` (análise preliminar pedida fora da entrada), `court_sync.run` (consulta de um tribunal; até 400 processos por job, depois continua sozinho), `bi.refresh` (pedido de atualização ao Power BI) e `import.distribute` (distribuição dos processos novos de uma importação, em blocos de 100). As ações manuais da tela da entrada rodam na própria requisição.

## Passo a passo

1. Defina as variáveis de ambiente (tabela abaixo). Em produção, `APP_URL` deve ser a URL `https://` pública, porque isso ativa o cookie `Secure` e a checagem de origem dos uploads.
2. `npm ci`
3. Faça **backup** (banco e `STORAGE_DIR` juntos) antes de migrar.
4. `npm run db:migrate`: aplica as migrações de `drizzle/` (`0000` a `0013`). Rode a cada deploy, **antes** de subir a nova versão.
5. Ao atualizar uma base da v1 para a v2, rode `npm run db:backfill:v2` depois da migração (ver [Atualizar uma base da v1](#atualizar-uma-base-da-v1-para-a-v2)).
6. `npm run build`
7. Suba `npm start` e `npm run worker` com um supervisor (systemd, PM2, contêiner) que reinicie em caso de falha. O worker trata SIGINT e SIGTERM e termina o ciclo atual antes de sair.
8. **Não** rode `npm run db:seed` nem `npm run db:seed:v2` em produção: eles criam organizações e contas **de demonstração** com senha conhecida (e uma chave de API de demonstração). `npm run db:seed -- --reset` **apaga todos os dados de todas as organizações** e os arquivos armazenados.
9. Crie a organização real e o primeiro administrador. **Pendente**: não há tela nem script de bootstrap de organização; hoje isso exige um script próprio que insira `organizations` e `users` (senha com `hashPassword` de `src/server/auth/password.ts`). Depois, cadastre empresas, escritórios externos, unidades e usuários pela administração.
10. Integrações (opcionais, cada uma independente): DataJud ([abaixo](#datajud-cnj)), API de entrada ([abaixo](#api-de-entrada)) e Power BI ([abaixo](#power-bi)).

## Variáveis de ambiente

| Variável | Produção |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Obrigatória. Use TLS (`?sslmode=require`) e um usuário com privilégios mínimos (DDL só para quem aplica migrações). |
| `APP_URL` | URL pública `https://…` (também usada nos links absolutos dos e-mails simulados e das respostas da API de entrada). |
| `STORAGE_DIR` | Caminho absoluto em volume persistente, com backup e fora do diretório público. |
| `MAX_UPLOAD_MB` | Padrão 20 (máx. 100) para documentos, inclusive os enviados pela API de entrada. Planilhas de importação têm limite fixo de 15 MB. Ajuste também o limite de corpo do proxy reverso. |
| `SESSION_TTL_HOURS` | Padrão 12. |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT`, `AI_MAX_OUTPUT_TOKENS` | Só a Central de IA ([AI.md](AI.md)). Não ativam a IA na análise preliminar. A chave deve vir de um cofre de segredos. |
| `WORKER_POLL_INTERVAL_MS` | Padrão 3000. |
| `LOG_LEVEL` | `info` (use `debug` só para diagnóstico). |
| `DATAJUD_API_KEY` | Chave **pública** do DataJud, publicada pelo CNJ em `https://datajud-wiki.cnj.jus.br/api-publica/acesso` (só a chave, sem o prefixo "APIKey "). O CNJ pode trocá-la a qualquer momento. Vazia = coleta inativa (nada quebra). |
| `DATAJUD_BASE_URL`, `DATAJUD_TIMEOUT_MS` | Padrões `https://api-publica.datajud.cnj.jus.br` e 60000 ms (as consultas costumam levar de 7 a 25 s). |
| `POWERBI_TENANT_ID`, `POWERBI_CLIENT_ID`, `POWERBI_CLIENT_SECRET` | Aplicativo registrado no Microsoft Entra ID para os painéis Power BI. Sem as três, `/paineis-bi` mostra as instruções e nenhuma atualização é pedida. O segredo deve vir de um cofre e ser trocado periodicamente. |
| `POWERBI_API_URL`, `POWERBI_AUTHORITY_URL` | Só mudam em nuvens governamentais da Microsoft. |
| `BI_DB_PASSWORD` | Senha do usuário de banco somente leitura do Power BI, usada só por `scripts/bi-setup.ts`. |
| `PRAETOR_API_KEY`, `PRAETOR_API_URL` | Só para `scripts/demo-api-push.ts` (sistema externo de demonstração). |

Web e worker precisam das **mesmas** variáveis, e mudanças exigem reiniciar os dois. Não existem variáveis de provedor de e-mail nem de provedor da análise preliminar: ambos são sempre simulados nesta versão.

## PostgreSQL

- Desenvolvido e testado com PostgreSQL 18 (embarcado) e PGlite. Use PostgreSQL 15 ou superior, em **UTF-8**.
- Recursos usados: `gen_random_uuid()`, `jsonb`, índices únicos parciais e de expressão, `FOR UPDATE SKIP LOCKED`, `pg_advisory_xact_lock`, busca textual com a configuração `portuguese`, funções e triggers PL/pgSQL (índice padrão das valorações, imutabilidade dos relatórios jurídicos), visões com `security_barrier` no schema `bi` e um papel de banco somente leitura para o Power BI.
- Cada processo abre um pool de até 10 conexões (`src/server/db/client.ts`). Dimensione `max_connections` para (instâncias web + workers) × 10, mais a folga e as conexões do Power BI.
- O banco embarcado (`npm run db:dev`, dados em `.data/postgres`) é **só para desenvolvimento**.

### Banco de desenvolvimento em UTF-8

`npm run db:dev` inicializa o cluster com `--encoding=UTF8` e ICU pt-BR, independentemente da página de código do sistema (o Windows usa WIN1252 por padrão, que recusa caracteres como "→" e emoji). Quando o banco do `DATABASE_URL` não existe, ele é criado em UTF-8 (`template0`, ICU pt-BR); quando existe com outra codificação, o comando avisa e aponta para esta seção.

### Migrar o banco local para UTF-8

Para um banco de desenvolvimento criado antes dessa mudança (por exemplo, em WIN1252):

1. Pare a aplicação e o worker (deixe `npm run db:dev` rodando).
2. `npm run db:backup -- --label antes-utf8` (grava tabelas e arquivos em `.data/backups/<data-hora>_antes-utf8/`).
3. Renomeie o banco antigo com qualquer cliente PostgreSQL conectado ao banco `postgres` (porta 54329, usuário e senha do `DATABASE_URL`): `ALTER DATABASE praetor RENAME TO praetor_win1252_antigo;` (o PostgreSQL recusa enquanto houver conexões abertas no banco).
4. Pare e suba de novo `npm run db:dev`: ele cria um `praetor` novo em UTF-8.
5. `npm run db:migrate` (o banco novo precisa ter o mesmo schema do backup ou um mais novo).
6. `npm run db:restore -- .data/backups/<pasta>_antes-utf8 --yes`.
7. Suba a aplicação e confira. Mantenha o banco antigo até ter certeza; depois ele pode ser removido com `DROP DATABASE praetor_win1252_antigo;`.

Cuidados: o restore insere as linhas com os triggers ligados, então valorações antigas sem índice informado (`correction_index` nulo, anteriores à migração `0007`) recebem o índice padrão da organização (normalmente "nenhum"). O backup não leva a tabela de controle das migrações nem os papéis de banco (usuários de leitura do Power BI): rode o `bi-setup` de novo depois.

O banco de desenvolvimento deste projeto já foi migrado assim; o antigo ficou como `praetor_win1252_antigo` e o backup como `.data/backups/2026-10-12T00-49-46-721Z_antes-utf8`. Esta documentação descreve o procedimento a partir dos scripts; ele não foi repetido nesta revisão.

## Migrações

- `npm run db:migrate` aplica, em ordem, os arquivos de `drizzle/` ainda não aplicados (controle na tabela `drizzle.__drizzle_migrations`). Lista e conteúdo de cada uma em [DATA_MODEL.md](DATA_MODEL.md#migrações-0000-a-0013).
- `0000_initial.sql` é a v1; `0001_v2_portfolio.sql` é a v2 (só adições). Da `0002` em diante, cada migração tem a reversão em `drizzle/down/<tag>.sql`.
- Gere novas migrações com `npm run db:generate -- --name <mudanca>` e versione o SQL. Com mais de uma pessoa ou agente no mesmo diretório, crie a trava `mkdir .data/locks/db-generate` antes e remova-a depois. Nunca edite uma migração aplicada.
- Faça backup antes de migrar.
- **Reversão**: `npm run db:rollback -- <tag> --yes` (ex.: `npm run db:rollback -- 0013_process_detail_indexes --yes`) roda `drizzle/down/<tag>.sql` e remove a linha da migração de `drizzle.__drizzle_migrations` numa única transação. Só reverte a **última** migração aplicada (recusa quando ela não está aplicada ou há outra depois dela); sem `--yes`, só mostra o uso. Para voltar várias, rode uma por vez, da mais nova para a mais antiga. Faça `npm run db:backup` antes. `npm run db:migrate` reaplica.
- Antes de reverter as migrações do Power BI (`0003` a `0006` e `0011`), remova os usuários de leitura: sem a barreira de segurança ou com as visões antigas, um usuário de leitura poderia enxergar linhas de outra organização ([POWER_BI.md](POWER_BI.md#7-desfazer)).
- `0012_phase_instance_split` (P0.5) separa fase e instância: a fase passa a ser só conhecimento, liquidação ou execução, a fase anterior fica em `legacy_phase` e "recurso" vira instância (2º/3º grau). Processos com fase anterior "Pré-ajuizamento", "Acordo" ou "Recurso" sem instância recursal conhecida ficam **pendentes de conferência**, com uma linha de auditoria `legal_process.phase_migration` por processo afetado. Competências fechadas não são tocadas; uma prévia calculada antes da migração precisa ser recalculada antes do fechamento. A reversão restaura a fase anterior, desfaz só o que a migração definiu e mantém as linhas de auditoria (acrescenta `legal_process.phase_migration_rollback`).

## Atualizar uma base da v1 para a v2

1. `npm run db:backup -- --label antes-da-v2` (desenvolvimento/demonstração; em produção, o backup nativo do banco + `STORAGE_DIR`).
2. `npm run db:migrate` (aplica da `0001` até a `0013`).
3. `npm run db:backfill:v2`: completa, em **todas as organizações** do `DATABASE_URL`, o histórico que os registros anteriores à v2 não têm. É **idempotente e aditivo** (nada é apagado ou sobrescrito), uma transação por organização, auditado com contexto de sistema:
   - processo com valor da causa e sem valoração de causa → uma valoração **oficial** de causa (origem manual, data-base = ajuizamento ou cadastro, quem cadastrou o processo como criador e revisor, motivo "Valor da causa do cadastro anterior à v2 (migrado)"); processos carregados por importação da v2 ficam de fora;
   - processo com probabilidade de perda e sem classificação de risco → uma classificação **oficial** com o percentual da organização, vigente desde o cadastro, com parecer pedindo revisão; os espelhos do processo são recalculados.
   - O resumo informa quantos registros ficaram sem pessoa identificada no cadastro original.
4. Reinicie web e worker. O worker cria as rotinas novas de cada organização (`ensureDefaultRoutines`).

## Integrações

### DataJud (CNJ)

1. Copie a chave pública da página de acesso da API pública do DataJud para `DATAJUD_API_KEY` e reinicie web e worker.
2. Em Administração, Integrações, DataJud: confira "Coleta ativa", ajuste os parâmetros (intervalo entre consultas do mesmo processo, de 1 a 720 h; limite por minuto por tribunal, de 1 a 120; números por consulta, de 1 a 500; aplicar mudanças de fase inequívocas; completar processos recebidos pela API) e, se quiser, use "Sincronizar a carteira agora".
3. A saúde da coleta (última execução e resultado por tribunal, falhas, processos aguardando) fica na mesma página. Três execuções falhas seguidas de um tribunal, ao longo de 2 h ou mais, abrem um alerta crítico.

Limites: o limite por minuto fica em memória no worker; com vários workers, cada um respeita o seu. O DataJud não informa partes, valores, documentos nem a data das audiências.

### API de entrada

1. Em Administração, Integrações, API de entrada, crie uma chave por sistema externo, só com os escopos necessários e, se possível, com validade. A chave aparece **uma única vez**: entregue-a ao sistema por um canal seguro.
2. O sistema envia `Authorization: Bearer prt_…` para `POST /api/v1/processos` (ver [API.md](API.md) e `GET /api/v1/openapi.json`).
3. A mesma página mostra as requisições das últimas 24 h por situação. Revogue a chave que vazar ou não for mais usada.

`/api/v1/*` fica fora do proxy de sessão. Atrás de proxy reverso, repasse `X-Forwarded-For` (o IP vai para `last_used_ip`) e ajuste o limite de corpo (até 20 documentos em base64 por requisição). O limite de 60 requisições por minuto por chave é por instância.

Demonstração: `PRAETOR_API_KEY=prt_… npx tsx scripts/demo-api-push.ts` envia um processo fictício ao servidor local (`--dry-run` só mostra o resumo).

### Power BI

Passo a passo completo, para quem não é da área técnica, em [POWER_BI.md](POWER_BI.md). Em resumo:

1. Registre o aplicativo no Microsoft Entra ID, libere-o no Power BI e no workspace, e preencha `POWERBI_TENANT_ID`, `POWERBI_CLIENT_ID` e `POWERBI_CLIENT_SECRET`.
2. Com as migrações aplicadas, crie o usuário de banco somente leitura: `BI_DB_PASSWORD='senha-forte' npx tsx scripts/bi-setup.ts` (com várias organizações no banco, um usuário por organização: `--org=<id> --role=praetor_bi_<nome curto>`; `--print` só mostra os comandos, para bancos gerenciados). O script confere que o usuário só lê o schema `bi`, desfaz tudo se algo falhar, copia os rótulos e recalcula os acessos. **Rode de novo depois de cada atualização do Praetor** que recrie visões do schema `bi`.
3. Monte o relatório no Power BI Desktop sobre as visões do schema `bi`, com o papel de segurança por linha, publique e cadastre os ids em Administração, Integrações, Power BI ("Testar conexão" ajuda a copiá-los).
4. A rotina `bi_access_refresh` mantém os acessos e pede as atualizações; "Atualizar agora" e o histórico ficam na mesma página.

Recomendado: `REVOKE TEMPORARY ON DATABASE <banco> FROM PUBLIC` (o bi-setup avisa enquanto essa permissão existir).

### Índices de correção (Banco Central)

A rotina `index_series_refresh` usa a API pública do SGS, sem chave. A situação de cada série (último mês, meses faltando, último erro) e o botão "Atualizar agora" ficam em Administração, Integrações; o índice aplicado aos valores novos, em Administração, Configurações. Uma falha de rede fica registrada e a coleta tenta de novo nas próximas execuções.

## Dados de demonstração

| Comando | O que faz |
|---|---|
| `npm run db:setup` | `db:migrate` + `db:seed` + `db:seed:v2`. |
| `npm run db:seed` | Cria as organizações fictícias "Grupo Aurora Exemplo S.A. (demonstração)" e "Outra Empresa Ltda. (teste de isolamento)" com as contas e os dados da v1. Não faz nada se a organização demo já existir. |
| `npm run db:seed:v2` | **Incremental e idempotente, passo a passo**: cada passo confere a própria marca e só acrescenta o que falta, sem apagar nada e sem tocar outras organizações. Numa base que já tem uma demonstração v2 anterior, acrescenta só os dados novos; quando todas as marcas existem, termina sem mudanças. `--skip=<passo>[,<passo>]` (claims, suggestions, scenarios, indices, api-key) deixa passos de fora. |
| `npm run db:seed -- --reset` | **Apaga todos os dados de todas as organizações** e os arquivos armazenados e recria a demonstração da v1; depois rode `npm run db:seed:v2`. Só em desenvolvimento. |

Passos do `db:seed:v2` (pelos serviços reais dos módulos, com o contexto do usuário demo que faria cada ação): rotinas; empresa, escritório e unidades regionais fictícios e as contas da v2; regras de distribuição; importação da planilha fictícia pelo gestor jurídico (data-base 2026-07-29) com distribuição; classificações de risco, sugestões, garantias, atualizações de valor, uma quitação, acordos e o fechamento dos dois meses anteriores (pela contabilidade, **com justificativa** quando há processos sem classificação; só a primeira execução fecha meses) mais a prévia do atual; audiências; três chegadas simuladas com análise preliminar e e-mail simulados e a revisão do advogado; uma ocorrência preventiva com plano de ação; pedidos avaliados de 20 processos e sugestões de pedidos das análises preliminares; cenários de 4 processos; uma execução da coleta de índices do Banco Central (API real; falha de rede é registrada e a carga continua); uma execução das demais rotinas (exceto DataJud, que a carga nunca chama, e a chegada simulada, que continua desligada); um resumo diário simulado; e uma **chave de API de demonstração**, mostrada **uma vez** na saída da carga (para outra, revogue a atual e rode a carga de novo). Todos os dados são fictícios.

## Backup e restauração

Scripts de **backup lógico** para desenvolvimento e demonstração. Em produção, use os backups nativos do banco (`pg_dump`, snapshots gerenciados) junto com `STORAGE_DIR`.

- `npm run db:backup` (ou `npm run db:backup -- --label <nome>`) grava em `.data/backups/<data-hora>[_<nome>]/`:
  - `tables/<tabela>.json`: todas as linhas de **todas as tabelas do schema `public`**;
  - `storage/`: cópia de `STORAGE_DIR`, quando existe;
  - `manifest.json`: data, banco, migrações aplicadas, contagem de linhas e SHA-256 do arquivo de cada tabela.
- `npm run db:restore -- <pasta-do-backup> --yes` é **destrutivo**: numa transação, trunca todas as tabelas presentes no backup e recarrega as linhas em ordem de dependência das chaves estrangeiras; depois substitui `STORAGE_DIR` pelos arquivos do backup. Sem `--yes`, não faz nada.
- O que **não** cobre: a tabela de controle de migrações (schema `drizzle`), o schema `bi` (só visões, recriadas pelas migrações) e os papéis de banco. O banco de destino precisa ter o mesmo schema ou um mais novo (aplique as migrações antes); colunas criadas depois do backup ficam com o padrão ou nulo. Os triggers ficam ligados durante o restore (ver o cuidado com `correction_index` em [Migrar o banco local para UTF-8](#migrar-o-banco-local-para-utf-8)). Não há agendamento, retenção nem cópia fora da máquina.
- Backups existentes do desenvolvimento: `_antes-da-v2`, `_antes-do-seed-v2` e `_antes-utf8` em `.data/backups/`.

## Armazenamento

- Os arquivos ficam em `STORAGE_DIR/<organizationId>/…`, sem extensão; o nome e o MIME estão no banco.
- O banco referencia os arquivos por `storage_key`. **Faça backup do banco e de `STORAGE_DIR` juntos** (mesma janela). O PDF de um relatório jurídico é conferido pelo SHA-256 guardado antes de cada download (um arquivo divergente é recusado).
- Documentos excluídos (exclusão lógica) **mantêm** os arquivos no disco. Não há limpeza automática.
- Com mais de uma instância web, `STORAGE_DIR` precisa ser um volume compartilhado, ou é preciso trocar para um storage de objetos (ver [ARCHITECTURE.md](ARCHITECTURE.md#como-trocar-o-armazenamento-s3-ou-compatível)).

## Health check

`GET /api/health` (público, sem dados sensíveis, `Cache-Control: no-store`):

- `200 {"status":"ok","database":"ok"}`
- `503 {"status":"degraded","database":"error"}` quando o banco não responde

Use como readiness/liveness da instância web. O worker não expõe porta: monitore pelo processo, pelos logs e pela idade dos jobs `queued`. **Administração, Integrações** mostra a fila por situação e tipo, o job mais antigo, falhas, a última execução de cada rotina, as últimas importações, análises preliminares, e-mails simulados e as séries de índices; as subpáginas DataJud, API de entrada e Power BI mostram a saúde de cada integração.

## Logs

- JSON por linha em stdout (`debug`/`info`) e stderr (`warn`/`error`), com campos `t`, `level`, `msg` e contexto.
- Chaves sensíveis são redigidas automaticamente (ver [SECURITY.md](SECURITY.md#logs-e-redação)). Mesmo assim, trate os logs como dados internos com acesso restrito.
- Eventos úteis:
  - `auth.login_failed`; `job_succeeded`, `job_failed` (com `outcome: dead` quando esgotou as tentativas), `jobs_recovered`; `routine_completed`;
  - documentos, entrada, análise preliminar e e-mails: `document_upload_failed`, `document_download_failed`, `intake_registered`, `case_brief_generated`, `case_brief_run_failed`, `email_send_failed`, `hearing_reminder_failed`, `health_db_failed`;
  - importação: `import_upload_failed`, `import_distribution_failed`, `import_distribution_interrupted`, `import_distribution_stopped`;
  - DataJud: `court_sync_run`, `court_sync_apply_failed`, `datajud_request_failed`, `court_lookup`, `simulated_feed_arrival`;
  - API de entrada: `inbound_process_failed`, `inbound_route_failed`, `inbound_status_failed`, `inbound_request_log_failed`, `inbound_court_apply_failed`;
  - Power BI: `bi_embed_token_rejected`, `bi_embed_token_failed`, `bi_refresh_failed`, `bi_refresh_rejected`, `bi_refresh_status_failed`;
  - índices e relatórios jurídicos: `bcb_sgs_request_failed`, `index_series_refresh_failed`, `legal_report_pdf_hash_mismatch`.

## Escala e limites

- **Web**: sem estado em memória entre requisições, **exceto** o limitador de tentativas de login e o limite por chave da API de entrada, que são por processo. Atrás de balanceador, repasse `Host`/`X-Forwarded-Host` e `X-Forwarded-For`.
- **Worker**: vários workers são seguros (`SKIP LOCKED`, rotinas reservadas atomicamente, jobs presos voltam à fila após 15 minutos). O limite de consultas por minuto ao DataJud é por worker.
- **Importação**: análise e confirmação rodam na requisição; a distribuição dos processos novos roda no worker, em blocos.
- **Relatórios jurídicos**: o PDF é gerado dentro da transação que trava a numeração; emissões do mesmo tipo e ano na mesma organização esperam em fila alguns segundos. A emissão concorrente ainda precisa ser validada em PostgreSQL real.
- **Exportações**: carteira até 20.000 processos por arquivo; auditoria até 10.000 linhas; movimentação até 10.000 eventos; memória de cálculo em PDF até 3.000 processos (acima disso, XLSX).
- **Crescimento de tabelas**: `jobs` concluídos, `audit_logs`, `ai_analyses`, `email_messages`, `import_rows`, `case_brief_revisions`, `inbound_requests`, `court_sync_runs` e `bi_refresh_runs` não são expurgados nesta versão.

## Fuso horário

Datas de calendário (`YYYY-MM-DD`) não têm fuso. A interface e "hoje" usam `America/Sao_Paulo`, independentemente do fuso do servidor. A movimentação do período usa o deslocamento fixo −03:00 para os limites do dia. As séries de índices nunca coletam o mês corrente (o mês M só a partir do dia de confirmação do mês M+1, em São Paulo). O período de uso de IA (`ai_usage.period`) é por mês em UTC.

## Checklist rápido de produção

- [ ] `APP_URL` com `https://` e TLS no proxy reverso
- [ ] Banco em UTF-8, com TLS, backup automático e restauração testada (os scripts `db:backup`/`db:restore` não substituem isso)
- [ ] `STORAGE_DIR` em volume persistente e criptografado, com backup junto do banco
- [ ] Web **e worker** supervisionados; health check configurado
- [ ] Seeds de demonstração **não** executados; organização real e admin criados
- [ ] Ao vir da v1: `db:migrate` e `db:backfill:v2` executados depois do backup
- [ ] Chaves de API criadas por sistema, com escopo mínimo; chave de demonstração inexistente
- [ ] `DATAJUD_API_KEY` conferida com a página do CNJ
- [ ] Power BI: segredo em cofre, usuário de leitura criado pelo `bi-setup` (de novo após cada atualização), `REVOKE TEMPORARY` aplicado
- [ ] Chave de IA em cofre; orçamento mensal definido; contrato de tratamento de dados com o fornecedor de IA
- [ ] Usuários avisados de que análise preliminar e e-mail são simulados nesta versão
- [ ] Itens de [SECURITY.md, O que ainda precisa ser avaliado](SECURITY.md#o-que-ainda-precisa-ser-avaliado-antes-de-uso-em-produção) avaliados
