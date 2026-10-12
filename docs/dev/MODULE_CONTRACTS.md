# Module contracts

Cross-module APIs and conventions. Modules may add functions, but the
signatures listed here are relied upon by other modules — change them only
together with every caller.

## Layout

```
src/
  app/                       Next.js routes only (thin): pages, layouts, route handlers
  components/ui/             design-system primitives (client-safe)
  components/layout/         app shell (sidebar, header, search, alerts bell, demo banner)
  components/brand/          logo (inline SVG), brand status page
  domain/                    client-safe shared types: enums.ts, analysis.ts, case-brief.ts,
                             contingency.ts (pure money rules), cnj.ts, entities.ts, demo.ts
  lib/                       client-safe helpers: format.ts, utils.ts (cn), nav.ts, tones.ts, search-params.ts
  modules/<domain>/
    schemas.ts               zod input contracts (client-safe, no server imports)
    service.ts               business rules + persistence (server only)
    actions.ts               "use server" actions — thin wrappers over service.ts
    components/              domain UI (server components by default; "use client" only when needed)
  server/
    auth/                    context, permissions, access (row visibility), session (Next glue)
    db/                      drizzle client + schema
    integrations/ai/         AI provider interface + implementations (Central de IA)
    integrations/ai/case-brief/  preliminary-analysis provider (simulated; live adapter not enabled)
    integrations/email/      e-mail provider interface (simulated only)
    integrations/storage/    file storage provider
    integrations/courts/     DataJud client (real API with DATAJUD_API_KEY; fake.ts for tests), per-tribunal rate limit
    integrations/bcb/        Banco Central SGS client (index series)
    integrations/powerbi/    Power BI REST client (embed tokens, refreshes)
    integrations/text-extraction.ts
    pdf/                     server-side PDF engine (pdf-lib + fontkit, embedded Inter / Cormorant Garamond)
    db/migrations.ts         rollback planner used by scripts/db-rollback.ts (drizzle/down/<tag>.sql)
    jobs/                    queue, worker loop, handlers, routines
    services/                cross-cutting: audit.ts, auth.ts
    lib/                     errors, logger
scripts/                     db-dev, migrate, db-rollback, seed, seed-v2, backfill-v2, worker, db-backup, db-restore,
                             bi-setup, demo-api-push, generate-icons
drizzle/                     migrations; drizzle/down/<tag>.sql = reversal of each migration from 0002 on
tests/                       vitest (PGlite)
```

Domains (v1): `processes`, `occurrences`, `contracts`, `documents`, `work` (deadlines + tasks),
`comments`, `alerts`, `analyses`, `dashboard`, `admin` (users, teams, units, settings, audit queries).
Domains added by v2: `organization` (companies, law firms), `contingency`, `hearings`, `imports`,
`briefs` (preliminary analysis), `intake`, `distribution`, `emails`, `reports`, `preventive-intel`.
Domains added after the v2 integration: `court-sync` (DataJud), `inbound` (API de entrada `/api/v1`),
`api-keys`, `bi` (Power BI), `indices` (correction indexes, P1.7), `claims` (pedidos, P1.6),
`legal-reports` (PDF reports engine and the R1 "Relatório de Processo"), `provision-memo` (memória de cálculo, P1.10).

## Service conventions (mandatory)

1. First parameter is `ctx: AuthContext` (`@/server/auth/context`). Never accept
   `organizationId`/`userId` from the client.
2. Check the action permission with `assertCan(ctx, "<perm>")` (`@/server/auth/permissions`).
3. Every tenant read includes the row-visibility condition from `@/server/auth/access`
   (`processWhere`, `occurrenceWhere`, `contractWhere`, `documentWhere`, `taskWhere`,
   `deadlineWhere`, `analysisWhere`, `entityReferenceWhere`, and the v2 builders listed below).
   Single-record reads query `and(eq(table.id, id), <scope>)` and throw `NotFoundError` when empty.
   Writes to an existing record first load it with the same scope.
   Foreign ids received in input (processId, responsibleId, unitId, companyId, lawFirmId, …) must be
   checked to belong to `ctx.organizationId` (and be visible, for records) before being stored.
4. Validate input inside the service with the module's zod schema (services are the trust
   boundary for actions, route handlers, jobs and tests). Throw `ValidationError` with
   `fieldErrors` from `z.flattenError(err).fieldErrors`.
5. Mutations run in `getDb().transaction(async (tx) => …)` and call
   `recordAudit(ctx, {...}, tx)` with `diffChanges(before, after)` for updates.
6. Dates: `date` columns are `"YYYY-MM-DD"` strings; timestamps are `Date`. Money is integer cents.
7. Lists return `Paginated<T>` (`@/domain/entities`) and accept `Page`.
8. Services never import from `next/*` or `@/server/auth/session` (they also run in the worker
   and in tests). Only `actions.ts`, pages and route handlers use the session helpers.
9. Never log or audit document contents, extracted text, prompts, AI answers, brief content,
   e-mail subjects/bodies/addresses or spreadsheet cell values.

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
| `/dashboard` | `periodo=30d\|90d\|6m\|12m\|ytd\|all` (padrão `12m`), `empresa` (v2), `unidade`, `area`, `responsavel` — ver `src/modules/dashboard/bi-filters.ts`; `dimensao=tribunal\|instancia\|fase\|cidade\|empresa\|unidade` (padrão `tribunal`, P0.3) — dimensão do gráfico da carteira, ver `src/modules/dashboard/dimension-chart.ts` |
| `/processos` | `q`, `status`, `area`, `phase`, `risco`, `unidade`, `responsavel`, `pagina` (+ v2 params below) |
| `/preventivo` | `q`, `status`, `categoria`, `risco`, `unidade`, `responsavel`, `pagina` |
| `/contratos` | `q`, `status`, `tipo`, `vencendo=1` (ends within org setting days), `responsavel`, `pagina` |
| `/documentos` | `q`, `categoria`, `pagina` |
| `/prazos` | `aba=calendario\|prazos\|tarefas\|validacao`, `situacao=vencidos\|proximos\|abertos`, `responsavel`, `origem`, `mes=YYYY-MM`, `pagina` |
| `/ia` | `status`, `tipo`, `desatualizadas=1`, `pagina` |
| `/admin/auditoria` | `acao`, `entidade`, `usuario`, `de`, `ate`, `pagina` |

Additional params implemented by the modules (additive; the table above still holds):

| Route | Extra params |
|---|---|
| `/preventivo` | `risco` may repeat (`?risco=high&risco=critical`); `origem=inteligencia-preventiva` (v2: occurrences created from a preventive-intelligence indicator) |
| `/contratos` | `vencidos=1` (status expired, or active with end date before today); v2: `acompanhamento=vencendo\|vencidos\|aviso\|obrigacoes_atrasadas` (`vencendo=1` and `vencidos=1` still work). `aviso` = active contract still in force whose notice date (end date − `renewalNoticeDays`, when > 0) falls within `alerts.contractExpirationDays` or has already passed |
| `/prazos` | `q` (Prazos and Tarefas tabs); Tarefas tab: `status`, `tipo`, `situacao=vencidos`; `prazo=<id>` / `tarefa=<id>` highlight an item |
| `/ia` | `aba=analises\|perguntas\|solicitar\|uso` |
| `/admin/usuarios`, `/admin/equipes`, `/admin/unidades` | `q`, `perfil`, `unidade`, `situacao=ativos\|inativos`, `pagina`; v2: `/admin/usuarios` also `escritorio=<lawFirmId>` |
| `/admin/auditoria` | v2: the "Acessos a processos sigilosos" shortcut is `acao=legal_process.view_confidential` |
| Detail pages | `aba=<tab>` (e.g. `/processos/[id]?aba=partes-e-andamento`, see "Process detail tabs"; the keys of the previous layout still work); `/processos/[id]?vinculo=falhou` shows the occurrence-link warning; `/processos/[id]?valor_causa=em_conferencia` shows "Valor da causa enviado para conferência" (P0.6); P0.4: `/processos/[id]?aba=valores-e-acordos#classificacao-risco` |

## Cross-module service APIs (v1)

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
// v2
getDocumentVersionPageText(ctx, documentId, versionId, page: number | null): Promise<DocumentPageText>  // one page of the extracted text (document:read + documentWhere)
```
`listDocuments` `q` matches title, description and file name only (never the extracted text).
`@/modules/documents/confidentiality`: `effectiveConfidentiality(category, requested)` — PD-04:
`sensitive_health` is always stored as `restricted` (upload and metadata update); `SENSITIVE_HEALTH_HINT`.
`@/server/integrations/text-extraction`: `ExtractionResult` gained `pageCount` and `pageOffsets`
(offset where each page starts in the normalized text); exports `PAGE_SEPARATOR` and `joinPages(pages)`.
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
v2: `sourceAnalysisId` (deadlines and tasks) accepts an `ai_analyses` id **or** a `case_briefs` id
visible through `caseBriefWhere(ctx)`. `DeadlineListItem.sourceKind` / `TaskListItem.sourceKind`
(`"analysis" | "case_brief" | null`) tells the UI which one; brief-sourced items are labeled
"Sugerido pela análise preliminar (simulação)" and link to `/analises-preliminares/<id>`.
`CalendarData.hearings` brings the hearings shown on the `/prazos` calendar.
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
getAiUsageSummary(ctx): Promise<{ period: string; requests: number; inputTokens: number; outputTokens: number; costMicroUsd: number; monthlyTokenBudget: number }>
```
Modules that update a process/occurrence/contract call `markAnalysesStaleForEntity` in the same transaction.
UI: `<AnalysisPanel ctx={ctx} subject={{ type: AnalysisSubjectType, id }} />` from `@/modules/analyses/components/analysis-panel`.

### alerts — `@/modules/alerts/service`
```ts
listAlerts(ctx, filters: { openOnly?: boolean; limit?: number }): Promise<AlertItem[]>
resolveAlert(ctx, id: string): Promise<void>
upsertAlert(input: { organizationId: string; type: AlertType; severity: AlertSeverity; title: string; message: string; entityType: EntityType; entityId: string; dedupeKey: string }, db?: DbOrTx): Promise<void>   // system
```
v2 additions are listed in "v2 cross-module APIs → alerts".

### jobs — `@/server/jobs/*`
```ts
// @/server/jobs/queue
enqueueJob(input: { type: JobType; organizationId?: string | null; payload: Record<string, unknown>; dedupeKey?: string | null; runAt?: Date; maxAttempts?: number }, db?: DbOrTx): Promise<{ id: string; deduplicated: boolean }>
// @/server/jobs/worker
processPendingJobs(opts?: { limit?: number }): Promise<{ processed: number }>   // runs queued jobs inline (admin "processar fila agora", seed, tests)
// @/server/jobs/routines
ensureDefaultRoutines(organizationId: string, db?: DbOrTx): Promise<void>
// job types include "legal_report.generate" (R1 after a brief approval, @/modules/legal-reports/automation);
// routine types include "legal_reports_refresh" (daily R1 refresh)
```

### processes / occurrences / contracts (v1)
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

### admin — `@/modules/admin/service` (v1)
```ts
listUserOptions(ctx): Promise<{ id: string; name: string; role: Role; unitId: string | null }[]>   // active users of the org
listUnitOptions(ctx): Promise<{ id: string; name: string }[]>
listEntityHistory(ctx, entity: EntityRef): Promise<{ id: string; action: string; summary: string; actorName: string | null; changes: Record<string, { from: unknown; to: unknown }> | null; createdAt: Date }[]>
```
UI: `<EntityHistory ctx={ctx} entity={{ type, id }} />` from `@/modules/admin/components/entity-history`.
New audit actions need a pt-BR label in `src/modules/admin/history-format.ts` (`ACTION_LABELS`;
`ACTION_PREFIX_ENTITY` for new entity prefixes), otherwise the "Histórico" tab shows the raw id.

## Data-origin separation (UI rule)

Every screen that mixes sources must label them with `<OriginBadge origin=... />`:
cadastrado manualmente / importado / sugerido pela IA (pendente de validação humana).
AI output is shown only inside analysis views with sources, date, limitations,
validation points and the disclaimer — never merged silently into record fields.

---

# v2 — Carteira, contingências, entrada de processos e simulações

Added by the v2 reformulation (migration `drizzle/0001_v2_portfolio.sql`, additive only), built in
ten packages on top of a shared foundation and integrated in commit `fe5564b`. Everything above still
applies. Business rules come from the client's requirements document ("Levantamento de requisitos —
sistema de gestão de passivo e carteira judicial"): RN-01..RN-12, RF-01..RF-24. Traceability matrix:
[`docs/RASTREABILIDADE.md`](../RASTREABILIDADE.md).

## Business rules that code must enforce

| Rule | Where |
|---|---|
| RN-01/RN-09 CNJ number is the key: one `legal_processes` row per CNJ; each instance is a `process_instances` row. Counts never add instances. A 20-digit number typed without punctuation is stored in CNJ format; the check digit is verified and only reported (never corrected). | processes, imports, intake |
| RN-02 Valor da causa and valor liquidado are never summed; always shown side by side and labeled. | everywhere |
| RN-03 Null is not zero: `null` liquidated = "não apurado" (UI shows "Não apurado", CSV leaves the cell empty). | everywhere |
| RN-04/RN-05/RN-07 Exposure and provision: use the pure functions in `@/domain/contingency` (`netExposure`, `provisionFor`, `addToBucket`). Estimates are always flagged. | contingency, reports, dashboard, distribution |
| RN-06 Extinction by payment = new `liquidated` valuation with amount 0 and reason starting with "Quitação"; history stays. Not applied automatically by the import. | contingency |
| RN-08 Divergent values are recorded (proposed valuation with reason), never overwritten silently. The source-prevalence order is a human decision in the review queue (not automated). | imports, contingency |
| RN-10 Monthly snapshot; a `closed` period is immutable and reports read it from `portfolio_snapshot_items`. Closing is a human action (`snapshot:close`); the routine only refreshes the current month's preview. | contingency, reports, dashboard |
| RN-11 Proposed values only become `official` through an identified human (`reviewedById`). Below `settings.contingency.confidenceThreshold` they cannot be bulk-approved. | contingency |
| RN-12 Loss of patronage: `status = closed`, `closureReason = lost_patronage`; out of the active portfolio (`ACTIVE_PORTFOLIO_STATUSES = active, suspended`), history kept. | processes |
| RF-12 Automatic risk suggestions are always `status = proposed`. | contingency |
| P0.5 Phase and instance are distinct axes: phase ∈ {knowledge, liquidation, enforcement}; instance ∈ {first, second, superior} (1º/2º/3º grau). "Em recurso" is the instance, never a phase; closure is the status, never a phase. Legacy phases are display-only (see "Phase and instance (P0.5)"). | everywhere |
| AI / e-mail | Simulated only in this version. Every simulated output is labeled (see "Simulation labeling"). |

## Ownership during the v2 build (historical)

During the parallel build each package owned the files below; shared files (enums, schema, access,
permissions, nav, job handlers, routines registry, test fixtures, docs) were owned by the integrator.
The table is kept to find who wrote what; after integration, any module may be changed following the
conventions of this document.

| Package | Owns |
|---|---|
| brand-shell | `src/components/brand/**`, `src/components/layout/**`, `src/app/(app)/layout.tsx`, `src/app/(app)/busca/**`, `src/app/globals.css`, `src/app/icon.svg`, `src/app/favicon.ico`, `src/app/apple-icon.png`, `src/app/page.tsx`, `src/components/landing/**`, `src/app/login/**`, `scripts/generate-icons.mjs` |
| portfolio | `src/modules/processes/**`, `src/app/(app)/processos/**`, `src/app/api/processes/**` |
| contingency | `src/modules/contingency/**`, `src/app/(app)/contingencias/**`, `src/app/(app)/acordos/**`, `src/app/api/contingency/**` |
| hearings-alerts | `src/modules/hearings/**`, `src/modules/alerts/**`, `src/modules/work/**`, `src/app/(app)/audiencias/**`, `src/app/(app)/alertas/**`, `src/app/(app)/prazos/**` |
| imports | `src/modules/imports/**`, `src/app/(app)/importacoes/**`, `src/app/api/imports/**` |
| briefs-ai | `src/modules/briefs/**`, `src/server/integrations/ai/case-brief/**`, `src/server/integrations/text-extraction.ts`, `src/modules/documents/**`, `src/app/(app)/analises-preliminares/**`, `src/app/(app)/documentos/**`, `src/app/api/documents/**` |
| intake-distribution | `src/modules/intake/**`, `src/modules/distribution/**`, `src/app/(app)/entrada/**`, `src/app/(app)/distribuicao/**` |
| emails (+ contracts) | `src/modules/emails/**`, `src/server/integrations/email/**`, `src/app/(app)/emails/**`, contracts improvements |
| reports-preventive | `src/modules/reports/**`, `src/modules/preventive-intel/**`, `src/app/(app)/relatorios/**`, `src/app/(app)/inteligencia-preventiva/**`, `src/app/api/reports/**` |
| admin-dashboard | `src/modules/admin/**`, `src/modules/organization/**`, `src/app/(app)/admin/**`, `src/modules/dashboard/**`, `src/app/(app)/dashboard/**` |

Tests: each package wrote `tests/<package>/**`. Shared fixture: `tests/helpers/fixtures.ts`
(`setupFixture()` also returns `companyA`, `lawFirmA` and contexts `accountant`, `auditor`,
`externalCounsel` — the latter belongs to `lawFirmA`).

## Roles and permissions

Roles: `accountant` (contabilidade), `auditor` (auditoria), `external_counsel` (escritório externo,
`AuthContext.lawFirmId`). See `ROLE_PERMISSIONS` in `src/server/auth/permissions.ts`, rules 10–13
in `src/server/auth/access.ts` and the matrix in [`docs/SECURITY.md`](../SECURITY.md). New permissions:
`contingency:read|write|approve`, `snapshot:close`, `report:read`, `import:run`, `intake:manage`,
`distribution:manage`, `brief:read|review`, `email:read|send`, `preventive_intel:read`; after the v2
integration: `report:generate` (generate / regenerate legal reports in PDF; admin, legal_manager,
lawyer, accountant; the report type still restricts the roles, see "Legal reports") and
`court_sync:run` ("Sincronizar agora" on a process and the ad-hoc DataJud lookup; admin,
legal_manager, lawyer, analyst); after the R1: `legal_report:read` (read and download legal reports of
visible processes; every role with `report:read`, plus `external_counsel`, which has no `report:read`). API keys, DataJud settings and Power BI configuration use
`admin:organization`; the Power BI pages and embed token use `report:read`.

New row-visibility builders (`@/server/auth/access`): `processChildWhere(ctx, table)`,
`valuationWhere`, `guaranteeWhere`, `riskAssessmentWhere`, `settlementWhere`, `hearingWhere`,
`intakeWhere`, `caseBriefWhere`, `emailWhere`, and `visible*Ids` for hearings, settlements,
valuations, guarantees, intakes and case briefs.
`entityReferenceWhere(ctx, typeCol, idCol, opts?)` also resolves `hearing`, `settlement`, `valuation`,
`guarantee`, `case_brief`, `intake` (`REFERENCE_ENTITY_TYPES`; any other type is never visible).
`opts.types` restricts the condition to those entity types (only their branches are built; an empty
list matches nothing): alerts pass the types the role may read (rule 9) or the types present among the
rows being counted. Without it every resolvable type is considered (comments, activity feeds).
`userDirectoryWhere(ctx): SQL | undefined` (rule 10): the users that may appear in "responsável"
selects and filters. Internal roles: `undefined` (every user of the organization); external counsel:
users of their own law firm, themselves and the responsible people of the processes they see. Callers
still add the organization and active filters. Used by `listUserOptions` (admin), `listHearingUserOptions`
(hearings, plus the responsibles of visible hearings) and `listWorkUserOptions` (work) and by the
responsible check of work items. `isExternalCounsel(ctx)` lets pages hide internal structure (the
`/processos` "Unidade" and "Escritório externo" filters; a unit or firm that arrives in the URL is still
applied and shown in a removable callout).
Companies, law firms, distribution rules, import batches and snapshots are
organization-level (permission-gated, `organization_id = ctx.organizationId`).

