import { boolean, date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ConfidentialityLevel, DocumentCategory, TextExtractionStatus } from "@/domain/enums";
import { createdAt, deletedAt, id, ts, updatedAt } from "./_columns";
import { organizations, users } from "./core";
import { contracts, legalProcesses, occurrences } from "./legal";

/**
 * A logical document. Its binary content lives in `document_versions`; every
 * upload creates a new version. A document may be linked to at most one
 * process, one occurrence and one contract (all optional).
 *
 * Access: a document linked to a record inherits that record's visibility.
 * `restricted` documents are additionally limited to admins, legal managers,
 * the uploader and the responsible user of the linked record.
 */
export const documents = pgTable(
  "documents",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").$type<DocumentCategory>().notNull(),
    confidentiality: text("confidentiality").$type<ConfidentialityLevel>().notNull().default("internal"),
    processId: uuid("process_id").references(() => legalProcesses.id),
    occurrenceId: uuid("occurrence_id").references(() => occurrences.id),
    contractId: uuid("contract_id").references(() => contracts.id),
    /** Denormalized pointer to the latest version (no FK to avoid a cycle). */
    currentVersionId: uuid("current_version_id"),
    currentVersionNumber: integer("current_version_number").notNull().default(0),
    uploadedById: uuid("uploaded_by_id").references(() => users.id),
    /** Optional retention date after which the document is eligible for deletion review. */
    retentionUntil: date("retention_until", { mode: "string" }),
    legalHold: boolean("legal_hold").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("documents_org_idx").on(t.organizationId, t.createdAt),
    index("documents_process_idx").on(t.processId),
    index("documents_occurrence_idx").on(t.occurrenceId),
    index("documents_contract_idx").on(t.contractId),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    /** Original file name, sanitized. Never used as a storage path. */
    fileName: text("file_name").notNull(),
    /** MIME type detected from the file signature, not trusted from the client. */
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** Opaque key in the storage provider (e.g. `<orgId>/<documentId>/<versionId>`). */
    storageKey: text("storage_key").notNull(),
    extractionStatus: text("extraction_status").$type<TextExtractionStatus>().notNull().default("pending"),
    /**
     * Extracted plain text. UNTRUSTED CONTENT: may contain instructions aimed at
     * the AI; it is only ever passed to providers as delimited data.
     */
    extractedText: text("extracted_text"),
    extractedAt: ts("extracted_at"),
    changeNote: text("change_note"),
    uploadedById: uuid("uploaded_by_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("document_versions_doc_number_uq").on(t.documentId, t.versionNumber),
    index("document_versions_sha_idx").on(t.organizationId, t.sha256),
  ],
);
