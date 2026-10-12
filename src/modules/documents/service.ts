import { randomUUID } from "node:crypto";
import { and, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type {
  ConfidentialityLevel,
  DocumentCategory,
  TextExtractionStatus,
} from "@/domain/enums";
import { normalizePage, type LinkableEntityType, type Page, type Paginated } from "@/domain/entities";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import { markCaseBriefsStale } from "@/modules/briefs/service";
import { contractWhere, documentWhere, occurrenceWhere, processWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { contracts, documents, documentVersions, legalProcesses, occurrences, users } from "@/server/db/schema";
import { env } from "@/server/env";
import {
  buildStorageKey,
  getStorage,
  InvalidStorageKeyError,
  readStreamToBytes,
  StorageObjectNotFoundError,
  StorageReadLimitError,
} from "@/server/integrations/storage";
import { extractText } from "@/server/integrations/text-extraction";
import { enqueueJob } from "@/server/jobs/queue";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit, diffChanges } from "@/server/services/audit";
import { effectiveConfidentiality } from "./confidentiality";
import { maxUploadBytes } from "./file-types";
import { errorSummary } from "./log";
import {
  addVersionSchema,
  idSchema,
  listDocumentsSchema,
  updateDocumentSchema,
  uploadDocumentSchema,
  type UpdateDocumentInput,
} from "./schemas";
import { validateUploadFile, type ValidatedUpload } from "./validation";

/**
 * Documents: logical documents with immutable, versioned binary content.
 *
 * Security notes:
 * - every read applies `documentWhere(ctx)` (org isolation, inherited
 *   visibility of linked records, confidentiality level);
 * - linked process/occurrence/contract ids are verified to be visible to the
 *   user before being stored;
 * - file type is detected from content (./validation.ts); storage keys are
 *   generated here, never derived from user input;
 * - audit entries and logs carry metadata only (name, size, type, hash prefix),
 *   never contents or extracted text.
 */

export type UploadFile = { name: string; bytes: Uint8Array };

export type DocumentLink = {
  type: LinkableEntityType;
  id: string;
  /** null when the linked record is not visible to the current user. */
  label: string | null;
};

export type DocumentListItem = {
  id: string;
  title: string;
  category: DocumentCategory;
  confidentiality: ConfidentialityLevel;
  legalHold: boolean;
  links: DocumentLink[];
  currentVersionId: string | null;
  currentVersionNumber: number;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  extractionStatus: TextExtractionStatus | null;
  uploadedByName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DocumentVersionItem = {
  id: string;
  versionNumber: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  extractionStatus: TextExtractionStatus;
  extractedAt: Date | null;
  /** Number of pages (PDF) when known. */
  pageCount: number | null;
  changeNote: string | null;
  uploadedByName: string | null;
  createdAt: Date;
  isCurrent: boolean;
};

export type DocumentTextPreview = {
  versionNumber: number;
  text: string;
  totalChars: number;
  truncated: boolean;
};

export type DocumentDetail = {
  id: string;
  title: string;
  description: string | null;
  category: DocumentCategory;
  confidentiality: ConfidentialityLevel;
  processId: string | null;
  occurrenceId: string | null;
  contractId: string | null;
  links: DocumentLink[];
  currentVersionId: string | null;
  currentVersionNumber: number;
  uploadedById: string | null;
  uploadedByName: string | null;
  retentionUntil: string | null;
  legalHold: boolean;
  createdAt: Date;
  updatedAt: Date;
  versions: DocumentVersionItem[];
  /** First characters of the current version's extracted text (untrusted content — render as plain text). */
  textPreview: DocumentTextPreview | null;
};

export const TEXT_PREVIEW_CHARS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Verifique os campos informados.", z.flattenError(parsed.error).fieldErrors as Record<string, string[]>);
  }
  return parsed.data;
}

/** Ids that are not UUIDs can never match a visible record: answer "not found". */
function parseId(id: unknown): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function sha256Prefix(sha: string): string {
  return sha.slice(0, 12);
}

