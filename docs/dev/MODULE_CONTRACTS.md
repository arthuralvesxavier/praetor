# Module contracts

Cross-module APIs and conventions. Modules may add functions, but the
signatures listed here are relied upon by other modules — change them only
together with every caller.

## Layout

```
src/
  app/                       Next.js routes only (thin): pages, layouts, route handlers
  components/ui/             design-system primitives (client-safe)
  components/layout/         app shell (sidebar, header, demo banner)
  domain/                    client-safe shared types: enums.ts, analysis.ts, entities.ts
  lib/                       client-safe helpers: format.ts, utils.ts (cn)
  modules/<domain>/
    schemas.ts               zod input contracts (client-safe, no server imports)
    service.ts               business rules + persistence (server only)
    actions.ts               "use server" actions — thin wrappers over service.ts
    components/              domain UI (server components by default; "use client" only when needed)
  server/
    auth/                    context, permissions, access (row visibility), session (Next glue)
    db/                      drizzle client + schema
    integrations/ai/         AI provider interface + implementations
    integrations/storage/    file storage provider
    integrations/text-extraction.ts
    jobs/                    queue, worker loop, handlers, routines
    services/                cross-cutting: audit.ts, auth.ts
    lib/                     errors, logger
scripts/                     db-dev, migrate, seed, worker
tests/                       vitest (PGlite)
```

Domains: `processes`, `occurrences`, `contracts`, `documents`, `work` (deadlines + tasks),
`comments`, `alerts`, `analyses`, `dashboard`, `admin` (users, teams, units, settings, audit queries).

## Service conventions (mandatory)

1. First parameter is `ctx: AuthContext` (`@/server/auth/context`). Never accept
   `organizationId`/`userId` from the client.
2. Check the action permission with `assertCan(ctx, "<perm>")` (`@/server/auth/permissions`).
3. Every tenant read includes the row-visibility condition from `@/server/auth/access`
   (`processWhere`, `occurrenceWhere`, `contractWhere`, `documentWhere`, `taskWhere`,
   `deadlineWhere`, `analysisWhere`, `entityReferenceWhere`). Single-record reads query
   `and(eq(table.id, id), <scope>)` and throw `NotFoundError` when empty.
   Writes to an existing record first load it with the same scope.
   Foreign ids received in input (processId, responsibleId, unitId, …) must be checked to
   belong to `ctx.organizationId` (and be visible, for records) before being stored.
4. Validate input inside the service with the module's zod schema (services are the trust
   boundary for actions, route handlers, jobs and tests). Throw `ValidationError` with
   `fieldErrors` from `z.flattenError(err).fieldErrors`.
5. Mutations run in `getDb().transaction(async (tx) => …)` and call
   `recordAudit(ctx, {...}, tx)` with `diffChanges(before, after)` for updates.
6. Dates: `date` columns are `"YYYY-MM-DD"` strings; timestamps are `Date`. Money is integer cents.
7. Lists return `Paginated<T>` (`@/domain/entities`) and accept `Page`.
8. Services never import from `next/*` or `@/server/auth/session` (they also run in the worker
   and in tests). Only `actions.ts`, pages and route handlers use the session helpers.
9. Never log or audit document contents, extracted text, prompts or AI answers.

## Server action conventions

```ts
"use server";
export async function createXAction(_prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireActionContext("x:write");
    const result = await createX(ctx, parseFormData(formData));
    revalidatePath("/x");
    return { ok: true, data: { id: result.id }, message: "Registro salvo." };
  } catch (err) {
    return toActionError(err);   // logs nothing sensitive; maps AppError -> pt-BR message
  }
}
```
`redirect()` must be called outside `try`. Unexpected errors should be logged with
`logger.error("action_failed", { action: "createX", error })` before `toActionError`.

## URL filter parameters (used by dashboard deep links)

Values are the English enum ids from `@/domain/enums`.

