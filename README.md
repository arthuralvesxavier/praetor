# Praetor

Plataforma de gestão jurídica corporativa para departamentos jurídicos internos no Brasil. A versão 2 substitui o controle do passivo judicial em planilha por uma base viva e auditável:

- **Carteira de processos** por número CNJ, com fase e instância separadas, empresas do grupo, escritórios externos e saída da carteira ativa com motivo.
- **Contingências**: valor da causa e valor apurado sempre separados, valores com histórico (nada é sobrescrito), fila de conferência humana, garantias e exposição líquida, classificação de risco por processo e **por pedido**, valor atualizado por índice do Banco Central, provisão, acordos e fechamento mensal imutável com memória de cálculo.
- **Automação**: acompanhamento da carteira no **DataJud (CNJ)**, **API de entrada** para sistemas externos enviarem processos novos e **painéis Power BI** com as mesmas regras de acesso do sistema.
- **Entrada de processos**: distribuição por regras, leitura dos documentos e **análise preliminar** para revisão do advogado, aviso por e-mail. *Nesta versão a análise preliminar e o e-mail são simulações demonstrativas.*
- **Relatórios jurídicos em PDF** com numeração, fontes conferidas, aprovação e versões (motor pronto; os relatórios R1 a R4 estão pendentes).
- **Jurídico preventivo, contratos, documentos, prazos, audiências, alertas, relatórios e inteligência preventiva.**
- **Central de IA** (da v1): análises de documentos e registros com fontes citadas, limitações e aviso de que **não substitui o advogado**.

> **Ambiente demonstrativo.** Os dados criados pelos seeds são **fictícios** e organizações de demonstração exibem uma faixa de aviso em todas as telas. Nesta versão:
>
> - a **análise preliminar** é gerada por regras determinísticas, **sem inteligência artificial**, e é rotulada como simulação;
> - **nenhum e-mail é enviado**: as mensagens são apenas registradas na Central de e-mails, com a marca "[Simulação]";
> - a única coleta nos tribunais é a **API pública do DataJud**, ativa só com `DATAJUD_API_KEY` configurada; MNI, PJe, consulta pública dos TRTs e diário eletrônico **não são integrados**;
> - a Central de IA roda em **modo demonstrativo** (regras de texto) quando não há chave de API.
>
> O projeto **não** declara conformidade legal (LGPD ou outra) nem segurança completa. Veja [docs/SECURITY.md](docs/SECURITY.md), [docs/STATUS.md](docs/STATUS.md) e a matriz de requisitos em [docs/RASTREABILIDADE.md](docs/RASTREABILIDADE.md).

## O que há de novo (outubro de 2026)

- **Telas mais limpas**: ficha do processo em 6 abas com a faixa "Exige decisão agora"; carteira com uma linha por processo e resumo de 4 números; painel em 3 blocos (decisão, carteira, mais indicadores recolhidos); um único selo "Simulações" no cabeçalho; textos sem travessão e sem códigos internos.
- **Fase e instância separadas**: fase é Conhecimento, Liquidação ou Execução; "em recurso" é a instância (2º ou 3º grau).
- **Painel**: exposição líquida (valor apurado menos garantias vinculadas, com o detalhe do que foi abatido), cobertura do valor apurado (nunca "R$ 0" para não apurado), gráfico único por dimensão e a lista de garantias paradas.
- **Pedidos do processo**: risco avaliado por pedido; a classificação do processo deriva dos pedidos; pedido sem valor nunca vale zero.
- **Índices de correção**: IPCA-E, IPCA, INPC, Selic e TR coletados do Banco Central; o valor atualizado é calculado na leitura, ao lado do original, e nunca somado.
- **Fechamento mensal com bloqueio**: competência com processo sem classificação de risco só fecha com justificativa registrada; **memória de cálculo** em XLSX e PDF.
- **DataJud**: movimentações novas, campos vazios da capa, alertas de movimentação relevante e de audiência designada, saúde da coleta por tribunal; nada é encerrado automaticamente.
- **API de entrada** (`/api/v1`) com chaves por sistema, idempotência e limite por minuto; **Power BI** com camada de leitura governada e segurança por usuário.
- **Migrações reversíveis** (`npm run db:rollback`) e banco de desenvolvimento em UTF-8.

O que funciona de verdade, o que é simulado e o que falta está em [docs/STATUS.md](docs/STATUS.md).

## Funcionalidades desta versão