Delegated context (intake): `registerIncomingProcess` creates the process and its parties with
`{ ...ctx, kind: "system" }` when the caller lacks `process:write` (analysts with `intake:manage`).
Same user id (creator and audit actor) and organization; the flow never sets confidentiality or
law firm. Do not reuse this pattern elsewhere without a security review (see `docs/SECURITY.md`).

## New tables (see the schema files for column docs)

`companies`, `law_firms`, `users.law_firm_id` (core.ts) · `process_instances` + new `legal_processes`
columns (`companyId`, `lawFirmId`, `instance`, `processClass`, `city`, `state`, `phaseDetail`,
`liquidatedAmountCents`, `riskPercentageBp`, `closureReason`, `needsVerification`,
`verificationNote`, `lastMovementAt`, `importBatchId`) (legal.ts) · `process_valuations`,
`process_guarantees`, `process_risk_assessments`, `settlements`, `settlement_installments`,
`portfolio_snapshots`, `portfolio_snapshot_items` (contingency.ts) · `hearings`,
`distribution_rules`, `case_intakes` (operations.ts) · `case_briefs`, `case_brief_revisions`,
`case_brief_sources` (briefs.ts) · `email_messages`, `email_events` (email.ts) ·
`import_batches`, `import_rows` (imports.ts). `document_versions` gained `pageCount` and
`pageOffsets`. `process_parties.liabilityNature`, `process_events.cnjMovementCode|instance`.
After the v2 integration (migrations `0002` to `0013`, each with `drizzle/down/<tag>.sql`):
`api_keys`, `inbound_requests`, `court_sync_states`, `court_sync_runs` (integrations.ts) ·
`bi_settings`, `bi_process_access`, `bi_refresh_runs`, `bi_labels`, `bi_reader_roles` (bi.ts) + the `bi`
schema views · `index_series`, `index_series_values`, `process_valuations.correction_index` (indices.ts,
contingency.ts) · `legal_reports`, `legal_report_sequences`, `legal_report_items`, `legal_report_sources`,
`process_scenarios` (legal-reports.ts) · `process_claims`, `process_claim_assessments`,
`process_claim_risk_links` (claims.ts) · `snapshot_close_overrides` (snapshot-close.ts) ·
`legal_processes.subjects|legacy_phase|legacy_instance_set|legacy_verification_set`,
`process_events.externalId`, `process_instances.legacy_phase`, `process_valuations.cleared_on`.
Details and immutability rules: [`docs/DATA_MODEL.md`](../DATA_MODEL.md).

## Denormalized mirrors on `legal_processes`

Kept in sync by the contingency service (`syncProcessMirrors` in `@/modules/contingency/internal`)
inside the same transaction as the valuation/risk/guarantee change:

- `liquidatedAmountCents` = latest OFFICIAL `liquidated` valuation (`OFFICIAL_VALUATION_ORDER`: base date,
  then most recently reviewed, then created, then id; mirrored by `later()` in `@/modules/contingency/position`);
- `claimAmountCents` = latest OFFICIAL `claim` valuation (kept when there is none);
- `riskPercentageBp` / `lossProbability` = official risk assessment in force today (kept when none);
- `provisionAmountCents` = `provisionFor(...)` with the linked guarantees.