| Route | Params |
|---|---|
| `/dashboard` | `periodo=30d\|90d\|6m\|12m\|ytd\|all` (padrão `12m`), `unidade`, `area`, `responsavel` — ver `src/modules/dashboard/bi-filters.ts` |
| `/processos` | `q`, `status`, `area`, `phase`, `risco`, `unidade`, `responsavel`, `pagina` |
| `/preventivo` | `q`, `status`, `categoria`, `risco`, `unidade`, `responsavel`, `pagina` |
| `/contratos` | `q`, `status`, `tipo`, `vencendo=1` (ends within org setting days), `responsavel`, `pagina` |
| `/documentos` | `q`, `categoria`, `pagina` |
| `/prazos` | `aba=calendario\|prazos\|tarefas\|validacao`, `situacao=vencidos\|proximos\|abertos`, `responsavel`, `origem`, `mes=YYYY-MM`, `pagina` |
| `/ia` | `status`, `tipo`, `desatualizadas=1`, `pagina` |
| `/admin/auditoria` | `acao`, `entidade`, `usuario`, `de`, `ate`, `pagina` |

Additional params implemented by the modules (additive; the table above still holds):

| Route | Extra params |
|---|---|
| `/preventivo` | `risco` may repeat (`?risco=high&risco=critical`) |
| `/contratos` | `vencidos=1` (status expired, or active with end date before today) |
| `/prazos` | `q` (Prazos and Tarefas tabs); Tarefas tab: `status`, `tipo`, `situacao=vencidos`; `prazo=<id>` / `tarefa=<id>` highlight an item |
| `/ia` | `aba=analises\|perguntas\|solicitar\|uso` |
| `/admin/usuarios`, `/admin/equipes`, `/admin/unidades` | `q`, `perfil`, `unidade`, `situacao=ativos\|inativos`, `pagina` |
| Detail pages | `aba=<tab>` (e.g. `/processos/[id]?aba=partes`); `/processos/[id]?vinculo=falhou` shows the occurrence-link warning |

## Cross-module service APIs

### documents — `@/modules/documents/service`
```ts
type UploadFile = { name: string; bytes: Uint8Array };
uploadDocument(ctx, input: {
  title: string; category: DocumentCategory; description?: string | null;
  confidentiality?: ConfidentialityLevel; processId?: string | null; occurrenceId?: string | null;
  contractId?: string | null; file: UploadFile;
}): Promise<{ documentId: string; versionId: string }>
addDocumentVersion(ctx, documentId: string, input: { changeNote?: string | null; file: UploadFile }): Promise<{ versionId: string; versionNumber: number }>
listDocuments(ctx, filters: { q?: string; category?: DocumentCategory; processId?: string; occurrenceId?: string; contractId?: string } & Page): Promise<Paginated<DocumentListItem>>
getDocument(ctx, id: string): Promise<DocumentDetail>              // includes versions
openDocumentVersion(ctx, documentId: string, versionId: string): Promise<{ fileName: string; mimeType: string; sizeBytes: number; stream: ReadableStream<Uint8Array> }>
extractDocumentVersionText(versionId: string): Promise<void>        // system, called by the job handler
```
UI: `import { EntityDocuments } from "@/modules/documents/components/entity-documents"`
`<EntityDocuments ctx={ctx} entity={{ type: "legal_process" | "occurrence" | "contract", id }} />` (server component; shows list + upload form when allowed).