| Área | O que existe |
|---|---|
| Painel executivo (`/dashboard`) | "Exige decisão agora" (audiências da semana, prazos fatais, parcelas, garantias paradas, valores a conferir); carteira com exposição líquida, cobertura do valor apurado, comparação com a última competência fechada, gráfico por tribunal, instância, fase, cidade, empresa e unidade; "Mais indicadores" recolhido. Filtro por empresa. |
| Alertas e pendências (`/alertas`) | Painel por área, resolução com registro de quem resolveu, cada alerta abrindo a aba do seu tipo. Sino no cabeçalho. |
| Carteira de processos (`/processos`) | Filtros da planilha do cliente, recorte ativa/encerrada, totais separados, exportação CSV/Excel no layout da planilha, retirada da carteira, pendentes de conferência. |
| Ficha do processo (`/processos/[id]`) | Resumo com a faixa de decisão; partes e andamento (linha do tempo única das instâncias e DataJud); valores e acordos (valores, índices, exposição líquida, pedidos, acordos, cenários); prazos e audiências; documentos e análises (com os downloads de documentos sensíveis); histórico. |
| Importação de planilhas (`/importacoes`) | Análise antes de gravar, relatório de inconsistências, divergências viram valores propostos, confirmação idempotente, distribuição em segundo plano e desfazer. |
| Entrada de processos (`/entrada`) e distribuição (`/distribuicao`) | Cadastro com documentos, pipeline em etapas (responsável, análise preliminar simulada, e-mail simulado, revisão, aprovação), regras de distribuição, painel de carga. Processos chegam também pela API de entrada; na demonstração, "Simular chegada de processo". |
| Análises preliminares (`/analises-preliminares`) | Fila de revisão, proveniência de cada item com citação de documento e página, edição por revisões, aprovação, aplicação explícita de sugestões, pedidos sugeridos para confirmação. |
| Audiências (`/audiencias`), prazos e tarefas (`/prazos`) | Agenda, resultado, redesignação com histórico, alertas e lembrete por e-mail simulado; calendário, prazos, tarefas e validação de prazos sugeridos. |
| Contingências (`/contingencias`), acordos (`/acordos`) | Valores e provisão, fila de conferência com a página do documento ao lado e o índice de cada valor, garantias paradas, fechamento mensal com bloqueio, memória de cálculo (XLSX e PDF) e CSV para a contabilidade, acordos com parcelas. |
| Relatórios (`/relatorios`) e relatórios jurídicos (`/relatorios-juridicos`) | Carteira, exposição, provisão por competência fechada, carta de auditoria, movimentação, por responsável (CSV, XLSX e impressão); relatórios jurídicos em PDF com aprovação e versões (hoje só o documento de teste do motor). |
| Painéis Power BI (`/paineis-bi`) | Relatórios publicados no Power BI, exibidos com token somente leitura e as regras de acesso do Praetor. |
| Consulta ao DataJud (`/consulta-datajud`) | Consulta avulsa de um número CNJ na API pública, sem gravar nada. |
| Jurídico preventivo, inteligência preventiva, contratos, documentos | Ocorrências e planos de ação; indicadores da carteira e sugestões ilustrativas; contratos com obrigações e renovação; documentos com validação por assinatura, versões e download autenticado. |
| Central de e-mails (`/emails`), Central de IA (`/ia`), busca global (`/busca`) | Mensagens simuladas; análises e perguntas à base (v1); busca com a permissão de cada seção. |
| Administração (`/admin`) | Usuários e oito perfis, equipes, unidades, empresas, escritórios, permissões, auditoria com exportação CSV, parâmetros (contingência, índice padrão, e-mail, entrada, relatórios jurídicos), rotinas e **Integrações** (saúde da fila, DataJud, API de entrada, Power BI, séries de índices). |

## Requisitos

- **Node.js >= 20.9** e npm.
- **Não é preciso Docker nem PostgreSQL instalado**: em desenvolvimento, `npm run db:dev` sobe um PostgreSQL real embarcado (pacote `embedded-postgres`) na porta 54329, em UTF-8, com dados em `.data/postgres`.
- Os testes usam PGlite (PostgreSQL em memória) e não precisam de servidor.

## Instalação e primeira execução

```bash
npm install
cp .env.example .env          # no Windows (PowerShell): Copy-Item .env.example .env
```

**Terminal 1**: banco de dados (deixe rodando):

```bash
npm run db:dev
```

