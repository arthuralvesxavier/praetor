/**
 * Importação da planilha da carteira (RF-02, RN-01, RN-03, RN-08, RN-09, RNF-04).
 *
 *   analyzeImport  → lê o arquivo, guarda o original no storage, grava o lote
 *                    (`import_batches`, status "analyzed") e cada linha com a
 *                    normalização, as inconsistências e a ação prevista.
 *   commitImport   → recalcula o plano contra a base ATUAL e grava processos,
 *                    partes, vínculos de instância e valorações numa transação.
 *                    Reimportar o mesmo arquivo não duplica nada (RNF-04).
 *                    Com "distribuir após confirmar", enfileira na mesma
 *                    transação o job `import.distribute` (dedupe
 *                    `import.distribute:<lote>`), que distribui os processos
 *                    novos em blocos, com progresso auditado por bloco.
 *   rollbackImport → desfaz um lote confirmado quando os processos não foram
 *                    alterados depois da importação nem entraram numa
 *                    competência fechada; recalcula os espelhos de valores.
 *   resumeImportDistribution → enfileira de novo a distribuição que parou no
 *                    meio (retoma do último bloco registrado).
 *
 * Organization-level and permission-gated (`import:run`). Never logs or audits
 * cell contents: the audit trail records counts only.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { cnjDigits, normalizeCnj } from "@/domain/cnj";
import type { ImportBatchStatus, ImportRowAction, IssueLevel, ProcessInstance } from "@/domain/enums";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import { formatNumber, todayISO } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import { loadSettings, syncProcessMirrors } from "@/modules/contingency/internal";
import { assertCompanyInOrg } from "@/modules/organization/service";
import { systemContext, type AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  auditLogs,
  caseBriefs,
  caseIntakes,
  comments,
  companies,
  deadlines,
  documents,
  hearings,
  importBatches,
  importRows,
  jobs,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processEvents,
  processGuarantees,
  processInstances,
  processParties,
  processRiskAssessments,
  processValuations,
  settlements,
  tasks,
  units,
  users,
  type ImportIssue,
  type ImportMapping,
  type ImportSheetSummary,
  type ImportStats,
} from "@/server/db/schema";
import { buildStorageKey, getStorage } from "@/server/integrations/storage";
import { enqueueJob } from "@/server/jobs/queue";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "@/server/services/audit";
import {
  parseWorkbook,
  type BaseDateHint,
  type NormalizedRow,
  type ParsedIssue,
  type ParsedRow,
} from "./parser";
import {
  buildImportPlan,
  rowKey,
  withoutLegacyPhase,
  type Divergence,
  type ExistingProcess,
  type ImportPlan,
  type InstanceValues,
  type PlanRow,
  type ProcessFieldValues,
} from "./plan";
import {
  analyzeImportSchema,
  commitImportSchema,
  listImportIssuesSchema,
  listImportRowsSchema,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_MB,
  type CommitImportInput,
  type ListImportIssuesFilters,
  type ListImportRowsFilters,
} from "./schemas";
import { bulkUpdateById, type RowChanges } from "./bulk-update";
import { MAX_IMPORT_ROWS, MAX_IMPORT_UNCOMPRESSED_MB } from "./limits";
import { readWorkbook, UnreadableWorkbookError } from "./xlsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UploadedFile = { name: string; bytes: Uint8Array };

export type AnalyzeImportInput = {
  file: UploadedFile;
  companyId: string;
  defaultUnitId?: string | null;
  /** "YYYY-MM-DD"; when empty the date suggested by the file (if any) is used. */
  baseDate?: string | null;
  distributeAfterCommit?: boolean;
};

/** `import_batches.mapping` as stored by this module (the schema type plus the base date choice). */
export type StoredMapping = ImportMapping & {
  baseDate?: string | null;
  baseDateSource?: "user" | "file" | null;
  baseDateHint?: BaseDateHint | null;
  clientName?: string | null;
};

/** Content of `import_rows.normalized`. */
export type StoredRow = {
  kind: "data" | "total";
  sheetRole: "consolidated" | "instance";
  sheetInstance: ProcessInstance | null;
  error: boolean;
  data: NormalizedRow | null;
  /** Issues found by the parser (the `issues` column = these + the plan issues). */
  baseIssues: ParsedIssue[];
  divergences: Divergence[];
};

/** `import_rows.before` (kept on the main line of a process changed by the import; used by rollback). */
export type BeforeState = {
  process?: Partial<ProcessFieldValues>;
  instances?: Record<string, Partial<InstanceValues>>;
};

/**
 * Post-commit distribution of the processes created by a batch (stored as the
 * metadata of the `import_batch.distribute` audit, one entry per chunk).
 * `assigned` counts every process of the batch that has a responsible;
 * `attempted` = assigned + processes left without one in this run.
 */
export type DistributionSummary = {
  attempted: number;
  assigned: number;
  failed: number;
  failures: { processId: string; number: string; message: string }[];
  /** App clock of the last chunk written (rollback boundary). */
  completedAt: string;
  /** false while chunks are still pending (an interrupted run stays false). Absent (older single entries) = done. */
  done?: boolean;
  /** Processes of this run not processed yet when the entry was written. */
  remaining?: number;
};

/**
 * "running" = the `import.distribute` job is queued or running; "interrupted" =
 * stopped before the end with no job pending (resume with `resumeImportDistribution`).
 */
export type DistributionState = "none" | "running" | "interrupted" | "done";

export type CommitImportResult = {
  created: number;
  updated: number;
  unchanged: number;
  instancesCreated: number;
  valuationsOfficial: number;
  valuationsProposed: number;
  /**
   * Always null: the post-commit distribution runs in the `import.distribute`
   * job (see `distributionQueued`); read its progress with `getImportBatch`.
   */
  distribution: DistributionSummary | null;
  /** The `import.distribute` job was enqueued in the commit transaction. */
  distributionQueued: boolean;
};

/** Result of `resumeImportDistribution`: the job that finishes the distribution. */
export type ResumeDistributionResult = { jobId: string; deduplicated: boolean };

export type ImportBatchListItem = {
  id: string;
  fileName: string;
  companyName: string | null;
  status: ImportBatchStatus;
  stats: ImportStats | null;
  createdByName: string | null;
  createdAt: Date;
  committedAt: Date | null;
  rolledBackAt: Date | null;
};

export type IssueSummaryItem = { level: IssueLevel; code: string; rows: number };

export type ImportBatchDetail = ImportBatchListItem & {
  fileSha256: string;
  sizeBytes: number;
  companyId: string | null;
  defaultUnitId: string | null;
  defaultUnitName: string | null;
  sheets: ImportSheetSummary[];
  /** sheet -> canonical field -> header found in the file. */
  columnMapping: Record<string, Record<string, string>>;
  baseDate: string | null;
  baseDateSource: "user" | "file" | null;
  baseDateHint: BaseDateHint | null;
  distributeAfterCommit: boolean;
  committedByName: string | null;
  rolledBackByName: string | null;
  hasStoredFile: boolean;
  issueSummary: IssueSummaryItem[];
  /** Rows with at least one issue of each level. */
  levelCounts: Record<IssueLevel, number>;
  /** Rows stored for the batch (data + TOTAL rows). */
  storedRows: number;
  /** Rows with at least one error or warning. */
  problemRows: number;
  sameFileBatches: { id: string; createdAt: Date; status: ImportBatchStatus }[];
  distribution: DistributionSummary | null;
  distributionState: DistributionState;
  /** Data sheets in file order (filters). */
  dataSheets: string[];
};

export type ImportRowListItem = {
  id: string;
  sheet: string;
  rowNumber: number;
  cnj: string | null;
  cnjValid: boolean;
  action: ImportRowAction;
  kind: "data" | "total";
  instance: ProcessInstance | null;
  court: string | null;
  phaseDetail: string | null;
  /** The sheet of the row has a "valor liquidado" column. */
  hasLiquidatedColumn: boolean;
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  city: string | null;
  state: string | null;
  issues: ImportIssue[];
  processId: string | null;
};

export type ImportIssueListItem = {
  rowId: string;
  sheet: string;
  rowNumber: number;
  cnj: string | null;
  processId: string | null;
  level: IssueLevel;
  code: string;
  field: string | null;
  message: string;
};

export type ImportDivergenceListItem = Divergence & { rowId: string; processId: string | null };

export type RollbackBlocker = { processId: string; number: string; reasons: string[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHUNK = 250;

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const flat = z.flattenError(r.error) as { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(flat.fieldErrors)) if (v && v.length) fieldErrors[k] = v;
    throw new ValidationError(flat.formErrors[0] ?? Object.values(fieldErrors)[0]?.[0] ?? "Verifique os campos informados.", fieldErrors);
  }
  return r.data;
}