### work — `@/modules/work/service`
```ts
listDeadlines(ctx, filters: { situation?: "overdue" | "upcoming" | "open"; status?: DeadlineStatus; responsibleId?: string; origin?: DataOrigin; validationStatus?: ValidationStatus; processId?: string; occurrenceId?: string; contractId?: string; from?: string; to?: string } & Page): Promise<Paginated<DeadlineListItem>>
createDeadline(ctx, input: DeadlineInput): Promise<{ id: string }>          // manual
createSuggestedDeadline(ctx, input: { title: string; dueDate: string; kind: DeadlineKind; description?: string | null; sourceAnalysisId: string; sourceExcerpt: string; processId?: string | null; occurrenceId?: string | null; contractId?: string | null }): Promise<{ id: string }>  // origin ai_suggested + pending_validation
validateDeadline(ctx, id: string, input: { decision: "validated" | "rejected"; note?: string | null; dueDate?: string | null }): Promise<void>   // requires deadline:validate
setDeadlineStatus(ctx, id: string, status: DeadlineStatus): Promise<void>
listTasks(ctx, filters: { status?: TaskStatus; assigneeId?: string; kind?: TaskKind; processId?: string; occurrenceId?: string; contractId?: string; overdue?: boolean } & Page): Promise<Paginated<TaskListItem>>
createTask(ctx, input: TaskInput & { origin?: "manual" | "ai_suggested"; sourceAnalysisId?: string | null }): Promise<{ id: string }>
updateTask(ctx, id: string, patch: Partial<TaskInput> & { status?: TaskStatus }): Promise<void>
```
UI: `import { EntityWorkItems } from "@/modules/work/components/entity-work-items"`
`<EntityWorkItems ctx={ctx} entity={{ type, id }} taskKind?: TaskKind title?: string />`.

### comments — `@/modules/comments/service`
```ts
listComments(ctx, entity: EntityRef): Promise<CommentItem[]>
addComment(ctx, entity: EntityRef, body: string): Promise<{ id: string }>
```
UI: `<CommentThread ctx={ctx} entity={{ type, id }} />` from `@/modules/comments/components/comment-thread`.

### analyses — `@/modules/analyses/service`
```ts
requestAnalysis(ctx, input: { type: AnalysisType; subjectType: AnalysisSubjectType; subjectId?: string | null; question?: string | null; trigger?: AnalysisTrigger }): Promise<{ analysisId: string; reused: boolean }>
listAnalyses(ctx, filters: { subjectType?: AnalysisSubjectType; subjectId?: string; status?: AnalysisStatus; type?: AnalysisType; staleOnly?: boolean } & Page): Promise<Paginated<AnalysisListItem>>
getAnalysis(ctx, id: string): Promise<AnalysisDetail>
reviewAnalysis(ctx, id: string, input: { decision: "reviewed" | "dismissed"; note?: string | null }): Promise<void>
applySuggestedTask(ctx, analysisId: string, index: number): Promise<{ taskId: string }>
applySuggestedDeadline(ctx, analysisId: string, index: number): Promise<{ deadlineId: string }>
markAnalysesStaleForEntity(input: { organizationId: string; entityId: string; reason: string }, db?: DbOrTx): Promise<number>  // system
onDocumentVersionTextReady(input: { organizationId: string; documentId: string; versionId: string }): Promise<void>        // system
getAiRuntimeInfo(): { mode: AiMode; provider: string; model: string }
```
Modules that update a process/occurrence/contract call `markAnalysesStaleForEntity` in the same transaction.
UI: `<AnalysisPanel ctx={ctx} subject={{ type: AnalysisSubjectType, id }} />` from `@/modules/analyses/components/analysis-panel`.

### alerts — `@/modules/alerts/service`
```ts
listAlerts(ctx, filters: { openOnly?: boolean; limit?: number }): Promise<AlertItem[]>
resolveAlert(ctx, id: string): Promise<void>
upsertAlert(input: { organizationId: string; type: AlertType; severity: AlertSeverity; title: string; message: string; entityType: EntityType; entityId: string; dedupeKey: string }, db?: DbOrTx): Promise<void>   // system
```

### jobs — `@/server/jobs/queue`
```ts
enqueueJob(input: { type: JobType; organizationId?: string | null; payload: Record<string, unknown>; dedupeKey?: string | null; runAt?: Date; maxAttempts?: number }, db?: DbOrTx): Promise<{ id: string; deduplicated: boolean }>
```

### more analyses / jobs helpers
```ts
// @/modules/analyses/service
getAiUsageSummary(ctx): Promise<{ period: string; requests: number; inputTokens: number; outputTokens: number; costMicroUsd: number; monthlyTokenBudget: number }>
// @/server/jobs/worker
processPendingJobs(opts?: { limit?: number }): Promise<{ processed: number }>   // runs queued jobs inline (admin "processar fila agora", seed, tests)
// @/server/jobs/routines
ensureDefaultRoutines(organizationId: string, db?: DbOrTx): Promise<void>
```