Other modules never write the mirrors themselves: the claims module (derived classification) and the
processes service call `syncProcessMirrors` inside their own transaction; the indices module does not
touch them (an index swap that would change the value in force is refused, see "Correction indexes"). Only two other writers exist: the import
commit (initial bulk load, same rules) and the processes service for `claimAmountCents` (P0.6,
`recordClaimValuation` in `@/modules/processes/service`):
- an identified person whose ROLE has `contingency:approve` (`canMakeClaimOfficial(ctx)`; the delegated
  intake context is judged by the analyst's role, never by the system bypass of `can`) appends an OFFICIAL
  `claim` valuation (reviewer = that person), supersedes the previous official claims and runs
  `syncProcessMirrors` in the same transaction; the mirror diff (e.g. `provisionAmountCents`) is merged into
  the `legal_process.create|update` audit changes. Removing the valor da causa supersedes the official
  claims and stamps `process_valuations.cleared_on = today` on them (migration `0013_process_detail_indexes`);
- anyone else (lawyer, external counsel, analyst through the intake) appends a PROPOSED claim valuation
  (`source: manual`, no reviewer, nothing superseded; an identical pending proposal of the same source is reused) for
  the review queue, and the proposed amount never reaches the record: on UPDATE the record keeps its current
  valor da causa, on CREATE it stays null ("Não informado", the current `process_instances` row too), until
  the proposal is approved (`reviewValuation` then promotes it and `syncProcessMirrors` fills the mirror); a
  rejection leaves the record untouched. So a proposal never enters totals, positions (`positionAt` record
  fallback) or exposure. Audit `valuation.propose` (create and update) + `metadata.proposedClaimValuationId`
  on the update entry / `metadata.claimValuationStatus = "proposed"` on the create entry. Distribution rules
  with a claim range therefore see "valor da causa não informado" until the approval. A non-approver cannot
  remove the valor da causa (`ValidationError` on `claimAmountCents`, `CLAIM_REMOVAL_NEEDS_APPROVER`);
- contexts without a person (imports, inbound API) record no claim valuation here: `createProcess` keeps the
  informed value on the record, and `updateProcess` refuses a change of the valor da causa
  (`ValidationError`, `CLAIM_CHANGE_NEEDS_PERSON`), so the record never diverges from the synced mirrors;
- simulated values: `createProcess(ctx, input, { claimSource: "simulation" })` (server-only option, never read
  from a form) records the claim valuation with `source: simulation` and the reason "Valor da causa simulado
  (demonstração) ...", official for an approver, proposed for anyone else. The queue, the band and BI then label
  it "Extração simulada (demonstração)" and bulk approval refuses it. Default `manual`. The intake's
  `simulateIncomingProcess` must pass it (see `registerIncomingProcess`);
- current instance: the `process_instances` row is a snapshot taken when the link was created, and the review
  queue approval fills only the record. On read, the CURRENT instance without its own valor da causa shows the
  record's (`currentInstanceClaimFallback`): `ProcessInstanceItem.claimFromRecordCents` on the detail page
  ("Valor do cadastro do processo" under the amount) and `claimAmountCents` of the per-instance export sheet.
  The link row itself is not written (the instance dialog edits only its own value).
`updateProcess` returns `{ claimValuation: { id, status: "official" | "proposed" } | null }` and
`createProcess` adds `claimValuationStatus`; the actions redirect with `?valor_causa=em_conferencia` when the value
went to the queue (the page shows a notice). `commitImport` and `rollbackImport` call `syncProcessMirrors`
for **every process they touch**, so the mirrors always match the remaining history after a commit
or an undo. `rollbackImport` is blocked when a process of the batch is in a **closed competência**
snapshot (the monthly close must stay reproducible). `createProcess`/`updateProcess` **ignore**
`provisionAmountCents` and `lossProbability`; register risk/provision through the contingency service.

Organization settings gained `contingency`, `email`, `intake` and two alert windows
(`upcomingHearingDays`, `installmentDueDays`); always read them through `mergeOrganizationSettings` /
`loadOrganization` (`@/modules/analyses/org-settings`). A change of the risk percentages increments
`settings.contingency.rulesVersion` (RNF-14).

## v2 cross-module APIs (implemented)

All functions take `ctx` first, check their own permission and apply row visibility.

### organization — `@/modules/organization/service`
```ts
listCompanyOptions(ctx) / listLawFirmOptions(ctx): Promise<{ id; name }[]>          // active only
listAllCompanyOptions(ctx) / listAllLawFirmOptions(ctx)                             // include inactive (filters, history)
assertCompanyInOrg(ctx, id, db?) / assertLawFirmInOrg(ctx, id, db?)                 // ValidationError on companyId / lawFirmId
listCompanies, getCompany, createCompany, updateCompany, setCompanyActive
deleteCompany(ctx, id): Promise<{ outcome: "deleted" | "deactivated" }>              // deactivates when linked records exist
listLawFirms, getLawFirm, createLawFirm, updateLawFirm, setLawFirmActive
deleteLawFirm(ctx, id): Promise<{ outcome: "deleted" | "deactivated" }>
// @/modules/organization/schemas: isValidCnpj, formatCnpj (alphanumeric CNPJ supported)
```
Writes require `admin:organization`. CNPJ uniqueness is checked by the application (no DB index).

### processes — `@/modules/processes/service`
```ts
searchProcesses(ctx, q, limit = 8): Promise<{ id; number; title; court; status }[]>
summarizeProcesses(ctx, filters): Promise<ProcessListSummary>        // totals strip: causa and liquidado separately, "não apurado" counts
getProcessFilterOptions(ctx): Promise<ProcessFilterOptions>
exportProcesses(ctx, filters, format: "csv" | "xlsx"): Promise<ProcessExportData>   // PROCESS_EXPORT_LIMIT = 20_000; audit legal_process.export
recordConfidentialProcessView(ctx, processId): Promise<boolean>     // audit legal_process.view_confidential, max 1 per user/process/hour
                                                                     // (lookup by entity_type + entity_id; no lock/transaction when a recent view exists)
listProcessOptions(ctx): Promise<ProcessOption[]>                    // P0.6: EVERY visible process (no silent 1000 cap)
searchProcessOptions(ctx, { q?, includeIds?, limit? = 50 }): Promise<{ items; total; shown }>   // search-as-you-type (number with or
                                                                     // without punctuation, or title); "mostrando N de M"; includeIds keeps visible selections
listSensitiveDocumentDownloads(ctx, processId, { limit? = 20 }): Promise<{ sensitiveDocuments; total; items }>   // P2.12, process:read +
                                                                     // document:read; `document.download` audits of the process documents the viewer can
                                                                     // see (documentWhere) that are sensitive_health, confidential or restricted
canMakeClaimOfficial(ctx), CLAIM_REMOVAL_NEEDS_APPROVER, CLAIM_CHANGE_NEEDS_PERSON   // valor da causa rules (see "Denormalized mirrors")
createProcess(ctx, input, { claimSource?: "manual" | "simulation" })   // claimSource: simulated intake value (labeled), default manual
currentInstanceClaimFallback(instance, recordClaimCents)             // current instance without its own valor da causa: the record's
// @/modules/processes/tabs (client-safe, P0.6): PROCESS_TAB_KEYS, PROCESS_TAB_LABELS, LEGACY_PROCESS_TABS, resolveProcessTab(aba),
//   processTabUrl(processId, tab, section?), PROCESS_SECTION_IDS, processHeaderSubtitle(p), CLAIM_PROPOSED_PARAM_VALUE
// @/modules/processes/cover, @/modules/processes/timeline (client-safe): missingCoverFields, firstSentence, eventsByInstance, isDataJudEvent
closeProcess(ctx, id, { closureReason, closedAt?, note? }): Promise<void>       // leaves the active portfolio (RN-12)
reactivateProcess(ctx, id, { note? }): Promise<void>
flagProcessForVerification(ctx, id, { note }): Promise<void>
resolveProcessVerification(ctx, id, { note? }): Promise<void>
addProcessInstance(ctx, processId, input): Promise<{ id }>
updateProcessInstance(ctx, instanceId, input): Promise<{ processId }>
removeProcessInstance(ctx, instanceId): Promise<{ processId }>        // imported instances cannot be removed
ACTIVE_PORTFOLIO_STATUSES, isInActivePortfolio(status)
canEditProcessConfidentiality(ctx), canChangeProcessLawFirm(ctx)
// @/modules/processes/filters (client-safe)
processFiltersFromSearchParams(sp): ProcessListParams                 // shared URL parser (list, export route, deep links)
MISSING_FIELD_PARAMS, MISSING_FIELD_LABELS                             // pendencia= values / "Sem instância informada"…
// @/modules/processes/schemas (P0.2)
PROCESS_MISSING_FIELDS = ["court","instance","phase","city","company","unit"]   // ProcessFilters.missingField
```
External counsel can only create processes of their own law firm and cannot move a process to
another firm. Pages that show a confidential process call `recordConfidentialProcessView`.

`ProcessFilters.missingField` (URL `pendencia=`, P0.2) keeps only the processes whose field is empty:
`court`/`city` null or blank (whitespace only), `instance`/`companyId`/`unitId` null, `phase` null (the
phase is required, so `fase` is accepted but always empty today). It is part of the shared list WHERE
(`listProcesses`, `summarizeProcesses`, `exportProcesses`), so `processWhere(ctx)` and the other filters
always apply. The dashboard's "Pendências de cadastro" uses the same rule.

### contingency — `@/modules/contingency/*`
```ts
// service.ts
getProcessContingencySummary(ctx, processId): Promise<ProcessContingencySummary>
getPortfolioExposure(ctx, filters?: { companyId?; unitId?; court?; instance?; phase?; city?; includeClosed? }): Promise<{ rows: PortfolioExposureRow[]; totals: MoneyBucket }>
proposeValuation(ctx, input: ProposeValuationData): Promise<{ id }>   // ALWAYS proposed; contingency:write. Input: processId, kind, amountCents, baseDate, source,
                                                                     // instance?, documentId?, documentVersionId?, page?, excerpt?, confidence?, reason?, briefId?, isEstimate?
addValuation(ctx, input): Promise<{ id; status }>                    // official when ctx has contingency:approve (reviewer = ctx user); otherwise proposed
reviewValuation(ctx, id, { decision: "approve" | "correct" | "reject", correctedAmountCents?, note? }, { expectedCorrectionIndex? }?)
                                                                     // contingency:approve + identified person; locks the proposal FOR UPDATE
bulkApproveValuations(ctx, ids, expectedCorrectionIndexes?): Promise<{ approved; refused: { id; reason }[] }>
                                                                     // isBulkEligible: confidence >= settings.contingency.confidenceThreshold (RN-11)
                                                                     // AND source !== "simulation" (SIMULATED_BULK_REFUSAL) AND not a quitação;
                                                                     // a row whose index changed since the screen loaded is refused; the others go one by one
registerExtinction(ctx, processId, { baseDate, documentId?, note? }): Promise<{ id; status; outcome: ExtinctionOutcome }>
                                                                     // liquidated 0, reason "Quitação" (RN-06); official with contingency:approve, else proposed;
                                                                     // outcome "zeroed" | "already_zero" | "history_only" | "proposed" (messages and audit are built
                                                                     // from it); once official it supersedes the official liquidated values of EVERY instance with
                                                                     // base date on/before the payment; a quitação dated before an official liquidated value is refused
listValuations, getValuationTimeline(ctx, processId), getPositionAt(ctx, processId, date)
listReviewQueue(ctx, filters), getReviewItem(ctx, id), countPendingValuations(ctx)
// risk-service.ts
addRiskAssessment(ctx, processId, { classification, percentage?, opinion, effectiveFrom })   // official; contingency:write + identified person
suggestRiskAssessment(ctx, processId)                                // deterministic rule, ALWAYS proposed (RF-12)
approveRiskProposal / rejectRiskProposal                             // contingency:write + identified person
// guarantee-service.ts: listGuarantees, createGuarantee, updateGuarantee, setGuaranteeStatus, deleteGuarantee
// settlement-service.ts: listSettlements, listProcessSettlements, createSettlement, updateSettlementTerms,
//   setSettlementStatus, updateSettlementNotes, setInstallmentPaid, listUpcomingInstallments, getSettlementKpis
// snapshot-service.ts
generateSnapshot(ctx, period)        // preview; contingency:approve (routine: system ctx); refused for closed or future periods
closeSnapshot(ctx, period, { justification? })   // snapshot:close + identified person; immutable afterwards; close gate (P1.9, below):
                                     // throws CloseBlockedError without a justification while preview items are unclassified
listSnapshots, getSnapshot, exportSnapshotCsv(ctx, period)           // CSV: contingency:read, audit snapshot.export
// routines.ts: runPortfolioAlertsRoutine(rc) / runMonthlySnapshotRoutine(rc): Promise<string>
```
Pure helpers reusable by reports: `buildSnapshotCsv`, `calculationMemo`, `csvMoney`
(`@/modules/contingency/csv`), `positionAt` (`@/modules/contingency/position`). Snapshot metric
breakdowns use the key `"__none__"` (`NONE_KEY` in `@/modules/contingency/labels`; the same value is
exported by `@/modules/reports/grouping`) for null dimensions, and `"unclassified"` in
`byClassification`. Valuation, guarantee, risk and settlement audits use `entityType: "legal_process"`
with the child id in `metadata` (so they show in the process "Histórico"); snapshot audits use
`entityType: "snapshot"`.
UI (process tabs): `<ProcessContingencyTab ctx processId />`, `<ProcessSettlementsTab ctx processId />`,
`<ProcessValuesSummary ctx processId />` from `@/modules/contingency/components/process-tabs`.
Net exposure (P1.8): `<NetExposurePanel breakdown headingId compact? />` (`./components/net-exposure`) +
`exposureBreakdown(summary, guarantees)` (`./components/exposure-breakdown`, pure), used by both
`ProcessContingencyTab` and `ProcessValuesSummary`: exposição líquida = valor apurado in force minus the
LINKED guarantees, never negative, with the deductions listed (released and deleted guarantees are neither
deducted nor listed; the list adds up to the total). Without valor apurado it shows "Não apurado" and the
estimate (causa × % − guarantees) apart, labeled "Estimado", or "Não calculada: sem classificação de risco".
The "Exposição líquida" tile left `SummaryTiles` (the panel replaces it). Valuation chart:
`collapseIndexSwaps` (`./components/value-series`) draws an index swap chain as ONE point with each change
noted. Risk history: rows whose `getClaimRiskLinkKinds` kind is `derived` are labeled with
`claimsRiskAttribution` ("Derivada dos pedidos") and a `CLAIM_RISK_LINK_KIND_LABELS` badge, never as an
approved rule suggestion. Each valuation row renders `<CorrectionIndexDialog mode />` when
`correctionIndexChangeFor(row, { write, approve })` returns a mode.

### hearings — `@/modules/hearings/service`
```ts
listHearings(ctx, filters), getHearing(ctx, id), listProcessHearings(ctx, processId)   // process:read
listUpcomingHearings(ctx, { days?, limit? }): Promise<UpcomingHearing[]>
getHearingCounts(ctx), countUpcomingProcessHearings(ctx, processId)
createHearing(ctx, input)                    // process:write; origin "manual" or "ai_suggested" (explicit user action only)
updateHearing(ctx, id, input)                // correction while scheduled (no rescheduling history)
setHearingStatus(ctx, id, input): Promise<{ newHearingId: string | null }>   // held (only from the scheduled date), rescheduled (creates the new hearing), cancelled (reason)
// @/modules/hearings/routines: runHearingAlertsRoutine(rc)
```
Hearings cannot be deleted. Audits use `entityType: "legal_process"` + `metadata.hearingId`; they never
record notes, outcomes or meeting links. UI: `<ProcessHearingsTab ctx processId />`.
The `hearing_alerts` routine (alerts and simulated reminder e-mails) only considers hearings of processes in the
active portfolio (status `active` or `suspended`, `ALERTED_PROCESS_STATUSES`); open alerts of hearings whose
process left it are resolved by `resolveStaleAlerts` on the next run (product decision, deferred finding 18).
`listHearingUserOptions(ctx)` follows `userDirectoryWhere` plus the responsibles of the visible hearings.

### alerts — `@/modules/alerts/service` (v2 additions)
```ts
countOpenAlerts(ctx): Promise<{ total; critical }>                    // header bell
listAlertsPaged(ctx, filters & Page), countAlertsByArea(ctx, filters), listAlertGroups(ctx, filters, ...)
alertHref(entityType, entityId, type?): string | null                 // null for process-owned entities
resolveAlertHrefs(organizationId, rows: AlertLinkRow[], db?): Promise<Map<string, string | null>>   // batch: hearing/settlement/guarantee/valuation -> process tab
alertHrefKey(row: { type; entityType; entityId }): string            // `${type}@${entityType}:${entityId}`: the key of ONE alert's link in that map
resolveAlertsByDedupeKeys(organizationId, keys, db?) / resolveStaleAlerts(...)
ALERT_ENTITY_READ_PERMISSION: Record<ReferenceEntityType, Permission>  // rule 9: process/hearing/intake -> process:read, occurrence, contract,
                                                                     // document, task, deadline, analysis, case_brief -> brief:read,
                                                                     // valuation/guarantee/settlement -> contingency:read
alertEntityTypesFor(ctx): ReferenceEntityType[]                      // entity types whose alerts ctx may read
visibleAlertsWhere(ctx, onlyTypes?): SQL                             // organization + module read permission + row visibility (entityReferenceWhere
                                                                     // with opts.types); onlyTypes only narrows. Every alert read uses it: center, area
                                                                     // counts, bell, daily digest, dashboard, process decision band, resolveAlert
```
`AlertItem` gained `area` and `resolvedByName`. Areas (`@/modules/alerts/areas`): `ALERT_AREAS`,
`ALERT_AREA_PARAMS` (URL values below), `ALERT_TYPES_BY_AREA` (every alert type belongs to exactly one area;
`court_hearing_designated` → hearings, `snapshot_close_blocked` → values, `court_movement_relevant`,
`court_sync_failed`, `claims_risk_review` and `legal_report_outdated` → verification).

Alert links depend on the alert TYPE, not only on the entity: a process with a relevant movement and a
designated hearing has two alerts that open different tabs. Read each link with `alertHrefKey(row)`. The
map is also keyed by `${entityType}:${entityId}` (**deprecated**): it holds the link shared by every alert of
that entity in the batch or, when they differ, the entity's own link without a tab, never another type's
tab. `PROCESS_TAB_BY_ALERT_TYPE` (service-local; legacy tab keys, resolved by `resolveProcessTab`):
`valuation_pending_review`, `enforcement_without_value`, `claims_risk_review` and `snapshot_close_blocked`
→ `valores` (the last two with `#classificacao-risco`), `court_movement_relevant` → `movimentacoes`,
`court_hearing_designated` → `audiencias`, `legal_report_outdated` → `documentos-e-analises#relatorio-do-processo`; other
`legal_process` alerts open the process page.

### briefs — `@/modules/briefs/service`
```ts
requestCaseBrief(ctx, processId, { intakeId?, inline? }): Promise<{ briefId; status }>   // brief:review; intake:manage only together with an intakeId of that process
runCaseBriefJob(briefId, { attempt, maxAttempts }): Promise<void>     // job "case_brief.generate" { briefId }
listCaseBriefs(ctx, filters & Page), countCaseBriefsByStatus(ctx), getCaseBrief(ctx, id)   // brief:read
getLatestCaseBriefSummary(ctx, processId): Promise<CaseBriefSummary | null>
getCaseBriefEmailDigest(ctx, briefId): Promise<CaseBriefEmailDigest>
getBriefCitationPage(ctx, briefId, ...)                              // brief:read + document:read
saveCaseBriefRevision(ctx, id, { content, baseRevision, changeNote? })   // brief:review; new revision, edited items get provenance "reviewer"
saveCaseBriefSection(ctx, id, { section, value, baseRevision, changeNote? })
approveCaseBrief(ctx, id, { note? }) / rejectCaseBrief(ctx, id, { reason })   // brief:review; resolve brief_pending_review
regenerateCaseBrief(ctx, briefId)                                     // new version
applyBriefDeadline(ctx, briefId, index): Promise<{ deadlineId }>     // deadline:write; literal date only; pending_validation
applyBriefNextStep(ctx, briefId, index): Promise<{ taskId }>         // task:write; origin ai_suggested
proposeBriefAmount(ctx, briefId, index): Promise<{ valuationId }>    // contingency:write; proposeValuation source "simulation" (+ page, excerpt)
markCaseBriefsStale(input, db?), onDocumentTextReadyForBriefs({ organizationId, documentId, versionId })
isStuckGenerating(brief), REVIEWABLE_STATUSES, APPLICABLE_STATUSES
// @/modules/briefs/demo-documents
buildDemoCaseDocuments(info: DemoCaseInfo, { variant? }): Promise<DemoDocument[]>   // fictitious PDFs (pdf-lib)
// @/server/integrations/ai/case-brief
getCaseBriefProvider(), getCaseBriefRuntimeInfo(), setCaseBriefProviderForTesting(provider | null),
CASE_BRIEF_SIMULATION_VERSION, pageForOffset(pageOffsets, offset)
CaseBriefProvider.generate(CaseBriefRequest): Promise<{ brief: CaseBrief; usage }>
```
`approveCaseBrief` does **not** send the `brief_approved` e-mail. UI: `<ProcessBriefTab ctx processId />`.

Versions and the intake:

- Regenerating a brief without `intakeId` (process tab, `regenerateCaseBrief`) re-links the
  process's open intake (`case_intakes.briefId`) to the new version, so the intake follows the
  latest version.
- A version is no longer reviewable or approvable once a newer version **with content** exists for
  the process (`assertReviewable` rejects it).
- When a version becomes ready (`ready_for_review`), `runCaseBriefJob` enqueues `intake.process` for
  the intakes linked to it (the pipeline then sends the e-mail). Nothing is enqueued on failure: a
  failed linked version is regenerated by the intake pipeline only on its next run ("Continuar
  processamento"), never in an automatic loop.
- Deadline and task descriptions created from a brief never contain document text; quotes go only
  to `sourceExcerpt`.
- A version superseded by a newer one WITH content is not "awaiting review" anywhere: the queue, the
  dashboard card, the daily digest and the workload panel apply the same "no newer version with content"
  filter.
- After a version becomes `ready_for_review` (post-commit, best effort), its pedidos become claim
  SUGGESTIONS through `suggestClaimsFromBriefAsSystem(organizationId, briefId)` (`@/modules/claims/service`,
  dynamic import): pending confirmation, idempotent, never counted before a person confirms. A failure is
  logged without content and never fails the brief.
Audit actions: `case_brief.request|generate|edit|approve|reject|apply|propose|status_change` (generic
verb labels).

### emails — `@/modules/emails/service` (templates' data types in `@/modules/emails/templates`)
```ts
sendTemplatedEmail(ctx, { template, toUserId, data, linkPath, processId?, briefId?, intakeId?, entity? }): Promise<{ emailId; status: EmailStatus }>
resendEmail(ctx, id): Promise<{ emailId; status }>                   // email:send; copy of a visible message
sendDailyDigest(ctx): Promise<{ emailId; status }>                   // email:send, user context only (on demand)
buildDailyDigestData(ctx): Promise<DailyDigestData>
listEmails(ctx, filters), getEmail(ctx, id), listEmailFilterOptions(ctx)   // email:read + emailWhere
// @/modules/emails/render: renderEmail(template, data, { recipientName, linkUrl, appUrl })
// @/server/integrations/email: getEmailProvider() (SimulatedEmailProvider only), getEmailRuntimeInfo(), setEmailProviderForTesting()
```
Rules for callers of `sendTemplatedEmail`:

- Call it **after your own transaction commits**: it runs its own transactions (two-phase: store the
  message as "Envio não concluído", call the provider outside any transaction, record the outcome) and
  must see the referenced process, brief and intake. A provider failure does not throw: the message is
  stored with status `failed`.
- User contexts need `email:send` (analysts, auditors and external counsel do not have it). Callers
  that notify as a side effect (intake pipeline, routines, approval by external counsel) should pass
  `systemContext(orgId)`. The process must be visible to `ctx`; brief and intake must belong to it.
- It does **not** check `settings.email.notifyOnBriefReady` / `notifyOnAssignment`: the caller must.
  The intake pipeline checks `notifyOnBriefReady` (with `intake.autoNotify`);
  `sendAssignmentEmail` (`@/modules/intake/assignment`) checks `notifyOnAssignment`.
- Templates in use by application flows: `case_brief_ready` (intake pipeline), `intake_assigned`
  (`sendAssignmentEmail`: the intake defines or changes its responsible, and redistribution from
  `/distribuicao` — `reassignResponsible`, `assignResponsible({ notify: true })`; never the bulk
  distribution after an import, never to the person who made the assignment), `hearing_reminder`
  (`hearing_alerts` routine), `daily_digest` (button on `/emails`). `deadline_reminder` and
  `brief_approved` render but no flow sends them.
- `case_brief_ready` data has `digestOmitted?: boolean`: when the recipient cannot open the brief
  (`caseBriefWhere` of their own context), the intake sends only process data and the link (no
  headline, urgencies, deadlines or counts are rendered).

UI: `<ProcessEmailsTab ctx processId />`.

### distribution — `@/modules/distribution/service`
```ts
decideAssignment(ctx, processId): Promise<AssignmentDecision>          // distribution:manage or intake:manage
assignResponsible(ctx, processId, { force?, notify?, handledIntakeId? }): Promise<AssignmentDecision>
  // keeps an existing responsible unless force (method "kept"); force = distribution:manage
applyManualAssignment(ctx, processId, input, { notify?, handledIntakeId? }) / reassignResponsible(ctx, processId, input)
  // reason required; reassign = distribution:manage (always notify)
previewAssignment(ctx, processId)                                       // "Testar regras" (no write)
listAssignableUsers(ctx), getWorkload(ctx)
listRules, getRule, createRule, updateRule, setRuleActive, deleteRule, reorderRules, moveRule   // distribution:manage
```
Assignable roles: `lawyer`, `legal_manager`, `external_counsel`. No matching rule → least loaded active
lawyer of the process unit, else of the organization. Audit `legal_process.assign` with the reason.

- **Who assigns**: `intake:manage` only makes the FIRST assignment of a process, to an internal
  lawyer or legal manager. Replacing an existing responsible, `force`, and choosing an
  `external_counsel` require `distribution:manage` (`ForbiddenError` otherwise).
- **Law firm follows external counsel** (`applyToProcess`): a new responsible from a law firm (or a
  rule with a fixed firm) sets `legal_processes.lawFirmId`; when the previous responsible was the
  external counsel through whom the process belonged to their firm and the new one is outside that
  firm, `lawFirmId` is cleared (the old firm loses access). A firm linked independently of an
  external responsible is kept. `unitId` is only filled when empty.
- **Intakes follow the process responsible**: when the responsible changes, the open intakes of the
  process (not cancelled, brief not approved) get the new responsible in the same transaction (step
  in the timeline, `lastEmailId` reset) and `intake.process` is enqueued to notify them.
  `handledIntakeId` is for the intake module only (it records its own intake).
- **Concurrency**: the process row is locked (`FOR UPDATE`) before reading the responsible; a
  concurrent assignment waits and then keeps the first one's result.
- `notify`: after the commit, `sendAssignmentEmail` (simulated `intake_assigned`, only when
  `settings.email.notifyOnAssignment`). The distribution screen passes it; the post-import bulk
  distribution does not.
- Loads (least loaded) count active processes as responsible + open intakes, attributed to the
  current process responsible. `getWorkload` uses `recordRiskBp` (bp mirror, else the organization
  percentage of `lossProbability`) and per-process aggregates joined once (no correlated subqueries).

### intake — `@/modules/intake/service`
```ts
registerIncomingProcess(ctx, input & { source?, documents?, deferProcessing?, receivedNote? }): Promise<{ intakeId; processId; documentIds; jobQueued }>   // intake:manage
simulateIncomingProcess(ctx, { seed?, variant? })                        // demo organizations only
processIntakeJob(intakeId, { attempt, maxAttempts }): Promise<void>      // job "intake.process" { intakeId }
requestIntakeProcessing(ctx, intakeId, { reason: "start" | "retry" })
autoAssignIntake, regenerateIntakeBrief, resendIntakeEmail (email:send)
assignIntakeManually(ctx, intakeId, input): Promise<AssignmentDecision & { assignmentEmail: "sent" | "disabled" | "skipped" | "failed" }>
getIntakeStatusCounts(ctx), getIntakeCounts(ctx), listIntakes(ctx, filters), getIntake(ctx, id)   // process:read + intakeWhere
listProcessIntakes(ctx, processId): Promise<{ id; receivedAt; status: EffectiveIntakeStatus }[]>
// @/modules/intake/assignment (used by distribution; no service imports)
syncOpenIntakesWithResponsible(tx, …), intakeAssigneeSql(), sendAssignmentEmail({ … }), enqueueIntakeJob(orgId, intakeId, db?)
// @/modules/intake/status (client-safe)
effectiveIntakeStatus(status, briefStatus): EffectiveIntakeStatus   // IntakeStatus | "brief_rejected"
```

- **Responsible of an open intake = responsible of its process** (read time: `getIntake`,
  `listIntakes`, `computeLoads`; the pipeline re-syncs the row before sending an e-mail). A process
  edit or a redistribution is therefore followed; "Reatribuir" to the person who already is the
  process responsible only brings the intake in line.
- **Assignment permissions**: `intake:manage` assigns only when the intake and the process have no
  responsible yet (and never to external counsel); reassignment requires `distribution:manage`.
  `getIntake().permissions.canAssign` follows the same rule.
- **Effective status** `brief_rejected` ("Análise rejeitada — gerar nova versão") is computed, never
  stored (not in `INTAKE_STATUSES`); `getIntakeCounts` counts it in no bucket (not "awaiting
  review"); `/entrada?status=brief_rejected` filters it.
- **Pipeline**: a responsible chosen at registration is kept even with `intake.autoAssign` off; a
  linked brief that failed (or whose generation died) is generated again on the next run; a
  still-generating version waits; a rejected version is not e-mailed. The arrival alerts
  (`new_process_received`, `intake_unassigned`) are resolved when the responsible is recorded, when
  the e-mail step is disabled and for cancelled intakes. The "análise disponível" e-mail is
  idempotent per brief + recipient + assignment (a retry reuses the stored message).
- **Registration**: if anything after `createProcess` fails (parties, uploads, intake row), the
  process and the documents already uploaded are soft-deleted (audit `legal_process.delete`), so
  the same CNJ number can be registered again.

### imports — `@/modules/imports/service` (all `import:run`)
```ts
analyzeImport(ctx, { file, companyId, defaultUnitId?, baseDate?, distributeAfterCommit? }): Promise<{ batchId }>   // reads only; nothing is written to the portfolio
commitImport(ctx, batchId, { baseDate, distributeAfterCommit? }): Promise<CommitImportResult>   // one transaction; idempotent re-import (RNF-04)
getRollbackBlockers(ctx, batchId), rollbackImport(ctx, batchId)          // all-or-nothing
listImportBatches, getImportBatch, listImportRows, listImportIssues, listAllImportIssues, listImportDivergences
openImportFile(ctx, batchId)                                             // original file (audited import_batch.download)
resumeImportDistribution(ctx, batchId): Promise<{ jobId; deduplicated }> // enqueues `import.distribute` again for a committed batch whose
                                                                         // distribution stopped (ConflictError when not committed or committed
                                                                         // without distribution)
runImportDistributionJob(organizationId, batchId)                         // body of the `import.distribute` job (system context, idempotent)
IMPORT_DISTRIBUTION_CHUNK = 100, DistributionState = "none" | "running" | "interrupted" | "done"
```
Post-commit distribution (P0.6): with `distributeAfterCommit`, `commitImport` enqueues the job
`import.distribute` (dedupe `import.distribute:<batchId>`) INSIDE the commit transaction and returns
`distributionQueued: true` (`distribution` is always null; read progress with `getImportBatch`). The job
distributes the processes created by the batch that are still without a responsible, in chunks of 100,
as the system; after each chunk an `import_batch.distribute` audit entry records the progress, which is
also the rollback boundary. A run that stops throws, the queue retries it with backoff, and the retry
resumes from the last chunk (already assigned processes are skipped). "running" = the job is queued or
running; "interrupted" = stopped with no job pending (the page offers the resume).
Imported valuations use `source: "spreadsheet"`, `importBatchId`, reviewer = the confirming user for
official values, and reasons starting with "Divergência entre abas:" or "Planilha … informa" for
proposed ones. Use a **user** context (official values need an identified reviewer, RN-11).

### reports, preventive intelligence and occurrences
```ts
// @/modules/reports/service (report:read)
getReport(ctx, type, filters), exportReport(ctx, type, filters, format): Promise<{ fileName; contentType; body; rowCount }>, listReportFilterOptions(ctx)
// @/modules/preventive-intel/service (preventive_intel:read)
getPreventiveIntelligence(ctx, { companyId?, court? })
createOccurrenceFromSuggestion(ctx, key, filters)        // + occurrence:write
createActionPlanFromSuggestion(ctx, key, filters)        // + task:write (+ occurrence:write when the occurrence is created); not atomic, re-runnable
// @/modules/occurrences/service
findPreventiveIntelOccurrences(ctx, keys, { openOnly? }): Promise<Map<key, { id; title; status; createdAt }>>
// listOccurrences filter origin: "preventive_intel"; OccurrenceListItem.preventiveOrigin; OccurrenceStats.fromPreventiveIntel
```
`@/modules/occurrences/preventive-origin`: the occurrence facts end with a footer carrying the marker
`[ref: pi:<key>]` and the line "Indicador: …" (no schema column; editing the marker out removes the
origin label).

### admin and dashboard
```ts
// @/modules/admin/service
updateContingencySettings(ctx, input): Promise<{ rulesVersion; rulesVersionChanged }>   // admin:organization
updateEmailIntakeSettings(ctx, input): Promise<void>                    // sender must use a reserved domain (.invalid, .test, example.com…)
exportAuditLogs(ctx, filters): Promise<{ items; total; truncated }>     // audit:read; AUDIT_EXPORT_MAX_ROWS = 10_000
// @/modules/admin/integrations: getIntegrationsOverview(ctx), describeIntegrations()
// @/modules/admin/audit-csv: buildAuditCsv, csvCell (BOM, ";", formula-injection guard)
// @/modules/dashboard/portfolio-service
getPortfolioPanel(ctx, filters: BiFilters, { today? }): Promise<Section<PortfolioData>>   // Section<T> = ok | forbidden | error
getFollowUpPanel(ctx): Promise<FollowUpData>                            // hearings, intake and briefs cards are Section<…>
// @/modules/dashboard/decision-service (P0.1 — first band of /dashboard, "Exige decisão agora")
getDecisionBand(ctx): Promise<DecisionBand>                              // dashboard:read; read-only; not affected by BiFilters
idleGuaranteeCondition(today, idleDays): SQL                             // same rule as the portfolio_alerts routine
DECISION_HREFS, DECISION_WINDOW_DAYS (7), FATAL_DEADLINE_KINDS, DECISION_ITEMS_LIMIT (5)
// UI: <DecisionBand band /> from @/modules/dashboard/components/decision-band (forbidden blocks render nothing)
// @/modules/dashboard/portfolio (pure, client-safe; P0.2 — coverage instead of "R$ 0 oficial")
liquidatedCoverage(bucket): LiquidatedCoverage                           // { assessed, total, ratio|null }: null = não apurado (never covered), 0 = apurado
coveragePercent(c), coverageStatement(c)                                // "valor apurado em X de Y processos (Z%)"
exposureBasisCounts(bucket): { official; estimate; none }                // processes by exposure basis (apurado / causa × risco / sem base)
splitUnknownKey(groups): { known; missing }                             // null keys never become chart categories
// UI (@/modules/dashboard/components/portfolio-panel): <CoverageCard />, <RegistrationGaps gaps description? />, REVIEW_QUEUE_HREF
// UI (@/modules/dashboard/components/charts/bar-chart): <BarChart tipValue?={(row) => string} /> — per-row tooltip/aria text
// P0.3 — one portfolio chart with a dimension selector (replaces the six "Exposição e processos por …" cards)
// @/modules/dashboard/format (pure): moneyScaleFor(valuesCents): MoneyScale        // one unit per chart from the largest value
//   ("R$" | "R$ mil" | "R$ milhões" | "R$ bilhões", decimals chosen once); formatInScale(cents, scale) // "1,30", "< 0,01"
// @/modules/dashboard/dimension-chart (pure, client-safe)
DIMENSION_PARAM ("dimensao"), DEFAULT_DIMENSION ("court"), DIMENSION_PARAMS (= MISSING_FIELD_PARAMS slugs), DIMENSION_LABELS
parseChartDimension(searchParams): DimensionKey                          // unknown → "court"
dimensionChartModel({ rows }): DimensionChartModel                       // { kind: exposure|count; series; scale; unitLabel; rows[{ key; label; href; values; valueText; tip }]; withOfficial; someRowUnassessed }
// @/modules/dashboard/portfolio: DIMENSIONS / DimensionKey now live here (re-exported by portfolio-service)
// UI (@/modules/dashboard/components/portfolio-panel): <ExposureByDimension dimensions initial? filterFormId? />, <DimensionPanel dimension />
//   (DimensionChart was removed); client tablist in ./dimension-tabs (Radix Tabs: arrows, Home/End)
// UI (charts/chart-card): <ChartBody legend? note? table?>…</ChartBody> — inside of ChartCard, reusable in another frame
// UI (charts/bar-chart): <BarChart header?={{ label, value }} /> — column headers; `value` = the chart's single unit
// UI kit: <FilterBar id? /> — lets a control elsewhere submit with the filters (`form` attribute)
```
P0.3: the dashboard portfolio shows ONE block, "Exposição e processos por dimensão", with an ARIA tablist (tribunal, instância,
fase, cidade, empresa, unidade; default tribunal) over the chart and the "Ver dados em tabela" view of the selected dimension.
Every bar label of a chart is written in ONE money unit, chosen from the largest drawn value and shown once in the value
column header ("R$ mil", "R$ milhões"…); a positive value below the chart's precision reads "< 0,01", never "0,00".
Tooltips and accessible names carry the exact amount (`formatMoneyCents`), the table keeps every exact value.
Exposição oficial (apurado) and estimada stay separate series (never summed); the P0.2 rules (não apurado ≠ 0, no
official series without a valor apurado, null keys are registration gaps) are unchanged. The selection is kept in the
URL with `history.replaceState` (no request) and submitted with the filter form (hidden input with `form="filtros-painel"`).
`PortfolioData` (P0.2) gained `coverage: LiquidatedCoverage` (active portfolio in scope; X = processes with an
official liquidated value, zero included) and `registrationGaps: RegistrationGap[]` (`{ field: DimensionKey;
count; href }`, only fields with ≥ 1 process, in `DIMENSIONS` order; `href` = `/processos?pendencia=<campo>`
with the BI filters). `Dimension.rows[].key`/`href` are never null any more; processes without the field go to
`Dimension.missing` (`{ bucket; href } | null`) and stay out of the chart (and of its table). UI rule: every
amount based on the official liquidated value (valor liquidado, exposição/provisão oficial, per classification,
per chart, previous-closing deltas) is shown with its coverage, and as "Sem valor apurado" instead of R$ 0 when
nothing is assessed. Per chart: a row without any valor apurado reads "não apurado · est. R$ X" (tooltip and
aria-label "Exposição oficial: não apurado"), a row without any basis "sem base de cálculo"; when no drawn row has
a valor apurado the chart drops the official series and legend and draws only the estimate (labelled
"Estimativa" in the note). Previous closing: when either side has no valor apurado there is no Aumento/Redução
("Sem base de comparação: sem valor apurado no fechamento|agora"). The coverage statement (styled as a link) opens
`/contingencias/revisao`; the secondary link `/processos?liquidado=sem` (+ BI filters). The previous closing's
coverage comes from the stored snapshot items. The same rule applies outside the dashboard: the `/processos`
summary ("Sem valor apurado"/"Sem valor informado" when no process of the view has the value, coverage in the
hint) and `/contingencias` (official KPIs and table cells read "Sem valor apurado"/"Não apurado"; an empty
instância/empresa/tribunal is not a table category but a `<RegistrationGaps>` entry linking to
`/processos?pendencia=…` with the page filters).
`ProcessLinkExtra.pendencia` (`@/modules/dashboard/bi-filters`) builds the gap links.
`BiFilters` gained `companyId` (URL `empresa`). New audit actions: `company.create|update|delete|deactivate`,
`law_firm.create|update|delete|deactivate`, `organization.contingency_settings_update`,
`organization.email_intake_settings_update`, `audit.export`.

`DecisionBand` = `{ today, windows, hearings, deadlines, installments, guarantees, valuations }`; each block is a
`Section<DecisionBlock>` (`ok | forbidden | error`) with `total` (all visible items), `overdue`, `totalCents`
(only for amounts of the same quantity — installments to pay, idle guarantees; `null` for valuations, RN-02),
the top 5 `items` (process number, short description, date/amount, `href` where the user acts) and the block
`href`. Rules (each block applies its `*Where(ctx)`; parent labels are joined through the parent's scope):

| Block | Permission | Counts | Item link · block link |
|---|---|---|---|
| `hearings` | process:read | `scheduled`, from now to the end of the 7th day (`listUpcomingHearings` window) | `/processos/<id>?aba=audiencias` · `/audiencias?periodo=7d&status=scheduled` |
| `deadlines` | deadline:read | open `procedural`/`regulatory`, `validation_status in ('not_required','validated')`, due ≤ today + 7 (overdue included). `pendingValidation` = every open `pending_validation` deadline (same count as the Validação tab), never part of `total` | `/prazos?aba=prazos&prazo=<id>` · `/prazos?aba=prazos&situacao=abertos` (list without a count: it holds every open deadline); `/prazos?aba=validacao` |
| `installments` | contingency:read | `pending` installments of `BINDING_SETTLEMENT_STATUSES`, due ≤ today + `settings.alerts.installmentDueDays` (overdue included) | `/processos/<id>?aba=acordos` · `/acordos?vencendo=1` |
| `guarantees` | contingency:read | `linked` and last movement (status change, else deposit, else registration date) ≤ today − `settings.contingency.idleGuaranteeDays` (`idleGuaranteesWhere`, shared with the list page) | `/processos/<id>?aba=valores` · `/contingencias/garantias` (same condition, scope and order: exactly N rows) |
| `valuations` | contingency:read | `proposed` (`listReviewQueue`, oldest first); `source = "simulation"` items carry `simulated: true` and the label "Extração simulada (demonstração)" | `/contingencias/revisao?item=<id>` · `/contingencias/revisao` |

`DecisionBlock.list` = `{ href, count | null }` ("Ver lista completa (N)"; `count: null` for deadlines, whose
list is wider than the block). `DECISION_HREFS` holds the block links. An item linked to a record the
viewer cannot see (`restricted`) reads "Registro sem acesso", never "Sem processo vinculado".
`@/modules/dashboard/idle-guarantees`: `listIdleGuarantees(ctx, page)` (contingency:read + `guaranteeWhere`;
process label through `processWhere`) for `/contingencias/garantias`.
P0.6 dashboard layout: (1) the band; (2) "Carteira de passivo": `<NetExposureCard summary />`
(`PortfolioData.netExposure: NetExposureSummary`, deductions by guarantee kind and the top
`NET_EXPOSURE_TOP` processes, estimate apart), KPIs, previous closing, registration gaps, the dimension
chart and top exposures; (3) `<MoreIndicators defaultOpen>` (native `<details>`, collapsed unless the URL
chose a period): intake, alerts, briefs awaiting review, operations of the period. "Como ler este painel"
is a popover (`how-to-read.tsx`). Alert counts use `visibleAlertsWhere`.

### contracts — `@/modules/contracts/service` (v2 additions)
```ts
renewContract(ctx, id, { newEndDate, amendmentDocumentId?, note? }): Promise<void>
terminateContract(ctx, id, { terminationDate, documentId?, note? }): Promise<void>
fulfillObligation(ctx, obligationId, { generateNext? }): Promise<{ contractId; nextObligationId; nextDueDate }>
listContractLifecycle(ctx, id), listContractDocumentOptions(ctx, id)
```
`ContractListItem` / `ContractDetail` gained `notice`, `overdueObligations` and `nextObligation`;
`ContractKpis` gained `noticeSoon` and `overdueObligations`. The renewal/termination history is read
from the audit trail (`contract.renew`, `contract.terminate`). Overdue obligations are computed on read
(the stored status is not rewritten). The routine dedupe keys `contract_expiring:<id>` and
`obligation_due:<id>` are resolved immediately on renewal, termination, fulfilment and removal.

### shell and global search
```ts
// @/components/layout/shell-data (server only): loadShellData(ctx): Promise<ShellData>   // org, unit, law firm, alert counts, AI and e-mail modes
// @/components/layout/nav-utils: filterNavGroups(groups, can), activeNavHref(pathname, hrefs), matchesNavHref(pathname, href)
// src/app/(app)/busca/search.ts: runGlobalSearch(ctx, rawQuery): Promise<GlobalSearchResult>   // sections processes, documents, contracts, occurrences — each with its own permission (null when not allowed)
```

## Process detail tabs (`/processos/[id]?aba=...`)

P0.6: six tabs (keys, labels and helpers in `@/modules/processes/tabs`; build links with
`processTabUrl(processId, tab, section?)`, the default tab has no query):

| Key | Label | Content (in order) · anchors |
|---|---|---|
| `resumo` (default) | Resumo | Decision band (P0.4, loaded once by `ProcessSummaryTab`); compact cover: only fields with a value, valor da causa and valor apurado side by side ("Não informado"/"Não apurado", never summed; a valor da causa awaiting review is shown below it as "R$ X proposto, aguardando conferência", from the band's proposals, contingency:read), ONE "Completar cadastro (N campos)" link to `/processos/<id>/editar` listing the empty fields, the only list of registration gaps on the tab (`missingCoverFields(p, { claimPending })`: tribunal, vara/órgão, cidade, classe, instância, empresa, unidade, responsável, ajuizamento, valor da causa unless a proposal is pending; without process:write the list only); short preliminary-analysis card (status, one sentence, link) only with brief:read AND a brief. No empty card is rendered (no AI card here). |
| `partes-e-andamento` | Partes e andamento | Parties `#partes`; instances `#instancias`; ONE timeline of every instance of the CNJ `#andamento` (P2.13: most recent first, instance badge, source badge "DataJud (CNJ)" / imported / manual, per-instance counts) with `<CourtSyncPanel ctx processId/>` and the manual entry form beside it. |
| `valores-e-acordos` | Valores e acordos | `<ProcessContingencyTab/>` `#valores` (risk card `#classificacao-risco`) and `<ProcessSettlementsTab/>` `#acordos` and `<ProcessScenarios/>` `#cenarios` only with contingency:read; `<ProcessClaimsPanel/>` `#pedidos` (process:read). |
| `prazos-e-audiencias` | Prazos e audiências | `<EntityWorkItems/>` `#prazos` (deadline:read / task:read), `<ProcessHearingsTab/>` `#audiencias`. |
| `documentos-e-analises` | Documentos e análises | Shown with document:read, brief:read or analysis:read. `<EntityDocuments/>` `#documentos` + downloads of sensitive documents `#downloads-sensiveis` (P2.12, `listSensitiveDocumentDownloads`; hidden when the viewer sees no sensitive document of the process); `<ProcessBriefTab/>` `#analise-preliminar` (brief:read); `<AnalysisPanel/>` `#analises-ia` only with analysis:read AND (analysis:request OR an analysis exists); `<ProcessReportCard/>` `#relatorio-do-processo` (R1, legal_report:read; "Gerar R1" only for the R1 generator roles and, with an approved R1, for who could approve it). |
| `historico` | Histórico | `<CommentThread/>` `#comentarios`, `<ProcessEmailsTab/>` `#emails` (email:read), `<EntityHistory/>` `#historico-alteracoes`. |

Keys of the previous fourteen-tab layout keep working (`LEGACY_PROCESS_TABS`, `resolveProcessTab`): the page
opens the tab that holds the content and scrolls to its section when the URL has no hash (`ScrollToSection`):
`visao-geral` → resumo · `partes` → partes-e-andamento#partes · `instancias` → #instancias · `movimentacoes` →
#andamento · `valores` → valores-e-acordos · `acordos` → #acordos · `audiencias` → prazos-e-audiencias#audiencias ·
`prazos` → prazos-e-audiencias · `analise-preliminar` → documentos-e-analises#analise-preliminar · `documentos` →
documentos-e-analises · `ia` → #analises-ia · `emails` → historico#emails · `comentarios`/`historico` → historico.
Links stored in e-mails and alerts with the old keys therefore stay valid; new links should use the new keys.
Unknown or hidden tabs open `resumo`. Tab content components are async server components
`({ ctx, processId })` that check their own permission; the page gates the sections so no "sem acesso" notice is
shown inside a merged tab.

Header (P0.6): title = CNJ number, subtitle "Autor × Empresa" (`processHeaderSubtitle`), badges (status,
instance, phase, CNJ check, sigiloso, "Pendente de conferência", retenção legal). The tab bar is wrapped in
`<ActiveTabScroller/>` (`@/modules/processes/components/active-tab-scroller`): on a phone the bar scrolls
sideways and the open tab is scrolled into view. The `needsVerification` flag is called "conferência"
everywhere on the page (menu items, dialogs "Marcar para conferência" / "Concluir conferência", badge, band). Only "Editar" is a visible button; "Retirar da
carteira ativa" / "Reativar na carteira", "Marcar para conferência" / "Concluir conferência" and "Excluir processo"
live in the "Mais ações" dropdown (`<ProcessActionsMenu/>`, Radix, same actions and permission checks; each item
opens its dialog).
Anchor (P0.4): `/processos/<id>?aba=valores-e-acordos#classificacao-risco` = risk classification card
(`RISK_SECTION_ID` in `@/modules/processes/decision-band`).

### Process decision band (P0.4) — before the tabs of `/processos/[id]`

The "Resumo" tab opens with the band "Exige decisão agora" (P0.6: inside the default tab, above the compact
cover; before P0.6 it sat above the tabs of every tab). Registration gaps are no longer a pendência of the band
(P0.6): the cover lists them once, with the single "Completar cadastro" link. The "Marcado para verificação" callout was
folded into the band (pendência "Pendente de conferência" with the note). The header keeps the badge
("Pendente de conferência"); the action to resolve it is "Concluir conferência" inside "Mais ações"
(`<ProcessActionsMenu/>`, permission `process:write`), there is no separate button.

```ts
// @/modules/processes/decision-band-service (server)
getProcessDecisionBand(ctx, processId, { today? }): Promise<ProcessDecisionBand>   // process:read + processWhere (NotFoundError); read-only
processBandAccess(ctx): BandAccess   // { alerts: dashboard:read, deadlines: deadline:read, contingency: contingency:read,
                                     //   classify: contingency:read+write, distribute: distribution:manage }
// @/modules/processes/decision-band (pure, client-safe)
buildProcessDecisionBand(input: ProcessBandInput): ProcessDecisionBand
riskInForce(risks, today)                                // official, greatest effectiveFrom <= today, then latest created
COUNTED_DEADLINE_VALIDATION, CONTINGENCY_ALERT_TYPES, BAND_REDUNDANT_ALERT_TYPES, RISK_SECTION_ID
// UI: <ProcessDecisionBandSection ctx processId /> (loads; a failure renders a notice, never breaks the page)
//     loadProcessDecisionBand(ctx, processId): Promise<ProcessDecisionBand | null> + <ProcessDecisionBandOrNotice band />
//     <ProcessDecisionBandView band /> from @/modules/processes/components/process-decision-band
```

`ProcessDecisionBand = { processId, today, pendencies, nextAct, valuations, risk, responsible }`:

| Block | Rule | Permission · links |
|---|---|---|
| `pendencies` | Open alerts (`visibleAlertsWhere`) whose entity is the process or one of its hearings, settlements or guarantees — except `process_needs_verification` and `valuation_pending_review` (dedicated blocks) and, without contingency:read, `CONTINGENCY_ALERT_TYPES`; open deadlines `pending_validation`; the `needsVerification` flag ("Pendente de conferência" + note); scheduled hearings of a past day ("Audiência sem desfecho registrado"). Sorted critical → warning → info, then flag, alert, validation, hearing outcome. Registration gaps are listed by the cover (P0.6). The UI shows 4 and collapses the rest in a `<details>` | alerts: dashboard:read; validations: deadline:read. Alert → `resolveAlertHrefs` read by `alertHrefKey(row)` (each alert keeps its own type's tab; an alert whose link is the page itself → `/alertas?tipo=<type>`); validation → `/prazos?aba=validacao&prazo=<id>`; outcome → `?aba=prazos-e-audiencias#audiencias` |
| `nextAct` | Nearest of: open deadline with `validation_status in ('not_required','validated')` (overdue included, always first) and scheduled hearing from today on. Same day: the hearing (fixed time) before the deadline (runs until the end of the day); hearings by time. `more` = the other acts | deadlines only with deadline:read (`deadlinesConsidered`). Deadline → `/prazos?aba=prazos&prazo=<id>`; hearing → `?aba=prazos-e-audiencias#audiencias`; `moreHref` → `?aba=prazos-e-audiencias` (without deadline:read `#audiencias`) |
| `valuations` | `proposed` valuations of the process (`valuationWhere`), oldest first; count + each amount with kind and base date (never summed, RN-02); `simulated` / `estimate` flags labeled | contingency:read, else `null` (not queried). Item → `/contingencias/revisao?item=<id>`; block → the oldest item |
| `risk` | `official` assessment in force today (`riskInForce`); else the classification kept on the record (`basis: "record"`, flagged "Somente no cadastro"); else `basis: "none"` ("Sem classificação"). `pendingProposals` = rule suggestions awaiting approval | contingency:read, else `null` (not queried). Link `?aba=valores-e-acordos#classificacao-risco` ("Classificar" with contingency:write when not official) |
| `responsible` | Name and law firm; `assigned: false` → "Sem responsável" | `distributeHref` = `/distribuicao?aba=regras&processo=<id>` only with distribution:manage ("Distribuir" / "Redistribuir") |

## Routes and URL params (v2)

Money in URLs is in reais (integer); services take cents.

| Route | Permission | Params |
|---|---|---|
| `/processos` | process:read | v1 params + `tribunal`, `instancia`, `cidade`, `uf`, `empresa`, `escritorio`, `classe`, `valor_min`, `valor_max` (reais), `liquidado=com\|sem`, `pendencia=tribunal\|instancia\|fase\|cidade\|empresa\|unidade` (registration gap: field empty, see `ProcessFilters.missingField`), `verificar=1`, `carteira=ativa\|encerrada\|todas` (default `ativa`), `ordem=recentes\|numero\|causa_maior\|causa_menor\|liquidado_maior\|liquidado_menor\|ajuizamento_recente\|ajuizamento_antigo\|movimentacao_recente`. A `status` without `carteira` widens the view to `todas` |
| `/processos/novo`, `/processos/[id]/editar` | process:write | — |
| `/busca` | process:read | `q` — sections processos (max 20), documentos, contratos, ocorrências; each follows its own permission and visibility; documents match title, description or file name only |
| `/entrada` | intake:manage | `status` (effective status, including `brief_rejected`), `origem=manual\|import\|simulated_feed`, `q` (CNJ with or without punctuation, or title), `pagina` |
| `/entrada/nova` | intake:manage | — |
| `/entrada/[id]` | process:read (+ `intakeWhere`) | — (pipeline timeline; links to `/entrada`, briefs and e-mails only for profiles with intake:manage, brief:read, email:read) |
| `/distribuicao` | distribution:manage | `aba=regras\|carga`; on `regras`: `teste=<busca>` and `processo=<id>` ("Testar regras") |
| `/distribuicao/regras/nova`, `/distribuicao/regras/[id]` | distribution:manage | — |
| `/analises-preliminares` | brief:read | `status`, `responsavel`, `pagina` |
| `/analises-preliminares/[id]` | brief:read | `editar=1` |
| `/audiencias` | process:read | `periodo=7d\|30d\|90d\|passadas`, `status`, `responsavel`, `pagina` |
| `/alertas` | dashboard:read | `tipo`, `severidade`, `situacao=abertos\|resolvidos`, `area=audiencias\|prazos\|entrada\|valores\|acordos\|verificacoes\|analises-preliminares\|contratos\|analises-ia`, `pagina`. The header bell links to `/alertas` and `/alertas?severidade=critical` |
| `/contingencias` | contingency:read | `empresa`, `tribunal`, `instancia`, `fase`. Empty instância/empresa/tribunal → "Pendências de cadastro" → `/processos?pendencia=instancia\|empresa\|tribunal` (+ these filters as `/processos` params) |
| `/contingencias/revisao` | contingency:read | `origem=document\|official_system\|spreadsheet\|manual\|simulation`, `confianca=baixa\|alta`, `pagina`, `item` (selected valuation) |
| `/contingencias/provisao` | contingency:read | `competencia=YYYY-MM`, `pagina` (memória de cálculo table) |
| `/acordos` | contingency:read | `status`, `vencendo=1`, `pagina` |
| `/relatorios` | report:read | `tipo=carteira\|exposicao\|provisao\|auditoria\|movimentacao\|responsaveis`, `empresa`, `unidade`, `competencia=YYYY-MM`, `de`, `ate` (YYYY-MM-DD, movimentação; default = current month to today), `pagina` (movimentação on screen). `competencia`: comparison snapshot for `exposicao` (default previous month); closed competência for `provisao` (default latest closed) and `auditoria` (empty = current position) |
| `/inteligencia-preventiva` | preventive_intel:read | `empresa`, `tribunal` (court as registered) |
| `/emails` | email:read | `modelo`, `destinatario`, `processo`, `pagina` |
| `/emails/[id]` | email:read (+ `emailWhere`) | — |
| `/importacoes`, `/importacoes/nova` | import:run | — |
| `/importacoes/[id]` | import:run | `aba=resumo\|linhas\|inconsistencias\|divergencias`, `planilha`, `acao`, `nivel`, `codigo=<issue code>`, `pagina`, `confirmado=1` / `desfeito=1` (banners) |
| `/admin/empresas`, `/admin/escritorios` | admin:organization | `q`, `situacao=ativos\|inativos`, `pagina`; detail `?criado=1` |
| `/admin/usuarios/novo` | admin:users | `escritorio=<lawFirmId>` pre-fills the external counsel |
| `/admin/integracoes` | admin:organization | — |
| `/admin/configuracoes` | admin:organization | in-page anchors (`#ia`, `#contingencias`, `#email`, `#rotinas`) |
| `/admin`, `/admin/permissoes` | any of admin:users, admin:organization, audit:read | — |
| `/dashboard` | dashboard:read | v1 params + `empresa`. First band "Exige decisão agora" (`getDecisionBand`), then the portfolio (carteira: coverage of the valor apurado → `/contingencias/revisao`, KPIs, "Pendências de cadastro" → `/processos?pendencia=…`, one chart with a dimension selector `dimensao=` and one money unit per chart, without null categories) and the other sections; the filters apply only below the band |

Routes added after the v2 integration:

| Route | Permission | Params / notes |
|---|---|---|
| `/contingencias/garantias` | contingency:read | `pagina`; idle linked guarantees (same condition as the dashboard block) |
| `/consulta-datajud` | court_sync:run | `numero` (CNJ with or without punctuation); ad-hoc DataJud lookup that reads the official data WITHOUT saving anything |
| `/paineis-bi` | report:read | `painel=<report id>` (default: the first registered report); setup instructions when not configured; configuration link only with admin:organization |
| `/relatorios-juridicos`, `/relatorios-juridicos/[id]`, `/relatorios-juridicos/parametros` | see "Legal reports" | |
| `/admin/integracoes/datajud` | admin:organization | health per tribunal, settings (DataJud + simulated feed), "Sincronizar a carteira agora" |
| `/admin/integracoes/api` | admin:organization | API keys (create shows the key once, revoke), requests of the last 24 h |
| `/admin/integracoes/power-bi` | admin:organization | workspace, reports, RLS role, "Testar conexão", "Atualizar agora", refresh history |

Admin pages that show async cards (`IndexSeriesCard` on `/admin/integracoes`, `DefaultCorrectionIndexCard` on
`/admin/configuracoes`) resolve them in the page body (`await IndexSeriesCard({ ctx })`, inside `Promise.all`)
instead of nesting async elements, so the `renderToString` page tests keep working. Keep this pattern.

### Route handlers (API)

| Route | Auth | Notes |
|---|---|---|
| `POST /api/v1/processos`, `GET /api/v1/processos/{numero}`, `GET /api/v1/openapi.json` | API key (`Authorization: Bearer prt_…`) + scope; the OpenAPI document is public | Outside the proxy matcher (no cookie); see "Inbound API" and `docs/API.md` |
| `GET /api/bi/embed-token?report=<id>` | session + report:read | Read-only embed token (20 min) with the user's effective identity; 401/403/400/404/409/502/503 |
| `GET /api/provision-memo/[period]?formato=xlsx\|pdf` | session + contingency:read | Memória de cálculo (P1.10); audit `provision_memo.export`; PDF refused (400 JSON) above `PROVISION_MEMO_PDF_ROW_LIMIT` |
| `GET /api/legal-reports/[id]/pdf` | session + legal_report:read | See "Legal reports" |
| `GET /api/health` | public | `{ status, database }`, 200 or 503 |
| `GET /api/processes/export?<list params>&formato=csv\|xlsx` | session + process:read | Same filters as `/processos`; max 20,000 processes per file; audit `legal_process.export` (filters + count, written before the file is built) |
| `GET /api/reports/<tipo>?formato=csv\|xlsx&empresa=&unidade=&competencia=&de=&ate=` | session + report:read | 401/403/404 (unknown type)/400 (format or filters); the CSV carries the report's main table (for `provisao`: the per-process calculation detail); audit `report.export` |
| `GET /api/contingency/snapshots/[period]/csv` | session + contingency:read | Accounting CSV of a competência with memória de cálculo; audit `snapshot.export` |
| `POST /api/imports/upload` | session + same-origin + import:run | Excluded from the proxy matcher; 15 MB; only analyzes |
| `GET /api/imports/[id]/issues?planilha=&nivel=&codigo=` | session + import:run | Issues CSV |
| `GET /api/imports/[id]/file` | session + import:run | Original spreadsheet (audited) |
| `GET /admin/auditoria/exportar?acao=&entidade=&usuario=&de=&ate=` | session + audit:read | Audit CSV (same filters as `/admin/auditoria`), max 10,000 rows; audit `audit.export` |
| `POST /api/documents/upload` | session + same-origin + document:upload | Unchanged; the intake form also uses it |

Uploads that are not documents go through a route handler excluded from the proxy matcher
(`/api/imports/upload` is excluded in `src/proxy.ts`). `/brand/*` (public logo files) too.
CSV exports: UTF-8 with BOM, `;` separator, decimal comma, CRLF; null money cells stay empty (RN-03).
Every CSV neutralizes formulas in text cells (leading `=`, `+`, `-`, `@`, tab or CR get an apostrophe),
the monthly close CSV included (`csvText` in `@/modules/contingency/csv`; money and percent cells are never
prefixed).
Download links: a route that audits each download must be requested once. Links rendered with `next/link`
(`ButtonLink`) carry `prefetch={false}` and `download` (import file and issues CSV, audit export), otherwise
the route is fetched twice and two audit entries are written. The other downloads are plain `<a href>` (the
monthly close CSV and the provision memo also with `download`).

## Simulation labeling (mandatory UI rule)

- Anything produced by the simulated case-brief provider shows `CASE_BRIEF_DEMO_NOTICE`
  (`@/domain/case-brief`) and each item shows its provenance badge (`PROVENANCE_LABELS`):
  Extraído (with document + page + quote), Cadastro/planilha, Ilustrativo, Lacuna, and
  "Incluído/editado pelo advogado" for items written or changed during review (providers never emit it).
- Every simulated e-mail shows a banner "Envio simulado — nenhuma mensagem foi enviada" and its
  subject starts with "[Simulação]" (the simulated provider refuses messages without the prefix).
  Sender addresses must use a reserved domain.
- Values with `source = "simulation"` are labeled "Extração simulada (demonstração)".
- Indicators computed from data must be visually separated from illustrative suggestions
  (label "Calculado a partir da carteira" vs "Sugestão ilustrativa — avaliar com a área responsável").
- Demo documents carry "DOCUMENTO FICTÍCIO — GERADO PARA DEMONSTRAÇÃO" on every page.
- "Simular chegada de processo" exists only in demo organizations and labels the case as fictitious.
- Never present simulated or illustrative content as a fact of the case; never invent case law,
  court movements, CNJ movement codes or tribunal integrations. The DataJud public API is the only
  tribunal source (operational when `DATAJUD_API_KEY` is set, "Coleta inativa" otherwise); MNI, PJe,
  consulta pública and diários are shown as "não integrado nesta versão". The simulated arrival feed
  (`simulated_feed` routine, demo organizations only, off by default) labels every case as fictitious.

## Demo data facts (spreadsheet `scripts/seed-data/files/Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx`)

Fictitious data provided by the client for the demo. Sheets: "Dashboard" (summary — ignore),
"Consolidado Geral" (1166 rows + header; a TOTAL row near row 1097, extra rows after it),
"1º Grau" (TOTAL near 717), "2º Grau" (no Cidade column; TOTAL near 241), "3º Grau (TST)"
(Instância values "3º Grau (TST)" and "TST"; TOTAL near 143), "Atualização Geral (29-07-2026)"
(narrative log — ignore for rows; its date is offered as the base date). Columns: Instância,
TRT/Tribunal, Nº do Processo, Parte Autora, Parte Ré, Cidade, Vara / Órgão Julgador / Turma, Classe,
Fase, Valor da Causa (R$), Valor Liquidado/Apurado - 1º grau (R$). 208 CNJs repeat in Consolidado (up
to 3 instances); the parser tests expect 1165 consolidated rows and 928 distinct CNJs. Fase is a
composite string (e.g. "Execução — ARQUIVADO def. …", "PAGO/EXTINTO — arquivado def. 2026-06-25",
"Conhecimento — Saiu do acervo … verificar", "Recurso decidido — baixou do 2º grau (à origem/TST)").
City variants ("Palmas - TO", "Palmas/TO", "Palmas"), non-city values ("Cejusc Digital",
"Secretaria de Cálculos Judiciais"). The client party is "EMPRESA MODELO TESTE LTDA (e outros)".
Values diverge across sheets for some CNJs. The import module reads it with
`read-excel-file/universal`.

## Alert producers (entity conventions)

`upsertAlert` (`@/modules/alerts/service`) with a stable `dedupeKey`; resolve with
`resolveStaleAlerts`/`resolveAlertsByDedupeKeys` when the condition disappears.

| Alert type | entityType / entityId | Producer |
|---|---|---|
| `hearing_upcoming` | `hearing` / hearing id | `hearing_alerts` routine (critical for today/tomorrow) |
| `settlement_installment_due` | `settlement` / settlement id | `portfolio_alerts` routine |
| `valuation_pending_review` | `legal_process` / process id (one per process) | `portfolio_alerts` routine |
| `enforcement_without_value` | `legal_process` | `portfolio_alerts` routine |
| `guarantee_idle` | `guarantee` / guarantee id | `portfolio_alerts` routine |
| `process_needs_verification` | `legal_process` | `portfolio_alerts` routine |
| `brief_pending_review` | `case_brief` / brief id | briefs service (on generation; resolved on approve/reject) |
| `intake_unassigned`, `new_process_received` | `intake` / intake id | intake service |
| `court_movement_relevant` | `legal_process` (dedupe `court_movement_relevant:<processId>`) | court-sync (`applyCourtRecords`): closure-type or relevant movements within `ALERT_LOOKBACK_DAYS` (120), or a closure that is the latest movement of the process |
| `court_hearing_designated` | `legal_process` (dedupe `court_hearing_designated:<processId>:<movement id>`) | court-sync: hearing designated by the tribunal (the date must be registered by a person); resolved when a later movement of the same hearing supersedes it |
| `court_sync_failed` | `legal_process` (a sample process of the tribunal; dedupe `court_sync_failed:<alias>`, critical) | court-sync: the last `FAILED_RUNS_FOR_ALERT` (3) runs of a tribunal failed over at least 2 h; resolved by the next successful run |
| `claims_risk_review` | `legal_process` (dedupe `claims_risk_review:<processId>`) | claims service (see "claims") |
| `snapshot_close_blocked` | `legal_process` (dedupe `snapshot_close_blocked:<processId>`) | `monthly_snapshot` routine (close gate, see P1.9) |
| `legal_report_outdated` | `legal_process` (dedupe `legal_report_outdated:<processId>`, warning) | `legal_reports_refresh` routine and the R1 job: an APPROVED R1 whose data fingerprint differs from the process data; resolved by any new R1 of the process (same transaction) and by the routine when the data matches again |

Links: hearing → `?aba=audiencias`, settlement → `?aba=acordos`, guarantee/valuation →
`?aba=valores` of their process (resolved in batch by `resolveAlertHrefs`, read with `alertHrefKey`);
`legal_process` alerts by type through `PROCESS_TAB_BY_ALERT_TYPE` (see "alerts"); `case_brief` →
`/analises-preliminares/<id>`; `intake` → `/entrada/<id>`; `deadline_pending_validation` →
`/prazos?aba=validacao&prazo=<id>`. The legacy tab keys open the new tabs (see "Process detail tabs").

## Contracts added before the build

- `CreateProcessInput` / `UpdateProcessInput` (`@/modules/processes/schemas`) accept the v2
  optional fields (`companyId`, `lawFirmId`, `instance`, `processClass`, `city`, `state`,
  `phaseDetail`, `closureReason`, `needsVerification`, `verificationNote`, `lastMovementAt`);
  the portfolio service persists them (with tenant checks).
- Case-brief provenance `reviewer` ("Incluído/editado pelo advogado") is used for items written or
  changed during review; providers never emit it (the service rejects it on generation).
- XLSX export: `write-excel-file@4.1.1` (`write-excel-file/node`). CSV exports use
  UTF-8 with BOM, `;` separator and decimal comma; null money cells stay empty (RN-03).
- The portfolio service inserts `claim` valuations (source `manual`) when the valor da causa is set or
  changed, so the value history (RF-09) is complete: official (reviewer = the editing person) only for
  `contingency:approve` roles, proposed for everyone else (P0.6, see "Denormalized mirrors").
  The imports commit may insert instances/valuations/mirrors directly for the bulk load.
  Every other valuation write goes through the contingency service.

## Phase and instance (P0.5) — `@/domain/enums`

- `PROCESS_PHASES = ["knowledge", "liquidation", "enforcement"]` (Conhecimento, Liquidação, Execução) and
  `PROCESS_INSTANCES = ["first", "second", "superior"]` (1º grau, 2º grau, 3º grau; `PROCESS_INSTANCE_RANK`
  orders them). Every form, filter (`phase`/`fase`, `instancia`) and zod schema derives from these lists.
- `LEGACY_PROCESS_PHASES` (`pre_filing`, `appeal`, `settlement`, `closed`) + `LEGACY_PROCESS_PHASE_LABELS` exist
  ONLY to display historical rows that must not change: items of closed competências
  (`portfolio_snapshot_items.phase` is typed `StoredProcessPhase`), audit history, BI labels and the
  `legacy_phase` kept by the migration. Display a stored phase with `processPhaseLabel(code)` (or
  `PROCESS_PHASE_DISPLAY_LABELS`); never build options from the legacy map. `isProcessPhase(v)` checks writes.
- The database refuses other values: CHECK `legal_processes_phase_ck` / `process_instances_phase_ck`.
- Migration `0012_phase_instance_split` (reverse: `drizzle/down/0012_phase_instance_split.sql`, run with
  `npm run db:rollback -- 0012_phase_instance_split --yes`, see `@/server/db/migrations`):
  - `legal_processes.legacy_phase` / `process_instances.legacy_phase` keep the previous phase; the new phase comes
    from `phase_detail` with the importer's rule (lead term Execução/Cumprimento → enforcement, Liquidação →
    liquidation, Conhecimento → knowledge; then the term anywhere), otherwise `knowledge`;
  - `appeal` becomes the INSTANCE: when `legal_processes.instance` is null it gets the highest 2º/3º grau link in
    `process_instances` (none: `second`), tracked by `legacy_instance_set`;
  - `pre_filing`, `settlement` and `appeal` without a known appellate instance (no 2º/3º grau link and the
    instance empty or 1º grau) are flagged for verification with the note "Fase anterior '<rótulo>' migrada:
    conferir fase e instância" (`legacy_verification_set` = the migration turned the flag on); `closed` stays
    only as status (untouched); a `closed` phase whose status was still open (`active`/`suspended`, a
    contradiction the previous model allowed) is flagged the same way ("Fase anterior 'Encerrado' migrada…");
  - one `legal_process.phase_migration` audit row per affected process (codes only); the rollback adds
    `legal_process.phase_migration_rollback` rows and keeps the others. Closed competências are never touched (RN-10).
  - succeeded AI analyses that used a migrated process as a source are marked stale (`is_stale`, reason
    "Fase e instância do processo convertidas…", no alert); the rollback keeps them stale (informational only).
  - A PREVIEW calculated before the migration is stale (`PreviewStaleness.changed`, below) and must be recalculated
    before the close: no legacy phase is frozen into a newly closed competência.
  - The movement report ignores both actions (a reclassification is not a procedural phase change).
- Consumers: the imports parser takes the phase only from Conhecimento/Liquidação/Execução terms; recurso / agravo /
  ROT / AIRO name the 2º grau and TST / RR / AIRR / recurso de revista the 3º grau (`PhaseParse.instance`), which
  fills a row without Instância (WARNING `instance_from_phase`, `NormalizedRow.instanceFromPhase`; the plan marks
  the process for verification). Negated or deadline-only wording ("sem recurso", "não houve recurso", "recurso não
  interposto", "prazo recursal", "prazo para recurso") names no instance. A row whose Fase only names the instance
  ("Recurso Ordinário") is registered as Conhecimento with the warning `phase_fallback_instance_only` + verification
  ("Fase não informada (o texto indica só a instância: 2º grau)…"), not `phase_fallback`. A closed row without a
  phase term is registered as Conhecimento with the info issue `phase_fallback_closed` (no verification); an
  unrecognized phase never overwrites the phase of an existing process. Rows stored in `import_rows.normalized`
  before P0.5 (batch analyzed before the deploy, committed after it) carry `phase: "appeal" | "closed"…` and no
  `phase.instance`: `buildImportPlan` re-reads them with `normalizeStoredPhase` (`@/modules/imports/parser`, from
  the stored cell text), so the commit never writes a legacy phase. An import rollback never writes back a legacy
  phase (`withoutLegacyPhase`, `@/modules/imports/plan`). RF-12 (`suggestRiskByRule`) and the simulated case brief
  use the INSTANCE (2º/3º grau) for "em grau de recurso". DataJud never changes the phase of a closed/archived process.
- Inbound API `POST /api/v1/processos` (`@/modules/inbound/schemas`, OpenAPI): `fase` accepts only
  `knowledge | liquidation | enforcement` (BREAKING for external clients: `pre_filing`, `appeal`, `settlement` and
  `closed` are now refused with 400 and a field error that points to `instancia`); new optional
  `instancia` = `first | second | superior` (1º/2º/3º grau, default `first`). Both apply only when the process is
  created; an existing CNJ (200 `updated_existing`) keeps its phase and instance.

## Close gate of the monthly close (P1.9) — `@/modules/contingency/snapshot-service`

A competência closes without reservation only when every ITEM of its preview (the population the
close freezes) has an OFFICIAL risk classification in force on the reference date: a
`process_risk_assessments` row with `status = 'official'` and `effective_from <= data-base`.
Rule suggestions (`proposed`) and the classification typed on the process record
(`legal_processes.loss_probability` without any assessment) do not count. Classifications derived
from the claims (pedidos) count because the claims module records them as process risk assessments.
A derived assessment takes the latest `effective_from` among the counted claim assessments in force
(`derivedEffectiveFrom` in `@/modules/claims/derivation`), never earlier than the official assessment in
force and never after today, so a claim assessment backdated into the competência satisfies its gate.
Exception: an explicit "aplicar classificação derivada" that ends an override (claims panel or Valores
tab) is dated today, like the override itself. Approved rule suggestions take the approval date.

The preview is STALE, and the close is refused even with a justification until it is recalculated,
when (counts in `PreviewStaleness`, `@/modules/contingency/close-gate`):
- `classified`: for an item, an official assessment in force on the reference date was created or
  reviewed after `portfolio_snapshots.generated_at`, or the one in force differs from the stored
  classification/percentage (covers a recording concurrent with the calculation);
- `added`: a live process active on the reference date (`activeAtCondition`) is not an item;
- `removed`: an item is no longer active on it (soft-deleted, e.g. import rollback; closed before it;
  filed after it);
- `changed` (P0.5): an item still active whose stored phase/instance differs from the process record, or whose
  phase is not one of the three current phases (preview calculated before migration 0012).
So the override ids are always a subset of the closed items, and the frozen phase/instance are the record's.

```ts
closeSnapshot(ctx, period, { justification? })   // snapshot:close + identified person
//   -> { id, override: { id, unclassifiedCount } | null }
//   throws CloseBlockedError (extends ValidationError: unclassifiedCount, unclassified[] visible to ctx,
//          hiddenCount) when processes are unclassified and no justification is given;
//   throws ValidationError (fieldErrors.justification) for a justification under 20 characters;
//   throws ConflictError (stalePreviewMessage) when the preview is stale (recalculate first).
//   With a justification and pending processes: inserts `snapshot_close_overrides` (reason,
//   unclassified_process_ids, unclassified_count, closed_by_id) in the same transaction and adds
//   closeOverrideId/unclassifiedCount/justification to the `snapshot.close` audit metadata.
//   A justification is ignored (no override row) when nothing is pending.
getCloseGate(ctx, period, { limit? })            // contingency:read; CloseGateView (preview: unclassified
//   items still active, with responsible, classifiedFrom, recordOnly, pendingProposal; isStale;
//   staleness (org-wide counts, scope all/org_wide only); canCloseWithoutJustification for
//   snapshot:close holders. Closed: the stored override; `reason` is null for a "visible"-scope
//   viewer with none of its processes listed, and the page shows a neutral line)
refreshCloseGateAlerts(organizationId, today?)    // system; used by the monthly_snapshot routine (LIVE
//   population: what the next recalculation will need classified)
runCloseGateAlertsRoutine(rc)                     // wired after runMonthlySnapshotRoutine in src/server/jobs/routines.ts
```

- Table `snapshot_close_overrides` (`src/server/db/schema/snapshot-close.ts`): insert-only, one per
  snapshot (unique), DB checks `char_length(btrim(reason)) >= 20` and `unclassified_count > 0`.
  Down: `drizzle/down/<tag>.sql`.
- Pure helpers (client-safe): `@/modules/contingency/close-gate` (`closeJustificationSchema`,
  `CLOSE_JUSTIFICATION_MIN_LENGTH`, message builders, `CLOSE_BLOCKED_ALERT_TYPE`).
- Visibility: the gate is organization-wide; lists and messages name only processes the viewer may
  see (confidential ones are counted as "sigiloso não listado" for org-wide roles, like the totals).
- The routine NEVER closes. Alert `snapshot_close_blocked` (entity `legal_process`, one open alert per
  process, dedupe `snapshot_close_blocked:<processId>`, severity warning) while a competência whose
  reference date already passed is still `preview` and the process is unclassified on it; resolved by
  `resolveStaleAlerts` on the next run and right after a close.
- UI: `/contingencias/provisao` lists the unclassified processes before the close (link to
  `?aba=valores` to classify), disables "Fechar competência" while the list is not empty and offers
  "Fechar com justificativa" (`src/app/(app)/contingencias/provisao/close-gate-forms.tsx`); a closed
  competência shows "Fechada com N processo(s) sem classificação, justificativa: ...".

### claims (pedidos do processo, P1.6) — `@/modules/claims/*`

Risk is assessed PER CLAIM; the process risk derives from the claims. Tables in
`src/server/db/schema/claims.ts`: `process_claims` (soft delete), `process_claim_assessments`
(APPEND-ONLY, in force = greatest `effective_from <= hoje`, then creation) and
`process_claim_risk_links` (APPEND-ONLY, ties a `process_risk_assessments` row to the claims: `derived` or
`override`, with the derivation result and `basis_fingerprint`). Down: `drizzle/down/<tag>.sql`.

```ts
// service.ts (all take ctx first; row visibility = processChildWhere / processWhere)
getProcessClaims(ctx, processId): Promise<ProcessClaimsOverview>   // process:read; risk part only with contingency:read
createClaim(ctx, processId, ClaimInput) / updateClaim(ctx, claimId, ClaimInput)   // process:write + person
confirmClaim(ctx, claimId, ClaimInput) / dismissClaim(ctx, claimId, { reason? })   // process:write; pending suggestions only
removeClaim(ctx, claimId, { reason })                // process:write; soft delete; re-derives when the claim had an assessment in force
assessClaim(ctx, claimId, ClaimAssessmentInput)      // contingency:write + person; confirmed claims only; re-derives in the same tx
applyDerivedRisk(ctx, processId)                     // contingency:write; records the derived classification (ends an override)
overrideProcessRisk(ctx, processId, { classification, percentage?, justification })   // contingency:write; must differ from the derived
suggestClaimsFromBrief(ctx, briefId)                 // process:write + brief:read; latest applicable brief; idempotent
suggestClaimsFromBriefAsSystem(organizationId, briefId)   // system hook for the briefs pipeline (never confirms)
getBriefClaimsOffer(ctx, processId), getClaimProcessId(ctx, claimId), reviewAlertKey(processId)
getClaimRiskLinkKinds(ctx, processId)                // contingency:read; { [riskAssessmentId]: "derived" | "override" }
// derivation.ts (pure, client-safe)
deriveProcessRisk(claims), derivedProcessRate(d, orgBp) -> { bp, basis, weightedBp } | null, derivedProcessBp(d, orgBp),
derivedRateNeedsReview(rate), differsFromInForce(derived, inForce), claimsFingerprint(claims), derivationOpinion(d, rate, actor)
// labels.ts (client-safe): claimsRiskAttribution(kind, { assessedByName, createdAt }), DERIVED_RATE_BASIS_LABELS
// UI: <ProcessClaimsPanel ctx processId /> from @/modules/claims/components/process-claims-panel
```

Rules:

- Derivation counts only `confirmed` claims with an assessment in force: classification = worst
  (remote < possible < probable); provision = Σ (base × %) of the quantified ones; an assessed claim
  without base is "não quantificado" (listed, never summed as zero). The process assessment records the
  weighted percentage Σ(base × %) / Σ base only when EVERY counted assessed claim is quantified
  (`basis: weighted`). Otherwise it records the organization percentage of the derived classification:
  `organization_no_base` when no assessed claim has a base, `organization_unquantified` when quantified
  and unquantified claims are mixed. The weighted rate would count the unquantified claims as zero, so
  the mixed case is also flagged for review (alert + panel callout + opinion text).
- PO decision pending: the official provision (mirror, RN-05) applies the process percentage to the net
  liquidated value or, without it, to the valor da causa, so it differs from "Σ claim base × claim %"
  whenever those bases differ. The panel shows both ("Provisão oficial do processo" next to "Provisão
  pelos pedidos") and flags the difference; the official provision is the one used by closes and reports.
- When the derived result differs from the official process assessment in force, a NEW official
  `process_risk_assessments` row is inserted with `effective_from` = `derivedEffectiveFrom(claims,
  inForceEffectiveFrom, today)` (the latest effective date of the counted claim assessments, never before
  the assessment in force, never after today; a forced derivation that ends an override is dated today)
  (origin `system`, opinion "Derivado dos pedidos: ...",
  assessed/reviewed by the person whose action triggered it, `rulesVersion`), `syncProcessMirrors` runs
  in the same transaction and the audit is `risk_assessment.derive` (`entityType: "legal_process"`,
  `metadata.riskAssessmentId`). The contingency module has no reusable function for a system-origin
  official assessment inside another transaction, so the insert lives in the claims service with the
  same invariants as `addRiskAssessment`.
- Override: official assessment origin `manual`, opinion "Classificação definida manualmente, diferente
  da derivada dos pedidos (...). Justificativa: ...", link `override`. Later derivations keep it; when
  the counted claim assessments change (fingerprint), the alert `claims_risk_review` (entity
  `legal_process`, dedupe `claims_risk_review:<processId>`) is opened and the panel flags it. Removing
  every assessed claim is also a change (empty fingerprint). "Aplicar classificação derivada" or a new
  override resolves it.
- An official classification recorded OUTSIDE the panel (aba de valores, approved rule suggestion) after
  the first claim assessment of the process is a human decision: derivations keep it like an override
  (`overrideKind: "outside_panel"`, its parecer is the justification) and flag it for review when a claim
  assessment is recorded or an assessed claim is removed after it. One recorded BEFORE any claim
  assessment is replaced by the next derivation (new dated record). Time comparisons run in SQL on
  `coalesce(reviewed_at, created_at)`.
- A derived classification whose claims lose every assessment is kept (nothing to derive) and flagged
  (`derivedWithoutBasis`, outcome `{ status: "no_assessed_claims", needsReview: true }`).
- Derived rows are `origin: "system"`, `status: "official"`, assessed/reviewed by the person whose
  action triggered them, but they are NOT rule suggestions: the risk history of the Valores tab must label
  rows whose `getClaimRiskLinkKinds` kind is `derived` with `claimsRiskAttribution` ("Derivada dos
  pedidos ..."), not "Sugestão automática por regra ... aprovada por".
- Claims suggested by the preliminary analysis (`origin: ai_suggested`, `status: pending_confirmation`)
  come only from brief items with provenance `extracted`, `record` or `reviewer` (never `illustrative`
  or `missing`), keep `source_brief_id` + `source_index` (unique) and a `source_note` with the version,
  the simulation label and citation refs only (no document text). They cannot be assessed and do not
  count until a person confirms them (`confirmClaim`, with the reviewer's corrections).
- Values: claim value and assessment base carry a base date and a correction index
  (`CORRECTION_INDEXES`, null = sem índice informado); the updated value is not stored (not computed
  by this module yet). Editing a claim never changes the base stored in its assessments.
- Audits (`entityType: "legal_process"`, `metadata.claimId`): `claim.create|update|delete|suggest|confirm|dismiss`,
  `claim_assessment.create`, `risk_assessment.derive|override`. Claim descriptions are never written to
  the audit trail (they may come from documents); diff keys use the `claim*` prefix with pt-BR values.
- Wiring: `<ProcessClaimsPanel/>` is in the "Valores e acordos" tab (`#pedidos`, process:read); the
  `claims_risk_review` alert opens `?aba=valores#classificacao-risco`; the briefs pipeline calls
  `suggestClaimsFromBriefAsSystem` when a version becomes ready for review.
- Known gaps (not defects, recorded in docs/STATUS.md): an official classification recorded in the Valores
  tab does not resolve an open `claims_risk_review` (the contingency module does not know the alert; the
  next claims action re-syncs it); `provisionDiffers` is true when only one side has a provision, so the
  panel's "Provisão do processo diferente da provisão pelos pedidos" callout may show on a process without
  claims; an outside-panel classification EQUAL to the derived one is still kept as an override.

## Correction indexes and updated value (P1.7) — `@/modules/indices/*`

Monthly series of IPCA-E, IPCA, INPC, Selic and TR collected AUTOMATICALLY from the Banco Central SGS
public API; each valuation carries a correction index; the updated value is computed on read and
NEVER stored. Migration `drizzle/0007_correction_index_series.sql` (+ `drizzle/down/`): tables
`index_series` (catalog + collection status) and `index_series_values` (global public data, no
`organization_id`), column `process_valuations.correction_index` and the trigger
`process_valuations_default_correction_index`.

SGS codes (confirmed on 2026-10-12 against the SGS metadata service `FachadaWSSGS.getUltimoValorVO`
and the data API; see `@/modules/indices/catalog`): IPCA-E `10764`, IPCA `433`, INPC `188`, Selic
accumulated in the month `4390`, TR first day of the month `7811`. Do not add a series without the
same check.

```ts
// math.ts (pure, client-safe)
updatedValue(amountCents, baseDate, indexCode | null, asOf, seriesByIndex)
  → { status: "no_index" | "not_corrected" | "no_months" | "updated" | "unavailable",
      cents | null, factor | null, monthsApplied, firstMonth, throughMonth, missingMonths[], pendingMonths[] }
unavailableMessage(r)  // "atualização indisponível (faltam meses: 03/2025 a 05/2025)"
parseRateMicro, microToRateText, formatRateMicro, addMonths, monthRange, formatMonth, formatMonthRanges
// service.ts (server)
getValuationUpdates(ctx, processId, { asOf? }): Promise<{ asOf; items: ValuationUpdate[]; byId }>   // contingency:read + valuationWhere
computeValuationUpdates(ctx, rows, { asOf? })             // same result for rows the caller ALREADY loaded with its own access checks
                                                          // (review queue); contingency:read; reads only the public series
loadMonthlyRates(codes, fromMonth, toMonth, db?) / loadRatesFor(rows, asOf, db?)                       // reuse in reports/claims
setValuationCorrectionIndex(ctx, valuationId, index, { note? })
  → { processId, changed, mode: "in_place" | "new_record" | null, valuationId }
                                                          // identified person; see the rules below for who may and how;
                                                          // audit valuation.correction_index_set (in place, metadata.valuationStatus)
                                                          // or valuation.correction_index_replace (new record, metadata.newValuationId)
getDefaultCorrectionIndex(ctx) / updateDefaultCorrectionIndex(ctx, index)   // admin:organization to change; audit organization.correction_index_default_update
refreshIndexSeries(ctx, { now?, force?, client? })        // admin:organization (routine: system ctx)
requestIndexSeriesRefresh(ctx)                            // "Atualizar agora"; audit organization.index_series_refresh_request
getIndexSeriesOverview(ctx, now?)                         // admin:organization; status per series + this org's routine
// routines.ts: runIndexSeriesRefreshRoutine(rc)   (routine type `index_series_refresh`, daily)
// policy.ts (pure, client-safe): correctionIndexEditability(row), correctionIndexChangeFor(row, { write, approve }) → mode | null,
//     canEditCorrectionIndex(row, perms), pinnedCorrectionIndex(formValue), CORRECTION_INDEX_NOTE_MAX
// contingency (review, P1.7): ReviewQueueItem.correctionIndex; reviewValuation(ctx, id, input, { expectedCorrectionIndex? })
//     and bulkApproveValuations(ctx, ids, { [id]: expectedIndex }) refuse an approval/correction when the index changed
//     after the screen was loaded (CORRECTION_INDEX_CHANGED_MESSAGE); the forms send the shown index in hidden fields
//     `expectedCorrectionIndex` / `expectedCorrectionIndex:<id>` ("" = sem índice informado)
// catalog.ts (pure): INDEX_SERIES_CATALOG (with confirmationDay), lastStorableMonth(def, today), monthsToCollect(stored, lastStorable)
// UI: <ValuationOriginalValue/>, <ValuationUpdatedValue update/> (components/valuation-values, no hooks),
//     <IndexSeriesCard ctx/> (/admin/integracoes), <DefaultCorrectionIndexCard ctx/> (/admin/configuracoes),
//     <CorrectionIndexDialog valuationId current valueLabel mode/> (client; render only when correctionIndexChangeFor(row, perms)
//     returns a mode, and pass it), review queue: index + <ValuationUpdatedValue compact/> per row (contingency review-forms)
// Client: @/server/integrations/bcb (getSgsClient, setSgsClientForTesting, BcbSgsClient, parseSgsResponse)
```

Rules:

- Calculation convention (product decision, not a legal rule): compound the monthly rates from the
  month AFTER the base date up to the last month published BEFORE the month of `asOf`. Any missing
  month inside that range → `cents: null` with the months listed; nothing is estimated. Months after
  the last published one are returned as `pendingMonths` (shown as "sem taxa coletada"). Exact
  arithmetic: integer micro-percent + BigInt product, one rounding (half away from zero) at the end.
- `correction_index` null = "sem índice informado" (rows that existed before the migration). New rows
  get `settings.contingency.defaultCorrectionIndex` (default `"none"`) from the database trigger when
  the insert does not set the column, so every insert path (contingency, processes, imports, seeds)
  is covered. Code may still set the column explicitly, and a path that derives a new valuation from
  another one MUST copy it (the review correction in `reviewValuation` copies `correctionIndex` from
  the proposal). `"none"` = no update; it may come from the organization default (nobody chose it per
  value), so the interface says "Sem atualização (índice: nenhum)", never "escolhido".
- Who changes the index of a valuation, and how (`policy.ts`):
  - `proposed`: in place, `contingency:write` (the lawyer's choice during the review).
  - official/superseded with null ("sem índice informado"): in place, once, `contingency:approve` only
    (an official value never gets an index from someone who could not approve it).
  - OFFICIAL with an index (including `"none"` stamped by the default: values registered directly as
    official by an approver, imported official rows, the valor da causa of the process form, seeds):
    `contingency:approve` only, with a NEW official valuation (same kind, amount, base date, instance,
    source, document refs, brief; `supersedesId` = old row; reviewer = the person; not part of any
    import batch) that supersedes it. The old row keeps its index (append-only history). Registering
    a new value is NOT the way to change an index: an approver's new value gets the default again.
  - superseded with an index (history) and rejected: never.
  Amount and base date never change.
- Swap guard (the `new_record` path must never move money): `setValuationCorrectionIndex` refuses with a
  pt-BR `ConflictError` when another official or superseded valuation of the same kind and base date exists
  in a different instance (`sameBaseDateOtherInstance`, `@/modules/indices/swap-guard`), and it loads the
  history of the kind before and after the insert in the same transaction and rolls back (`ConflictError`)
  when the row in force changes at any base date or for the official value of the process record
  (`indexSwapInForceChange`, pure; mirrors `later()` of `position.ts` and `OFFICIAL_VALUATION_ORDER`).
  Conservative by design (product decision): values of different instances sharing a base date (every
  multi-instance import, a quitação dated like another instance's liquidated value) never have their index
  swapped, and the dialog still offers "Trocar índice" (the person gets the refusal). Residual race: no
  process-level lock, so a concurrent approval in the milliseconds between the two reads is not detected.
- Reports after a swap: the movement report (screen, CSV, XLSX) lists the kind `index_change` ("Troca de
  índice de atualização", neutral badge; detail "<tipo> de R$ X (data-base d) · índice de A para B · valor e
  data-base mantidos", `previousCents`/`newCents` null) instead of a zero value change, and
  `summary.valueChanges` excludes swaps; the Valores tab series collapses the chain (`collapseIndexSwaps`). Which index applies to a case is the lawyer's choice: no code
  maps case types to indexes.
- The review makes the index final, so the review queue shows the index and the updated value of
  each proposal (rows and detail), and the review forms pin the index shown (see the review contract
  above): if a lawyer changes it after the screen was loaded, the approval or correction is refused.
- The updated value is never added to the valor da causa, never enters exposure/provision/snapshot
  totals and is labeled "Valor original (data-base dd/mm/aaaa)" / "Valor atualizado por <índice> até
  mm/aaaa" side by side.
- Collection: the gaps between the first and the last stored month plus the months after the last
  stored one (or 07/1994), up to `lastStorableMonth(def, today)` (São Paulo): never the current month,
  and month M only from day `confirmationDay` of M+1 (Selic 4390: day 10, because it accumulates the
  daily Selic and the last business days of M reach the SGS only in M+1; the other series: day 1).
  Points outside the months asked are ignored. A stored month is never rewritten (`on conflict do
  nothing`). Gaps that the source still lacks are asked again on the next runs, appear in the run
  status and as "Meses faltando na série" (health `gaps`) on the admin card. 404 "Value(s) not found" = no new month;
  HTML/5xx/429/timeouts are retried with backoff; a network/timeout failure stops the run. Throttle:
  a series consulted successfully less than 6 h ago (1 h after a failure) is skipped unless forced.
  Errors are stored in `index_series.last_error` (pt-BR, never the response body).
- `updateContingencySettings` (admin) keeps `defaultCorrectionIndex`; `mergeOrganizationSettings`
  falls back to `"none"` for an unknown stored value (same fallback as the trigger).

## Legal reports (relatórios jurídicos em PDF): foundation and R1

Migration `drizzle/0008_legal_reports.sql` (reverse: `drizzle/down/0008_legal_reports.sql`). The foundation ships the
data model, the PDF engine, the issuing pipeline (validation, source checking, pending items, sequential reference,
approval, versions, download) and a "Documento de teste do motor" generator (`engine_sample`, type `process_report`,
`is_sample = true`). The R1 generator ("Relatório de Processo", `process_report`) is described in "R1" below; R2 to R4
come later. The R1 needed no migration (layout, purpose, app version and data fingerprint live in `parameters`).

### Data model (`src/server/db/schema/legal-reports.ts`, client-safe types in `@/domain/legal-reports`)

- `legal_reports`: `type` (`process_report|provision_report|portfolio_report|responsibility_report`,
  codes R1 to R4 in `LEGAL_REPORT_TYPE_CODES`), `reference` "R1-2026-0007" (sequential per
  organization, type and year: `legal_report_sequences`, `INSERT … ON CONFLICT DO UPDATE` inside the
  issuing transaction, so concurrent issues never repeat a number and a rolled-back issue gives the
  number back; the PDF is rendered inside that transaction, so issues of the same organization, type and
  year queue for a few seconds, the price of a numbering without gaps). The engine sample has its own
  series "TESTE-R1-2026-0001" (sequence key `sample:<type>`), so it never consumes the official numbers,
  `version` (a new version keeps the reference; unique `(organization_id, reference,
  version)`; `supersedes_id` unique, so a version has at most one successor), `scope` jsonb
  (`processId | period | filters | responsibleId`) + `process_id` (denormalized for row visibility),
  `base_date`, `parameters` jsonb (generator, confidence threshold, bands, legal basis text, sections,
  methodology, scope label: frozen at issue), `status` `draft|pending_review|approved|superseded`
  (`draft` is reserved for types that will allow editing before issuing), `generated_by_id` (null =
  system), `approved_by_id/at`, `pdf_storage_key`, `pdf_sha256`, `pdf_size_bytes`, `is_sample`, `title`.
- `legal_report_items`: `section`, `position`, `content`, `origin`
  (`documented|record|inference|analysis|gap`, NOT NULL), `document_id`, `document_version_id`, `page`,
  `excerpt` (never stored for `sensitive_health` documents), `record_source` jsonb (table, field,
  recordId, pt-BR label, `recordedAt`, `dateBasis` `record|latest|query`: date of the record read, of
  the most recent of several rows read, or of the query that found no row), `derived_from` jsonb (item ids), `confidence` 0 to 100,
  `simulated`, `pending_reason` (null = stated; otherwise the item is NOT stated and is shown in
  "Pendências do relatório"), `data` jsonb (table payload: columns with `nullLabel`/`quantity`, rows,
  totals, note).
- `legal_report_sources`: `reference` (D1… documents, C1… cadastro), `source`, `url` (internal path),
  document/version/page/hash, `sensitive`, `checked_at`, `confirmed`, `not_confirmed_reason`.
- `process_scenarios`: description, `probability_band` (`very_high|high|moderate|low|very_low`),
  `percent_min/max` (inside the band configured in `settings.legalReports.bands`), comment, `origin`
  (`system|manual`), `author_id`, `created_at`. Append-only.
- Database triggers (in the migration): a report never changes content after issue; an approved report
  only goes to `superseded` (nothing else changes); no report is deleted; items, sources and scenarios
  reject UPDATE and DELETE.
- Settings block `settings.legalReports` (`confidenceThreshold` 70, `bands` 80/60/40/20/0, `legalBasisText`);
  always read through `mergeOrganizationSettings`.

### Rules enforced in code (`@/modules/legal-reports/validation`, pure)

- `validateDraft(draft)`: every item needs an origin (a missing origin is an ERROR that blocks issuing:
  nothing is persisted and no number is consumed); documented = document + version + page + literal
  excerpt + `documentSha256` (SHA-256 of the version the generator read); record/analysis =
  `recordSource` with a valid `recordedAt` (`isRecordDate`: a calendar-valid `YYYY-MM-DD`, optionally followed
  by the strict suffix `THH:MM[:SS[.f{1,9}]][Z|±HH:MM]`; a missing or invalid date is an error, never a
  generic "date not stored" note); inference = `derivedFrom` pointing to existing items (no cycles); a
  gap carries no value.
- `placeItems(items, { threshold, sourceVerdicts })`: unconfirmed documented sources, confidence below
  the threshold, inferences whose bases are all gaps and inferences based on non-stated items go to
  pending (with the reason).
- `@/domain/legal-reports`: `GAP_MARKER` ("[DADO NÃO LOCALIZADO]"), `itemDisplayText`, `cellDisplayText`
  (null is never "0" nor empty), `totalOf(values, quantity)` (sums ONE money quantity; mixing valor da
  causa and valor apurado throws, RN-02/RN-03), `itemGapLabels(item)` (the gaps of an item: the gap item
  itself, or every empty cell of a column whose null label is the marker, "Coluna (linha): [DADO NÃO
  LOCALIZADO]"; used by the "Dados não localizados" list AND by the R1 methodology count),
  `redactPersonalIds(text)` / `containsPersonalId(text)` (CPF and CNPJ: formatted, after the acronym, or
  11/14 bare digits with valid check digits become "[CPF omitido]" / "[CNPJ omitido]"; the CNJ number, money
  and dates are untouched).
- Draft-only fields (never stored): `ReportItemDraft.gapRefs` (keys of the gap items whose marker a non-gap
  item repeats in its text, e.g. the R1 synthesis) and `summarizesGaps` (an inference that only summarizes
  gap items: not sent to pending). `validateDraft` blocks (`undeclared_gap_marker`) a marker in the text of
  a non-gap item that is not backed by `gapRefs` or by an empty gap cell of the same item, and
  (`invalid_table`) a cell with the marker written in it (a gap cell is an empty cell).
- `checkDocumentSources(ctx, inputs)` (`./source-checker`): document visible to the generating user,
  version belongs to the document and has the hash read by the generator (always compared; a missing
  hash is "not confirmed"), page exists (paged versions
  only), literal excerpt found in that page text (`getDocumentVersionPageText`; whitespace-tolerant).

### Services (`@/modules/legal-reports/*`; `legal_report:read` + `legalReportWhere(ctx)`; generating needs `report:generate`)

`legal_report:read` (read and download legal reports of visible processes) is separate from `report:read`
(management reports, exports and Power BI of the whole organization): every role with `report:read` has it,
and `external_counsel` has ONLY `legal_report:read` (reads the R1 of its firm's processes; never generates
nor approves).

```ts
// service.ts
listLegalReports(ctx, { type?, status?, processId?, page?, pageSize? }): Promise<Paginated<LegalReportListItem>>
getLegalReport(ctx, id): Promise<{ view: ReportView; versions; processNumber; approverDescription; permissions: { canApprove; canRegenerate; canDownload } }>
issueLegalReport(ctx, draft: IssuableDraft, { settings, supersedes? }): Promise<{ id; reference; version }>   // validation + source check + pending + PDF (watermark) + audit legal_report.generate|regenerate
//   IssuableDraft = LegalReportDraft & { onIssue?(tx, ctx, { reportId, reference }) }: writes the content presupposes
//   (R1: system scenario proposals), run INSIDE the issue transaction after validation (nothing stays if the issue fails).
//   Free text (items, cells, notes, labels, methodology, titles) goes through redactPersonalIds; literal excerpts never do.
//   draft.requiredPermissions -> parameters.requiredPermissions (sorted, unique).
generateEngineSample(ctx, { processId? | processNumber? }): Promise<{ id; reference; version }>                   // + process:read; values from contingency positionAt (same as the process page)
regenerateLegalReport(ctx, id)            // new version (same reference) with current data; previous -> superseded (PDF + hash kept); an APPROVED version only by someone who could approve it
approveLegalReport(ctx, id)               // identified person with the role of the type; final PDF with stamp, no watermark; audit legal_report.approve
openLegalReportPdf(ctx, id): Promise<{ fileName; bytes; sha256 }>   // checks the stored hash; audit legal_report.download
formatLegalReportReference(code, year, n), allocateReferenceNumber(tx, orgId, type, year)
// approvers.ts: APPROVER_RULES, canApproveLegalReport(ctx, { type, scopeResponsibleId })
//   GENERATOR_ROLES + canGenerateLegalReport(ctx, type): `report:generate` AND the role of the type
//   (R1/R4: admin, legal_manager, lawyer; R2: admin, legal_manager, accountant; R3: admin, legal_manager;
//   system always; read-only profiles never). issueLegalReport, generateEngineSample and
//   regenerateLegalReport enforce it; canSupersedeLegalReport(ctx, { type, status, scopeResponsibleId }):
//   superseding an APPROVED version also needs canApproveLegalReport (checked again under the row lock)
//   R1/R4: legal_manager or the responsible LAWYER of the scope (R1: current process responsible); R2: legal_manager or accountant; R3: legal_manager; admin always; system never
// view.ts (client-safe): buildReportView(report, items, sources, people) -> numbering (2.1…, pending P1…), itemNotes, standardMethodology
// pdf.ts: buildLegalReportPdfSpec(view), renderLegalReportPdf(view) -> { bytes, sha256, pageCount }
// scenarios.ts: addProcessScenario(ctx, processId, input) (contingency:write), listProcessScenarios(ctx, processId) (contingency:read)
// settings-service.ts: getLegalReportSettings(ctx), updateLegalReportSettings(ctx, input) (admin:organization; audit organization.legal_reports_settings_update)
```
Visibility (`legalReportWhere`, module-local): organization; process reports need the process visible
(external counsel: only its firm's processes); reports without a process only for organization-wide roles or
the generator; every document cited by an item must be visible (a `sensitive_health` citation hides the report
from profiles that cannot see the document); the viewer must hold every permission in
`parameters.requiredPermissions` (the read permissions of the content the report carries; R1: `process:read`
always, `document:read` with documents, `brief:read` with the preliminary analysis, `deadline:read` with deadlines,
`contingency:read` with values; e.g. an R1 with the brief is hidden from executive and accountant). Admin and
legal manager see all. New generators register in `GENERATORS` (service.ts) and
return a `LegalReportDraft`; `regenerateLegalReport` reuses the generator stored in `parameters.generator`.
Audits: `legal_report.generate|regenerate|approve|download` (entity `legal_report`),
`process_scenario.create` (entity `legal_process`, `metadata.scenarioId`), `process_scenario.propose` (entity
`legal_process`, `metadata.scenarioIds`, system proposals of the R1).

### PDF engine (`@/server/pdf`, server only)

`renderPdf(spec: PdfDocumentSpec): Promise<{ bytes; pageCount }>`: A4 flow layout with embedded fonts
(Inter 4.1 and Cormorant Garamond 4.000, static TTFs + OFL in `src/server/pdf/fonts/`, subset, lining
figures in the serif), header on every page (vector wordmark from `wordmark-paths.ts` + arch/square of
`logo.tsx`, "CONFIDENCIAL · USO INTERNO" stripe), footer "Página X de Y · reference · Data-base" + "O
conteúdo reflete o estado da base em dd/mm/aaaa." (second pass), diagonal watermark until approval.
Blocks: `heading` (kept with the next block, its space after included; a table with fewer than 5 data rows, which can
never be split, travels whole with its heading), `paragraph` (no hyphenation, 2-line orphan/widow control),
`item` (origin seal + number + text + literal quote + notes; items up to 200 pt never split), `table`
(header repeated on every page with "(continuação)", rows never split unless taller than a page, tables
up to 220 pt kept together, at least 3 rows before and 2 after a break, totals row never alone; optional
per-row origin seal `rowSeals` drawn in column `sealColumn`, used by the R1 row items),
`keyValues` (cover identification block), `callout` (`info|warning|stamp`), `rule`, `spacer`, `pageBreak`.
The origin legend is inserted before the first sealed block. Text is sanitized (no em/en dash, no soft
hyphen or control characters); the literal quote of an `item` keeps the source's dashes (a quote is
reproduced as the document has it). Letter spacing stays below 0.09 em so PDF readers extract words (search
and copy work). Fonts are read from `process.cwd()/src/server/pdf/fonts` (server and worker run from the
project root) and parsed per document (a fontkit font shared across documents loses ToUnicode entries).

### Routes

| Route | Permission | Notes |
|---|---|---|
| `/relatorios-juridicos` | legal_report:read | `tipo`, `situacao`, `pagina`; "Relatório de Processo (R1)" form ("Gerar R1": process from the list or by number) and "Documento de teste do motor" form (both: report:generate + R1 generator role + process:read) |
| `/relatorios-juridicos/[id]` | legal_report:read (+ `legalReportWhere`) | `gerado=1` banner; approve (approver of the type) / new version (`canSupersedeLegalReport`; action `report:generate`) / download |
| `/relatorios-juridicos/parametros` | admin:organization | confidence threshold, probability bands, legal basis text |
| `GET /api/legal-reports/[id]/pdf` | session + legal_report:read | stored PDF (hash checked), 401/403/404/409; audit `legal_report.download` |

UI on the process: `<ProcessScenarios/>` (`@/modules/legal-reports/components/process-scenarios`) in the
"Valores e acordos" tab (`#cenarios`, contingency:read; adding a scenario needs contingency:write) and
`<ProcessReportCard ctx processId/>` (`@/modules/legal-reports/components/process-report-card`) in "Documentos e análises"
(`#relatorio-do-processo`, legal_report:read).

### R1: Relatório de Processo (`@/modules/legal-reports/process-report`, `automation`)

```ts
// process-report.ts (server)
buildProcessReportDraft(ctx, { processId }, settings): Promise<IssuableDraft>   // generator "process_report" (GENERATORS); rows read with ctx's scope;
                                                                                // writes NOTHING: without any scenario, plans proposals (scenarios.ts)
                                                                                // and `onIssue` records them in the issue transaction
processReportFingerprint(organizationId, processId, db?, { plannedScenarioIds? }): Promise<string | null>
                                                                                   // SHA-256 of the data the R1 shows (no row scope): phase/instance,
                                                                                   // official values and indexes, risk assessments, claims and their
                                                                                   // assessments, guarantees, scenarios (planned proposals count as
                                                                                   // recorded), movements and the brief used
PROCESS_REPORT_SECTIONS, SCENARIO_CAVEAT, PROCESS_REPORT_PURPOSE, TIMELINE_MAX_ROWS (150, most recent; older ones counted in an item)
// service.ts
generateProcessReport(ctx, { processId? | processNumber? })    // "Gerar R1": new reference, or the next version of the current R1;
                                                               // approved current R1: only canSupersedeLegalReport (approver); current R1 not
                                                               // visible to ctx (cites a document outside its access): ConflictError
currentProcessReport(organizationId, processId, db?)           // latest pending/approved R1 of the generator (no row scope)
refreshProcessReportAsSystem(organizationId, processId, { createIfMissing, allowNewVersion?, isDemo? })
  → { outcome: "created" | "new_version" | "unchanged" | "outdated_alert" | "deferred" | "process_not_found"; reportId }
getProcessReportPanel(ctx, processId): Promise<ProcessReportPanel>   // legal_report:read + processWhere (card of the process page)
outdatedProcessReportAlertKey(processId), APP_VERSION (package.json, stored as parameters.appVersion)
// automation.ts
runProcessReportJob(organizationId, payload)                    // job "legal_report.generate" { processId, trigger: "brief_approved" }
runLegalReportsRefreshRoutine(rc)                               // routine "legal_reports_refresh" (daily; REFRESH_MAX_NEW_VERSIONS_PER_RUN = 40)
// scenarios.ts
planScenarioProposals(sources, bands, now?): PlannedScenarioProposal[]      // pure: one proposal per assessed claim (band containing its %), ids fixed
insertScenarioProposals(tx, ctx, processId, planned, { reportReference })  // inside the issue transaction; process row locked; ConflictError if a
                                                                              // scenario appeared meanwhile; origin "system", no author; audit
                                                                              // process_scenario.propose with who asked ("pedida por <nome>" or
                                                                              // "geração automática") and the report reference
```

Rules:

- Layout `parameters.layout = "process_report"` (`reportOutline(view)` in `view.ts`, used by the page and the PDF): 1 capa de
  identificação (report data without seal: reference, base date, situation, generated at, "Elaborado por" = Praetor + app
  version, "Revisado por" empty until approval, finalidade, legal basis; then the process items), 2 nota metodológica (generated
  from the data read + `standardMethodology`), 3 síntese (3 to 6 points), 4 linha do tempo, 5 pedidos e valores, 6 garantias e
  exposição líquida, 7 cenários (`ReportSectionSpec.note` = the fixed caveat, rendered after the section), 8 pontos de atenção,
  9 auditoria de fontes (Verificado and Não confirmado with the rule sentence), 10 pendências (items not stated + the list of
  every gap: `gapEntries(view)`, gap items AND empty gap cells such as "Cidade/UF (2º grau)", pending items included). Reports
  without `layout` keep the standard layout (methodology 1, sections from 2, pending, sources, not confirmed).
- Gaps: every datum not located is a gap item or an empty cell of a gap column; the synthesis repeats a marker only through
  `gapRefs` (phase, current instance, valor da causa, valor apurado). The methodology count (`itemGapLabels`) equals the
  "Dados não localizados" list. The synthesis gap point is an `inference` with `summarizesGaps`, derived from the gap items it
  names (record gaps, missing documents, other brief gaps). "sem registros encontrados" (`dateBasis: "query"`) only for empty
  queries (no guarantee, no open deadline, no hearing); counts of rows found use `latest`/`record`.
- Synthesis 3.1: current instance, court and division from the `process_instances` row with `is_current` (else the row of
  `legal_processes.instance`); `legal_processes.court/court_division` only when the process has no instance rows (court-sync
  fills those fields from the origin instance). The cover adds "Fase processual" (record or gap) and, without instance rows,
  city/UF and court gaps; a CNJ number that fails the check digit becomes an attention item.
- Row items (`ReportItemData.kind = "row"`, `group`, `caption`, `columns`, `cells`): consecutive items of the same group are
  rendered as ONE table with each row's origin seal (`PdfBlock.table.rowSeals` + `sealColumn`, engine) and item number; each row
  is still an item (own origin, source check, pending). Used by the timeline (process events as Cadastro, DataJud ones with
  source "DataJud (CNJ), coletado em …"; brief events as Documentado with document and page).
- Values: the claims table shows the claimed value (original) and the updated value side by side (`updatedValueText`, computed
  with `loadRatesFor` + `updatedValue`, never stored; missing months → "atualização indisponível (faltam meses: …)"); "Valor
  apurado" per claim is always "Não apurado" (the claims module records none). Valor da causa and valor apurado of the process
  are separate items (position as `positionAt`); no table of the R1 has a totals row. Net exposure = `exposureBreakdown`
  (deductions listed; the estimate is a separate item starting with "Estimado").
- Preliminary analysis: latest APPROVED brief, else the latest `ready_for_review`/`in_review` one (`caseBriefWhere`).
  extracted → Documentado (first citation with a visible document, page and an excerpt of at least 12 characters and without
  CPF/CNPJ; document hash = `document_versions.sha256` of the version the brief read); record → not repeated (the record is read
  directly); missing → Lacuna, from EVERY section (`gaps`, `identification`, `amounts`, `claims`, arguments, missing
  documents, timeline; reviewer items of `gaps` too), labeled "(apontado pela análise preliminar vN[, simulação])"; missing items
  citing "REG" (the record) are not repeated, because the R1 reads the record itself and marks its current gaps (counted in the
  methodology); illustrative → Análise `simulated: true`, text starting with "Simulação", only in sections 3 and 8; reviewer →
  Análise credited to the person and date of the revision that introduced the item in its current form (`case_brief_revisions`;
  without a record: "revisor não identificado no histórico de revisões"). Items citing a `sensitive_health` document have generic
  text and no excerpt.
- Automation: `approveCaseBrief` enqueues `legal_report.generate` AFTER its transaction (failure logged, never fails the
  approval). `refreshProcessReportAsSystem`: same fingerprint → nothing; pending R1 → next version; approved R1 → alert
  `legal_report_outdated` (never superseded by the system); no R1 → created only with `createIfMissing` (the job, not the routine).
  The routine resolves the outdated alerts of R1s that match the data again (only when no process failed in the run).

## Provision memo (memória de cálculo, P1.10): `@/modules/provision-memo/*`

```ts
// service.ts (server)
getProvisionMemo(ctx, period, { now? }): Promise<ProvisionMemo>        // contingency:read; NotFoundError when the competência was never calculated
exportProvisionMemo(ctx, period, format: "xlsx" | "pdf", { now? }): Promise<{ fileName; contentType; bytes; rows }>
                                                                      // audit provision_memo.export (entity snapshot, counts only);
                                                                      // PDF refused (ValidationError) above PROVISION_MEMO_PDF_ROW_LIMIT (3000)
// memo.ts (pure, client-safe): ProvisionMemo, ProvisionMemoRow, MemoTotalsLine, buildTotals, memoBase, splitProvision,
//   MEMO_CLASSIFICATION_SOURCE_LABELS, PROVISION_MEMO_PDF_ROW_LIMIT (re-exported by service.ts), labels (NOT_ASSESSED_LABEL…)
// xlsx.ts: buildProvisionMemoXlsx(memo) (sheets "Memória" and "Totais"); pdf.ts: renderProvisionMemoPdf(memo) (@/server/pdf)
// route: GET /api/provision-memo/[period]?formato=xlsx|pdf
```

- Source: the STORED items of the competência (`portfolio_snapshot_items`): a closed competência is never
  recalculated (RN-10). XLSX and PDF are built from the SAME `ProvisionMemo` object, so their numbers match.
  Parecer and responsible come from the official assessment in force on the reference date WHEN the
  competência was calculated (insert-only history; later assessments are ignored), only when it matches
  the stored classification and percentage.
- Per row: base aplicável (`net_liquidated` = valor apurado minus the linked guarantees, never negative;
  `claim` = valor da causa, an ESTIMATED provision that does not deduct guarantees, as `provisionFor`;
  `none`), percentage, provision split into official and estimated columns (never one single total), and
  the classification source (`MemoClassificationSource`: claims-derived, claims override, outside-panel
  (manual, rule suggestion or imported recorded after the first claim assessment, following the claims
  module's `overrideOf` rule), manual, rule suggestion, imported, record only, unclassified, not located).
- Null is not zero: a missing value is text in the PDF ("Não apurado", "Não informado") and an empty cell in
  the XLSX; a totals column where no process has a value reads "Sem provisão" (PDF) or an empty cell (XLSX),
  never R$ 0,00; a recorded zero still shows 0.
- Close override (ressalva): the memo lists EVERY process of `snapshot_close_overrides` (no 500 cap), built
  from the override row plus the listed rows with the same reason / count / hidden-count policy as
  `getCloseGate` (which caps its own list at 500 for the closing screen); `close-override-list.test.ts`
  keeps the two in agreement.
- Visibility (same policy as the provision page, `snapshotScope`): rows = processes the person may see (current
  rule of the process without the soft-delete condition, so a process deleted afterwards stays, flagged);
  organization totals only for scope `all` / `org_wide` (snapshot:close) with the count of confidential
  processes not listed. **Policy decision**: for org-wide viewers the totals BY COMPANY include confidential
  processes, so a company whose only process is confidential shows that provision (with the "inclui N
  sigilosos" note). This is finer than the provision page and the reports, which sum per company over the
  visible rows only (recorded in docs/SECURITY.md).
- UI: `/contingencias/provisao` offers "Memória em XLSX" and "Memória em PDF" (`download` links); above
  3,000 rows the PDF button is disabled with a hint to use the XLSX (`view.itemsTotal`, same visibility as
  `memo.rows`). Opening the route directly above the limit returns the route's JSON 400.

## Court sync (DataJud, CNJ): `@/modules/court-sync/*`

Provider: `@/server/integrations/courts` (`getCourtProvider()` returns null without `DATAJUD_API_KEY`;
`COURT_COLLECTION_INACTIVE` = "Coleta inativa: configure DATAJUD_API_KEY."; `setCourtProviderForTesting`;
`fake.ts` for tests; per-alias sliding-window rate limit that waits; timeouts, 429 and 5xx retried).
`courtAliasesForCnj(number)` maps a CNJ number to the DataJud endpoints (origin tribunal + TST for labor cases).

```ts
// service.ts
runCourtSync(organizationId, opts): Promise<CourtSyncSummary>      // system; due processes grouped by origin alias; provider failures never throw
runCourtSyncJob(organizationId, payload)                            // body of the "court_sync.run" job (one alias, MAX_PROCESSES_PER_RUN = 400,
                                                                    // continues itself up to MAX_CONTINUATIONS = 50; a run that failed entirely stops)
applyCourtRecords(...)                                              // system write, ONE transaction per process (see rules)
fetchCourtRecordsForCnj(number, opts)                               // read only
syncProcessNow(ctx, processId): Promise<SyncProcessResult>          // court_sync:run + processWhere; inline, one attempt per endpoint
requestPortfolioSync(ctx): Promise<{ jobs; processes }>             // admin:organization; one job per tribunal; audit organization.court_sync_request
getProcessCourtSyncPanel(ctx, processId): Promise<ProcessCourtSyncPanel>   // process:read; `canRun` = court_sync:run
lookupCourtRecord(ctx, rawNumber): Promise<CourtLookupResult>       // court_sync:run; /consulta-datajud; never writes (logs court_lookup: user + counts)
getCourtSyncHealth(ctx) / describeDataJudIntegration(ctx) / updateCourtIntegrationSettings(ctx, input)   // admin:organization
listDueAliases(organizationId, settings), aliasesWithPendingSync(organizationId), courtSyncJobKey(orgId, alias)
nextCheckAfterError(consecutiveErrors, settings)                    // 1 h, 2 h, 4 h… capped at the sync interval
// routines.ts: runCourtSyncRoutine(rc) (`court_sync`, hourly), runSimulatedFeedRoutine(rc) (`simulated_feed`)
// mapping.ts (pure): DATAJUD_SOURCE_LABEL "DataJud (CNJ)", DATAJUD_ACTOR "Sistema · DataJud", movementExternalId, phaseTargetFor,
//   isForwardPhaseChange, relevantKind, reopensCase, parseCityState, courtsDiffer, mergeVerificationNote, DATAJUD_NOTE_PREFIX "[DataJud]"
// UI: <CourtSyncPanel ctx processId /> in "Partes e andamento"; <CourtSettingsForm/> and the health table on /admin/integracoes/datajud
```

Rules (`applyCourtRecords`):

- Only the process's own number is used. Instance links (G1, G2, superior) are created for the graus found.
- Movements: only NEW ones (`process_events.external_id` = code + date-time + grau, unique per process and
  source, `origin: imported`, `external_source` "DataJud (CNJ)", `cnj_movement_code` as informed). Nothing is
  invented; the DataJud does not inform parties, values, documents or hearing dates.
- Record fields: only EMPTY ones are filled (órgão julgador, classe, cidade/UF from the órgão name, ajuizamento);
  `subjects` and `lastMovementAt` follow the tribunal. A difference with what a person typed becomes a
  verification note (`[DataJud] …`) and flags the process ONLY when the tribunal's value is new compared with
  `court_sync_states.instances_found` (a resolved verification is not reopened by the same value; a grau that
  did not answer keeps its previous values with `notReturnedSince`).
- Phase: forward only, unambiguous movements only, never for a process outside the active portfolio;
  applied with `settings.integrations.datajud.autoApplyPhase`, otherwise a note. Instance: "remessa em grau de
  recurso" moves the current instance up (same switch).
- Closure-type movements (trânsito, baixa, arquivamento, extinção) raise `court_movement_relevant` and flag
  the process for verification; NOTHING is closed automatically, even when the closure is the latest movement
  of an old process. Designated hearings raise `court_hearing_designated`. Alerts only for movements within
  `ALERT_LOOKBACK_DAYS` (120), except a standing closure (`standingClosureId`).
- Audit `legal_process.court_sync` (actor "Sistema · DataJud", fields and counts only). Errors stored in
  `court_sync_states.last_error` / `court_sync_runs.error_message` are sanitized.
- Scheduling: each process has its own `next_check_at` (`syncIntervalHours`, default 24, with a small
  tolerance for processes checked a few minutes late; error backoff). Invalid CNJ numbers are `unsupported`
  and re-evaluated later. A tribunal whose last 3 runs failed over ≥ 2 h raises `court_sync_failed`.
- Settings: `settings.integrations.datajud` (`enabled`, `syncIntervalHours` 1 to 720, `maxRequestsPerMinute`
  1 to 120, `batchSize` 1 to 500, `autoApplyPhase`, `enrichOnIntake`) and `settings.integrations.simulatedFeed`
  (`enabled`, `intervalMinutes` 5 to 10,080); audit `organization.integration_settings_update`.

## Inbound API (`/api/v1`) and API keys: `@/modules/inbound/*`, `@/modules/api-keys/*`

```ts
// @/modules/api-keys/service (admin:organization unless noted)
createApiKey(ctx, { name, scopes, expiresOn? }): Promise<{ id; key; keyPrefix; name }>   // the key is returned ONCE; audit api_key.create
listApiKeys(ctx), revokeApiKey(ctx, id) (audit api_key.revoke), listInboundRequests(ctx, { limit? }), countRecentInboundRequests(ctx)
authenticateApiKey(rawKey, { ipAddress? }): Promise<ApiKeyIdentity | null>   // no ctx; null for malformed/unknown/revoked/expired
hasScope(identity, scope), apiKeyContext(identity, ip?): AuthContext   // system context bound to the key's organization, name "API: <key name>"
hashApiKey(key) (SHA-256 hex), generateApiKey() ("prt_" + 32 random bytes base64url)
// @/modules/api-keys/schemas (client-safe): API_KEY_PREFIX, API_KEY_PATTERN, createApiKeySchema
// @/modules/inbound/service
receiveInboundProcess(identity, req): Promise<InboundResponse>      // POST /api/v1/processos (scope intake:create)
getInboundProcessStatus(identity, rawNumber): Promise<InboundResponse>   // GET /api/v1/processos/{numero} (scope process:read)
recordRejectedRequest(identity, endpoint, httpStatus, errorCode), errorResponse(status, code, message, extra?)
// @/modules/inbound/http: authenticateRequest(request, endpoint) (401/403/429 + Retry-After), readLimitedBody, idempotencyKeyOf, clientIp, toHttpResponse
// @/modules/inbound/schemas: inboundProcessSchema (pt-BR field errors with full paths), INBOUND_MAX_DOCUMENTS = 20, INBOUND_POLOS
// @/modules/inbound/rate-limit: INBOUND_REQUESTS_PER_MINUTE = 60 (in memory, per process); @/modules/inbound/openapi: buildOpenApiDocument
```

Rules:

- The organization ALWAYS comes from the key; organization fields in the body are ignored. Scopes
  (`API_KEY_SCOPES`): `intake:create`, `process:read`.
- Request bodies are never stored or logged: `inbound_requests` keeps the status, ids, a short error code and
  the SHA-256 of the body. Idempotency: same key + same `Idempotency-Key` + same body → the stored response
  (`Idempotent-Replayed: true`); another body → 422 `idempotency_conflict`; still processing → 409 with
  `Retry-After: 5`; a refused request (4xx) releases the key; a 500 can be retried with it.
- Documents (base64): at most 20, `MAX_UPLOAD_MB` each, the sum at most 5× that limit, PDF/DOCX/TXT detected by
  magic bytes with a matching extension (same validation as uploads).
- RN-01: an existing CNJ number is never duplicated: the documents are attached to the existing process, a
  note goes to its latest intake, nothing on the record changes → 200 `updated_existing`.
- A new number: optional DataJud enrichment (`enrichOnIntake`, empty fields only, up to 20 s; movements found
  are recorded), then `registerIncomingProcess` with source `api` (the intake flow follows: distribution,
  simulated preliminary analysis, simulated e-mail) → 201 `accepted`. `fase` accepts only the three current
  phases (400 for the legacy values), `instancia` defaults to `first`. The valor da causa informed goes to the
  record but never becomes an official valuation (no identified person).
- Status endpoint: only processes received through the API by the same organization (others: 404).
- Audits: `inbound.receive`, `inbound.update_existing` (key name in metadata, no content).

## Power BI: `@/modules/bi/*`

```ts
// service.ts
getBiPageData(ctx): Promise<BiPageData>                              // report:read; /paineis-bi
createBiEmbedToken(ctx, reportId): Promise<BiEmbedToken>             // report:read; read-only, BI_EMBED_TOKEN_MINUTES = 20, effective identity
                                                                     // biUserKey(ctx.userId) + rlsRole; audit bi.embed_view (max 1 per user and report per hour)
getBiAdminOverview(ctx), updateBiSettings(ctx, input), requestBiRefresh(ctx), testPowerBiConnection(ctx)   // admin:organization
BiNotConfiguredError (ConflictError)
// access.ts: refreshBiAccess(organizationId) (bi_process_access from processWhere(ctx) of every ACTIVE user; processes deleted after
//   being in a CLOSED competência stay, RN-10), biUserKey(userId)
// refresh.ts: runBiRefreshJob(orgId, payload) (job "bi.refresh"), decideAutomaticRefresh, latestSourceChange, DEFAULT_BI_REFRESH_POLICY
//   { scheduledRefreshHours: 24, minIntervalMinutes: 60, maxRefreshesPerDay: 8 }
// routines.ts: runBiAccessRefreshRoutine(rc) (`bi_access_refresh`, hourly)
// labels.ts: BI_LABEL_DOMAINS, syncBiLabels(db?) (bi_labels); setup-sql.ts: BI_DB_ROLE "praetor_bi", biSetupStatements, privilege checks
// @/server/integrations/powerbi: REST client (Entra ID token, embed token, refreshes); PowerBiError (userMessage in pt-BR)
// scripts/bi-setup.ts: creates/updates the read-only role, registers its organization in bi_reader_roles, checks privileges, syncs labels and access
```

Rules:

- Power BI reads ONLY the views of the `bi` schema, with a read-only database role per organization
  (`bi_reader_roles`). Every view filters rows by the organization registered for `current_user` INSIDE the
  view (or shows everything to a role that can read `public.legal_processes`). **Every view of the `bi`
  schema must be created `WITH (security_barrier = true)`** (migration `0011`): without it a function created
  by the reader in its own session (PUBLIC has TEMPORARY) can see rows of other organizations before the
  view's filter. `tests/bi/data.test.ts` attacks exactly that and checks every view has the option. A migration
  that recreates a view must keep the option, and the bi-setup must run again afterwards (grants).
- View rules: valor da causa and valor apurado in separate columns (never summed); NULL is not zero;
  official and estimated exposure/provision in separate columns, computed like `netExposure`/`provisionFor`;
  competências only when CLOSED, as stored; no party names, no CPF/CNPJ of people, no document text; the
  default percentages repeat `DEFAULT_ORGANIZATION_SETTINGS` (the test fails if they diverge).
- Row-level security in Power BI: the RLS role (default `AcessoPraetor`) filters `bi.acesso[user_key] =
  USERNAME()`; the embed token carries `biUserKey(userId)`. An access change reaches the dataset only with the
  next refresh (triggers: import committed or undone, competência closed, court sync with news, access change,
  schedule, manual).
- Secrets: `POWERBI_CLIENT_SECRET` and the Entra ID token never leave the server; nothing about Power BI is
  stored in the database except ids, report names and run messages.