function uploadLimitBytes(): number {
  return maxUploadBytes(env().MAX_UPLOAD_MB);
}

type LinkIds = { processId?: string | null; occurrenceId?: string | null; contractId?: string | null };

/**
 * Verifies that every linked record exists in the organization AND is visible
 * to the user. Throws ValidationError with per-field messages otherwise.
 */
async function assertLinksVisible(ctx: AuthContext, links: LinkIds, db: DbOrTx = getDb()): Promise<void> {
  const fieldErrors: Record<string, string[]> = {};
  if (links.processId) {
    const [row] = await db
      .select({ id: legalProcesses.id })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, links.processId), processWhere(ctx)))
      .limit(1);
    if (!row) fieldErrors.processId = ["Processo não encontrado ou sem permissão de acesso."];
  }
  if (links.occurrenceId) {
    const [row] = await db
      .select({ id: occurrences.id })
      .from(occurrences)
      .where(and(eq(occurrences.id, links.occurrenceId), occurrenceWhere(ctx)))
      .limit(1);
    if (!row) fieldErrors.occurrenceId = ["Ocorrência não encontrada ou sem permissão de acesso."];
  }
  if (links.contractId) {
    const [row] = await db
      .select({ id: contracts.id })
      .from(contracts)
      .where(and(eq(contracts.id, links.contractId), contractWhere(ctx)))
      .limit(1);
    if (!row) fieldErrors.contractId = ["Contrato não encontrado ou sem permissão de acesso."];
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError("Verifique os vínculos informados.", fieldErrors);
}

/** Labels of linked records, only for records visible to the user. */
async function resolveLinks(ctx: AuthContext, rows: LinkIds[]): Promise<(row: LinkIds) => DocumentLink[]> {
  const db = getDb();
  const ids = (key: keyof LinkIds) => [...new Set(rows.map((r) => r[key]).filter((v): v is string => Boolean(v)))];
  const processIds = ids("processId");
  const occurrenceIds = ids("occurrenceId");
  const contractIds = ids("contractId");

  const [procs, occs, ctrs] = await Promise.all([
    processIds.length
      ? db
          .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
          .from(legalProcesses)
          .where(and(inArray(legalProcesses.id, processIds), processWhere(ctx)))
      : Promise.resolve([]),
    occurrenceIds.length
      ? db
          .select({ id: occurrences.id, title: occurrences.title })
          .from(occurrences)
          .where(and(inArray(occurrences.id, occurrenceIds), occurrenceWhere(ctx)))
      : Promise.resolve([]),
    contractIds.length
      ? db
          .select({ id: contracts.id, title: contracts.title })
          .from(contracts)
          .where(and(inArray(contracts.id, contractIds), contractWhere(ctx)))
      : Promise.resolve([]),
  ]);
  const procMap = new Map(procs.map((p) => [p.id, `${p.number} · ${p.title}`]));
  const occMap = new Map(occs.map((o) => [o.id, o.title]));
  const ctrMap = new Map(ctrs.map((c) => [c.id, c.title]));

  return (row) => {
    const out: DocumentLink[] = [];
    if (row.processId) out.push({ type: "legal_process", id: row.processId, label: procMap.get(row.processId) ?? null });
    if (row.occurrenceId) out.push({ type: "occurrence", id: row.occurrenceId, label: occMap.get(row.occurrenceId) ?? null });
    if (row.contractId) out.push({ type: "contract", id: row.contractId, label: ctrMap.get(row.contractId) ?? null });
    return out;
  };
}

/** Loads a document visible to the user or throws NotFoundError. */
async function loadVisibleDocument(ctx: AuthContext, id: string, db: DbOrTx = getDb()) {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), documentWhere(ctx)))
    .limit(1);
  if (!doc) throw new NotFoundError();
  return doc;
}

