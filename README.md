# Praetor

Plataforma de gestão jurídica corporativa para departamentos jurídicos internos no Brasil. Reúne em um só lugar:

- **Jurídico preventivo** — ocorrências que ainda não são processos (reclamações, notificações, incidentes), com classificação de risco, plano de ação e conversão em processo quando necessário.
- **Contencioso** — cadastro e acompanhamento de processos judiciais e administrativos: partes, movimentações, valores, risco e provisão.
- **Inteligência artificial como apoio contínuo** — análises de documentos e registros (resumo, extração, sinais de risco, inconsistências, ações preventivas, perguntas e respostas). Cada resultado cita as fontes, lista limitações e pontos de validação e traz um aviso de que **não substitui o advogado**. A IA não prevê resultados, não inventa jurisprudência ou citações e não altera registros: sugestões de tarefas e prazos só passam a existir por ação explícita de uma pessoa, e prazos sugeridos exigem validação humana.

> **Ambiente demonstrativo.** Esta é a primeira versão funcional. Os dados criados por `npm run db:seed` são **fictícios**, e organizações de demonstração exibem uma faixa de aviso em todas as telas. Sem chave de API configurada, a IA roda em **modo demonstrativo**: regras simples de texto, **sem inteligência artificial real**, e todo resultado é rotulado como tal. O projeto **não** declara conformidade legal (LGPD ou outra) nem segurança completa. Veja [docs/SECURITY.md](docs/SECURITY.md) e [docs/STATUS.md](docs/STATUS.md).

## Funcionalidades desta versão

| Área | O que existe |
|---|---|
| Dashboard (`/dashboard`) | Indicadores de processos, ocorrências, prazos, contratos e IA; exposição financeira informada; carga por responsável; alertas; atividade recente. Tudo filtrado pelas permissões de quem acessa. |
| Processos (`/processos`) | Cadastro, edição, exclusão lógica, partes, movimentações manuais, filtros, abas (documentos, prazos, IA, comentários, histórico). Criação a partir de uma ocorrência. |
| Jurídico preventivo (`/preventivo`) | Ocorrências com fatos, áreas envolvidas, informações faltantes, risco, plano de ação (tarefas), vínculo com processo e card de sinais da IA. |
| Contratos (`/contratos`) | Contratos, obrigações, vigência e prazo de aviso calculados a partir das datas informadas, filtros "vencendo" e "vencidos". |
| Documentos (`/documentos`) | Upload (PDF, DOCX, PNG, JPG, TXT, MD, CSV) com validação por assinatura do arquivo, versões, extração de texto (PDF/DOCX/texto), download autenticado. |
| Prazos e tarefas (`/prazos`) | Calendário mensal, listas de prazos e tarefas, fila de validação de prazos sugeridos pela IA, comentários. |
| Central de IA (`/ia`) | Solicitar análises, perguntas à base da organização, histórico, revisão humana, aplicação de sugestões, uso e limites. |
| Administração (`/admin`) | Usuários, equipes, unidades, matriz de permissões, auditoria, configurações da organização, rotinas agendadas e fila. |
| Segundo plano | Fila de tarefas em PostgreSQL, worker, rotinas (alertas de prazos e contratos, reanálise de análises desatualizadas, revisão de retenção sem exclusão automática). |

## Requisitos

- **Node.js >= 20.9** e npm.
- **Não é preciso Docker nem PostgreSQL instalado**: em desenvolvimento, `npm run db:dev` sobe um PostgreSQL real embarcado (pacote `embedded-postgres`) na porta 54329, com dados em `.data/postgres`.
- Os testes usam PGlite (PostgreSQL em memória) e não precisam de servidor.

## Instalação e primeira execução

```bash
npm install
cp .env.example .env          # no Windows (PowerShell): Copy-Item .env.example .env
```

**Terminal 1** — banco de dados (deixe rodando):

```bash
npm run db:dev
```

**Terminal 2** — migrações, dados de demonstração, aplicação e worker:

```bash
npm run db:setup && npm run dev
```

O seed cria duas organizações fictícias, "Grupo Aurora Exemplo S.A. (demonstração)" e "Outra Empresa Ltda. (teste de isolamento)", com processos, ocorrências, contratos, documentos, análises (modo demonstrativo), prazos, tarefas, comentários e alertas. As datas são relativas ao dia em que o seed roda.

Abra <http://localhost:3000> e entre com uma das contas de demonstração (definidas em `src/domain/demo.ts`). A senha de todas é **`Praetor@2026`**. Enquanto existir uma organização de demonstração, a tela de login mostra essas contas com o botão "Usar esta conta".

| E-mail | Perfil | Observação |
|---|---|---|
| `admin@demo.praetor.local` | Administrador | Acesso total, inclusive administração |
| `gestor@demo.praetor.local` | Gestor jurídico | Vê tudo da organização, inclusive confidenciais |
| `advogada@demo.praetor.local` | Advogado | Unidade Matriz São Paulo |
| `advogado.recife@demo.praetor.local` | Advogado | Unidade Filial Recife |
| `analista@demo.praetor.local` | Analista | Unidade Matriz São Paulo |
| `executivo@demo.praetor.local` | Executivo | Somente consulta |
| `admin@outra.praetor.local` | Administrador | Outra organização (teste de isolamento entre organizações) |

`npm run dev` sobe **duas coisas**: o Next.js (web) e o worker de segundo plano (`scripts/worker.ts`). Sem o worker, análises de IA e extração de texto ficam "Na fila". A administração tem o botão "Processar fila agora" para processar a fila manualmente.

