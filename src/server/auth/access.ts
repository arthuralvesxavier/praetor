/**
 * Record-level access policy (row visibility). Single source of truth: every
 * service query that reads tenant data MUST include the matching `*Where(ctx)`
 * condition, and single-record reads must query `id AND scope` (returning
 * NotFoundError when nothing comes back, without revealing existence).
 *
 * Rules (documented in docs/SECURITY.md):
 *
 * 1. Organization isolation: every condition starts with
 *    `organization_id = ctx.organizationId`. No exceptions.
 * 2. Soft-deleted rows are never visible.
 * 3. Admin and legal manager: every record of the organization, including
 *    confidential ones.
 * 4. Executive: every NON-confidential record (read-only by permission).
 * 5. Lawyer and analyst: records of their unit (or without unit) that are not
 *    confidential, plus any record where they are the responsible person or
 *    the creator.
 * 6. Tasks and deadlines linked to a process/occurrence/contract inherit the
 *    visibility of that record; unlinked ones follow rule 5 by unit. The
 *    assignee/responsible/creator always sees their own item.
 * 7. Documents inherit the visibility of every record they are linked to and
 *    are further limited by confidentiality:
 *      internal      -> anyone who sees the linked records
 *      confidential  -> admin, legal manager, lawyers (+ uploader)
 *      restricted    -> admin, legal manager, uploader and the responsible
 *                       person of a linked record
 * 8. AI analyses are visible when their subject is visible AND every document
 *    used as a source is visible. Question/answer analyses are private to the
 *    requester.
 * 9. Alerts and comments follow the entity they reference.
 */
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Role } from "@/domain/enums";
import { getDb } from "@/server/db/client";
import {
  aiAnalyses,
  aiAnalysisSources,
  contracts,
  deadlines,
  documents,
  legalProcesses,
  occurrences,
  tasks,
} from "@/server/db/schema";
import type { AuthContext } from "./context";

const ORG_WIDE_ROLES: readonly Role[] = ["admin", "legal_manager", "executive"];
const CONFIDENTIAL_ROLES: readonly Role[] = ["admin", "legal_manager"];

/** Sees every non-confidential record of the organization. */
export function hasOrganizationWideScope(ctx: AuthContext): boolean {
  return ctx.kind === "system" || ORG_WIDE_ROLES.includes(ctx.role);
}

/** Sees everything, including confidential and restricted records. */
export function seesConfidential(ctx: AuthContext): boolean {
  return ctx.kind === "system" || CONFIDENTIAL_ROLES.includes(ctx.role);
}

const FALSE = sql`false`;
const TRUE = sql`true`;

function all(...conds: (SQL | undefined)[]): SQL {
  return and(...conds) ?? TRUE;
}
function any(...conds: (SQL | undefined)[]): SQL {
  return or(...conds) ?? FALSE;
}

function unitCondition(ctx: AuthContext, unitCol: AnyPgColumn): SQL {
  return ctx.unitId ? any(isNull(unitCol), eq(unitCol, ctx.unitId)) : isNull(unitCol);
}

// ---------------------------------------------------------------------------
// Scoped records: legal processes, occurrences, contracts
// ---------------------------------------------------------------------------

type ScopedTable = {
  organizationId: AnyPgColumn;
  unitId: AnyPgColumn;
  responsibleId: AnyPgColumn;
  createdById: AnyPgColumn;
  isConfidential: AnyPgColumn;
  deletedAt: AnyPgColumn;
};

export function scopedRecordWhere(ctx: AuthContext, t: ScopedTable): SQL {
  const base = all(eq(t.organizationId, ctx.organizationId), isNull(t.deletedAt));
  if (seesConfidential(ctx)) return base;
  const own = ctx.userId ? any(eq(t.responsibleId, ctx.userId), eq(t.createdById, ctx.userId)) : FALSE;
  const visible = hasOrganizationWideScope(ctx)
    ? eq(t.isConfidential, false)
    : all(eq(t.isConfidential, false), unitCondition(ctx, t.unitId));
  return all(base, any(own, visible));
}

