import { boolean, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { ImportBatchStatus, ImportRowAction, IssueLevel } from "@/domain/enums";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { companies, organizations, units, users } from "./core";
import { legalProcesses } from "./legal";

export type ImportIssue = {
  level: IssueLevel;
  /** Stable machine code, e.g. `cnj_invalid_check_digit`, `value_divergence`, `duplicate_in_sheet`. */
  code: string;
  /** Column/field concerned (pt-BR header as in the file), when applicable. */
  field: string | null;
  /** pt-BR explanation. */
  message: string;
};

export type ImportSheetSummary = {
  name: string;
  /** How the sheet was used: process rows of an instance, consolidated rows, or ignored. */
  role: "consolidated" | "instance" | "ignored";
  /** Instance of the rows when `role = instance`. */
  instance: "first" | "second" | "superior" | null;
  headerRow: number | null;
  rowCount: number;
  /** Why it was ignored (e.g. summary/dashboard sheet, narrative log). */
  note: string | null;
};

/** Column mapping per sheet: canonical field -> header text found in the file. */
export type ImportMapping = {
  sheets: Record<string, Record<string, string>>;
  companyId: string | null;
  defaultUnitId: string | null;
  /** Optional UF -> unit id mapping chosen by the user. */
  unitByState: Record<string, string>;
  /** Run the distribution rules for processes without responsible after commit. */
  distributeAfterCommit: boolean;
};

export type ImportStats = {
  rowsRead: number;
  processesDetected: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  instanceLinks: number;
  errors: number;
  warnings: number;
  duplicatesInSheet: number;
  divergences: number;
  ignoredRows: number;
};

/**
 * Lote de importação de planilha (RF-02): analisar → (relatório de
 * inconsistências) → confirmar → (opcional) desfazer. O arquivo original é
 * guardado pelo provedor de storage para rastreabilidade.
 */
export const importBatches = pgTable(
  "import_batches",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    companyId: uuid("company_id").references(() => companies.id),
    defaultUnitId: uuid("default_unit_id").references(() => units.id),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key"),
    status: text("status").$type<ImportBatchStatus>().notNull().default("analyzed"),
    sheets: jsonb("sheets").$type<ImportSheetSummary[]>().notNull().default([]),
    mapping: jsonb("mapping").$type<ImportMapping>(),
    stats: jsonb("stats").$type<ImportStats>(),
    errorMessage: text("error_message"),
    createdById: uuid("created_by_id").references(() => users.id),
    committedById: uuid("committed_by_id").references(() => users.id),
    committedAt: ts("committed_at"),
    rolledBackById: uuid("rolled_back_by_id").references(() => users.id),
    rolledBackAt: ts("rolled_back_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("import_batches_org_created_idx").on(t.organizationId, t.createdAt)],
);

/** One spreadsheet row with its normalization, issues and resulting action. */
export const importRows = pgTable(
  "import_rows",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
    sheet: text("sheet").notNull(),
    /** 1-based row number as shown by spreadsheet software. */
    rowNumber: integer("row_number").notNull(),
    /** Normalized CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO) or the raw value when it could not be normalized. */
    cnj: text("cnj"),
    cnjValid: boolean("cnj_valid").notNull().default(false),
    action: text("action").$type<ImportRowAction>().notNull(),
    issues: jsonb("issues").$type<ImportIssue[]>().notNull().default([]),
    /** Cell values keyed by header (fictitious/demo data or the client's own base — never logged). */
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    normalized: jsonb("normalized").$type<Record<string, unknown>>(),
    processId: uuid("process_id").references(() => legalProcesses.id),
    /** State of the process fields before an update (used by rollback). */
    before: jsonb("before").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("import_rows_batch_idx").on(t.batchId, t.sheet, t.rowNumber),
    index("import_rows_batch_action_idx").on(t.batchId, t.action),
    index("import_rows_org_cnj_idx").on(t.organizationId, t.cnj),
  ],
);