### processes / occurrences / contracts
```ts
// @/modules/processes/service
listProcessOptions(ctx): Promise<{ id: string; number: string; title: string }[]>
// @/modules/occurrences/service
listOccurrenceOptions(ctx): Promise<{ id: string; title: string }[]>
linkOccurrenceToProcess(ctx, occurrenceId: string, processId: string): Promise<void>   // sets linkedProcessId + status converted_to_process; requires occurrence:write
// /processos/novo?ocorrencia=<id> pre-fills the form from the occurrence and links it after creation.
// @/modules/contracts/service
listContractOptions(ctx): Promise<{ id: string; title: string; counterparty: string }[]>
```

### admin — `@/modules/admin/service`
```ts
listUserOptions(ctx): Promise<{ id: string; name: string; role: Role; unitId: string | null }[]>   // active users of the org
listUnitOptions(ctx): Promise<{ id: string; name: string }[]>
listEntityHistory(ctx, entity: EntityRef): Promise<{ id: string; action: string; summary: string; actorName: string | null; changes: Record<string, { from: unknown; to: unknown }> | null; createdAt: Date }[]>
```
UI: `<EntityHistory ctx={ctx} entity={{ type, id }} />` from `@/modules/admin/components/entity-history`.

## Data-origin separation (UI rule)

Every screen that mixes sources must label them with `<OriginBadge origin=... />`:
cadastrado manualmente / importado / sugerido pela IA (pendente de validação humana).
AI output is shown only inside analysis views with sources, date, limitations,
validation points and the disclaimer — never merged silently into record fields.

---

# v2 — Carteira, contingências, entrada de processos e simulações

Added by the v2 reformulation (migration `drizzle/0001_v2_portfolio.sql`, additive only).
Everything above still applies. Business rules come from the requirements document
("Levantamento de requisitos — gestão de passivo"): RN-01..RN-12, RF-01..RF-24.

## Business rules that code must enforce

| Rule | Where |
|---|---|
| RN-01/RN-09 CNJ number is the key: one `legal_processes` row per CNJ; each instance is a `process_instances` row. Counts never add instances. | processes, imports |
| RN-02 Valor da causa and valor liquidado are never summed; always shown side by side and labeled. | everywhere |
| RN-03 Null is not zero: `null` liquidated = "não apurado" (UI shows "Não apurado", CSV leaves the cell empty). | everywhere |
| RN-04/RN-05/RN-07 Exposure and provision: use the pure functions in `@/domain/contingency` (`netExposure`, `provisionFor`, `addToBucket`). Estimates are always flagged. | contingency, reports, dashboard |
| RN-06 Extinction by payment = new `liquidated` valuation with amount 0 and reason "Quitação"; history stays. | contingency |
| RN-08 Divergent values are recorded (proposed valuation with reason), never overwritten silently. | imports, contingency |
| RN-10 Monthly snapshot; a `closed` period is immutable and reports read it from `portfolio_snapshot_items`. | contingency, reports |
| RN-11 Proposed values only become `official` through an identified human (`reviewedById`). Below `settings.contingency.confidenceThreshold` they cannot be bulk-approved. | contingency |
| RN-12 Loss of patronage: `status = closed`, `closureReason = lost_patronage`; out of the active portfolio, history kept. | processes |
| RF-12 Automatic risk suggestions are always `status = proposed`. | contingency |
| AI / e-mail | Simulated only in this version. Every simulated output is labeled (see "Simulation labeling"). |

## Ownership (v2 build)

Each package owns the files listed; do not edit files owned by another package.
Shared files not listed (enums, schema, access, permissions, nav, job handlers,
routines registry, test fixtures, docs) are owned by the integrator: report needed changes instead.