const idSchema = z.guid();
function parseId(id: string): string {
  const r = idSchema.safeParse(id);
  if (!r.success) throw new NotFoundError();
  return r.data;
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Rows of a raw `execute()` result (node-postgres and PGlite both expose `.rows`). */
function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function fileError(message: string): ValidationError {
  return new ValidationError(message, { file: [message] });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function batchScope(ctx: AuthContext, id: string): SQL {
  return and(eq(importBatches.id, id), eq(importBatches.organizationId, ctx.organizationId)) as SQL;
}

async function loadBatchRow(ctx: AuthContext, id: string, db: DbOrTx = getDb()) {
  const [batch] = await db.select().from(importBatches).where(batchScope(ctx, parseId(id)));
  if (!batch) throw new NotFoundError("Importação não encontrada.");
  return batch;
}

function storedMapping(batch: { mapping: ImportMapping | null }): StoredMapping {
  return (batch.mapping ?? {
    sheets: {},
    companyId: null,
    defaultUnitId: null,
    unitByState: {},
    distributeAfterCommit: false,
  }) as StoredMapping;
}

function toPlanRow(row: { sheet: string; rowNumber: number; normalized: Record<string, unknown> | null }): PlanRow {
  const stored = (row.normalized ?? {}) as Partial<StoredRow>;
  return {
    sheet: row.sheet,
    rowNumber: row.rowNumber,
    sheetRole: stored.sheetRole ?? "consolidated",
    kind: stored.kind ?? "data",
    error: stored.error ?? true,
    data: stored.data ?? null,
  };
}

/** Existing (not deleted) processes of the organization whose number has the same 20 digits. */
async function loadExistingProcesses(db: DbOrTx, organizationId: string, cnjs: readonly string[]): Promise<Map<string, ExistingProcess>> {
  const result = new Map<string, ExistingProcess>();
  const digits = [...new Set(cnjs.map((c) => cnjDigits(c)))];
  const numberDigits = sql<string>`regexp_replace(${legalProcesses.number}, '[^0-9]', '', 'g')`;
  for (const part of chunks(digits, 500)) {
    const rows = await db
      .select({
        id: legalProcesses.id,
        number: legalProcesses.number,
        court: legalProcesses.court,
        instance: legalProcesses.instance,
        courtDivision: legalProcesses.courtDivision,
        processClass: legalProcesses.processClass,
        city: legalProcesses.city,
        state: legalProcesses.state,
        phase: legalProcesses.phase,
        status: legalProcesses.status,
        closureReason: legalProcesses.closureReason,
        closedAt: legalProcesses.closedAt,
        needsVerification: legalProcesses.needsVerification,
        verificationNote: legalProcesses.verificationNote,
        phaseDetail: legalProcesses.phaseDetail,
        companyId: legalProcesses.companyId,
        unitId: legalProcesses.unitId,
        claimAmountCents: legalProcesses.claimAmountCents,
        liquidatedAmountCents: legalProcesses.liquidatedAmountCents,
      })
      .from(legalProcesses)
      .where(
        and(eq(legalProcesses.organizationId, organizationId), isNull(legalProcesses.deletedAt), inArray(numberDigits, part)),
      )
      .orderBy(asc(legalProcesses.createdAt));
    for (const r of rows) {
      const key = normalizeCnj(r.number);
      if (key && !result.has(key)) result.set(key, { ...r, instances: [] });
    }
  }
  const byId = new Map([...result.values()].map((p) => [p.id, p]));
  for (const part of chunks([...byId.keys()], 500)) {
    const inst = await db
      .select({
        id: processInstances.id,
        processId: processInstances.processId,
        instance: processInstances.instance,
        court: processInstances.court,
        courtDivision: processInstances.courtDivision,
        city: processInstances.city,
        state: processInstances.state,
        processClass: processInstances.processClass,
        phase: processInstances.phase,
        phaseDetail: processInstances.phaseDetail,
        claimAmountCents: processInstances.claimAmountCents,
        liquidatedAmountCents: processInstances.liquidatedAmountCents,
        isCurrent: processInstances.isCurrent,
      })
      .from(processInstances)
      .where(and(eq(processInstances.organizationId, organizationId), inArray(processInstances.processId, part)));
    for (const { processId, ...i } of inst) byId.get(processId)?.instances.push(i);
  }
  return result;
}

/** process id -> "kind:amountCents" of every valuation already recorded (any status). */
async function loadValuationKeys(db: DbOrTx, organizationId: string, processIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  for (const part of chunks(processIds, 500)) {
    const rows = await db
      .select({ processId: processValuations.processId, kind: processValuations.kind, amountCents: processValuations.amountCents })
      .from(processValuations)
      .where(and(eq(processValuations.organizationId, organizationId), inArray(processValuations.processId, part)));
    for (const r of rows) {
      if (!map.has(r.processId)) map.set(r.processId, new Set());
      map.get(r.processId)!.add(`${r.kind}:${r.amountCents}`);
    }
  }
  return map;
}

async function planFor(
  db: DbOrTx,
  organizationId: string,
  rows: readonly PlanRow[],
  opts: { companyId: string | null; defaultUnitId: string | null; fileName: string; baseDate: string | null },
): Promise<ImportPlan> {
  const cnjs = [...new Set(rows.map((r) => r.data?.cnj).filter((c): c is string => !!c))];
  const existing = await loadExistingProcesses(db, organizationId, cnjs);
  const valuationKeys = await loadValuationKeys(db, organizationId, [...existing.values()].map((p) => p.id));
  return buildImportPlan({ rows, existing, existingValuationKeys: valuationKeys, ...opts });
}

function rowIssues(baseIssues: readonly ParsedIssue[], planIssues: readonly ParsedIssue[]): ImportIssue[] {
  return [...baseIssues, ...planIssues];
}

function withWarnings(stats: ImportStats, rowsIssues: readonly (readonly ImportIssue[])[]): ImportStats {
  return { ...stats, warnings: rowsIssues.filter((issues) => issues.some((i) => i.level === "warning")).length };
}

async function assertUnitInOrg(ctx: AuthContext, unitId: string): Promise<void> {
  const [u] = await getDb()
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.id, unitId), eq(units.organizationId, ctx.organizationId)));
  if (!u) throw new ValidationError("Unidade inválida.", { defaultUnitId: ["Selecione uma unidade da organização."] });
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

/** Reads, normalizes and stores an import batch (nothing is written to the portfolio). */
export async function analyzeImport(ctx: AuthContext, input: AnalyzeImportInput): Promise<{ batchId: string }> {
  assertCan(ctx, "import:run");
  const data = parseOrThrow(analyzeImportSchema, {
    fileName: input.file?.name,
    companyId: input.companyId,
    defaultUnitId: input.defaultUnitId ?? null,
    baseDate: input.baseDate ?? null,
    distributeAfterCommit: input.distributeAfterCommit ?? false,
  });
  const bytes = input.file.bytes;
  if (!bytes || bytes.byteLength === 0) throw fileError("O arquivo está vazio.");
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw fileError(`O arquivo excede o limite de ${MAX_IMPORT_MB} MB.`);
  if (data.baseDate && data.baseDate > todayISO()) {
    throw new ValidationError("A data-base não pode ser futura.", { baseDate: ["A data-base não pode ser futura."] });
  }

  await assertCompanyInOrg(ctx, data.companyId);
  if (data.defaultUnitId) await assertUnitInOrg(ctx, data.defaultUnitId);
  const [company] = await getDb()
    .select({ name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, data.companyId), eq(companies.organizationId, ctx.organizationId)));

  let rawSheets;
  try {
    rawSheets = await readWorkbook(bytes);
  } catch (err) {
    if (err instanceof UnreadableWorkbookError) {
      throw fileError(
        (err as { reason?: string }).reason === "too_large"
          ? `A planilha descompactada é grande demais (limite de ${MAX_IMPORT_UNCOMPRESSED_MB} MB). Divida o arquivo.`
          : "Não foi possível ler a planilha. Envie um arquivo .xlsx válido (Excel 2007 ou posterior).",
      );
    }
    throw err;
  }

  const workbook = parseWorkbook(rawSheets, { clientName: company?.name ?? null });
  if (!workbook.rows.some((r) => r.kind === "data")) {
    throw fileError(
      "Nenhuma linha de processo foi encontrada. Confira se a planilha tem uma aba com a coluna “Nº do Processo” no cabeçalho.",
    );
  }
  if (workbook.rows.length > MAX_IMPORT_ROWS) {
    throw fileError(
      `A planilha tem ${formatNumber(workbook.rows.length)} linhas de dados; o limite por importação é de ${formatNumber(MAX_IMPORT_ROWS)} linhas. Divida o arquivo.`,
    );
  }

  const baseDate = data.baseDate ?? workbook.baseDateHint?.date ?? null;
  const plan = await planFor(getDb(), ctx.organizationId, workbook.rows, {
    companyId: data.companyId,
    defaultUnitId: data.defaultUnitId,
    fileName: data.fileName,
    baseDate,
  });

  const records = workbook.rows.map((row) => buildRowRecord(row, plan));
  const stats = withWarnings(plan.stats, records.map((r) => r.issues));
  const mapping: StoredMapping = {
    sheets: Object.fromEntries(workbook.sheets.map((s) => [s.name, s.mapping as Record<string, string>])),
    companyId: data.companyId,
    defaultUnitId: data.defaultUnitId,
    unitByState: {},
    distributeAfterCommit: data.distributeAfterCommit,
    baseDate,
    baseDateSource: data.baseDate ? "user" : workbook.baseDateHint ? "file" : null,
    baseDateHint: workbook.baseDateHint,
    clientName: company?.name ?? null,
  };
  const sheets: ImportSheetSummary[] = workbook.sheets.map((s) => ({
    name: s.name,
    role: s.role,
    instance: s.instance,
    headerRow: s.headerRow,
    rowCount: s.rowCount,
    note: s.note,
  }));

  const batchId = randomUUID();
  const storageKey = buildStorageKey(ctx.organizationId, batchId, randomUUID());
  const storage = getStorage();
  await storage.put(storageKey, bytes);

  try {
    await getDb().transaction(async (tx) => {
      await tx.insert(importBatches).values({
        id: batchId,
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        defaultUnitId: data.defaultUnitId,
        fileName: data.fileName,
        fileSha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        storageKey,
        status: "analyzed",
        sheets,
        mapping,
        stats,
        createdById: ctx.userId,
      });
      for (const part of chunks(records)) {
        await tx.insert(importRows).values(
          part.map((r) => ({
            organizationId: ctx.organizationId,
            batchId,
            sheet: r.sheet,
            rowNumber: r.rowNumber,
            cnj: r.cnj,
            cnjValid: r.cnjValid,
            action: r.action,
            issues: r.issues,
            raw: r.raw,
            normalized: r.normalized as unknown as Record<string, unknown>,
            processId: r.processId,
          })),
        );
      }
      await recordAudit(
        ctx,
        {
          action: "import_batch.analyze",
          entityType: "import_batch",
          entityId: batchId,
          summary: `Planilha analisada: ${stats.rowsRead} linhas, ${stats.processesDetected} processos detectados`,
          metadata: {
            rowsRead: stats.rowsRead,
            processesDetected: stats.processesDetected,
            toCreate: stats.toCreate,
            toUpdate: stats.toUpdate,
            errors: stats.errors,
            sizeBytes: bytes.byteLength,
          },
        },
        tx,
      );
    });
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    throw err;
  }

  return { batchId };
}

