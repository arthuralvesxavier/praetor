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