| Package | Owns |
|---|---|
| brand-shell | `src/components/brand/**`, `src/components/layout/**`, `src/app/(app)/layout.tsx`, `src/app/(app)/busca/**`, `src/app/globals.css`, `src/app/icon.svg`, `src/app/favicon.ico`, `src/app/apple-icon.png`, `src/app/page.tsx`, `src/components/landing/**`, `src/app/login/**`, `scripts/generate-icons.mjs` |
| portfolio | `src/modules/processes/**`, `src/app/(app)/processos/**`, `src/app/api/processes/**` |
| contingency | `src/modules/contingency/**`, `src/app/(app)/contingencias/**`, `src/app/(app)/acordos/**`, `src/app/api/contingency/**` |
| hearings-alerts | `src/modules/hearings/**`, `src/modules/alerts/**`, `src/modules/work/**`, `src/app/(app)/audiencias/**`, `src/app/(app)/alertas/**`, `src/app/(app)/prazos/**` |
| imports | `src/modules/imports/**`, `src/app/(app)/importacoes/**`, `src/app/api/imports/**` |
| briefs-ai | `src/modules/briefs/**`, `src/server/integrations/ai/case-brief/**`, `src/server/integrations/text-extraction.ts`, `src/modules/documents/**`, `src/app/(app)/analises-preliminares/**`, `src/app/(app)/documentos/**`, `src/app/api/documents/**` |
| intake-distribution | `src/modules/intake/**`, `src/modules/distribution/**`, `src/app/(app)/entrada/**`, `src/app/(app)/distribuicao/**` |
| emails | `src/modules/emails/**`, `src/server/integrations/email/**`, `src/app/(app)/emails/**` |
| reports-preventive | `src/modules/reports/**`, `src/modules/preventive-intel/**`, `src/app/(app)/relatorios/**`, `src/app/(app)/inteligencia-preventiva/**`, `src/app/api/reports/**` |
| admin-dashboard | `src/modules/admin/**`, `src/modules/organization/**`, `src/app/(app)/admin/**`, `src/modules/dashboard/**`, `src/app/(app)/dashboard/**` |

Tests: each package writes its own `tests/<package>/**`. Shared fixture: `tests/helpers/fixtures.ts`
(`setupFixture()` now also returns `companyA`, `lawFirmA` and contexts `accountant`, `auditor`,
`externalCounsel` — the latter belongs to `lawFirmA`).

## New roles and permissions

Roles: `accountant` (contabilidade), `auditor` (auditoria), `external_counsel` (escritório externo,
`AuthContext.lawFirmId`). See `ROLE_PERMISSIONS` in `src/server/auth/permissions.ts` and rules 10–13
in `src/server/auth/access.ts`. New permissions: `contingency:read|write|approve`, `snapshot:close`,
`report:read`, `import:run`, `intake:manage`, `distribution:manage`, `brief:read|review`,
`email:read|send`, `preventive_intel:read`.

New row-visibility builders (`@/server/auth/access`): `processChildWhere(ctx, table)`,
`valuationWhere`, `guaranteeWhere`, `riskAssessmentWhere`, `settlementWhere`, `hearingWhere`,
`intakeWhere`, `caseBriefWhere`, `emailWhere`, and `visible*Ids` for each. `entityReferenceWhere`
also resolves `hearing`, `settlement`, `valuation`, `guarantee`, `case_brief`, `intake`.
Companies, law firms, distribution rules, import batches and snapshots are organization-level
(permission-gated, `organization_id = ctx.organizationId`).

## New tables (see the schema files for column docs)