**Terminal 2**: migrações, dados de demonstração (v1 + v2), aplicação e worker:

```bash
npm run db:setup && npm run dev
```

`db:setup` roda `db:migrate`, `db:seed` e `db:seed:v2`. O primeiro seed cria duas organizações fictícias, "Grupo Aurora Exemplo S.A. (demonstração)" e "Outra Empresa Ltda. (teste de isolamento)". O seed da v2 acrescenta à organização Aurora, passo a passo e sem apagar nada: empresa, escritório externo e unidades regionais fictícios, as contas da v2, regras de distribuição, a importação da **planilha fictícia** fornecida pelo cliente (`scripts/seed-data/files/Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx`), contingências e fechamentos mensais (com justificativa, quando há processos sem classificação), audiências, três chegadas simuladas de processo, uma ocorrência da inteligência preventiva, pedidos avaliados, cenários, uma coleta das séries do Banco Central e uma **chave de API de demonstração**, mostrada uma única vez na saída. Ele nunca chama o DataJud. As datas são relativas ao dia em que o seed roda.

Abra <http://localhost:3000> e entre com uma das contas de demonstração (definidas em `src/domain/demo.ts`). A senha de todas é **`Praetor@2026`**. Enquanto existir uma organização de demonstração, a tela de login mostra essas contas com o botão "Usar esta conta".

| E-mail | Perfil | Observação |
|---|---|---|
| `admin@demo.praetor.local` | Administrador | Acesso total, inclusive administração e integrações |
| `gestor@demo.praetor.local` | Gestor jurídico | Vê tudo da organização, inclusive sigilosos; aprova valores, fecha competência, distribui, importa |
| `advogada@demo.praetor.local` | Advogado | Unidade Matriz São Paulo |
| `advogado.recife@demo.praetor.local` | Advogado | Unidade Filial Recife |
| `analista@demo.praetor.local` | Analista | Unidade Matriz São Paulo |
| `executivo@demo.praetor.local` | Executivo | Somente consulta |
| `contabilidade@demo.praetor.local` | Contabilidade | Valores, provisão, memória de cálculo e fechamento mensal |
| `auditoria@demo.praetor.local` | Auditoria | Somente consulta, relatórios e trilha de auditoria |
| `escritorio@demo.praetor.local` | Escritório externo | Só a carteira do "Escritório Parceiro Exemplo Advogados (fictício)" |
| `advogada.palmas@demo.praetor.local` | Advogado | Regional Centro-Norte (fictícia) |
| `advogado.brasilia@demo.praetor.local` | Advogado | Regional Centro-Norte (fictícia) |
| `admin@outra.praetor.local` | Administrador | Outra organização (teste de isolamento entre organizações) |

`npm run dev` sobe **duas coisas**: o Next.js (web) e o worker de segundo plano (`scripts/worker.ts`). Sem o worker, o pipeline da entrada não avança, a distribuição após a importação não roda, análises e extração de texto ficam "Na fila", nada é consultado no DataJud e as rotinas não rodam. A administração tem o botão "Processar fila agora".

## Fluxos principais

1. **Carga da carteira**: Importação de planilhas, enviar `.xlsx`, conferir abas, inconsistências e divergências, confirmar com a data-base. Valores divergentes vão para Contingências, Conferência.
2. **Chegada de um processo**: Entrada de processos (registro manual, API de entrada ou "Simular chegada de processo" na demonstração); o worker distribui pelas regras, gera a análise preliminar **simulada** e registra o e-mail **simulado** ao advogado; o advogado revisa e aprova em Análises preliminares. Prazos, tarefas, valores e pedidos só são criados quando ele clica.
3. **Acompanhamento**: com `DATAJUD_API_KEY`, a rotina consulta a carteira ativa e traz as movimentações novas; encerramentos e audiências designadas viram alerta, nunca ação automática.
4. **Valores e provisão**: lançamentos e extrações entram como propostos; contabilidade ou gestão confere na fila (aprovar, corrigir, rejeitar); risco por pedido ou por processo, com parecer; prévia da competência; fechamento (imutável, com justificativa se houver processo sem classificação); memória de cálculo e CSV para a contabilidade.
5. **Diretoria e auditoria**: Painel executivo, Painéis Power BI, Relatórios (inclusive carta de auditoria) e Administração, Auditoria (com "Acessos a processos sigilosos" e exportação CSV).