type RowRecord = {
  sheet: string;
  rowNumber: number;
  cnj: string | null;
  cnjValid: boolean;
  action: ImportRowAction;
  issues: ImportIssue[];
  raw: Record<string, unknown>;
  normalized: StoredRow;
  processId: string | null;
};

function buildRowRecord(row: ParsedRow, plan: ImportPlan): RowRecord {
  const outcome = plan.outcomes.get(rowKey(row.sheet, row.rowNumber));
  const normalized: StoredRow = {
    kind: row.kind,
    sheetRole: row.sheetRole,
    sheetInstance: row.sheetInstance,
    error: row.error,
    data: row.data,
    baseIssues: row.issues,
    divergences: outcome?.divergences ?? [],
  };
  return {
    sheet: row.sheet,
    rowNumber: row.rowNumber,
    cnj: row.data?.cnj ?? row.data?.cnjRaw?.slice(0, 60) ?? null,
    cnjValid: row.data?.cnjValid ?? false,
    action: outcome?.action ?? (row.kind === "total" ? "skip" : "error"),
    issues: rowIssues(row.issues, outcome?.issues ?? []),
    raw: row.raw,
    normalized,
    processId: outcome?.existingProcessId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * Confirms an analyzed batch: recomputes the plan against the current base and
 * writes everything in one transaction. Requires the base date of the values.
 */
export async function commitImport(ctx: AuthContext, batchId: string, input: CommitImportInput): Promise<CommitImportResult> {
  assertCan(ctx, "import:run");
  const id = parseId(batchId);
  const data = parseOrThrow(commitImportSchema, input);
  if (data.baseDate > todayISO()) {
    throw new ValidationError("A data-base não pode ser futura.", { baseDate: ["A data-base não pode ser futura."] });
  }

  let result: Omit<CommitImportResult, "distribution" | "distributionQueued">;
  let distribute = false;

  try {
    ({ result, distribute } = await getDb().transaction(async (tx) => {
      const [batch] = await tx.select().from(importBatches).where(batchScope(ctx, id)).for("update");
      if (!batch) throw new NotFoundError("Importação não encontrada.");
      if (batch.status !== "analyzed") {
        throw new ConflictError(
          batch.status === "committed"
            ? "Esta importação já foi confirmada."
            : "Esta importação não pode mais ser confirmada (foi desfeita ou falhou). Envie a planilha novamente.",
        );
      }
      const mapping = storedMapping(batch);
      if (batch.companyId) await assertCompanyInOrg(ctx, batch.companyId, tx);

      const rows = await tx
        .select({ id: importRows.id, sheet: importRows.sheet, rowNumber: importRows.rowNumber, normalized: importRows.normalized })
        .from(importRows)
        .where(and(eq(importRows.batchId, batch.id), eq(importRows.organizationId, ctx.organizationId)))
        .orderBy(sheetOrder(batch.sheets.map((s) => s.name), importRows.sheet), asc(importRows.rowNumber));
      const planRows = rows.map(toPlanRow);
      const plan = await planFor(tx, ctx.organizationId, planRows, {
        companyId: batch.companyId,
        defaultUnitId: batch.defaultUnitId,
        fileName: batch.fileName,
        baseDate: data.baseDate,
      });

      const now = new Date();
      const processIdByCnj = new Map<string, string>();

      // 1. New processes, parties and instance links.
      const toCreate = plan.processes.filter((p) => p.action === "create");
      for (const p of toCreate) processIdByCnj.set(p.cnj, randomUUID());
      for (const part of chunks(toCreate)) {
        await tx.insert(legalProcesses).values(
          part.map((p) => ({
            id: processIdByCnj.get(p.cnj)!,
            organizationId: ctx.organizationId,
            number: p.cnj,
            title: p.target.title,
            court: p.target.court,
            courtDivision: p.target.courtDivision,
            area: p.target.area,
            phase: p.target.phase,
            status: p.target.status,
            unitId: p.target.unitId,
            companyId: p.target.companyId,
            instance: p.target.instance,
            processClass: p.target.processClass,
            city: p.target.city,
            state: p.target.state,
            phaseDetail: p.target.phaseDetail,
            claimAmountCents: p.target.claimAmountCents,
            liquidatedAmountCents: p.target.liquidatedAmountCents,
            closedAt: p.target.closedAt,
            closureReason: p.target.closureReason,
            needsVerification: p.target.needsVerification,
            verificationNote: p.target.verificationNote,
            dataOrigin: "imported" as const,
            externalSource: p.target.externalSource,
            importedAt: now,
            importBatchId: batch.id,
            createdById: ctx.userId,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
      const parties = toCreate.flatMap((p) =>
        p.parties.map((party) => ({
          organizationId: ctx.organizationId,
          processId: processIdByCnj.get(p.cnj)!,
          name: party.name,
          role: party.role,
          isClient: party.isClient,
        })),
      );
      for (const part of chunks(parties)) await tx.insert(processParties).values(part);

      // 2. Existing processes: field changes (before-state kept for rollback), written set-based.
      const beforeByRow = new Map<string, BeforeState>();
      const updatedIds: string[] = [];
      const mirrorIds: string[] = [];
      const processUpdates: RowChanges[] = [];
      const instanceUpdates: RowChanges[] = [];
      for (const p of plan.processes) {
        if (!p.existingId) continue;
        processIdByCnj.set(p.cnj, p.existingId);
        if (p.action !== "update") continue;
        updatedIds.push(p.existingId);
        // Money mirrors (provision etc.) are recomputed when an official value or a money field changes.
        if ("claimAmountCents" in p.changes || "liquidatedAmountCents" in p.changes || p.valuations.some((v) => v.status === "official")) {
          mirrorIds.push(p.existingId);
        }
        const before: BeforeState = {};
        if (Object.keys(p.changes).length > 0) {
          processUpdates.push({ id: p.existingId, changes: p.changes });
          before.process = p.before ?? {};
        }
        const instBefore: Record<string, Partial<InstanceValues>> = {};
        for (const inst of p.instances) {
          if (inst.action !== "update" || !inst.existingId) continue;
          instanceUpdates.push({ id: inst.existingId, changes: inst.changes });
          instBefore[inst.existingId] = inst.before ?? {};
        }
        for (const c of p.clearCurrent) {
          instanceUpdates.push({ id: c.id, changes: { isCurrent: false } });
          instBefore[c.id] = c.before;
        }
        if (Object.keys(instBefore).length > 0) before.instances = instBefore;
        if (before.process || before.instances) beforeByRow.set(p.primaryRowKey, before);
      }
      await bulkUpdateById(tx, legalProcesses, processUpdates, {
        where: eq(legalProcesses.organizationId, ctx.organizationId),
        updatedAt: now,
      });
      await bulkUpdateById(tx, processInstances, instanceUpdates, {
        where: eq(processInstances.organizationId, ctx.organizationId),
        updatedAt: now,
      });

      // 3. New instance links (new and existing processes).
      const newInstances = plan.processes.flatMap((p) =>
        p.instances
          .filter((i) => i.action === "create")
          .map((i) => ({
            organizationId: ctx.organizationId,
            processId: processIdByCnj.get(p.cnj)!,
            instance: i.instance,
            ...i.values,
            origin: "imported" as const,
            importBatchId: batch.id,
            sourceSheet: i.sheet,
            sourceRow: i.rowNumber,
          })),
      );
      for (const part of chunks(newInstances)) await tx.insert(processInstances).values(part);

      // 4. Valuations: official initial values (reviewer = whoever confirms) and proposed divergences (RN-08/RN-11).
      const valuations = plan.processes.flatMap((p) =>
        p.valuations.map((v) => ({
          organizationId: ctx.organizationId,
          processId: processIdByCnj.get(p.cnj)!,
          kind: v.kind,
          amountCents: v.amountCents,
          baseDate: data.baseDate,
          instance: v.instance,
          source: "spreadsheet" as const,
          status: v.status,
          isEstimate: false,
          reason: v.reason,
          importBatchId: batch.id,
          createdById: ctx.userId,
          reviewedById: v.status === "official" ? ctx.userId : null,
          reviewedAt: v.status === "official" ? now : null,
        })),
      );
      for (const part of chunks(valuations)) await tx.insert(processValuations).values(part);

      // Denormalized mirrors (provisionAmountCents...) of existing processes whose official values changed.
      // New processes need no resync: their claim/liquidated mirrors are the official values just written
      // and they have no risk assessment or guarantee yet, so their provision stays unknown (null).
      if (mirrorIds.length > 0) {
        const settings = await loadSettings(ctx.organizationId, tx);
        for (const pid of mirrorIds) await syncProcessMirrors(ctx.organizationId, pid, tx, settings);
      }

      for (const pid of updatedIds) {
        await markAnalysesStaleForEntity(
          { organizationId: ctx.organizationId, entityId: pid, reason: "Processo atualizado por importação de planilha." },
          tx,
        );
      }

      // 5. Rows: final action, process link, issues and before-state.
      const rowUpdates = rows.map((r) => {
        const key = rowKey(r.sheet, r.rowNumber);
        const outcome = plan.outcomes.get(key);
        const stored = (r.normalized ?? {}) as Partial<StoredRow>;
        const normalized: StoredRow = {
          kind: stored.kind ?? "data",
          sheetRole: stored.sheetRole ?? "consolidated",
          sheetInstance: stored.sheetInstance ?? null,
          error: stored.error ?? true,
          data: stored.data ?? null,
          baseIssues: stored.baseIssues ?? [],
          divergences: outcome?.divergences ?? [],
        };
        const cnj = stored.data?.cnj ?? null;
        return {
          id: r.id,
          action: outcome?.action ?? (normalized.kind === "total" ? "skip" : "error"),
          processId: cnj ? (processIdByCnj.get(cnj) ?? null) : null,
          before: beforeByRow.get(key) ?? null,
          issues: rowIssues(normalized.baseIssues, outcome?.issues ?? []),
          normalized,
        };
      });
      for (const part of chunks(rowUpdates, 200)) {
        const values = sql.join(
          part.map(
            (u) =>
              sql`(${u.id}, ${u.action}, ${u.processId}, ${u.before ? JSON.stringify(u.before) : null}, ${JSON.stringify(u.issues)}, ${JSON.stringify(u.normalized)})`,
          ),
          sql`, `,
        );
        await tx.execute(sql`
          update import_rows set
            "action" = v.action,
            "process_id" = v.process_id::uuid,
            "before" = v.before::jsonb,
            "issues" = v.issues::jsonb,
            "normalized" = v.normalized::jsonb
          from (values ${values}) as v(id, action, process_id, before, issues, normalized)
          where import_rows.id = v.id::uuid and import_rows.batch_id = ${batch.id}`);
      }

      const stats = withWarnings(plan.stats, rowUpdates.map((r) => r.issues));
      const official = valuations.filter((v) => v.status === "official").length;
      const counts = {
        created: toCreate.length,
        updated: updatedIds.length,
        unchanged: plan.stats.unchanged,
        instancesCreated: newInstances.length,
        valuationsOfficial: official,
        valuationsProposed: valuations.length - official,
      };
      const distributeAfterCommit = data.distributeAfterCommit ?? mapping.distributeAfterCommit ?? false;
      await tx
        .update(importBatches)
        .set({
          status: "committed",
          stats,
          mapping: { ...mapping, baseDate: data.baseDate, baseDateSource: "user", distributeAfterCommit } as StoredMapping,
          committedById: ctx.userId,
          committedAt: new Date(),
        })
        .where(eq(importBatches.id, batch.id));
      await recordAudit(
        ctx,
        {
          action: "import_batch.commit",
          entityType: "import_batch",
          entityId: batch.id,
          summary: `Importação confirmada: ${counts.created} novos, ${counts.updated} atualizados, ${counts.unchanged} sem alteração`,
          metadata: { ...counts, rows: rows.length, baseDate: data.baseDate },
        },
        tx,
      );
      // The distribution of the new processes runs in the background (chunked, resumable); the
      // job is enqueued with the commit so it exists exactly when the commit does.
      if (distributeAfterCommit) await enqueueDistributionJob(ctx.organizationId, batch.id, tx);
      return { result: counts, distribute: distributeAfterCommit };
    }));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        "Um processo com o mesmo número foi cadastrado enquanto a importação era gravada. Nada foi importado. Tente confirmar novamente.",
      );
    }
    throw err;
  }

  return { ...result, distribution: null, distributionQueued: distribute };
}

/** Pending (queued/running) distribution job of a batch: at most one, by the dedupe key. */
function distributionJobKey(batchId: string): string {
  return `import.distribute:${batchId}`;
}

async function enqueueDistributionJob(organizationId: string, batchId: string, db: DbOrTx = getDb()) {
  return enqueueJob(
    { type: "import.distribute", organizationId, payload: { batchId }, dedupeKey: distributionJobKey(batchId), maxAttempts: 5 },
    db,
  );
}

async function hasPendingDistributionJob(organizationId: string, batchId: string): Promise<boolean> {
  const [job] = await getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.dedupeKey, distributionJobKey(batchId)),
        inArray(jobs.status, ["queued", "running"]),
        eq(jobs.organizationId, organizationId),
      ),
    )
    .limit(1);
  return !!job;
}

/** Processes per distribution chunk; a progress entry (rollback boundary) is written after each one. */
export const IMPORT_DISTRIBUTION_CHUNK = 100;
const MAX_LISTED_FAILURES = 50;

/**
 * Body of the `import.distribute` job (src/server/jobs/handlers.ts): distributes
 * the processes created by a committed batch that are still without a
 * responsible, as the system ("Sistema" in the audit trail). Idempotent: a
 * batch that was undone, confirmed without distribution or already fully
 * distributed is left as is. When the run stops before the end (e.g. the
 * database went away while a progress entry was written) it throws, so the
 * queue retries it with backoff; the retry resumes from the last chunk
 * recorded, because processes that already have a responsible are skipped.
 */
export async function runImportDistributionJob(organizationId: string, batchId: string): Promise<DistributionSummary | null> {
  const [batch] = await getDb()
    .select({ id: importBatches.id, status: importBatches.status, mapping: importBatches.mapping })
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.organizationId, organizationId)));
  if (!batch) {
    logger.warn("import_distribution_batch_missing", { batchId });
    return null;
  }
  if (batch.status !== "committed" || !storedMapping(batch).distributeAfterCommit) return null;
  const last = await latestDistribution(organizationId, batch.id);
  if (last && last.summary.done !== false) return last.summary;
  const org = await loadOrganization(organizationId);
  const summary = await runImportDistribution(systemContext(organizationId, org.isDemo), batch.id);
  if (summary.done === false && !summary.stopped) throw new ImportDistributionInterruptedError();
  return summary;
}