`companies`, `law_firms` (core.ts) · `process_instances` + new `legal_processes` columns
(`companyId`, `lawFirmId`, `instance`, `processClass`, `city`, `state`, `phaseDetail`,
`liquidatedAmountCents`, `riskPercentageBp`, `closureReason`, `needsVerification`,
`verificationNote`, `lastMovementAt`, `importBatchId`) (legal.ts) · `process_valuations`,
`process_guarantees`, `process_risk_assessments`, `settlements`, `settlement_installments`,
`portfolio_snapshots`, `portfolio_snapshot_items` (contingency.ts) · `hearings`,
`distribution_rules`, `case_intakes` (operations.ts) · `case_briefs`, `case_brief_revisions`,
`case_brief_sources` (briefs.ts) · `email_messages`, `email_events` (email.ts) ·
`import_batches`, `import_rows` (imports.ts). `document_versions` gained `pageCount` and
`pageOffsets`. `process_parties.liabilityNature`, `process_events.cnjMovementCode|instance`.

Denormalized mirrors on `legal_processes` (kept in sync by the contingency service inside the same
transaction): `liquidatedAmountCents` = latest OFFICIAL liquidated valuation, `riskPercentageBp` /
`lossProbability` = official risk assessment in force, `provisionAmountCents` = current provision.
The import commit may write the mirrors directly for the initial load (same rules).

Organization settings gained `contingency`, `email`, `intake` and two alert windows; always read
them through `mergeOrganizationSettings` / `loadOrganization` (`@/modules/analyses/org-settings`).

## v2 cross-module APIs (stubs exist; owners implement the bodies, signatures are fixed)

```ts
// @/modules/organization/service  (implemented)
listCompanyOptions(ctx): Promise<{ id; name }[]>
listLawFirmOptions(ctx): Promise<{ id; name }[]>
assertCompanyInOrg(ctx, id, db?) / assertLawFirmInOrg(ctx, id, db?)   // ValidationError on field companyId / lawFirmId

// @/modules/processes/service  (implemented)
searchProcesses(ctx, q, limit = 8): Promise<{ id; number; title; court; status }[]>

// @/modules/alerts/service  (implemented)
countOpenAlerts(ctx): Promise<{ total; critical }>

// @/modules/contingency/service
getProcessContingencySummary(ctx, processId): Promise<ProcessContingencySummary>
getPortfolioExposure(ctx, filters?): Promise<{ rows: PortfolioExposureRow[]; totals: MoneyBucket }>
proposeValuation(ctx, input: ProposeValuationInput): Promise<{ id }>     // always `proposed`
// @/modules/contingency/components/process-tabs
<ProcessContingencyTab ctx processId />  <ProcessSettlementsTab ctx processId />  <ProcessValuesSummary ctx processId />
// @/modules/contingency/routines
runPortfolioAlertsRoutine(rc) / runMonthlySnapshotRoutine(rc): Promise<string>

// @/modules/hearings/service
listUpcomingHearings(ctx, { days?, limit? }): Promise<UpcomingHearing[]>
// @/modules/hearings/components/process-hearings-tab
<ProcessHearingsTab ctx processId />
// @/modules/hearings/routines
runHearingAlertsRoutine(rc): Promise<string>

// @/modules/briefs/service
requestCaseBrief(ctx, processId, { intakeId?, inline? }): Promise<{ briefId; status }>
runCaseBriefJob(briefId, { attempt, maxAttempts }): Promise<void>            // job "case_brief.generate" { briefId }
getLatestCaseBriefSummary(ctx, processId): Promise<CaseBriefSummary | null>
getCaseBriefEmailDigest(ctx, briefId): Promise<CaseBriefEmailDigest>
onDocumentTextReadyForBriefs({ organizationId, documentId, versionId }): Promise<void>
// @/modules/briefs/demo-documents
buildDemoCaseDocuments(info: DemoCaseInfo, { variant? }): Promise<DemoDocument[]>   // fictitious PDFs (pdf-lib)
// @/modules/briefs/components/process-brief-tab
<ProcessBriefTab ctx processId />

// @/modules/emails/service   (templates' data types in @/modules/emails/templates)
sendTemplatedEmail(ctx, { template, toUserId, data, linkPath, processId?, briefId?, intakeId?, entity? }): Promise<{ emailId }>
// @/modules/emails/components/process-emails-tab
<ProcessEmailsTab ctx processId />
// @/server/integrations/email
getEmailProvider(): EmailProvider (SimulatedEmailProvider only) · getEmailRuntimeInfo()

// @/modules/distribution/service
decideAssignment(ctx, processId): Promise<AssignmentDecision>
assignResponsible(ctx, processId, { force? }): Promise<AssignmentDecision>

// @/modules/intake/service
processIntakeJob(intakeId, { attempt, maxAttempts }): Promise<void>         // job "intake.process" { intakeId }
getIntakeCounts(ctx): Promise<IntakeCounts>

// @/server/integrations/ai/case-brief/provider
CaseBriefProvider.generate(CaseBriefRequest): Promise<{ brief: CaseBrief; usage }>
pageForOffset(pageOffsets, offset): number | null
```