/** Stores the blob, runs `work` in a transaction and removes the blob if the transaction fails. */
async function storeThenCommit(key: string, bytes: Uint8Array, work: (tx: DbOrTx) => Promise<void>): Promise<void> {
  const storage = getStorage();
  await storage.put(key, bytes);
  try {
    await getDb().transaction(async (tx) => {
      await work(tx);
    });
  } catch (err) {
    await storage.delete(key).catch((deleteErr: unknown) => {
      logger.error("document_blob_cleanup_failed", { storageKey: key, ...errorSummary(deleteErr) });
    });
    throw err;
  }
}

function enqueueExtraction(organizationId: string, versionId: string, tx: DbOrTx) {
  return enqueueJob(
    {
      type: "document.extract_text",
      organizationId,
      payload: { versionId },
      dedupeKey: `extract:${versionId}`,
    },
    tx,
  );
}

function fileAuditMetadata(file: ValidatedUpload, versionNumber: number) {
  return {
    versionNumber,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    mimeType: file.mimeType,
    sha256Prefix: sha256Prefix(file.sha256),
  };
}

// ---------------------------------------------------------------------------
// Upload & versions
// ---------------------------------------------------------------------------

export async function uploadDocument(
  ctx: AuthContext,
  input: {
    title: string;
    category: DocumentCategory;
    description?: string | null;
    confidentiality?: ConfidentialityLevel;
    processId?: string | null;
    occurrenceId?: string | null;
    contractId?: string | null;
    file: UploadFile;
  },
): Promise<{ documentId: string; versionId: string }> {
  assertCan(ctx, "document:upload");
  const { file: rawFile, ...metadata } = input ?? ({} as typeof input);
  const parsedMeta = parseOrThrow(uploadDocumentSchema, metadata);
  // PD-04: health documents (atestado, laudo, CAT) are always restricted.
  const meta = { ...parsedMeta, confidentiality: effectiveConfidentiality(parsedMeta.category, parsedMeta.confidentiality) };
  const file = validateUploadFile(rawFile, { maxBytes: uploadLimitBytes() });
  await assertLinksVisible(ctx, meta);

  const documentId = randomUUID();
  const versionId = randomUUID();
  const storageKey = buildStorageKey(ctx.organizationId, documentId, versionId);
  const now = new Date();

  await storeThenCommit(storageKey, rawFile.bytes, async (tx) => {
    await tx.insert(documents).values({
      id: documentId,
      organizationId: ctx.organizationId,
      title: meta.title,
      description: meta.description,
      category: meta.category,
      confidentiality: meta.confidentiality,
      processId: meta.processId,
      occurrenceId: meta.occurrenceId,
      contractId: meta.contractId,
      currentVersionId: versionId,
      currentVersionNumber: 1,
      uploadedById: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(documentVersions).values({
      id: versionId,
      organizationId: ctx.organizationId,
      documentId,
      versionNumber: 1,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      storageKey,
      extractionStatus: "pending",
      uploadedById: ctx.userId,
      createdAt: now,
    });
    await recordAudit(
      ctx,
      {
        action: "document.upload",
        entityType: "document",
        entityId: documentId,
        summary: `Documento "${meta.title}" enviado (versão 1).`,
        metadata: {
          ...fileAuditMetadata(file, 1),
          category: meta.category,
          confidentiality: meta.confidentiality,
          processId: meta.processId,
          occurrenceId: meta.occurrenceId,
          contractId: meta.contractId,
        },
      },
      tx,
    );
    await enqueueExtraction(ctx.organizationId, versionId, tx);
  });

  logger.info("document_uploaded", { documentId, versionId, sizeBytes: file.sizeBytes, mimeType: file.mimeType });
  return { documentId, versionId };
}

export async function addDocumentVersion(
  ctx: AuthContext,
  documentId: string,
  input: { changeNote?: string | null; file: UploadFile },
): Promise<{ versionId: string; versionNumber: number }> {
  assertCan(ctx, "document:upload");
  const id = parseId(documentId);
  const { changeNote } = parseOrThrow(addVersionSchema, { changeNote: input?.changeNote });
  const doc = await loadVisibleDocument(ctx, id);
  const file = validateUploadFile(input.file, { maxBytes: uploadLimitBytes() });

  if (doc.currentVersionId) {
    const [current] = await getDb()
      .select({ sha256: documentVersions.sha256 })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.id, doc.currentVersionId),
          eq(documentVersions.documentId, doc.id),
          eq(documentVersions.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);
    if (current?.sha256 === file.sha256) {
      const message = "O arquivo enviado é idêntico à versão atual do documento.";
      throw new ValidationError(message, { file: [message] });
    }
  }

  const versionId = randomUUID();
  const versionNumber = doc.currentVersionNumber + 1;
  const storageKey = buildStorageKey(ctx.organizationId, doc.id, versionId);
  const now = new Date();

  await storeThenCommit(storageKey, input.file.bytes, async (tx) => {
    // Optimistic concurrency: only advance from the version we validated against.
    const updated = await tx
      .update(documents)
      .set({ currentVersionId: versionId, currentVersionNumber: versionNumber, updatedAt: now })
      .where(
        and(
          eq(documents.id, doc.id),
          eq(documents.organizationId, ctx.organizationId),
          eq(documents.currentVersionNumber, doc.currentVersionNumber),
          isNull(documents.deletedAt),
        ),
      )
      .returning({ id: documents.id });
    if (updated.length === 0) {
      throw new ConflictError("O documento foi atualizado por outra pessoa. Recarregue a página e tente novamente.");
    }
    await tx.insert(documentVersions).values({
      id: versionId,
      organizationId: ctx.organizationId,
      documentId: doc.id,
      versionNumber,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      storageKey,
      extractionStatus: "pending",
      changeNote,
      uploadedById: ctx.userId,
      createdAt: now,
    });
    await recordAudit(
      ctx,
      {
        action: "document.version_add",
        entityType: "document",
        entityId: doc.id,
        summary: `Nova versão (${versionNumber}) do documento "${doc.title}".`,
        metadata: fileAuditMetadata(file, versionNumber),
      },
      tx,
    );
    await enqueueExtraction(ctx.organizationId, versionId, tx);
  });

  logger.info("document_version_added", { documentId: doc.id, versionId, versionNumber });
  return { versionId, versionNumber };
}

// ---------------------------------------------------------------------------
// Metadata & deletion
// ---------------------------------------------------------------------------

const UPDATABLE_FIELDS = [
  "title",
  "description",
  "category",
  "confidentiality",
  "processId",
  "occurrenceId",
  "contractId",
  "retentionUntil",
  "legalHold",
] as const;

/**
 * Updates document metadata (`document:upload`). Changing the legal hold flag
 * additionally requires `document:delete` (it governs deletion/retention).
 */
export async function updateDocumentMetadata(ctx: AuthContext, documentId: string, input: UpdateDocumentInput): Promise<void> {
  assertCan(ctx, "document:upload");
  const id = parseId(documentId);
  const v = parseOrThrow(updateDocumentSchema, input ?? {});
  const before = await loadVisibleDocument(ctx, id);

  const patch: Partial<typeof documents.$inferInsert> = {};
  if (v.title !== undefined && v.title !== before.title) patch.title = v.title;
  if (v.description !== undefined) {
    const description = v.description ? v.description : null;
    if (description !== before.description) patch.description = description;
  }
  if (v.category !== undefined && v.category !== before.category) patch.category = v.category;
  // PD-04: a health document stays restricted whatever level was requested.
  const nextCategory = patch.category ?? before.category;
  const requestedLevel = v.confidentiality ?? before.confidentiality;
  const nextLevel = effectiveConfidentiality(nextCategory, requestedLevel);
  if (nextLevel !== before.confidentiality) patch.confidentiality = nextLevel;
  if (v.retentionUntil !== undefined && v.retentionUntil !== before.retentionUntil) patch.retentionUntil = v.retentionUntil;
  if (v.legalHold !== undefined && v.legalHold !== before.legalHold) {
    assertCan(ctx, "document:delete");
    patch.legalHold = v.legalHold;
  }
  const newLinks: LinkIds = {};
  if (v.processId !== undefined && v.processId !== before.processId) patch.processId = newLinks.processId = v.processId;
  if (v.occurrenceId !== undefined && v.occurrenceId !== before.occurrenceId) {
    patch.occurrenceId = newLinks.occurrenceId = v.occurrenceId;
  }
  if (v.contractId !== undefined && v.contractId !== before.contractId) patch.contractId = newLinks.contractId = v.contractId;
  await assertLinksVisible(ctx, newLinks);

  if (Object.keys(patch).length === 0) return;
  const after = { ...before, ...patch };
  const changes = diffChanges(before, after, UPDATABLE_FIELDS);
  const linksOrLevelChanged =
    "processId" in patch || "occurrenceId" in patch || "contractId" in patch || "confidentiality" in patch;

  await getDb().transaction(async (tx) => {
    const updated = await tx
      .update(documents)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(documents.id, id), eq(documents.organizationId, ctx.organizationId), isNull(documents.deletedAt)))
      .returning({ id: documents.id });
    if (updated.length === 0) throw new NotFoundError();
    await recordAudit(
      ctx,
      {
        action: "document.update",
        entityType: "document",
        entityId: id,
        summary: `Dados do documento "${after.title}" atualizados.`,
        changes,
      },
      tx,
    );
    if (linksOrLevelChanged) {
      await markAnalysesStaleForEntity(
        {
          organizationId: ctx.organizationId,
          entityId: id,
          reason: "Os vínculos ou a confidencialidade de um documento usado na análise foram alterados.",
        },
        tx,
      );
      await markCaseBriefsStale(
        {
          organizationId: ctx.organizationId,
          documentId: id,
          processId: "processId" in patch ? (patch.processId ?? null) : null,
          reason: "Os vínculos ou a confidencialidade de um documento do processo foram alterados.",
        },
        tx,
      );
    }
  });
}