## Configuração (`.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:54329/praetor` | Conexão PostgreSQL. O padrão aponta para o banco embarcado de desenvolvimento. |
| `APP_URL` | `http://localhost:3000` | URL pública. Define o cookie `secure` (quando `https://`) e a origem aceita no upload. |
| `STORAGE_DIR` | `./storage` | Pasta dos arquivos enviados (fora de `public/`; acesso apenas pela rota autenticada). |
| `MAX_UPLOAD_MB` | `20` | Tamanho máximo por arquivo (máx. 100). |
| `SESSION_TTL_HOURS` | `12` | Duração da sessão. |
| `AI_PROVIDER` | `auto` | `auto` (Anthropic se houver chave, senão demonstrativo), `demo` ou `anthropic`. |
| `ANTHROPIC_API_KEY` | vazio | Chave da Anthropic. Só no servidor; nunca no banco nem no código. |
| `AI_MODEL` | `claude-opus-5-5` | Modelo usado no modo real. |
| `AI_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` ou `max`. |
| `AI_MAX_OUTPUT_TOKENS` | `16000` | Limite de tokens de saída por análise. |
| `WORKER_POLL_INTERVAL_MS` | `3000` | Intervalo de consulta da fila pelo worker. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` ou `error`. |

As variáveis são validadas com zod em `src/server/env.ts` na primeira utilização.

## Configuração da IA

- **Modo demonstrativo** (padrão sem chave): o `DemoProvider` aplica regras determinísticas (datas, valores em R$, palavras-chave) sobre o texto das fontes. **Não é IA.** Cada resultado recebe o aviso "MODO DEMONSTRATIVO", o selo "Modo demonstrativo" aparece no cabeçalho e alertas de risco gerados nesse modo começam com "[Demonstrativo]".
- **Modo real**: defina `ANTHROPIC_API_KEY` (com `AI_PROVIDER=auto` ou `anthropic`). O provedor usa o SDK oficial com saída estruturada validada por zod, modelo `claude-opus-5-5` por padrão e o fallback de recusa no servidor (`server-side-fallback-2026-07-01`, `fallbacks: "default"`) habilitado.
- Orçamento mensal de tokens, limite de caracteres por análise e análise automática no upload são configurados por organização em **Administração → Configurações**.

Detalhes em [docs/AI.md](docs/AI.md).

## Comandos

| Comando | Para que serve |
|---|---|
| `npm run db:dev` | Sobe o PostgreSQL embarcado de desenvolvimento (porta 54329). Deixe rodando. |
| `npm run db:setup` | `db:migrate` + `db:seed` (migrações e dados fictícios). |
| `npm run db:migrate` | Aplica as migrações SQL de `drizzle/`. |
| `npm run db:seed` | Cria as organizações e os dados de demonstração. Não faz nada se a organização demo já existir. |
| `npm run db:seed -- --reset` | **Apaga todos os dados de todas as organizações** e os arquivos armazenados e recria a demonstração. Só em desenvolvimento. |
| `npm run db:generate -- --name <mudanca>` | Gera uma migração após alterar `src/server/db/schema/*`. |
| `npm run dev` | Web (Next.js) + worker. |
| `npm run dev:web` / `npm run worker` | Cada processo separadamente. |
| `npm run typecheck` | `next typegen && tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run test` | Vitest (PGlite em memória). |
| `npm run build` / `npm start` | Build e servidor de produção. |
| `npm run validate` | typecheck + lint + test + build, nessa ordem. |

## Estrutura de pastas

```
src/
  app/                 rotas Next.js (páginas, layouts, route handlers) — finas
  components/ui/       componentes do design system (ver src/components/ui/README.md)
  components/layout/   shell da aplicação (menu lateral, cabeçalho, faixa de demonstração)
  domain/              tipos e enums compartilhados (client-safe), rótulos em pt-BR
  lib/                 utilitários client-safe (formatação, formulários, navegação)
  modules/<dominio>/   schemas.ts, service.ts, actions.ts, components/ por domínio
  server/
    auth/              contexto, permissões, visibilidade por linha, sessão
    db/                cliente Drizzle e schema
    integrations/      IA, armazenamento de arquivos, extração de texto
    jobs/              fila, worker, handlers, rotinas
    services/          auditoria e autenticação
    lib/               erros e logger
scripts/               db-dev, migrate, seed, worker
drizzle/               migrações SQL versionadas
tests/                 testes Vitest (PGlite)
docs/                  documentação
```

## Documentação

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — camadas, ciclo de uma requisição, filas, fluxo da IA, armazenamento.
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — tabelas, relacionamentos e convenções de dados.
- [docs/SECURITY.md](docs/SECURITY.md) — autenticação, autorização, isolamento, proteção de documentos e o que falta avaliar.
- [docs/AI.md](docs/AI.md) — princípios, provedores, prompts, saída estruturada, custos e limitações.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — execução em produção, backups, logs, escala.
- [docs/STATUS.md](docs/STATUS.md) — o que está implementado, simulado e pendente.
- [docs/adr/](docs/adr/) — decisões de arquitetura.
- Para desenvolvimento: [AGENTS.md](AGENTS.md), [docs/dev/MODULE_CONTRACTS.md](docs/dev/MODULE_CONTRACTS.md), [docs/dev/NEXTJS_16_NOTES.md](docs/dev/NEXTJS_16_NOTES.md), [docs/dev/ADDING_A_MODULE.md](docs/dev/ADDING_A_MODULE.md).