Process-detail tab content components are async server components `({ ctx, processId })` that check
their own permission and render nothing (or a short pt-BR notice) when the user lacks it.

## Process detail tabs (`/processos/[id]?aba=...`)

`visao-geral` (default) · `partes` · `instancias` · `movimentacoes` · `valores` (contingency) ·
`acordos` (contingency) · `audiencias` (hearings) · `analise-preliminar` (briefs) · `documentos` ·
`prazos` · `emails` (emails) · `ia` · `comentarios` · `historico`.
Links into the brief use `/processos/<id>?aba=analise-preliminar`.

## New routes and URL params

| Route | Params |
|---|---|
| `/processos` | v1 params + `tribunal`, `instancia`, `cidade`, `uf`, `empresa`, `escritorio`, `classe`, `valor_min`, `valor_max` (reais), `liquidado=com\|sem`, `verificar=1`, `carteira=ativa\|encerrada\|todas` (default `ativa`), `ordem` |
| `/entrada` | `status`, `pagina` |
| `/entrada/[id]` | — (pipeline timeline) |
| `/analises-preliminares` | `status`, `responsavel`, `pagina` |
| `/analises-preliminares/[id]` | `editar=1` |
| `/audiencias` | `periodo=7d\|30d\|90d\|passadas`, `status`, `responsavel`, `pagina` |
| `/alertas` | `tipo`, `severidade`, `situacao=abertos\|resolvidos` |
| `/contingencias` | `empresa`, `tribunal`, `instancia`, `fase` |
| `/contingencias/revisao` | `origem`, `confianca=baixa\|alta`, `pagina`, `item` (selected valuation) |
| `/contingencias/provisao` | `competencia=YYYY-MM` |
| `/acordos` | `status`, `vencendo=1`, `pagina` |
| `/relatorios` | `tipo`, `empresa`, `unidade`, `competencia` |
| `/inteligencia-preventiva` | `empresa`, `tribunal` |
| `/distribuicao` | `aba=regras\|carga` |
| `/emails` | `modelo`, `destinatario`, `processo`, `pagina` |
| `/emails/[id]` | — |
| `/importacoes`, `/importacoes/nova`, `/importacoes/[id]` | `/importacoes/[id]`: `aba=resumo\|linhas\|inconsistencias\|divergencias`, `nivel`, `acao`, `planilha`, `pagina` |
| `/busca` | `q` |

`/dashboard` gains `empresa`. Money in URLs is in reais (integer); services take cents.
Uploads that are not documents go through a route handler excluded from the proxy matcher
(`/api/imports/upload` is already excluded in `src/proxy.ts`). `/brand/*` (public logo files) too.

## Simulation labeling (mandatory UI rule)

- Anything produced by the simulated case-brief provider shows `CASE_BRIEF_DEMO_NOTICE`
  (`@/domain/case-brief`) and each item shows its provenance badge (`PROVENANCE_LABELS`):
  Extraído (with document + page + quote), Cadastro/planilha, Ilustrativo, Lacuna.
- Every simulated e-mail shows a banner "Envio simulado — nenhuma mensagem foi enviada" and its
  subject starts with "[Simulação]".
- Indicators computed from data must be visually separated from illustrative suggestions
  (label "Calculado a partir da carteira" vs "Sugestão ilustrativa").
