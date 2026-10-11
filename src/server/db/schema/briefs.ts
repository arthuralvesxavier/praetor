import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { StoredCaseBrief } from "@/domain/case-brief";
import type { AiMode, CaseBriefStatus } from "@/domain/enums";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { organizations, users } from "./core";
import { legalProcesses } from "./legal";

/**
 * Análise preliminar do processo (case brief). Gerada pelo provedor de
 * análise preliminar (nesta etapa, SIMULADO), revisada/editada e aprovada pelo
 * advogado. `originalContent` é o resultado da geração e nunca muda; `content`
 * é a versão vigente (última revisão). Cada edição gera uma linha em
 * `case_brief_revisions`. A análise nunca altera registros por conta própria.
 */
export const caseBriefs = pgTable(
  "case_briefs",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    intakeId: uuid("intake_id"),
    /** 1, 2, 3... per process (a regeneration creates a new version). */
    version: integer("version").notNull(),
    status: text("status").$type<CaseBriefStatus>().notNull().default("generating"),
    mode: text("mode").$type<AiMode>().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    originalContent: jsonb("original_content").$type<StoredCaseBrief>(),
    content: jsonb("content").$type<StoredCaseBrief>(),
    currentRevision: integer("current_revision").notNull().default(0),
    /** Sanitized pt-BR error (never document text). */
    errorMessage: text("error_message"),
    requestedById: uuid("requested_by_id").references(() => users.id),
    generatedAt: ts("generated_at"),
    lastEditedById: uuid("last_edited_by_id").references(() => users.id),
    lastEditedAt: ts("last_edited_at"),
    approvedById: uuid("approved_by_id").references(() => users.id),
    approvedAt: ts("approved_at"),
    approvalNote: text("approval_note"),
    rejectedById: uuid("rejected_by_id").references(() => users.id),
    rejectedAt: ts("rejected_at"),
    rejectionReason: text("rejection_reason"),
    isStale: boolean("is_stale").notNull().default(false),
    staleReason: text("stale_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("case_briefs_process_version_uq").on(t.processId, t.version),
    index("case_briefs_org_status_idx").on(t.organizationId, t.status),
  ],
);

/** Histórico de edições da análise preliminar (revisão 1 = conteúdo gerado). */
export const caseBriefRevisions = pgTable(
  "case_brief_revisions",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    briefId: uuid("brief_id").notNull().references(() => caseBriefs.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    content: jsonb("content").$type<StoredCaseBrief>().notNull(),
    /** Null for the generated revision. */
    editedById: uuid("edited_by_id").references(() => users.id),
    changeNote: text("change_note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("case_brief_revisions_uq").on(t.briefId, t.revision)],
);

/** Fontes usadas na geração (para citações, visibilidade e desatualização). */
export const caseBriefSources = pgTable(
  "case_brief_sources",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    briefId: uuid("brief_id").notNull().references(() => caseBriefs.id, { onDelete: "cascade" }),
    /** "REG" (cadastro do processo) or "D1", "D2"... */
    ref: text("ref").notNull(),
    /** `legal_process` | `document_version`. */
    sourceType: text("source_type").notNull(),
    /** Process id or document id. */
    entityId: uuid("entity_id").notNull(),
    versionId: uuid("version_id"),
    versionNumber: integer("version_number"),
    label: text("label").notNull(),
    contentHash: text("content_hash").notNull(),
    pageCount: integer("page_count"),
    charCount: integer("char_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("case_brief_sources_brief_idx").on(t.briefId),
    index("case_brief_sources_entity_idx").on(t.organizationId, t.entityId),
  ],
);