/** Soft delete (`document:delete`). Blocked while the document is under legal hold. */
export async function deleteDocument(ctx: AuthContext, documentId: string): Promise<void> {
  assertCan(ctx, "document:delete");
  const id = parseId(documentId);
  const doc = await loadVisibleDocument(ctx, id);
  if (doc.legalHold) {
    throw new ConflictError("Este documento está sob preservação legal (legal hold) e não pode ser excluído.");
  }
  await getDb().transaction(async (tx) => {
    const updated = await tx
      .update(documents)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.organizationId, ctx.organizationId),
          isNull(documents.deletedAt),
          eq(documents.legalHold, false),
        ),
      )
      .returning({ id: documents.id });
    if (updated.length === 0) throw new NotFoundError();
    await recordAudit(
      ctx,
      {
        action: "document.delete",
        entityType: "document",
        entityId: id,
        summary: `Documento "${doc.title}" excluído.`,
        metadata: { versions: doc.currentVersionNumber },
      },
      tx,
    );
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: id, reason: "Um documento usado na análise foi excluído." },
      tx,
    );
    await markCaseBriefsStale(
      { organizationId: ctx.organizationId, documentId: id, reason: `O documento "${doc.title}" usado na análise foi excluído.` },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listDocuments(
  ctx: AuthContext,
  filters: { q?: string; category?: DocumentCategory; processId?: string; occurrenceId?: string; contractId?: string } & Page,
): Promise<Paginated<DocumentListItem>> {
  assertCan(ctx, "document:read");
  const f = parseOrThrow(listDocumentsSchema, filters ?? {});
  const { page, pageSize, offset } = normalizePage(f);
  const db = getDb();

  const conds: (SQL | undefined)[] = [documentWhere(ctx)];
  if (f.category) conds.push(eq(documents.category, f.category));
  if (f.processId) conds.push(eq(documents.processId, f.processId));
  if (f.occurrenceId) conds.push(eq(documents.occurrenceId, f.occurrenceId));
  if (f.contractId) conds.push(eq(documents.contractId, f.contractId));
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`;
    conds.push(or(ilike(documents.title, pattern), ilike(documents.description, pattern), ilike(documentVersions.fileName, pattern)));
  }
  const where = and(...conds);
  const currentVersionJoin = and(
    eq(documentVersions.id, documents.currentVersionId),
    eq(documentVersions.documentId, documents.id),
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: documents.id,
        title: documents.title,
        category: documents.category,
        confidentiality: documents.confidentiality,
        legalHold: documents.legalHold,
        processId: documents.processId,
        occurrenceId: documents.occurrenceId,
        contractId: documents.contractId,
        currentVersionId: documents.currentVersionId,
        currentVersionNumber: documents.currentVersionNumber,
        fileName: documentVersions.fileName,
        mimeType: documentVersions.mimeType,
        sizeBytes: documentVersions.sizeBytes,
        extractionStatus: documentVersions.extractionStatus,
        uploadedByName: users.name,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .leftJoin(documentVersions, currentVersionJoin)
      .leftJoin(users, and(eq(users.id, documents.uploadedById), eq(users.organizationId, ctx.organizationId)))
      .where(where)
      .orderBy(desc(documents.updatedAt), desc(documents.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(documents).leftJoin(documentVersions, currentVersionJoin).where(where),
  ]);

  const linksOf = await resolveLinks(ctx, rows);
  return {
    items: rows.map(({ processId, occurrenceId, contractId, ...r }) => ({
      ...r,
      links: linksOf({ processId, occurrenceId, contractId }),
    })),
    total: Number(total),
    page,
    pageSize,
  };
}

export async function getDocument(ctx: AuthContext, documentId: string): Promise<DocumentDetail> {
  assertCan(ctx, "document:read");
  const id = parseId(documentId);
  const db = getDb();
  const [doc] = await db
    .select({ doc: documents, uploadedByName: users.name })
    .from(documents)
    .leftJoin(users, and(eq(users.id, documents.uploadedById), eq(users.organizationId, ctx.organizationId)))
    .where(and(eq(documents.id, id), documentWhere(ctx)))
    .limit(1);
  if (!doc) throw new NotFoundError();
  const d = doc.doc;

  const versionRows = await db
    .select({
      id: documentVersions.id,
      versionNumber: documentVersions.versionNumber,
      fileName: documentVersions.fileName,
      mimeType: documentVersions.mimeType,
      sizeBytes: documentVersions.sizeBytes,
      sha256: documentVersions.sha256,
      extractionStatus: documentVersions.extractionStatus,
      extractedAt: documentVersions.extractedAt,
      pageCount: documentVersions.pageCount,
      changeNote: documentVersions.changeNote,
      uploadedByName: users.name,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .leftJoin(users, and(eq(users.id, documentVersions.uploadedById), eq(users.organizationId, ctx.organizationId)))
    .where(and(eq(documentVersions.documentId, d.id), eq(documentVersions.organizationId, ctx.organizationId)))
    .orderBy(desc(documentVersions.versionNumber));

  let textPreview: DocumentTextPreview | null = null;
  if (d.currentVersionId) {
    const [preview] = await db
      .select({
        versionNumber: documentVersions.versionNumber,
        text: sql<string>`left(${documentVersions.extractedText}, ${TEXT_PREVIEW_CHARS})`,
        totalChars: sql<number>`char_length(${documentVersions.extractedText})`,
      })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.id, d.currentVersionId),
          eq(documentVersions.documentId, d.id),
          eq(documentVersions.organizationId, ctx.organizationId),
          eq(documentVersions.extractionStatus, "succeeded"),
        ),
      )
      .limit(1);
    if (preview && preview.text) {
      const totalChars = Number(preview.totalChars ?? 0);
      textPreview = {
        versionNumber: preview.versionNumber,
        text: preview.text,
        totalChars,
        truncated: totalChars > TEXT_PREVIEW_CHARS,
      };
    }
  }

  const linksOf = await resolveLinks(ctx, [d]);
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    category: d.category,
    confidentiality: d.confidentiality,
    processId: d.processId,
    occurrenceId: d.occurrenceId,
    contractId: d.contractId,
    links: linksOf(d),
    currentVersionId: d.currentVersionId,
    currentVersionNumber: d.currentVersionNumber,
    uploadedById: d.uploadedById,
    uploadedByName: doc.uploadedByName,
    retentionUntil: d.retentionUntil,
    legalHold: d.legalHold,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    versions: versionRows.map((v) => ({ ...v, isCurrent: v.id === d.currentVersionId })),
    textPreview,
  };
}

/**
 * Opens a version for download after checking that the document is visible
 * and that the version belongs to it. Audits "document.download".
 */
export async function openDocumentVersion(
  ctx: AuthContext,
  documentId: string,
  versionId: string,
): Promise<{ fileName: string; mimeType: string; sizeBytes: number; stream: ReadableStream<Uint8Array> }> {
  assertCan(ctx, "document:read");
  const docId = parseId(documentId);
  const verId = parseId(versionId);
  const [row] = await getDb()
    .select({
      title: documents.title,
      versionNumber: documentVersions.versionNumber,
      fileName: documentVersions.fileName,
      mimeType: documentVersions.mimeType,
      sizeBytes: documentVersions.sizeBytes,
      storageKey: documentVersions.storageKey,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(
      and(
        eq(documentVersions.id, verId),
        eq(documentVersions.documentId, docId),
        eq(documentVersions.organizationId, ctx.organizationId),
        eq(documents.id, docId),
        documentWhere(ctx),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError();

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await getStorage().getStream(row.storageKey);
  } catch (err) {
    if (err instanceof StorageObjectNotFoundError || err instanceof InvalidStorageKeyError) {
      logger.error("document_blob_missing", { documentId: docId, versionId: verId });
      throw new NotFoundError("O arquivo desta versão não está disponível no armazenamento.");
    }
    throw err;
  }

  await recordAudit(ctx, {
    action: "document.download",
    entityType: "document",
    entityId: docId,
    summary: `Download da versão ${row.versionNumber} do documento "${row.title}".`,
    metadata: { versionId: verId, versionNumber: row.versionNumber, fileName: row.fileName },
  });

  return { fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes, stream };
}

export type DocumentPageText = {
  documentId: string;
  versionId: string;
  title: string;
  versionNumber: number;
  fileName: string;
  /** Requested page, or null when the version has no page information (whole text returned). */
  page: number | null;
  pageCount: number | null;
  /** UNTRUSTED content: render as plain text. */
  text: string;
  /** True when the text was cut at PAGE_TEXT_MAX_CHARS. */
  truncated: boolean;
};

export const PAGE_TEXT_MAX_CHARS = 20_000;

/**
 * Extracted text of ONE page of a document version (used to show the page a
 * citation points to). Checks `document:read`, the document's visibility and
 * that the version belongs to it. Versions without page offsets (non-PDF)
 * return their whole text with `page = null`.
 */
export async function getDocumentVersionPageText(
  ctx: AuthContext,
  documentId: string,
  versionId: string,
  page: number | null,
): Promise<DocumentPageText> {
  assertCan(ctx, "document:read");
  const docId = parseId(documentId);
  const verId = parseId(versionId);
  const [row] = await getDb()
    .select({
      title: documents.title,
      versionNumber: documentVersions.versionNumber,
      fileName: documentVersions.fileName,
      extractionStatus: documentVersions.extractionStatus,
      text: documentVersions.extractedText,
      pageCount: documentVersions.pageCount,
      pageOffsets: documentVersions.pageOffsets,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(
      and(
        eq(documentVersions.id, verId),
        eq(documentVersions.documentId, docId),
        eq(documentVersions.organizationId, ctx.organizationId),
        documentWhere(ctx),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError();
  if (row.extractionStatus !== "succeeded" || !row.text) {
    throw new NotFoundError("O texto desta versão do documento não está disponível.");
  }

  const full = row.text;
  const offsets = Array.isArray(row.pageOffsets) ? row.pageOffsets : null;
  let text = full;
  let resolvedPage: number | null = null;
  if (offsets && offsets.length > 0 && page !== null) {
    if (!Number.isInteger(page) || page < 1 || page > offsets.length) {
      throw new ValidationError("Página inexistente neste documento.", { page: ["Página inexistente neste documento."] });
    }
    const start = offsets[page - 1];
    const end = page < offsets.length ? offsets[page] : full.length;
    text = full.slice(start, end).replace(/\s+$/, "");
    resolvedPage = page;
  }
  const truncated = text.length > PAGE_TEXT_MAX_CHARS;
  return {
    documentId: docId,
    versionId: verId,
    title: row.title,
    versionNumber: row.versionNumber,
    fileName: row.fileName,
    page: resolvedPage,
    pageCount: row.pageCount ?? (offsets ? offsets.length : null),
    text: truncated ? text.slice(0, PAGE_TEXT_MAX_CHARS) : text,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Text extraction (system — called by the "document.extract_text" job)
// ---------------------------------------------------------------------------

/**
 * Extracts the text of a version and stores it. Idempotent: versions already
 * processed (succeeded/unsupported) are skipped. Transient storage errors are
 * rethrown so the queue retries; parse errors mark the version as `failed`.
 */
export async function extractDocumentVersionText(versionId: string): Promise<void> {
  const parsed = idSchema.safeParse(versionId);
  if (!parsed.success) throw new ValidationError("Versão de documento inválida.");
  const db = getDb();
  const [v] = await db
    .select({
      id: documentVersions.id,
      documentId: documentVersions.documentId,
      storageKey: documentVersions.storageKey,
      mimeType: documentVersions.mimeType,
      sizeBytes: documentVersions.sizeBytes,
      extractionStatus: documentVersions.extractionStatus,
      documentDeletedAt: documents.deletedAt,
    })
    .from(documentVersions)
    .innerJoin(
      documents,
      and(eq(documents.id, documentVersions.documentId), eq(documents.organizationId, documentVersions.organizationId)),
    )
    .where(eq(documentVersions.id, parsed.data))
    .limit(1);
  if (!v) {
    logger.warn("extract_text_version_not_found", { versionId: parsed.data });
    return;
  }
  if (v.extractionStatus === "succeeded" || v.extractionStatus === "unsupported") return;
  if (v.documentDeletedAt) return;

  const markStatus = async (
    status: TextExtractionStatus,
    text: string | null,
    pages: { pageCount?: number | null; pageOffsets?: number[] | null } = {},
  ) => {
    await db
      .update(documentVersions)
      .set({
        extractionStatus: status,
        extractedText: text,
        extractedAt: new Date(),
        pageCount: pages.pageCount ?? null,
        // Offsets only make sense together with the stored text.
        pageOffsets: text !== null && pages.pageOffsets?.length ? pages.pageOffsets : null,
      })
      .where(and(eq(documentVersions.id, v.id), ne(documentVersions.extractionStatus, "succeeded")));
  };

  let bytes: Uint8Array;
  try {
    const stream = await getStorage().getStream(v.storageKey);
    bytes = await readStreamToBytes(stream, Math.max(v.sizeBytes, uploadLimitBytes()));
  } catch (err) {
    if (
      err instanceof StorageObjectNotFoundError ||
      err instanceof InvalidStorageKeyError ||
      err instanceof StorageReadLimitError
    ) {
      logger.error("extract_text_blob_unavailable", { versionId: v.id, reason: err.name });
      await markStatus("failed", null);
      return;
    }
    throw err; // transient (I/O) — let the queue retry
  }

  const result = await extractText(bytes, v.mimeType);
  await markStatus(result.status, result.status === "succeeded" ? (result.text ?? "") : null, {
    pageCount: result.pageCount ?? null,
    pageOffsets: result.pageOffsets ?? null,
  });
  logger.info("document_text_extracted", {
    versionId: v.id,
    status: result.status,
    chars: result.text?.length ?? 0,
    pageCount: result.pageCount ?? null,
  });
}