## Configuração (`.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:54329/praetor` | Conexão PostgreSQL. O padrão aponta para o banco embarcado de desenvolvimento. |
| `APP_URL` | `http://localhost:3000` | URL pública. Define o cookie `secure` (quando `https://`), a origem aceita nos uploads e os links dos e-mails simulados e da API. |
| `STORAGE_DIR` | `./storage` | Pasta dos arquivos enviados e dos PDFs gerados (fora de `public/`; acesso apenas por rotas autenticadas). |
| `MAX_UPLOAD_MB` | `20` | Tamanho máximo por documento (máx. 100). Planilhas de importação: 15 MB fixos. |
| `SESSION_TTL_HOURS` | `12` | Duração da sessão. |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT`, `AI_MAX_OUTPUT_TOKENS` | `auto`, vazio, `claude-opus-5-5`, `medium`, `16000` | Central de IA. Não afetam a análise preliminar. A chave fica só no servidor. |
| `WORKER_POLL_INTERVAL_MS` | `3000` | Intervalo de consulta da fila pelo worker. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` ou `error`. |
| `DATAJUD_API_KEY` | vazio | Chave **pública** do DataJud publicada pelo CNJ. Vazia = coleta inativa (nada quebra). |
| `DATAJUD_BASE_URL`, `DATAJUD_TIMEOUT_MS` | API pública do CNJ, `60000` | Endereço e tempo limite das consultas. |
| `POWERBI_TENANT_ID`, `POWERBI_CLIENT_ID`, `POWERBI_CLIENT_SECRET` | vazio | Aplicativo do Microsoft Entra ID para os painéis ([docs/POWER_BI.md](docs/POWER_BI.md)). Sem eles, `/paineis-bi` mostra as instruções. |
| `POWERBI_API_URL`, `POWERBI_AUTHORITY_URL` | endereços públicos da Microsoft | Só mudam em nuvens governamentais. |
| `BI_DB_PASSWORD` | vazio | Senha do usuário de banco somente leitura do Power BI (usada pelo `scripts/bi-setup.ts`). |