/** Retryable failure of the `import.distribute` job (the next attempt resumes the distribution). */
class ImportDistributionInterruptedError extends Error {
  readonly retryable = true;
  constructor() {
    super("import_distribution_interrupted");
    this.name = "ImportDistributionInterruptedError";
  }
}

/**
 * Runs the distribution rules for the processes created by the batch that are
 * still without a responsible (errors are reported per process, never thrown).
 * Resumable: processes that already have a responsible are skipped, and after
 * every chunk an `import_batch.distribute` entry records the progress, so the
 * rollback boundary always covers the assignments already made. If the run is
 * interrupted, the last entry stays `done: false` and the job retry (or
 * `resumeImportDistribution`) finishes it. Before every chunk the batch must
 * still be committed: a batch undone in the meantime stops the run
 * (`stopped: true`, nothing else is written).
 */
async function runImportDistribution(ctx: AuthContext, batchId: string): Promise<DistributionSummary & { stopped?: boolean }> {
  const scope = and(
    eq(legalProcesses.organizationId, ctx.organizationId),
    eq(legalProcesses.importBatchId, batchId),
    isNull(legalProcesses.deletedAt),
  );
  const [pending, [{ alreadyAssigned }]] = await Promise.all([
    getDb()
      .select({ id: legalProcesses.id, number: legalProcesses.number })
      .from(legalProcesses)
      .where(and(scope, isNull(legalProcesses.responsibleId)))
      .orderBy(asc(legalProcesses.number), asc(legalProcesses.id)),
    getDb()
      .select({ alreadyAssigned: count() })
      .from(legalProcesses)
      .where(and(scope, isNotNull(legalProcesses.responsibleId))),
  ]);
  const summary: DistributionSummary = {
    attempted: alreadyAssigned,
    assigned: alreadyAssigned,
    failed: 0,
    failures: [],
    completedAt: "",
    done: pending.length === 0,
    remaining: pending.length,
  };
  const writeProgress = async () => {
    summary.completedAt = new Date().toISOString();
    const total = summary.attempted + (summary.remaining ?? 0);
    await recordAudit(ctx, {
      action: "import_batch.distribute",
      entityType: "import_batch",
      entityId: batchId,
      summary: summary.done
        ? `Distribuição após importação: ${summary.assigned} atribuídos, ${summary.failed} sem atribuição`
        : `Distribuição após importação em andamento: ${summary.attempted} de ${total} processos (${summary.assigned} atribuídos, ${summary.failed} sem atribuição)`,
      metadata: { ...summary, failures: [...summary.failures] } as unknown as Record<string, unknown>,
    });
  };

  try {
    if (pending.length === 0) {
      await writeProgress();
      return summary;
    }
    const { assignResponsible } = await import("@/modules/distribution/service");
    for (const part of chunks(pending, IMPORT_DISTRIBUTION_CHUNK)) {
      if (!(await isBatchCommitted(ctx.organizationId, batchId))) {
        // Undone while the distribution ran: its processes are gone, nothing else to assign or record.
        logger.info("import_distribution_stopped", { batchId });
        return { ...summary, done: false, stopped: true };
      }
      for (const p of part) {
        summary.attempted += 1;
        try {
          const decision = await assignResponsible(ctx, p.id, {});
          if (decision.userId) summary.assigned += 1;
          else {
            summary.failed += 1;
            if (summary.failures.length < MAX_LISTED_FAILURES) {
              summary.failures.push({ processId: p.id, number: p.number, message: decision.reason || "Nenhum responsável elegível." });
            }
          }
        } catch (err) {
          summary.failed += 1;
          const message = err instanceof AppError ? err.message : "Falha inesperada ao aplicar as regras de distribuição.";
          if (!(err instanceof AppError)) {
            logger.warn("import_distribution_failed", { batchId, processId: p.id, errorName: err instanceof Error ? err.name : "unknown" });
          }
          if (summary.failures.length < MAX_LISTED_FAILURES) summary.failures.push({ processId: p.id, number: p.number, message });
        }
      }
      summary.remaining = (summary.remaining ?? 0) - part.length;
      summary.done = summary.remaining === 0;
      await writeProgress();
    }
  } catch (err) {
    // The batch stays committed; the last progress entry (done: false) is the rollback boundary
    // and the batch page offers to resume the distribution.
    logger.warn("import_distribution_interrupted", { batchId, errorName: err instanceof Error ? err.name : "unknown" });
    return { ...summary, done: false };
  }
  return summary;
}

