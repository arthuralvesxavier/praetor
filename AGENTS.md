<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Praetor — agent guide

Praetor is a corporate legal management platform (preventive + litigation) with an AI
analysis layer. Stack: Next.js 16 (App Router, TypeScript), Tailwind CSS 4, Radix UI,
PostgreSQL + Drizzle ORM, zod, Vitest (PGlite), Anthropic SDK behind a provider interface.

Read before changing code:
- `docs/dev/MODULE_CONTRACTS.md` — layout, service conventions, cross-module APIs, URL params.
- `docs/dev/NEXTJS_16_NOTES.md` — Next 16 specifics used here (cacheComponents is OFF).
- `docs/SECURITY.md` and `src/server/auth/access.ts` — row-visibility rules.
- `docs/dev/ADDING_A_MODULE.md` — checklist for a new domain module.
- `docs/STATUS.md` — what is implemented / simulated / pending (keep it honest).
- Background: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/AI.md`, `docs/OPERATIONS.md`, `docs/adr/`.
- UI kit catalog: `src/components/ui/README.md`.

Documentation (README, `docs/**`) is written in Brazilian Portuguese; code identifiers stay in English.

## Commands

| Command | Purpose |
|---|---|
| `npm run db:dev` | Start local PostgreSQL (embedded, port 54329) — keep running |
| `npm run db:setup` | Apply migrations + seed demo data |
| `npm run dev` | Web (Next dev) + background worker |
| `npm run db:generate -- --name <change>` | Generate a migration after editing `src/server/db/schema/*` |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | Vitest (in-memory PGlite, no server needed) |
| `npm run build` | Production build |
| `npm run validate` | All of the above in order — run before handing work back |

## Non-negotiable conventions

1. **Language**: identifiers, file names, DB columns and enum ids in English; every user-facing
   string in Brazilian Portuguese. Enum labels live in `src/domain/enums.ts`.
2. **Authorization on the server**: every page calls `requirePageContext(perm)`, every server
   action `requireActionContext(perm)`, every route handler `getCurrentUser()`; every service
   checks `assertCan` and applies the row-visibility `*Where(ctx)` from `src/server/auth/access.ts`.
   Hiding a button is never authorization.
3. **Tenant isolation**: never take `organizationId` from input; validate every foreign id belongs to
   `ctx.organizationId`.
4. **Layers**: `src/app` (routes) → `src/modules/<domain>/actions.ts` → `service.ts` → `src/server/db`.
   Services never import `next/*` or `@/server/auth/session`. Client components never import
   `@/server/*` or `service.ts`.
5. **Audit** relevant mutations with `recordAudit` inside the transaction. Never log or audit
   document contents, extracted text, prompts or AI answers.
6. **AI**: document text is untrusted data; it is only sent inside delimited source blocks via
   `src/server/integrations/ai`. AI output never changes records directly — suggestions become
   tasks/deadlines only through an explicit user action, and AI-suggested deadlines require
   human validation. Demo-mode output must always be labeled as demonstrative.
7. **No fabrication**: do not invent case law, citations, court movements or tribunal
   integrations. Seed data is fictional and labeled as such.
8. **Schema changes**: edit `src/server/db/schema/*`, run `npm run db:generate`, commit the SQL in
   `drizzle/`. Never edit an applied migration.
9. Keep `docs/STATUS.md` (implemented / simulated / pending) up to date when adding features.

## Mapa rápido

| Preciso de… | Onde está |
|---|---|
| Enums, rótulos pt-BR | `src/domain/enums.ts` (`*_LABELS`); opções de select: `optionsFromLabels` em `src/lib/options.ts` |
| Contrato da saída da IA, aviso, aviso de demo | `src/domain/analysis.ts` |
| `EntityRef`, `entityHref`, `Page`/`Paginated`, `normalizePage` | `src/domain/entities.ts` |
| Contas demo e senha | `src/domain/demo.ts` (seed em `scripts/seed.ts` + `scripts/seed-data/`) |
| Sessão (páginas, ações, rotas) | `src/server/auth/session.ts` (`requirePageContext`, `requireActionContext`, `getCurrentUser`) |
| Permissões / visibilidade por linha | `src/server/auth/permissions.ts` / `src/server/auth/access.ts` |
| Contexto de job | `systemContext(orgId)` em `src/server/auth/context.ts` |
| Erros e `ActionResult` | `src/server/lib/errors.ts` (`toActionError`) |
| Auditoria | `src/server/services/audit.ts` (`recordAudit`, `diffChanges`); rótulos pt-BR das ações em `src/modules/admin/history-format.ts` |
| Schema do banco | `src/server/db/schema/{core,legal,documents,work,ai}.ts`; migrações em `drizzle/` |
| Variáveis de ambiente | `src/server/env.ts` (zod) + `.env.example` |
| Configurações da organização (jsonb com defaults) | `OrganizationSettings` em `schema/core.ts`; leitura com `loadOrganization`/`mergeOrganizationSettings` (`src/modules/analyses/org-settings.ts`) |
| Provedores de IA, prompt, preços | `src/server/integrations/ai/` (`index.ts`, `anthropic.ts`, `demo.ts`, `prompt.ts`, `pricing.ts`) |
| Montagem de fontes da IA / busca de perguntas | `src/modules/analyses/sources.ts` |
| Storage / extração de texto | `src/server/integrations/storage/`, `src/server/integrations/text-extraction.ts` |
| Fila, worker, handlers, rotinas | `src/server/jobs/{queue,worker,handlers,routines}.ts`; entrypoint `scripts/worker.ts` |
| Upload / download | `src/app/api/documents/upload/route.ts`, `src/app/api/documents/[id]/versions/[versionId]/download/route.ts` |
| Componentes de UI | `src/components/ui/*` (catálogo no `README.md` da pasta); shell em `src/components/layout/` |
| Formatação de datas/dinheiro, formulários, parâmetros de URL | `src/lib/format.ts`, `src/lib/form.ts`, `src/lib/search-params.ts` |
| Menu lateral | `src/lib/nav.ts` |
| Componentes embutíveis por registro | `EntityDocuments` (documents), `EntityWorkItems` (work), `AnalysisPanel` (analyses), `CommentThread` (comments), `EntityHistory` (admin), `AlertList` (alerts) |
| Helper de testes | `tests/helpers/db.ts` (`createTestDatabase`); exemplos de fixtures em `tests/access.smoke.test.ts` |

## Validação antes de entregar

- Rode `npm run validate` (typecheck → lint → test → build). Tudo deve passar sem erros.
  Se outras sessões estiverem trabalhando no mesmo diretório, **não** rode `next build`/`next dev`, porque
  compartilham `.next/`. Rode `npx tsc --noEmit`, `npx eslint <seus caminhos>` e `npx vitest run <seus testes>`.
- Se `PageProps`/`LayoutProps`/`RouteContext` aparecerem como inexistentes, rode `npx next typegen`.
- Mudou schema: gere a migração e rode os testes (o PGlite aplica todas as migrações).
- Mudou UI: abra a tela no navegador (desktop e largura de celular) com mais de um perfil demo.
  Todas as telas já foram renderizadas no servidor de produção por perfil (ver `docs/STATUS.md`), mas
  nenhuma foi inspecionada visualmente num navegador.
- Atualize `docs/STATUS.md` e, se mudar contratos entre módulos, `docs/dev/MODULE_CONTRACTS.md`.

## Armadilhas conhecidas

- **Vitest no Git Bash (Windows)** falha antes de rodar qualquer teste ("Vitest failed to find the runner" /
  "Cannot read properties of undefined (reading 'config')") quando o diretório atual tem a letra do drive em
  minúscula (`cd /c/Users/...` resulta em `c:\...`). Entre com `cd C:/Users/...` (maiúscula) ou rode pelo
  **PowerShell** (ou cmd), onde passa normalmente.
- **Status HTTP com streaming**: as rotas de `(app)` têm `loading.tsx`, então a resposta começa com `200`
  antes da página rodar. `redirect("/sem-permissao")` e `notFound()` chamados na página viram redirecionamento
  no cliente e a tela de "não encontrado" com `noindex` — o status continua `200` (comportamento documentado do
  Next 16). Para testar por HTTP, procure `NEXT_REDIRECT;replace;/sem-permissao` ou
  `NEXT_HTTP_ERROR_FALLBACK;404` no HTML. Sem cookie, o proxy e o layout ainda redirecionam com `307` real.
- **React 19 reseta formulários** após uma server action. Para manter o que foi digitado em erro de validação,
  use os padrões existentes: `usePreservingSubmit` (contracts/occurrences), `useFormAction` (work),
  `useAdminForm` (admin), ou devolva `values` no estado da ação (processes).
- **Cache do Turbopack e `globals.css`**: após mudar tokens/keyframes em `src/app/globals.css`, um `next build` incremental
  pode reaproveitar o CSS antigo (classes novas somem do bundle). Se isso acontecer, apague `.next/` e reconstrua.
- **`redirect()` lança exceção**: chame fora do `try/catch` da ação.
- **Mensagens de erro do Drizzle/driver contêm os parâmetros da consulta** (títulos, fatos, texto extraído).
  Nunca logue `error.message` de erro de banco. Logue nome e código (`errorSummary` em
  `src/modules/documents/log.ts`, `safeErrorMessage` em `src/server/jobs/queue.ts`). Violação de unicidade:
  `code === "23505"`, possivelmente em `err.cause` (percorra a cadeia, como `isUniqueViolation` em `analyses/service.ts`).
- **Ids em schemas zod**: prefira `z.guid()` (qualquer UUID 8-4-4-4-12). `z.uuid()` é estrito (versão/variante
  RFC) e rejeita UUIDs fixos não-v4 usados em seeds e fixtures.
- **Datas `YYYY-MM-DD`** são datas de calendário. Não use `new Date("YYYY-MM-DD")` para exibir, porque o
  fuso desloca o dia. Use `src/lib/format.ts`, que trata "hoje" e timestamps em `America/Sao_Paulo`.
- **Busca textual em português**: a configuração `portuguese` do PostgreSQL não remove acentos. Pesquise as
  formas com e sem acento (ver `retrieveForQuestion` em `analyses/sources.ts`). Para `ILIKE`, escape
  `%`, `_` e `\` (`escapeLike` em `processes/service.ts`).
- **Layout não é autorização**: `(app)/layout.tsx` chama `requirePageContext()` sem permissão, e layouts
  não re-renderizam na navegação. Toda página chama `requirePageContext("<perm>")`.
- **Upload só pelo route handler** `/api/documents/upload` (fora do proxy; as server actions têm limite de
  2 MB). O handler faz a checagem de `Origin` (CSRF). Mantenha essa checagem em qualquer nova rota que mude estado.
- **`markAnalysesStaleForEntity(input, tx)`**: passe a transação, para a marcação de "desatualizada" ser
  confirmada ou desfeita junto com a mudança.
- **Ciclos de import entre serviços**: `documents/service` importa `analyses/service` estaticamente;
  `analyses/service` carrega `work/service` e `jobs/handlers` carrega `documents/service` com `import()`
  dinâmico. Mantenha assim ao adicionar dependências entre módulos.
- **Configurações da organização** (`organizations.settings`, jsonb) podem estar incompletas: sempre faça
  merge com `DEFAULT_ORGANIZATION_SETTINGS` (`mergeOrganizationSettings`).
- **Novas ações de auditoria** precisam de rótulo em `src/modules/admin/history-format.ts`; senão a aba
  "Histórico" mostra o id cru.
- **Prazos sugeridos pela IA** (`pending_validation`) e prazos rejeitados não contam como prazos reais. Todo
  indicador ou alerta de prazo deve filtrar `validation_status in ('not_required', 'validated')`.
- **Contagens no dashboard** devem usar o mesmo escopo que as listas (`*Where(ctx)`). Ao juntar um registro
  pai (ex.: título do processo de um prazo), aplique também o escopo do pai, para não vazar títulos de
  registros invisíveis.
- **`revalidateTag` no Next 16 exige 2 argumentos**. Prefira `revalidatePath`.
- **Testes de módulos que chamam a IA ou outros módulos**: use `vi.mock("@/modules/analyses/service", …)`
  ou `setAiProviderForTesting(...)`; a fila roda inline com `processPendingJobs()`.
- **Modo demonstrativo**: qualquer texto novo gerado a partir de uma análise `mode = "demo"` (alertas,
  descrições de tarefas e prazos) deve dizer que é demonstrativo.