export const processWhere = (ctx: AuthContext) => scopedRecordWhere(ctx, legalProcesses);
export const occurrenceWhere = (ctx: AuthContext) => scopedRecordWhere(ctx, occurrences);
export const contractWhere = (ctx: AuthContext) => scopedRecordWhere(ctx, contracts);

export const visibleProcessIds = (ctx: AuthContext) =>
  getDb().select({ id: legalProcesses.id }).from(legalProcesses).where(processWhere(ctx));
export const visibleOccurrenceIds = (ctx: AuthContext) =>
  getDb().select({ id: occurrences.id }).from(occurrences).where(occurrenceWhere(ctx));
export const visibleContractIds = (ctx: AuthContext) =>
  getDb().select({ id: contracts.id }).from(contracts).where(contractWhere(ctx));

/** In-memory equivalent of `scopedRecordWhere` (for already-loaded rows and tests). */
export function canViewScopedRecord(
  ctx: AuthContext,
  r: {
    organizationId: string;
    unitId: string | null;
    responsibleId: string | null;
    createdById: string | null;
    isConfidential: boolean;
    deletedAt?: Date | null;
  },
): boolean {
  if (r.organizationId !== ctx.organizationId || r.deletedAt) return false;
  if (seesConfidential(ctx)) return true;
  if (ctx.userId && (r.responsibleId === ctx.userId || r.createdById === ctx.userId)) return true;
  if (r.isConfidential) return false;
  if (hasOrganizationWideScope(ctx)) return true;
  return r.unitId === null || r.unitId === ctx.unitId;
}

// ---------------------------------------------------------------------------
// Parent-linked items: tasks, deadlines, documents
// ---------------------------------------------------------------------------

type LinkedColumns = { processId: AnyPgColumn; occurrenceId: AnyPgColumn; contractId: AnyPgColumn };

function parentsVisible(ctx: AuthContext, t: LinkedColumns): SQL {
  return all(
    any(isNull(t.processId), inArray(t.processId, visibleProcessIds(ctx))),
    any(isNull(t.occurrenceId), inArray(t.occurrenceId, visibleOccurrenceIds(ctx))),
    any(isNull(t.contractId), inArray(t.contractId, visibleContractIds(ctx))),
  );
}

function hasParent(t: LinkedColumns): SQL {
  return any(isNotNull(t.processId), isNotNull(t.occurrenceId), isNotNull(t.contractId));
}

function workItemWhere(
  ctx: AuthContext,
  t: LinkedColumns & {
    organizationId: AnyPgColumn;
    deletedAt: AnyPgColumn;
    unitId: AnyPgColumn;
    createdById: AnyPgColumn;
    person: AnyPgColumn;
  },
): SQL {
  const base = all(eq(t.organizationId, ctx.organizationId), isNull(t.deletedAt));
  if (seesConfidential(ctx)) return base;
  const own = ctx.userId ? any(eq(t.person, ctx.userId), eq(t.createdById, ctx.userId)) : FALSE;
  const visible = hasOrganizationWideScope(ctx)
    ? parentsVisible(ctx, t)
    : any(
        all(hasParent(t), parentsVisible(ctx, t)),
        all(sql`not (${hasParent(t)})`, unitCondition(ctx, t.unitId)),
      );
  return all(base, any(own, visible));
}

export const taskWhere = (ctx: AuthContext) => workItemWhere(ctx, { ...pick(tasks), person: tasks.assigneeId });
export const deadlineWhere = (ctx: AuthContext) =>
  workItemWhere(ctx, { ...pick(deadlines), person: deadlines.responsibleId });

function pick(t: typeof tasks | typeof deadlines) {
  return {
    organizationId: t.organizationId,
    deletedAt: t.deletedAt,
    unitId: t.unitId,
    createdById: t.createdById,
    processId: t.processId,
    occurrenceId: t.occurrenceId,
    contractId: t.contractId,
  };
}