- Demo documents carry "DOCUMENTO FICTÍCIO — GERADO PARA DEMONSTRAÇÃO" on every page.
- Never present simulated or illustrative content as a fact of the case; never invent case law,
  court movements, CNJ movement codes or tribunal integrations. Tribunal integrations (DataJud,
  MNI, PJe) are shown as "não integrado nesta versão".

## Demo data facts (spreadsheet `scripts/seed-data/files/Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx`)

Fictitious data provided by the client for the demo. Sheets: "Dashboard" (summary — ignore),
"Consolidado Geral" (1166 rows + header; a TOTAL row near row 1097, extra rows after it),
"1º Grau" (TOTAL near 717), "2º Grau" (no Cidade column; TOTAL near 241), "3º Grau (TST)"
(Instância values "3º Grau (TST)" and "TST"; TOTAL near 143), "Atualização Geral (29-07-2026)"
(narrative log — ignore for rows). Columns: Instância, TRT/Tribunal, Nº do Processo, Parte Autora,
Parte Ré, Cidade, Vara / Órgão Julgador / Turma, Classe, Fase, Valor da Causa (R$),
Valor Liquidado/Apurado - 1º grau (R$). 208 CNJs repeat in Consolidado (up to 3 instances).
Fase is a composite string (e.g. "Execução — ARQUIVADO def. …", "PAGO/EXTINTO — arquivado def.
2026-06-25", "Conhecimento — Saiu do acervo … verificar", "Recurso decidido — baixou do 2º grau
(à origem/TST)"). City variants ("Palmas - TO", "Palmas/TO", "Palmas"), non-city values
("Cejusc Digital", "Secretaria de Cálculos Judiciais"). The client party is
"EMPRESA MODELO TESTE LTDA (e outros)". Values diverge across sheets for some CNJs.
Read it with `read-excel-file/node` (v9: default export returns `[{ sheet, data: rows[][] }]`).

## Alert producers (entity conventions)

`upsertAlert` (`@/modules/alerts/service`) with a stable `dedupeKey`; resolve with
`resolveStaleAlerts`/`resolveAlertsByDedupeKeys` when the condition disappears.

| Alert type | entityType / entityId | Producer |
|---|---|---|
| `hearing_upcoming` | `hearing` / hearing id | hearings routine |
| `settlement_installment_due` | `settlement` / settlement id | contingency routine |
| `valuation_pending_review` | `legal_process` / process id (one per process) | contingency routine |
| `enforcement_without_value` | `legal_process` | contingency routine |
| `guarantee_idle` | `guarantee` / guarantee id | contingency routine |
| `process_needs_verification` | `legal_process` | contingency routine |
| `brief_pending_review` | `case_brief` / brief id | briefs service (on generation; resolved on approve/reject) |
| `intake_unassigned`, `new_process_received` | `intake` / intake id | intake service |

The alerts package resolves links for every entity type (hearing/settlement/guarantee/valuation
alerts link to their process tab; `case_brief` → `/analises-preliminares/<id>`; `intake` →
`/entrada/<id>`).

## Contracts added before the build

- `CreateProcessInput` / `UpdateProcessInput` (`@/modules/processes/schemas`) already accept the v2
  optional fields (`companyId`, `lawFirmId`, `instance`, `processClass`, `city`, `state`,
  `phaseDetail`, `closureReason`, `needsVerification`, `verificationNote`, `lastMovementAt`);
  the portfolio package persists them (with tenant checks).
- Case-brief provenance `reviewer` ("Incluído/editado pelo advogado") is used for items written or
  changed during review; providers never emit it.
- XLSX export: `write-excel-file@4.1.1` is installed (`write-excel-file/node`). CSV exports use
  UTF-8 with BOM, `;` separator and decimal comma; null money cells stay empty (RN-03).
- The portfolio service may insert `claim` valuations (official, source `manual`, reviewer = the
  editing user) when the valor da causa is set/changed, so the value history (RF-09) is complete.
  The imports commit may insert instances/valuations/mirrors directly for the bulk load.
  Every other valuation write goes through the contingency service.
