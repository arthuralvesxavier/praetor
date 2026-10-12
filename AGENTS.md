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
- `docs/RASTREABILIDADE.md` — client requirements (RF/RN/RNF/TE/PD/INT) × status × where.
- Background: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/AI.md`, `docs/OPERATIONS.md`, `docs/adr/`.
- UI kit catalog: `src/components/ui/README.md`.

Documentation (README, `docs/**`) is written in Brazilian Portuguese; code identifiers stay in English.

## Commands

| Command | Purpose |
|---|---|
| `npm run db:dev` | Start local PostgreSQL (embedded, port 54329) — keep running |
| `npm run db:setup` | Apply migrations + seed demo data (`db:seed` + `db:seed:v2`) |
| `npm run db:seed:v2` | Add the v2 demo to the demo organization (incremental, idempotent) |
| `npm run db:backfill:v2` | Fill v2 history (claim valuations, risk assessments) for data created before v2 (idempotent) |
| `npm run db:backup` / `npm run db:restore -- <dir> --yes` | Logical backup (tables as JSON + `STORAGE_DIR`) / destructive restore |
| `npm run dev` | Web (Next dev) + background worker |
| `npm run db:generate -- --name <change>` | Generate a migration after editing `src/server/db/schema/*` |
| `npm run db:rollback -- <tag> --yes` | Revert the LAST applied migration with `drizzle/down/<tag>.sql` (backup first) |
| `BI_DB_PASSWORD=… npx tsx scripts/bi-setup.ts` | Create/update the read-only Power BI database role (rerun after migrations that recreate `bi` views) |
| `PRAETOR_API_KEY=prt_… npx tsx scripts/demo-api-push.ts` | Fictitious external system posting a case to the inbound API (`--dry-run`) |
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
   human validation. Demo-mode output must always be labeled as demonstrative. In this version
   the preliminary analysis (case brief) and e-mail delivery are **simulations** behind provider
   interfaces (ADR-0010): every simulated output carries its label (see "Simulation labeling" in
   `docs/dev/MODULE_CONTRACTS.md`); never present it as AI, as a sent e-mail or as a fact of the case.
7. **No fabrication**: do not invent case law, citations, court movements or tribunal
   integrations. Seed data is fictional and labeled as such.
8. **Schema changes**: edit `src/server/db/schema/*`, run `npm run db:generate`, commit the SQL in
   `drizzle/`. Never edit an applied migration. Every migration is reversible: add `drizzle/down/<tag>.sql`
   (run by `npm run db:rollback`). With parallel sessions, take the lock `mkdir .data/locks/db-generate`
   before `db:generate` and `rmdir` it afterwards.
9. Keep `docs/STATUS.md` (implemented / simulated / pending) up to date when adding features.

## Mapa rápido

| Preciso de… | Onde está |
|---|---|
| Enums, rótulos pt-BR | `src/domain/enums.ts` (`*_LABELS`); opções de select: `optionsFromLabels` em `src/lib/options.ts` |
| Contrato da saída da IA (Central de IA), aviso, aviso de demo | `src/domain/analysis.ts` |
| `EntityRef`, `entityHref`, `Page`/`Paginated`, `normalizePage` | `src/domain/entities.ts` |
| Contas demo e senha | `src/domain/demo.ts` (seed v1 em `scripts/seed.ts` + `scripts/seed-data/`; v2 em `scripts/seed-v2.ts` + `scripts/seed-data/v2/`) |
| Lista de módulos e quem depende de quem | `src/modules/*`; contratos em `docs/dev/MODULE_CONTRACTS.md` (seção "v2 cross-module APIs") |
| Regras puras de valores (RN-02..RN-07) e número CNJ | `src/domain/contingency.ts` (`netExposure`, `provisionFor`, `addToBucket`), `src/domain/cnj.ts` (`normalizeCnj`, `isValidCnj`) |
| Contrato da análise preliminar, proveniência, avisos | `src/domain/case-brief.ts` (`caseBriefSchema`, `PROVENANCE_LABELS`, `CASE_BRIEF_DEMO_NOTICE`) |
| Empresas e escritórios externos | `src/modules/organization/service.ts` (`assertCompanyInOrg`, `assertLawFirmInOrg`, CRUD); CNPJ em `organization/schemas.ts` |
| Carteira: filtros de URL, exportação, saída da carteira | `src/modules/processes/filters.ts` (`processFiltersFromSearchParams`), `processes/export.ts`, `processes/service.ts` (`closeProcess`, `recordConfidentialProcessView`); rota `src/app/api/processes/export/route.ts` |
| Contingências | `src/modules/contingency/` (`service.ts` valores e fila; `risk-service.ts`, `guarantee-service.ts`, `settlement-service.ts`, `snapshot-service.ts`; `position.ts`, `csv.ts`, `labels.ts` com `NONE_KEY`; espelhos `syncProcessMirrors` em `internal.ts`; `routines.ts`) |
| Audiências | `src/modules/hearings/{service,routines,time}.ts`; aba `components/process-hearings-tab.tsx` |
| Alertas: áreas, links e visibilidade | `src/modules/alerts/{service,areas}.ts` (`visibleAlertsWhere` em toda leitura de alertas; `resolveAlertHrefs` lido com `alertHrefKey(row)`, o link depende do tipo; `ALERT_TYPES_BY_AREA`, `ALERT_AREA_PARAMS`) |
| Ficha do processo: abas, faixa de decisão, capa | `src/modules/processes/tabs.ts` (`PROCESS_TAB_KEYS`, `resolveProcessTab`, `processTabUrl`, chaves antigas em `LEGACY_PROCESS_TABS`), `decision-band.ts` (puro) + `decision-band-service.ts`, `cover.ts`, `timeline.ts`; página em `src/app/(app)/processos/[id]/` |
| Painel executivo: faixa "Exige decisão agora", carteira, garantias paradas | `src/modules/dashboard/{decision-service,portfolio-service,portfolio,dimension-chart,idle-guarantees}.ts`; lista em `src/app/(app)/contingencias/garantias/` |
| Pedidos do processo e risco derivado | `src/modules/claims/{service,derivation,labels}.ts` (`derivedEffectiveFrom`, `claimsRiskAttribution`); painel `components/process-claims-panel.tsx` |
| Índices de correção e valor atualizado | `src/modules/indices/{service,math,policy,swap-guard,catalog,routines}.ts`; cliente do Banco Central em `src/server/integrations/bcb/` |
| Fechamento mensal com bloqueio | `src/modules/contingency/close-gate.ts` (puro) e `snapshot-service.ts` (`closeSnapshot(ctx, period, { justification })`, `getCloseGate`); tabela `snapshot_close_overrides` |
| Memória de cálculo da provisão | `src/modules/provision-memo/{service,memo,xlsx,pdf}.ts`; rota `src/app/api/provision-memo/[period]/route.ts` |
| Relatórios jurídicos e PDF | `src/modules/legal-reports/{service,validation,approvers,source-checker,view,pdf,sample,scenarios}.ts`; motor de PDF em `src/server/pdf/`; tipos em `src/domain/legal-reports.ts` |
| Coleta no DataJud | `src/modules/court-sync/{service,mapping,routines}.ts` (`applyCourtRecords`, `syncProcessNow`, `lookupCourtRecord`); cliente e limite por tribunal em `src/server/integrations/courts/` (`fake.ts` nos testes) |
| API de entrada e chaves de API | `src/modules/inbound/{service,http,schemas,rate-limit,openapi}.ts`, `src/modules/api-keys/service.ts`; rotas `src/app/api/v1/**` (fora do matcher do proxy); guia `docs/API.md` |
| Power BI | `src/modules/bi/{service,access,refresh,routines,setup-sql,labels}.ts`; cliente em `src/server/integrations/powerbi/`; visões no schema `bi` (migrações `0004`, `0006`, `0011`); `scripts/bi-setup.ts`; guia `docs/POWER_BI.md` |
| Migrações reversíveis | `drizzle/down/<tag>.sql`; `src/server/db/migrations.ts` + `scripts/db-rollback.ts` |
| Importação de planilhas | `src/modules/imports/{service,parser,plan,xlsx,csv,http}.ts`; rotas `src/app/api/imports/**` |
| Entrada de processos e distribuição | `src/modules/intake/{service,simulation,status}.ts` (`processContext` = contexto delegado), `src/modules/distribution/{service,matching}.ts` |
| Análise preliminar e provedor | `src/modules/briefs/{service,demo-documents}.ts`; provedor em `src/server/integrations/ai/case-brief/{index,provider,simulated,live}.ts` (`getCaseBriefProvider`, `setCaseBriefProviderForTesting`) |
| E-mails simulados e provedor | `src/modules/emails/{service,render,templates,labels}.ts` (`sendTemplatedEmail`); provedor em `src/server/integrations/email/{index,provider,simulated}.ts` (`getEmailProvider`, `setEmailProviderForTesting`) |
| Relatórios | `src/modules/reports/{service,csv,xlsx,grouping}.ts`; rota `src/app/api/reports/[tipo]/route.ts` |
| Inteligência preventiva | `src/modules/preventive-intel/{service,claims,suggestions}.ts`; origem da ocorrência em `src/modules/occurrences/preventive-origin.ts` |
| Painel executivo, integrações, CSV da auditoria | `src/modules/dashboard/portfolio-service.ts`; `src/modules/admin/integrations.ts`, `src/modules/admin/audit-csv.ts` |
| Dados do shell, navegação e busca global | `src/components/layout/shell-data.ts` (`loadShellData`), `src/components/layout/nav-utils.ts` (`filterNavGroups`, `activeNavHref`, `matchesNavHref`); `src/app/(app)/busca/search.ts` (`runGlobalSearch`) |
| Logo e ícones | `src/components/brand/{logo.tsx,status-page.tsx,wordmark-paths.ts}`; `node scripts/generate-icons.mjs` regenera `favicon.ico`, `apple-icon.png` e `wordmark-paths.ts` (a partir de `public/brand/praetor-logo.svg`) |
| Seeds, backfill e backup | `scripts/seed-v2.ts` (passos incrementais com marcas; `--skip=`), `scripts/backfill-v2.ts` (regras em `scripts/seed-data/v2/backfill.ts`), `scripts/db-backup.ts`, `scripts/db-restore.ts`; banco de desenvolvimento em UTF-8 por `scripts/db-dev.ts` |
| Sessão (páginas, ações, rotas) | `src/server/auth/session.ts` (`requirePageContext`, `requireActionContext`, `getCurrentUser`) |
| Permissões / visibilidade por linha | `src/server/auth/permissions.ts` / `src/server/auth/access.ts` |
| Contexto de job | `systemContext(orgId)` em `src/server/auth/context.ts` |
| Erros e `ActionResult` | `src/server/lib/errors.ts` (`toActionError`) |
| Auditoria | `src/server/services/audit.ts` (`recordAudit`, `diffChanges`); rótulos pt-BR das ações em `src/modules/admin/history-format.ts` |
| Schema do banco | `src/server/db/schema/{core,legal,documents,work,ai,contingency,operations,briefs,email,imports,integrations,bi,indices,legal-reports,claims,snapshot-close}.ts`; migrações em `drizzle/` (`0001_v2_portfolio.sql` = v2; `0002` a `0013` com reversão em `drizzle/down/`) |
| Variáveis de ambiente | `src/server/env.ts` (zod) + `.env.example` |
| Configurações da organização (jsonb com defaults) | `OrganizationSettings` em `schema/core.ts`; leitura com `loadOrganization`/`mergeOrganizationSettings` (`src/modules/analyses/org-settings.ts`) |
| Provedores de IA, prompt, preços | `src/server/integrations/ai/` (`index.ts`, `anthropic.ts`, `demo.ts`, `prompt.ts`, `pricing.ts`) |
| Montagem de fontes da IA / busca de perguntas | `src/modules/analyses/sources.ts` |
| Storage / extração de texto | `src/server/integrations/storage/`, `src/server/integrations/text-extraction.ts` |
| Fila, worker, handlers, rotinas | `src/server/jobs/{queue,worker,handlers,routines}.ts`; entrypoint `scripts/worker.ts` |
| Upload / download | `src/app/api/documents/upload/route.ts`, `src/app/api/documents/[id]/versions/[versionId]/download/route.ts`; planilhas em `src/app/api/imports/upload/route.ts` (ambos fora do matcher de `src/proxy.ts`) |
| Componentes de UI | `src/components/ui/*` (catálogo no `README.md` da pasta); shell em `src/components/layout/` |
| Formatação de datas/dinheiro, formulários, parâmetros de URL | `src/lib/format.ts`, `src/lib/form.ts`, `src/lib/search-params.ts` |
| Menu lateral | `src/lib/nav.ts` (`NAV_GROUPS`, agrupado por área) |
| Componentes embutíveis por registro | `EntityDocuments` (documents), `EntityWorkItems` (work), `AnalysisPanel` (analyses), `CommentThread` (comments), `EntityHistory` (admin), `AlertList` (alerts); abas do processo: `ProcessContingencyTab`/`ProcessSettlementsTab`/`ProcessValuesSummary` e `NetExposurePanel` (contingency), `ProcessClaimsPanel` (claims), `ProcessScenarios` (legal-reports), `CourtSyncPanel` (court-sync), `CorrectionIndexDialog` (indices), `ProcessHearingsTab` (hearings), `ProcessBriefTab` (briefs), `ProcessEmailsTab` (emails), `ProcessDecisionBandSection` (processes) |
| Helper de testes | `tests/helpers/db.ts` (`createTestDatabase`); fixture com todos os perfis, empresa e escritório: `tests/helpers/fixtures.ts` (`setupFixture`); exemplos em `tests/access.smoke.test.ts` |

## Validação antes de entregar

- Rode `npm run validate` (typecheck → lint → test → build). Tudo deve passar sem erros.
  Se outras sessões estiverem trabalhando no mesmo diretório, **não** rode `next build`/`next dev`, porque
  compartilham `.next/`. Rode `npx tsc --noEmit`, `npx eslint <seus caminhos>` e `npx vitest run <seus testes>`.
- Se `PageProps`/`LayoutProps`/`RouteContext` aparecerem como inexistentes, rode `npx next typegen`.
- Mudou schema: gere a migração e rode os testes (o PGlite aplica todas as migrações).
- Mudou UI: abra a tela no navegador (desktop e largura de celular) com mais de um perfil demo. Quando
  `next dev` não pode rodar (sessões paralelas), renderize a tela no Vitest (`react-dom/server`, sessão
  simulada, CSS do Tailwind compilado) e capture com o Chrome sem interface em 1440 e 390 px, como na P0.6
  (`.data/p06-shots/`). Nenhuma tela da v2 foi usada num navegador com o servidor real (ver `docs/STATUS.md`).
- Atualize `docs/STATUS.md` e, se mudar contratos entre módulos, `docs/dev/MODULE_CONTRACTS.md`.

## Armadilhas conhecidas

- **Vitest no Git Bash (Windows)** falha antes de rodar qualquer teste ("Vitest failed to find the runner" /
  "Cannot read properties of undefined (reading 'config')") quando o diretório atual tem a letra do drive em
  minúscula (`cd /c/Users/...` resulta em `c:\...`). Entre com `cd C:/Users/...` (maiúscula) ou rode pelo
  **PowerShell** (ou cmd), onde passa normalmente.
- **Status HTTP com streaming**: as rotas de `(app)` têm `loading.tsx`, então a resposta começa com `200`
  antes da página rodar. `redirect("/sem-permissao")` e `notFound()` chamados na página viram redirecionamento
  no cliente e a tela de "não encontrado" com `noindex`; o status continua `200` (comportamento documentado do
  Next 16). Para testar por HTTP, procure `NEXT_REDIRECT;replace;/sem-permissao` ou
  `NEXT_HTTP_ERROR_FALLBACK;404` no HTML. Sem cookie, o proxy e o layout ainda redirecionam com `307` real.
- **React 19 reseta formulários** após uma server action (inclusive quando ela devolve erro). Para manter o que foi
  digitado ou escolhido, use `onSubmit={usePreservingSubmit(formAction)}` de `@/components/ui/use-preserving-submit`
  e mantenha `action={formAction}` no `<form>` (fallback sem JS). Formulários do work usam `useFormAction` e os do
  admin `useAdminForm`, que fazem o mesmo. Devolver `values` no estado da ação **não basta**: o React não reaplica um
  `defaultValue` alterado em `<select>`, e o reset automático volta a escolha original sem aviso.
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
  Planilhas usam `/api/imports/upload` (mesma checagem, `isSameOrigin` em `imports/http.ts`). Uma rota nova de
  upload precisa ser excluída do `matcher` de `src/proxy.ts`.
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
  descrições de tarefas e prazos) deve dizer que é demonstrativo. O mesmo vale para a análise preliminar
  simulada, os e-mails simulados e a chegada simulada de processos ("simulação", "fictício").
- **Drizzle: subconsulta correlacionada num `select` de UMA tabela**. Nos campos selecionados, as colunas
  dentro de ``sql`…` `` são escritas **sem o nome da tabela**. Uma subconsulta como
  `(select count(*) from users where users.unit_id = units.id)` vira uma comparação de `users.unit_id` com
  `users.id` e retorna 0 sem erro. Use uma consulta agrupada separada ou um `join`. (Foi a causa da lista de
  unidades da administração mostrar sempre 0 usuários/equipes, já corrigido.)
- **`sendTemplatedEmail` só depois do commit**: ele abre as próprias transações (entrega em duas fases) e
  precisa enxergar o processo, a análise e a entrada referenciados; chamá-lo dentro da sua transação falha ou
  envia sobre dados não confirmados. Ele **não** confere `settings.email.notifyOnBriefReady` /
  `notifyOnAssignment` (quem chama confere) e, em contexto de usuário, exige `email:send`, que analista,
  auditoria e escritório externo não têm. Notificações como efeito colateral usam `systemContext(orgId)`.
- **Espelhos de contingência em `legal_processes`** (`liquidatedAmountCents`, `riskPercentageBp`,
  `lossProbability`, `provisionAmountCents`, e `claimAmountCents` pelas regras do valor da causa) são
  recalculados **só** por `syncProcessMirrors` (`contingency/internal.ts`, na mesma transação; chamado também
  pelos pedidos e pelo serviço de processos) e pela confirmação ou desfazer da importação. Não grave esses
  campos em outro lugar: `createProcess`/`updateProcess` ignoram provisão e probabilidade. Registre valores,
  risco e garantias pelo serviço de contingências. Valor da causa de quem não tem `contingency:approve` vira
  valoração **proposta** e não chega ao cadastro antes da conferência.
- **Nunca some valor da causa e valor liquidado** (RN-02) e **nunca trate nulo como zero** (RN-03): use
  `netExposure`, `provisionFor` e `addToBucket` de `src/domain/contingency.ts`, mostre "Não apurado" e deixe
  a célula vazia nas exportações. Estimativas (causa ponderada pelo risco) são sempre sinalizadas (RN-07).
- **Valores e risco são append-only**: nunca faça `UPDATE` de `amount_cents`; nova apuração = novo registro e
  a oficial anterior vira `superseded`. Oficial exige `reviewedById` de uma pessoa (contexto de sistema não
  oficializa). Competência `closed` é imutável. Ver ADR-0011.
- **Auditoria de registros filhos do processo** (valoração, garantia, risco, acordo, audiência) usa
  `entityType: "legal_process"` e o id do filho em `metadata`, para aparecer no "Histórico" do processo.
- **Contexto delegado da entrada de processos** (`processContext` em `intake/service.ts`) usa
  `{ ...ctx, kind: "system" }` só para criar o processo e as partes de uma entrada registrada por analista.
  Não copie esse padrão; contexto de sistema passa em todas as permissões e vê toda a organização.
- **CSV**: use os helpers com BOM, `;`, vírgula decimal e neutralização de fórmulas (`csvCell` em
  `admin/audit-csv.ts` ou `imports/csv.ts`, `csvValue` em `reports/csv.ts`, `csvText` em `contingency/csv.ts`).
  O `csvCell` de `contingency/csv.ts` só escapa aspas e separadores: use-o só para valores numéricos já
  formatados.
- **Chave `"__none__"`** (`NONE_KEY`) marca dimensão vazia nas métricas do fechamento e nos relatórios;
  `"unclassified"` em `byClassification`. Não a mostre crua.
- **Sino de alertas e dados do shell** são carregados pelo layout, que não re-renderiza na navegação: a
  contagem só muda após `revalidatePath` ou recarga.
- **Testes de importação com a planilha completa** são pesados (cerca de 50 s no PGlite, timeouts de 240 s).
  Rode-os separados quando estiver mexendo em outro módulo.
- **Visões do schema `bi` precisam de `WITH (security_barrier = true)`**: sem a opção, uma função criada pelo
  usuário de leitura do Power BI na própria sessão vê linhas de outra organização antes do filtro da visão.
  Uma migração que recriar uma visão do `bi` deve declarar a opção (e o `tests/bi/data.test.ts` confere todas);
  depois dela, o `scripts/bi-setup.ts` precisa rodar de novo para reconceder a leitura. Nunca leia tabelas
  `public` direto do Power BI.
- **`sendTemplatedEmail` sempre depois do commit** (ver a armadilha acima): nas rotas novas (atribuição, API de
  entrada, rotinas), dispare o e-mail fora da transação que criou o processo, a entrada ou a análise.
- **Trocar índice nunca move dinheiro**: `setValuationCorrectionIndex` em valor oficial cria um novo registro e é
  recusado quando outra instância tem valor do mesmo tipo e data-base ou quando o valor em vigor mudaria
  (`indexSwapInForceChange`/`sameBaseDateOtherInstance` em `indices/swap-guard.ts`). Ao mexer na ordem de
  `OFFICIAL_VALUATION_ORDER` ou em `later()` de `contingency/position.ts`, mantenha os três iguais. O valor
  atualizado é calculado na leitura (`indices/math.ts`) e nunca entra em totais, espelhos ou fechamentos.
- **Bloqueio do fechamento nos testes e seeds**: `closeSnapshot` lança `CloseBlockedError` quando há processo da
  prévia sem classificação de risco oficial na data-base, e `ConflictError` quando a prévia está desatualizada.
  Em testes e cargas, classifique os processos (avaliação oficial com `effective_from` até a data-base) ou passe
  `{ justification }` com pelo menos 20 caracteres, e recalcule a prévia (`generateSnapshot`) depois de mudar
  dados. A rotina nunca fecha.
- **Inter e o hífen com números tabulares**: o recurso `tnum` da Inter alarga o hífen ("e - mail", números CNJ
  espaçados). Por isso não há `tabular-nums` global no `body` (`src/app/globals.css`): use a classe
  `tabular-nums` só em células e números (células `td.text-right` já recebem). Não aplique em blocos de texto.
- **Textos pt-BR sem travessão e sem códigos internos**: nada de "—" ou " – " como pontuação, nem RN-xx, RF-xx,
  TE-xx, PD-xx ou INT-xx em texto visível; valor vazio aparece como "Não informado" (ou "Não apurado") em cinza,
  nunca "—". O `tests/sweep/pt-br-text.test.ts` varre rótulos e o código-fonte. Trechos literais de documentos
  mantêm a pontuação original.
- **DataJud e Banco Central nos testes**: nunca chame as APIs reais. Use `setCourtProviderForTesting` (há um
  provedor falso em `src/server/integrations/courts/fake.ts`) e `setSgsClientForTesting`. Números CNJ de teste
  devem usar uma origem inexistente (ex.: unidade 9999), como no `scripts/demo-api-push.ts`.