export function documentWhere(ctx: AuthContext): SQL {
  const d = documents;
  const base = all(eq(d.organizationId, ctx.organizationId), isNull(d.deletedAt));
  if (seesConfidential(ctx)) return base;
  if (!ctx.userId) return FALSE;
  const me = ctx.userId;

  const responsibleOfParent = any(
    inArray(
      d.processId,
      getDb().select({ id: legalProcesses.id }).from(legalProcesses).where(eq(legalProcesses.responsibleId, me)),
    ),
    inArray(
      d.occurrenceId,
      getDb().select({ id: occurrences.id }).from(occurrences).where(eq(occurrences.responsibleId, me)),
    ),
    inArray(d.contractId, getDb().select({ id: contracts.id }).from(contracts).where(eq(contracts.responsibleId, me))),
  );

  const levelOk = any(
    eq(d.confidentiality, "internal"),
    ctx.role === "lawyer" ? eq(d.confidentiality, "confidential") : undefined,
    all(eq(d.confidentiality, "restricted"), responsibleOfParent),
  );

  const linksOk = parentsVisible(ctx, d);
  // Unlinked documents: visible org-wide (subject to confidentiality level).
  return all(base, any(eq(d.uploadedById, me), all(linksOk, levelOk)));
}

export const visibleDocumentIds = (ctx: AuthContext) =>
  getDb().select({ id: documents.id }).from(documents).where(documentWhere(ctx));
export const visibleTaskIds = (ctx: AuthContext) =>
  getDb().select({ id: tasks.id }).from(tasks).where(taskWhere(ctx));
export const visibleDeadlineIds = (ctx: AuthContext) =>
  getDb().select({ id: deadlines.id }).from(deadlines).where(deadlineWhere(ctx));

// ---------------------------------------------------------------------------
// AI analyses
// ---------------------------------------------------------------------------

export function analysisWhere(ctx: AuthContext): SQL {
  const a = aiAnalyses;
  const base = eq(a.organizationId, ctx.organizationId);
  if (ctx.kind === "system") return base;

  const isQa = eq(a.type, "question_answer");
  const qaVisible = ctx.userId ? all(isQa, eq(a.requestedById, ctx.userId)) : FALSE;

  const subjectVisible = any(
    all(eq(a.subjectType, "legal_process"), inArray(a.subjectId, visibleProcessIds(ctx))),
    all(eq(a.subjectType, "occurrence"), inArray(a.subjectId, visibleOccurrenceIds(ctx))),
    all(eq(a.subjectType, "contract"), inArray(a.subjectId, visibleContractIds(ctx))),
    all(eq(a.subjectType, "document"), inArray(a.subjectId, visibleDocumentIds(ctx))),
    hasOrganizationWideScope(ctx) ? eq(a.subjectType, "organization") : undefined,
  );

  const allSourcesVisible = seesConfidential(ctx)
    ? TRUE
    : notExists(
        getDb()
          .select({ one: sql`1` })
          .from(aiAnalysisSources)
          .where(
            all(
              eq(aiAnalysisSources.analysisId, a.id),
              eq(aiAnalysisSources.sourceType, "document_version"),
              notInArray(aiAnalysisSources.entityId, visibleDocumentIds(ctx)),
            ),
          ),
      );

  return all(base, any(qaVisible, all(sql`not (${isQa})`, subjectVisible, allSourcesVisible)));
}

export const visibleAnalysisIds = (ctx: AuthContext) =>
  getDb().select({ id: aiAnalyses.id }).from(aiAnalyses).where(analysisWhere(ctx));

// ---------------------------------------------------------------------------
// Polymorphic references (alerts, comments)
// ---------------------------------------------------------------------------

/** Visibility for rows that reference an entity through (entity_type, entity_id) columns. */
export function entityReferenceWhere(ctx: AuthContext, typeCol: AnyPgColumn, idCol: AnyPgColumn): SQL {
  return any(
    all(eq(typeCol, "legal_process"), inArray(idCol, visibleProcessIds(ctx))),
    all(eq(typeCol, "occurrence"), inArray(idCol, visibleOccurrenceIds(ctx))),
    all(eq(typeCol, "contract"), inArray(idCol, visibleContractIds(ctx))),
    all(eq(typeCol, "document"), inArray(idCol, visibleDocumentIds(ctx))),
    all(eq(typeCol, "task"), inArray(idCol, visibleTaskIds(ctx))),
    all(eq(typeCol, "deadline"), inArray(idCol, visibleDeadlineIds(ctx))),
    all(eq(typeCol, "analysis"), inArray(idCol, visibleAnalysisIds(ctx))),
  );
}