async function isBatchCommitted(organizationId: string, batchId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ status: importBatches.status })
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.organizationId, organizationId)));
  return row?.status === "committed";
}

/**
 * Resumes the post-commit distribution of a batch whose run stopped before the
 * end: enqueues the `import.distribute` job again (deduplicated while one is
 * pending), which applies the rules to the processes still without a
 * responsible (the ones already assigned are kept). Requires `import:run`.
 */
export async function resumeImportDistribution(ctx: AuthContext, batchId: string): Promise<ResumeDistributionResult> {
  assertCan(ctx, "import:run");
  const batch = await loadBatchRow(ctx, batchId);
  if (batch.status !== "committed") {
    throw new ConflictError("Somente importações confirmadas podem ter a distribuição retomada.");
  }
  if (!storedMapping(batch).distributeAfterCommit) {
    throw new ConflictError("Esta importação foi confirmada sem a distribuição automática dos processos novos.");
  }
  const last = await latestDistribution(ctx.organizationId, batch.id);
  if (last && last.summary.done !== false) throw new ConflictError("A distribuição desta importação já foi concluída.");
  const { id, deduplicated } = await enqueueDistributionJob(ctx.organizationId, batch.id);
  return { jobId: id, deduplicated };
}

async function latestDistribution(
  organizationId: string,
  batchId: string,
  db: DbOrTx = getDb(),
): Promise<{ summary: DistributionSummary; createdAt: Date } | null> {
  const [row] = await db
    .select({ metadata: auditLogs.metadata, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.entityType, "import_batch"),
        eq(auditLogs.entityId, batchId),
        eq(auditLogs.action, "import_batch.distribute"),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return row?.metadata ? { summary: row.metadata as unknown as DistributionSummary, createdAt: row.createdAt } : null;
}

/**
 * Distribution state of the batch page. While the `import.distribute` job is
 * queued or running (retries included) the distribution is "running"; once no
 * job is pending, an unfinished distribution is "interrupted" and the page
 * offers to resume it.
 */
function distributionState(
  batch: { status: ImportBatchStatus; committedAt: Date | null },
  distributeAfterCommit: boolean,
  last: { summary: DistributionSummary; createdAt: Date } | null,
  jobPending: boolean,
): DistributionState {
  if (last && last.summary.done !== false) return "done";
  if (batch.status !== "committed") return last ? "interrupted" : "none";
  if (!last && (!distributeAfterCommit || !batch.committedAt)) return "none";
  return jobPending ? "running" : "interrupted";
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

const BLOCKER_REASONS = {
  edited: "alterado depois da importação",
  valuations: "valores lançados ou conferidos depois da importação",
  instances: "vínculos de instância incluídos depois da importação",
  parties: "partes incluídas depois da importação",
  events: "andamentos registrados",
  contingency: "garantias, classificação de risco ou acordos registrados",
  hearings: "audiências registradas",
  documents: "documentos anexados",
  work: "prazos ou tarefas criados",
  briefs: "análise preliminar ou entrada registrada",
  comments: "comentários publicados",
} as const;

/** "2026-09" -> "09/2026". */
function periodLabel(period: string): string {
  const [year, month] = period.split("-");
  return month && year ? `${month}/${year}` : period;
}

type BatchProcesses = {
  /** Processes created by the batch (soft-deleted by the rollback). */
  created: string[];
  /** Existing processes whose fields or instance links the batch changed (before-state restored). */
  updated: { processId: string; rowId: string; before: BeforeState }[];
  /**
   * Every process the batch wrote to: the above plus existing processes that only
   * received valuations (e.g. proposals for a divergent value) or instance links.
   * All of them are checked for later changes before a rollback.
   */
  all: string[];
};

async function batchProcesses(db: DbOrTx, organizationId: string, batchId: string): Promise<BatchProcesses> {
  const rows = await db
    .select({ id: importRows.id, action: importRows.action, processId: importRows.processId, before: importRows.before })
    .from(importRows)
    .where(
      and(
        eq(importRows.batchId, batchId),
        eq(importRows.organizationId, organizationId),
        isNotNull(importRows.processId),
        or(inArray(importRows.action, ["create", "update", "merge_instance"]), isNotNull(importRows.before)),
      ),
    );
  const created = [...new Set(rows.filter((r) => r.action === "create").map((r) => r.processId!))];
  const updated = rows
    .filter((r) => r.action !== "create" && r.before)
    .map((r) => ({ processId: r.processId!, rowId: r.id, before: r.before as BeforeState }));
  const valuationProcesses = await db
    .selectDistinct({ processId: processValuations.processId })
    .from(processValuations)
    .where(and(eq(processValuations.organizationId, organizationId), eq(processValuations.importBatchId, batchId)));
  const instanceProcesses = await db
    .selectDistinct({ processId: processInstances.processId })
    .from(processInstances)
    .where(and(eq(processInstances.organizationId, organizationId), eq(processInstances.importBatchId, batchId)));
  const all = [
    ...new Set([
      ...rows.map((r) => r.processId!),
      ...valuationProcesses.map((v) => v.processId),
      ...instanceProcesses.map((i) => i.processId),
    ]),
  ];
  return { created, updated, all };
}

/**
 * Boundaries of the rollback check. Any change to a process of the batch after
 * the COMMIT blocks the rollback, except the assignments of the post-commit
 * distribution: `legal_process.assign` entries (and the `updated_at` they bump)
 * up to the last distribution progress entry are part of the import. Progress
 * is written after every chunk, so an interrupted distribution still covers the
 * assignments of its finished chunks; resuming it covers the rest (and never
 * hides other changes, which are always compared with the commit).
 */
type RollbackBoundary = {
  /** Commit audit time (database clock: `created_at` columns). */
  dbClock: Date;
  /** Commit time (application clock: `updated_at`, `reviewed_at`). */
  appClock: Date;
  /** Last distribution progress entry (database clock); equals `dbClock` without distribution. */
  distributionDbClock: Date;
  /** Last distribution progress entry (application clock); equals `appClock` without distribution. */
  distributionAppClock: Date;
};

async function rollbackBoundary(
  db: DbOrTx,
  organizationId: string,
  batch: { id: string; committedAt: Date | null },
): Promise<RollbackBoundary> {
  const [commit] = await db
    .select({ createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.entityType, "import_batch"),
        eq(auditLogs.entityId, batch.id),
        eq(auditLogs.action, "import_batch.commit"),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  const dist = await latestDistribution(organizationId, batch.id, db);
  const dbClock = commit?.createdAt ?? batch.committedAt ?? new Date(0);
  const appClock = batch.committedAt ?? new Date(0);
  const completedAt = dist?.summary.completedAt ? new Date(dist.summary.completedAt) : null;
  return {
    dbClock,
    appClock,
    distributionDbClock: dist && dist.createdAt > dbClock ? dist.createdAt : dbClock,
    distributionAppClock: completedAt && !Number.isNaN(completedAt.getTime()) && completedAt > appClock ? completedAt : appClock,
  };
}

async function findBlockers(
  db: DbOrTx,
  organizationId: string,
  batch: { id: string; committedAt: Date | null },
  processIds: readonly string[],
): Promise<RollbackBlocker[]> {
  if (processIds.length === 0) return [];
  const { dbClock, appClock, distributionDbClock, distributionAppClock } = await rollbackBoundary(db, organizationId, batch);
  const reasons = new Map<string, Set<string>>();
  const closedPeriods = new Map<string, Set<string>>();
  const add = (ids: { processId: string | null }[], reason: string) => {
    for (const { processId } of ids) {
      if (!processId) continue;
      if (!reasons.has(processId)) reasons.set(processId, new Set());
      reasons.get(processId)!.add(reason);
    }
  };

  for (const part of chunks([...new Set(processIds)], 400)) {
    add(
      await db
        .selectDistinct({ processId: auditLogs.entityId })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.entityType, "legal_process"),
            inArray(auditLogs.entityId, part),
            gt(auditLogs.createdAt, dbClock),
            // Assignments made by the post-commit distribution are part of the import.
            or(ne(auditLogs.action, "legal_process.assign"), gt(auditLogs.createdAt, distributionDbClock)),
          ),
        ),
      BLOCKER_REASONS.edited,
    );
    add(
      await db
        .select({ processId: legalProcesses.id })
        .from(legalProcesses)
        .where(and(inArray(legalProcesses.id, part), gt(legalProcesses.updatedAt, distributionAppClock))),
      BLOCKER_REASONS.edited,
    );
    add(
      await db
        .selectDistinct({ processId: processValuations.processId })
        .from(processValuations)
        .where(
          and(
            inArray(processValuations.processId, part),
            or(
              and(gt(processValuations.createdAt, dbClock), sql`${processValuations.importBatchId} is distinct from ${batch.id}`),
              and(
                eq(processValuations.importBatchId, batch.id),
                or(inArray(processValuations.status, ["superseded", "rejected"]), gt(processValuations.reviewedAt, appClock)),
              ),
            ),
          ),
        ),
      BLOCKER_REASONS.valuations,
    );
    add(
      await db
        .selectDistinct({ processId: processInstances.processId })
        .from(processInstances)
        .where(
          and(
            inArray(processInstances.processId, part),
            gt(processInstances.createdAt, dbClock),
            sql`${processInstances.importBatchId} is distinct from ${batch.id}`,
          ),
        ),
      BLOCKER_REASONS.instances,
    );
    const checks: { reason: string; query: Promise<{ processId: string | null }[]> }[] = [
      {
        reason: BLOCKER_REASONS.parties,
        query: db.selectDistinct({ processId: processParties.processId }).from(processParties).where(and(inArray(processParties.processId, part), gt(processParties.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.events,
        query: db.selectDistinct({ processId: processEvents.processId }).from(processEvents).where(and(inArray(processEvents.processId, part), gt(processEvents.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.contingency,
        query: db.selectDistinct({ processId: processGuarantees.processId }).from(processGuarantees).where(and(inArray(processGuarantees.processId, part), gt(processGuarantees.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.contingency,
        query: db
          .selectDistinct({ processId: processRiskAssessments.processId })
          .from(processRiskAssessments)
          .where(and(inArray(processRiskAssessments.processId, part), gt(processRiskAssessments.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.contingency,
        query: db.selectDistinct({ processId: settlements.processId }).from(settlements).where(and(inArray(settlements.processId, part), gt(settlements.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.hearings,
        query: db.selectDistinct({ processId: hearings.processId }).from(hearings).where(and(inArray(hearings.processId, part), gt(hearings.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.documents,
        query: db.selectDistinct({ processId: documents.processId }).from(documents).where(and(inArray(documents.processId, part), gt(documents.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.work,
        query: db.selectDistinct({ processId: tasks.processId }).from(tasks).where(and(inArray(tasks.processId, part), gt(tasks.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.work,
        query: db.selectDistinct({ processId: deadlines.processId }).from(deadlines).where(and(inArray(deadlines.processId, part), gt(deadlines.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.briefs,
        query: db.selectDistinct({ processId: caseBriefs.processId }).from(caseBriefs).where(and(inArray(caseBriefs.processId, part), gt(caseBriefs.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.briefs,
        query: db.selectDistinct({ processId: caseIntakes.processId }).from(caseIntakes).where(and(inArray(caseIntakes.processId, part), gt(caseIntakes.createdAt, dbClock))),
      },
      {
        reason: BLOCKER_REASONS.comments,
        query: db
          .selectDistinct({ processId: comments.entityId })
          .from(comments)
          .where(and(eq(comments.entityType, "legal_process"), inArray(comments.entityId, part), gt(comments.createdAt, dbClock))),
      },
    ];
    for (const check of checks) add(await check.query, check.reason);

    // RN-10: a closed competência generated after the commit includes the imported data and is immutable.
    const closed = await db
      .selectDistinct({ processId: portfolioSnapshotItems.processId, period: portfolioSnapshots.period })
      .from(portfolioSnapshotItems)
      .innerJoin(portfolioSnapshots, eq(portfolioSnapshots.id, portfolioSnapshotItems.snapshotId))
      .where(
        and(
          eq(portfolioSnapshots.organizationId, organizationId),
          eq(portfolioSnapshots.status, "closed"),
          gt(portfolioSnapshots.generatedAt, batch.committedAt ?? new Date(0)),
          inArray(portfolioSnapshotItems.processId, part),
        ),
      );
    for (const { processId, period } of closed) {
      if (!closedPeriods.has(processId)) closedPeriods.set(processId, new Set());
      closedPeriods.get(processId)!.add(period);
    }
  }
  for (const [processId, periods] of closedPeriods) {
    add([{ processId }], `incluído em competência fechada (${[...periods].sort().map(periodLabel).join(", ")})`);
  }

  if (reasons.size === 0) return [];
  const ids = [...reasons.keys()];
  const numbers = new Map<string, string>();
  for (const part of chunks(ids, 500)) {
    const rows = await db.select({ id: legalProcesses.id, number: legalProcesses.number }).from(legalProcesses).where(inArray(legalProcesses.id, part));
    for (const r of rows) numbers.set(r.id, r.number);
  }
  return ids
    .map((processId) => ({ processId, number: numbers.get(processId) ?? processId, reasons: [...reasons.get(processId)!] }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

function blockersMessage(blockers: readonly RollbackBlocker[]): string {
  const shown = blockers.slice(0, 10).map((b) => `${b.number} (${b.reasons.join("; ")})`);
  const more = blockers.length > 10 ? ` e mais ${blockers.length - 10}` : "";
  return `Não é possível desfazer esta importação: ${blockers.length === 1 ? "1 processo foi alterado" : `${blockers.length} processos foram alterados`} depois dela ou já consta${blockers.length === 1 ? "" : "m"} de competência fechada: ${shown.join(", ")}${more}. Ajuste esses processos manualmente ou mantenha a importação.`;
}

/** Processes that prevent the rollback of a committed batch (empty when it can be undone). */
export async function getRollbackBlockers(ctx: AuthContext, batchId: string): Promise<RollbackBlocker[]> {
  assertCan(ctx, "import:run");
  const batch = await loadBatchRow(ctx, batchId);
  if (batch.status !== "committed") return [];
  const { all } = await batchProcesses(getDb(), ctx.organizationId, batch.id);
  return findBlockers(getDb(), ctx.organizationId, batch, all);
}

/**
 * Undoes a committed batch: soft-deletes the processes it created, restores the
 * fields it changed and removes the instance links and valuations it added.
 * Refused (ConflictError with the list) when any process changed afterwards.
 */
export async function rollbackImport(ctx: AuthContext, batchId: string): Promise<{ removed: number; restored: number }> {
  assertCan(ctx, "import:run");
  const id = parseId(batchId);
  return getDb().transaction(async (tx) => {
    const [batch] = await tx.select().from(importBatches).where(batchScope(ctx, id)).for("update");
    if (!batch) throw new NotFoundError("Importação não encontrada.");
    if (batch.status !== "committed") {
      throw new ConflictError(
        batch.status === "rolled_back" ? "Esta importação já foi desfeita." : "Somente importações confirmadas podem ser desfeitas.",
      );
    }
    const { created, updated, all } = await batchProcesses(tx, ctx.organizationId, batch.id);
    const blockers = await findBlockers(tx, ctx.organizationId, batch, all);
    if (blockers.length > 0) throw new ConflictError(blockersMessage(blockers));

    const removedValuations = await tx
      .delete(processValuations)
      .where(and(eq(processValuations.organizationId, ctx.organizationId), eq(processValuations.importBatchId, batch.id)))
      .returning({ id: processValuations.id, processId: processValuations.processId });
    const removedInstances = await tx
      .delete(processInstances)
      .where(and(eq(processInstances.organizationId, ctx.organizationId), eq(processInstances.importBatchId, batch.id)))
      .returning({ id: processInstances.id, processId: processInstances.processId });

    const now = new Date();
    for (const part of chunks(created, 500)) {
      await tx
        .update(legalProcesses)
        .set({ deletedAt: now })
        .where(
          and(
            eq(legalProcesses.organizationId, ctx.organizationId),
            eq(legalProcesses.importBatchId, batch.id),
            inArray(legalProcesses.id, part),
            isNull(legalProcesses.deletedAt),
          ),
        );
    }

    for (const u of updated) {
      const processBefore = withoutLegacyPhase(u.before.process);
      if (processBefore && Object.keys(processBefore).length > 0) {
        await tx
          .update(legalProcesses)
          .set(processBefore)
          .where(and(eq(legalProcesses.id, u.processId), eq(legalProcesses.organizationId, ctx.organizationId)));
      }
      for (const [instanceId, raw] of Object.entries(u.before.instances ?? {})) {
        const values = withoutLegacyPhase(raw);
        if (!values || Object.keys(values).length === 0) continue;
        await tx
          .update(processInstances)
          .set(values)
          .where(and(eq(processInstances.id, instanceId), eq(processInstances.processId, u.processId)));
      }
    }

    // Existing processes the batch wrote to (fields, instance links or valuations) go back to their
    // previous state: mirrors (claim, liquidated, provision...) recomputed from what is left.
    const createdSet = new Set(created);
    const restoredIds = new Set(
      [...all, ...updated.map((u) => u.processId), ...removedValuations.map((v) => v.processId), ...removedInstances.map((i) => i.processId)].filter(
        (pid) => !createdSet.has(pid),
      ),
    );
    if (restoredIds.size > 0) {
      const settings = await loadSettings(ctx.organizationId, tx);
      for (const pid of restoredIds) {
        await syncProcessMirrors(ctx.organizationId, pid, tx, settings);
        await markAnalysesStaleForEntity(
          { organizationId: ctx.organizationId, entityId: pid, reason: "Importação de planilha desfeita." },
          tx,
        );
      }
    }

    await tx
      .update(importBatches)
      .set({ status: "rolled_back", rolledBackById: ctx.userId, rolledBackAt: now })
      .where(eq(importBatches.id, batch.id));
    const counts = {
      removed: created.length,
      restored: restoredIds.size,
      valuationsRemoved: removedValuations.length,
      instancesRemoved: removedInstances.length,
    };
    await recordAudit(
      ctx,
      {
        action: "import_batch.rollback",
        entityType: "import_batch",
        entityId: batch.id,
        summary: `Importação desfeita: ${counts.removed} processos removidos, ${counts.restored} restaurados`,
        metadata: counts,
      },
      tx,
    );
    return { removed: counts.removed, restored: counts.restored };
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const createdByUser = alias(users, "import_created_by");
const committedByUser = alias(users, "import_committed_by");
const rolledBackByUser = alias(users, "import_rolled_back_by");

export async function listImportBatches(ctx: AuthContext, page: Page = {}): Promise<Paginated<ImportBatchListItem>> {
  assertCan(ctx, "import:run");
  const { page: p, pageSize, offset } = normalizePage(page);
  const where = eq(importBatches.organizationId, ctx.organizationId);
  const [items, [{ total }]] = await Promise.all([
    getDb()
      .select({
        id: importBatches.id,
        fileName: importBatches.fileName,
        companyName: companies.name,
        status: importBatches.status,
        stats: importBatches.stats,
        createdByName: createdByUser.name,
        createdAt: importBatches.createdAt,
        committedAt: importBatches.committedAt,
        rolledBackAt: importBatches.rolledBackAt,
      })
      .from(importBatches)
      .leftJoin(companies, eq(companies.id, importBatches.companyId))
      .leftJoin(createdByUser, eq(createdByUser.id, importBatches.createdById))
      .where(where)
      .orderBy(desc(importBatches.createdAt))
      .limit(pageSize)
      .offset(offset),
    getDb().select({ total: count() }).from(importBatches).where(where),
  ]);
  return { items, total, page: p, pageSize };
}

export async function getImportBatch(ctx: AuthContext, batchId: string): Promise<ImportBatchDetail> {
  assertCan(ctx, "import:run");
  const id = parseId(batchId);
  const [row] = await getDb()
    .select({
      batch: importBatches,
      companyName: companies.name,
      unitName: units.name,
      createdByName: createdByUser.name,
      committedByName: committedByUser.name,
      rolledBackByName: rolledBackByUser.name,
    })
    .from(importBatches)
    .leftJoin(companies, eq(companies.id, importBatches.companyId))
    .leftJoin(units, eq(units.id, importBatches.defaultUnitId))
    .leftJoin(createdByUser, eq(createdByUser.id, importBatches.createdById))
    .leftJoin(committedByUser, eq(committedByUser.id, importBatches.committedById))
    .leftJoin(rolledBackByUser, eq(rolledBackByUser.id, importBatches.rolledBackById))
    .where(batchScope(ctx, id));
  if (!row) throw new NotFoundError("Importação não encontrada.");
  const b = row.batch;
  const mapping = storedMapping(b);

  const [summaryResult, sameFile, distributionAudit, distributionJobPending] = await Promise.all([
    getDb().execute(sql`
      select i.value->>'level' as level, i.value->>'code' as code, count(distinct r.id)::int as rows
      from import_rows r cross join lateral jsonb_array_elements(r.issues) as i(value)
      where r.batch_id = ${b.id} and r.organization_id = ${ctx.organizationId}
      group by 1, 2`),
    getDb()
      .select({ id: importBatches.id, createdAt: importBatches.createdAt, status: importBatches.status })
      .from(importBatches)
      .where(
        and(
          eq(importBatches.organizationId, ctx.organizationId),
          eq(importBatches.fileSha256, b.fileSha256),
          sql`${importBatches.id} <> ${b.id}`,
        ),
      )
      .orderBy(desc(importBatches.createdAt))
      .limit(5),
    latestDistribution(ctx.organizationId, b.id),
    b.status === "committed" ? hasPendingDistributionJob(ctx.organizationId, b.id) : false,
  ]);

  const levelOrder: Record<IssueLevel, number> = { error: 0, warning: 1, info: 2 };
  const issueSummary = resultRows<{ level: IssueLevel; code: string; rows: number | string }>(summaryResult)
    .map((r) => ({ level: r.level, code: r.code, rows: Number(r.rows) }))
    .sort((a, c) => levelOrder[a.level] - levelOrder[c.level] || c.rows - a.rows);
  const levelCounts: Record<IssueLevel, number> = { error: 0, warning: 0, info: 0 };
  // Rows with at least one issue of each level.
  const levelResult = await getDb().execute(sql`
    select i.value->>'level' as level, count(distinct r.id)::int as rows
    from import_rows r cross join lateral jsonb_array_elements(r.issues) as i(value)
    where r.batch_id = ${b.id} and r.organization_id = ${ctx.organizationId}
    group by 1`);
  for (const r of resultRows<{ level: IssueLevel; rows: number | string }>(levelResult)) {
    if (r.level in levelCounts) levelCounts[r.level] = Number(r.rows);
  }
  const rowScope = and(eq(importRows.batchId, b.id), eq(importRows.organizationId, ctx.organizationId));
  const [[{ storedRows }], [{ problemRows }]] = await Promise.all([
    getDb().select({ storedRows: count() }).from(importRows).where(rowScope),
    getDb()
      .select({ problemRows: count() })
      .from(importRows)
      .where(
        and(
          rowScope,
          or(sql`${importRows.issues} @> '[{"level":"error"}]'::jsonb`, sql`${importRows.issues} @> '[{"level":"warning"}]'::jsonb`),
        ),
      ),
  ]);

  return {
    id: b.id,
    fileName: b.fileName,
    companyName: row.companyName,
    status: b.status,
    stats: b.stats,
    createdByName: row.createdByName,
    createdAt: b.createdAt,
    committedAt: b.committedAt,
    rolledBackAt: b.rolledBackAt,
    fileSha256: b.fileSha256,
    sizeBytes: b.sizeBytes,
    companyId: b.companyId,
    defaultUnitId: b.defaultUnitId,
    defaultUnitName: row.unitName,
    sheets: b.sheets,
    columnMapping: mapping.sheets ?? {},
    baseDate: mapping.baseDate ?? null,
    baseDateSource: mapping.baseDateSource ?? null,
    baseDateHint: mapping.baseDateHint ?? null,
    distributeAfterCommit: mapping.distributeAfterCommit ?? false,
    committedByName: row.committedByName,
    rolledBackByName: row.rolledBackByName,
    hasStoredFile: !!b.storageKey,
    issueSummary,
    levelCounts,
    storedRows,
    problemRows,
    sameFileBatches: sameFile,
    distribution: distributionAudit?.summary ?? null,
    distributionState: distributionState(b, mapping.distributeAfterCommit ?? false, distributionAudit, distributionJobPending),
    dataSheets: b.sheets.filter((s) => s.role !== "ignored").map((s) => s.name),
  };
}

/** ORDER BY sheet in file order, then row number. */
function sheetOrder(sheets: readonly string[], column: SQL | typeof importRows.sheet): SQL {
  if (sheets.length === 0) return sql`0`;
  const cases = sql.join(
    sheets.map((name, i) => sql`when ${name} then ${sql.raw(String(i))}`),
    sql` `,
  );
  return sql`case ${column} ${cases} else ${sql.raw(String(sheets.length))} end`;
}

async function batchSheets(ctx: AuthContext, batchId: string): Promise<string[]> {
  const batch = await loadBatchRow(ctx, batchId);
  return batch.sheets.filter((s) => s.role !== "ignored").map((s) => s.name);
}

export async function listImportRows(
  ctx: AuthContext,
  batchId: string,
  filters: ListImportRowsFilters & Page = {},
): Promise<Paginated<ImportRowListItem>> {
  assertCan(ctx, "import:run");
  const id = parseId(batchId);
  const f = parseOrThrow(listImportRowsSchema, { sheet: filters.sheet, action: filters.action, level: filters.level });
  const sheets = await batchSheets(ctx, id);
  const { page, pageSize, offset } = normalizePage({ page: filters.page, pageSize: filters.pageSize ?? 50 });
  const conds: SQL[] = [eq(importRows.batchId, id), eq(importRows.organizationId, ctx.organizationId)];
  if (f.sheet) conds.push(eq(importRows.sheet, f.sheet));
  if (f.action) conds.push(eq(importRows.action, f.action));
  if (f.level) conds.push(sql`${importRows.issues} @> ${JSON.stringify([{ level: f.level }])}::jsonb`);
  const where = and(...conds);
  const [rows, [{ total }]] = await Promise.all([
    getDb()
      .select({
        id: importRows.id,
        sheet: importRows.sheet,
        rowNumber: importRows.rowNumber,
        cnj: importRows.cnj,
        cnjValid: importRows.cnjValid,
        action: importRows.action,
        issues: importRows.issues,
        normalized: importRows.normalized,
        processId: importRows.processId,
      })
      .from(importRows)
      .where(where)
      .orderBy(sheetOrder(sheets, importRows.sheet), asc(importRows.rowNumber))
      .limit(pageSize)
      .offset(offset),
    getDb().select({ total: count() }).from(importRows).where(where),
  ]);
  const items = rows.map((r) => {
    const stored = (r.normalized ?? {}) as Partial<StoredRow>;
    const d = stored.data ?? null;
    return {
      id: r.id,
      sheet: r.sheet,
      rowNumber: r.rowNumber,
      cnj: r.cnj,
      cnjValid: r.cnjValid,
      action: r.action,
      kind: stored.kind ?? "data",
      instance: d?.instance ?? null,
      court: d?.court ?? null,
      phaseDetail: d?.phase?.detail ?? null,
      hasLiquidatedColumn: d?.hasLiquidatedColumn ?? false,
      claimAmountCents: d?.claimAmountCents ?? null,
      liquidatedAmountCents: d?.liquidatedAmountCents ?? null,
      city: d?.city ?? null,
      state: d?.state ?? null,
      issues: r.issues,
      processId: r.processId,
    };
  });
  return { items, total, page, pageSize };
}

function issueConditions(ctx: AuthContext, batchId: string, f: z.output<typeof listImportIssuesSchema>): SQL {
  const conds: SQL[] = [sql`r.batch_id = ${batchId}`, sql`r.organization_id = ${ctx.organizationId}`];
  if (f.sheet) conds.push(sql`r.sheet = ${f.sheet}`);
  if (f.level) conds.push(sql`i.value->>'level' = ${f.level}`);
  if (f.code) conds.push(sql`i.value->>'code' = ${f.code}`);
  return sql.join(conds, sql` and `);
}

type IssueRow = {
  rowId: string;
  sheet: string;
  rowNumber: number | string;
  cnj: string | null;
  processId: string | null;
  level: IssueLevel;
  code: string;
  field: string | null;
  message: string;
};

function toIssueItem(r: IssueRow): ImportIssueListItem {
  return { ...r, rowNumber: Number(r.rowNumber) };
}

/** Every issue of the batch (one line per issue), filtered and paginated. */
export async function listImportIssues(
  ctx: AuthContext,
  batchId: string,
  filters: ListImportIssuesFilters & Page = {},
): Promise<Paginated<ImportIssueListItem>> {
  assertCan(ctx, "import:run");
  const id = parseId(batchId);
  const f = parseOrThrow(listImportIssuesSchema, { sheet: filters.sheet, level: filters.level, code: filters.code });
  const sheets = await batchSheets(ctx, id);
  const { page, pageSize, offset } = normalizePage({ page: filters.page, pageSize: filters.pageSize ?? 50 });
  const where = issueConditions(ctx, id, f);
  const [rows, totals] = await Promise.all([
    getDb().execute(sql`
      select r.id as "rowId", r.sheet, r.row_number as "rowNumber", r.cnj, r.process_id as "processId",
             i.value->>'level' as level, i.value->>'code' as code, i.value->>'field' as field, i.value->>'message' as message
      from import_rows r cross join lateral jsonb_array_elements(r.issues) with ordinality as i(value, idx)
      where ${where}
      order by ${sheetOrder(sheets, sql`r.sheet`)}, r.row_number, i.idx
      limit ${pageSize} offset ${offset}`),
    getDb().execute(sql`
      select count(*)::int as total
      from import_rows r cross join lateral jsonb_array_elements(r.issues) as i(value)
      where ${where}`),
  ]);
  const total = Number(resultRows<{ total: number | string }>(totals)[0]?.total ?? 0);
  return { items: resultRows<IssueRow>(rows).map(toIssueItem), total, page, pageSize };
}

/** All issues matching the filters (CSV export). Audited as `import_batch.export_issues` (filters and count only). */
export async function listAllImportIssues(
  ctx: AuthContext,
  batchId: string,
  filters: ListImportIssuesFilters = {},
): Promise<{ fileName: string; items: ImportIssueListItem[] }> {
  assertCan(ctx, "import:run");
  const id = parseId(batchId);
  const f = parseOrThrow(listImportIssuesSchema, { sheet: filters.sheet, level: filters.level, code: filters.code });
  const batch = await loadBatchRow(ctx, id);
  const sheets = batch.sheets.filter((s) => s.role !== "ignored").map((s) => s.name);
  const rows = await getDb().execute(sql`
    select r.id as "rowId", r.sheet, r.row_number as "rowNumber", r.cnj, r.process_id as "processId",
           i.value->>'level' as level, i.value->>'code' as code, i.value->>'field' as field, i.value->>'message' as message
    from import_rows r cross join lateral jsonb_array_elements(r.issues) with ordinality as i(value, idx)
    where ${issueConditions(ctx, id, f)}
    order by ${sheetOrder(sheets, sql`r.sheet`)}, r.row_number, i.idx`);
  const items = resultRows<IssueRow>(rows).map(toIssueItem);
  // Traceability of the export: filters and row count only, never cell values.
  await recordAudit(ctx, {
    action: "import_batch.export_issues",
    entityType: "import_batch",
    entityId: batch.id,
    summary: `Inconsistências da importação exportadas em CSV (${items.length} ${items.length === 1 ? "linha" : "linhas"})`,
    metadata: { filters: { sheet: f.sheet ?? null, level: f.level ?? null, code: f.code ?? null }, rows: items.length },
  });
  return { fileName: batch.fileName, items };
}

/** Divergences between sheets (one line per field), taken from the official line of each CNJ + instance. */
export async function listImportDivergences(
  ctx: AuthContext,
  batchId: string,
  page: Page = {},
): Promise<Paginated<ImportDivergenceListItem>> {
  assertCan(ctx, "import:run");
  const id = parseId(batchId);
  const sheets = await batchSheets(ctx, id);
  const { page: p, pageSize, offset } = normalizePage({ page: page.page, pageSize: page.pageSize ?? 50 });
  const where = sql`
    r.batch_id = ${id} and r.organization_id = ${ctx.organizationId}
    and d.value->'base'->>'sheet' = r.sheet and (d.value->'base'->>'row')::int = r.row_number`;
  const [rows, totals] = await Promise.all([
    getDb().execute(sql`
      select r.id as "rowId", r.process_id as "processId", d.value as divergence
      from import_rows r cross join lateral jsonb_array_elements(coalesce(r.normalized->'divergences', '[]'::jsonb)) with ordinality as d(value, idx)
      where ${where}
      order by ${sheetOrder(sheets, sql`r.sheet`)}, r.row_number, d.idx
      limit ${pageSize} offset ${offset}`),
    getDb().execute(sql`
      select count(*)::int as total
      from import_rows r cross join lateral jsonb_array_elements(coalesce(r.normalized->'divergences', '[]'::jsonb)) as d(value)
      where ${where}`),
  ]);
  const total = Number(resultRows<{ total: number | string }>(totals)[0]?.total ?? 0);
  const items = resultRows<{ rowId: string; processId: string | null; divergence: Divergence | string }>(rows).map((r) => {
    const d = typeof r.divergence === "string" ? (JSON.parse(r.divergence) as Divergence) : r.divergence;
    return { ...d, rowId: r.rowId, processId: r.processId };
  });
  return { items, total, page: p, pageSize };
}

/** Original file of the batch (traceability). Audited. */
export async function openImportFile(
  ctx: AuthContext,
  batchId: string,
): Promise<{ fileName: string; sizeBytes: number; stream: ReadableStream<Uint8Array> }> {
  assertCan(ctx, "import:run");
  const batch = await loadBatchRow(ctx, batchId);
  if (!batch.storageKey) throw new NotFoundError("O arquivo original desta importação não está disponível.");
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await getStorage().getStream(batch.storageKey);
  } catch {
    throw new NotFoundError("O arquivo original desta importação não está disponível.");
  }
  await recordAudit(ctx, {
    action: "import_batch.download",
    entityType: "import_batch",
    entityId: batch.id,
    summary: "Download da planilha original da importação",
  });
  return { fileName: batch.fileName, sizeBytes: batch.sizeBytes, stream };
}