As variáveis são validadas com zod em `src/server/env.ts`. Não há variáveis para e-mail real nem para IA real na análise preliminar: ambos são simulados nesta versão ([docs/AI.md](docs/AI.md#análise-preliminar-de-processos)). Detalhes de produção em [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Configuração da IA (Central de IA)

- **Modo demonstrativo** (padrão sem chave): o `DemoProvider` aplica regras determinísticas (datas, valores em R$, palavras-chave) sobre o texto das fontes. **Não é IA.** Cada resultado recebe o aviso "MODO DEMONSTRATIVO", o selo "Simulações" do cabeçalho lista o modo, e alertas de risco gerados nesse modo começam com "[Demonstrativo]".
- **Modo real**: defina `ANTHROPIC_API_KEY` (com `AI_PROVIDER=auto` ou `anthropic`). O provedor usa o SDK oficial com saída estruturada validada por zod. Foi verificado só por tipos e testes com provedor simulado.
- Orçamento mensal de tokens, limite de caracteres por análise e análise automática no upload são configurados por organização em **Administração, Configurações**.

Detalhes em [docs/AI.md](docs/AI.md).

## Comandos

| Comando | Para que serve |
|---|---|
| `npm run db:dev` | Sobe o PostgreSQL embarcado de desenvolvimento (porta 54329, UTF-8). Deixe rodando. |
| `npm run db:setup` | `db:migrate` + `db:seed` + `db:seed:v2`. |
| `npm run db:migrate` | Aplica as migrações SQL de `drizzle/`. |
| `npm run db:rollback -- <tag> --yes` | Reverte a **última** migração aplicada com `drizzle/down/<tag>.sql`. Faça backup antes. |
| `npm run db:seed` | Cria as organizações e os dados de demonstração da v1. Não faz nada se a organização demo já existir. |
| `npm run db:seed:v2` | Acrescenta a demonstração da v2 à organização demo. Incremental e idempotente, passo a passo: não apaga nada e continua de onde parou. |
| `npm run db:seed -- --reset` | **Apaga todos os dados de todas as organizações** e os arquivos armazenados e recria a demonstração da v1 (rode `db:seed:v2` em seguida). Só em desenvolvimento. |
| `npm run db:backfill:v2` | Completa o histórico da v2 (valor da causa e classificação de risco) em bases criadas antes da v2. Idempotente e aditivo. |
| `npm run db:backup` / `npm run db:restore -- <pasta> --yes` | Backup lógico (tabelas em JSON + arquivos) e restauração **destrutiva**. Para desenvolvimento e demonstração; ver [docs/OPERATIONS.md](docs/OPERATIONS.md#backup-e-restauração). |
| `npm run db:generate -- --name <mudanca>` | Gera uma migração após alterar `src/server/db/schema/*` (escreva também `drizzle/down/<tag>.sql`). |
| `BI_DB_PASSWORD='…' npx tsx scripts/bi-setup.ts` | Cria ou atualiza o usuário de banco somente leitura do Power BI (`--org`, `--role`, `--print`). |
| `PRAETOR_API_KEY=prt_… npx tsx scripts/demo-api-push.ts` | Sistema externo fictício que envia um processo à API de entrada (`--dry-run` só mostra o resumo). |
| `npm run dev` | Web (Next.js) + worker. |
| `npm run dev:web` / `npm run worker` | Cada processo separadamente. |
| `npm run typecheck` | `next typegen && tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run test` | Vitest (PGlite em memória). |
| `npm run build` / `npm start` | Build e servidor de produção. |
| `npm run validate` | typecheck + lint + test + build, nessa ordem. |
| `node scripts/generate-icons.mjs` | Regenera `favicon.ico`, `apple-icon.png` e os traços da assinatura do logo a partir do SVG. |

## Estrutura de pastas

```
src/
  app/                 rotas Next.js (páginas, layouts, route handlers, API /api/v1): finas
  components/ui/       componentes do design system (ver src/components/ui/README.md)
  components/layout/   shell da aplicação (menu, cabeçalho, busca, sino de alertas, selo de simulações, faixa de demonstração)
  components/brand/    logo em SVG e página de status com a marca
  domain/              tipos, enums e regras puras compartilhados (client-safe), rótulos em pt-BR
  lib/                 utilitários client-safe (formatação, formulários, navegação, tons)
  modules/<dominio>/   schemas.ts, service.ts, actions.ts, components/ por domínio
  server/
    auth/              contexto, permissões, visibilidade por linha, sessão
    db/                cliente Drizzle, schema e plano de reversão das migrações
    integrations/      IA, e-mail, armazenamento, extração de texto, DataJud, Banco Central, Power BI
    pdf/               motor de PDF no servidor (fontes embutidas)
    jobs/              fila, worker, handlers, rotinas
    services/          auditoria e autenticação
    lib/               erros e logger
scripts/               db-dev, migrate, db-rollback, seed, seed-v2, backfill-v2, db-backup, db-restore, worker,
                       bi-setup, demo-api-push, generate-icons
drizzle/               migrações SQL versionadas; drizzle/down/ com a reversão de cada uma (a partir da 0002)
tests/                 testes Vitest (PGlite)
docs/                  documentação
```

## Documentação

- [docs/STATUS.md](docs/STATUS.md): o que está implementado, simulado e pendente, o que foi verificado e as decisões de produto registradas.
- [docs/RASTREABILIDADE.md](docs/RASTREABILIDADE.md): requisitos do cliente (RF, RN, RNF, TE, PD, INT), status e onde estão.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): camadas, módulos, filas e rotinas, entrada de processos, provedores simulados.
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md): tabelas, relacionamentos, histórico imutável e migrações.
- [docs/SECURITY.md](docs/SECURITY.md): autenticação, perfis e permissões, visibilidade, API de entrada, Power BI, proteção de documentos e o que falta avaliar.
- [docs/API.md](docs/API.md): API de entrada de processos (`/api/v1`) e acompanhamento no DataJud.
- [docs/POWER_BI.md](docs/POWER_BI.md): passo a passo dos painéis Power BI.
- [docs/AI.md](docs/AI.md): Central de IA, análise preliminar (simulada) e como trocar os provedores simulados.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): execução, variáveis, rotinas, migrações e reversão, integrações, seeds, backup e restauração, banco em UTF-8.
- [docs/adr/](docs/adr/): decisões de arquitetura.
- Para desenvolvimento: [AGENTS.md](AGENTS.md), [docs/dev/MODULE_CONTRACTS.md](docs/dev/MODULE_CONTRACTS.md), [docs/dev/NEXTJS_16_NOTES.md](docs/dev/NEXTJS_16_NOTES.md), [docs/dev/ADDING_A_MODULE.md](docs/dev/ADDING_A_MODULE.md).
