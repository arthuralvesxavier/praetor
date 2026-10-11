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
 * 4. Executive, accountant and auditor: every NON-confidential record
 *    (what they can do with it depends on their permissions).
 * 5. Lawyer and analyst: records of their unit (or without unit) that are not
 *    confidential, plus any record where they are the responsible person or
 *    the creator.
 * 6. Tasks and deadlines linked to a process/occurrence/contract inherit the
 *    visibility of that record; unlinked ones follow rule 5 by unit. The
 *    assignee/responsible/creator always sees their own item.
 * 7. Documents inherit the visibility of every record they are linked to and
 *    are further limited by confidentiality:
 *      internal      -> anyone who sees the linked records
 *      confidential  -> admin, legal manager, lawyers, external counsel (+ uploader)
 *      restricted    -> admin, legal manager, uploader and the responsible
 *                       person of a linked record
 * 8. AI analyses are visible when their subject is visible AND every document
 *    used as a source is visible. Question/answer analyses are private to the
 *    requester.
 * 9. Alerts and comments follow the entity they reference.
 * 10. External counsel (escritório externo) has NO unit scope: they see only
 *     processes assigned to their law firm (`legal_processes.law_firm_id =
 *     users.law_firm_id`, confidential included — the firm is the patron of
 *     the case) and records where they are responsible/creator. Occurrences
 *     and contracts only when they are responsible/creator (RF-21).
 * 11. Process-owned records (instances, valuations, guarantees, risk
 *     assessments, settlements, hearings, intakes) inherit the visibility of
 *     the process. Case briefs additionally require every source document to
 *     be visible (like rule 8).
 * 12. Documents of category `sensitive_health` (atestado, laudo, CAT — PD-04)
 *     are limited to admins, legal managers, the uploader and the responsible
 *     person of a linked record (or the external firm of a linked process).
 * 13. Simulated e-mails: admins/legal managers see all; others see messages
 *     addressed to them or triggered by them, and messages about a process
 *     (and brief) they can see.
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
  caseBriefSources,
  caseBriefs,
  caseIntakes,
  contracts,
  deadlines,
  documents,
  emailMessages,
  hearings,
  legalProcesses,
  occurrences,
  processGuarantees,
  processRiskAssessments,
  processValuations,
  settlements,
  tasks,
} from "@/server/db/schema";
import type { AuthContext } from "./context";

const ORG_WIDE_ROLES: readonly Role[] = ["admin", "legal_manager", "executive", "accountant", "auditor"];
const CONFIDENTIAL_ROLES: readonly Role[] = ["admin", "legal_manager"];
/** Roles allowed to read `confidential` documents of records they can see. */
const CONFIDENTIAL_DOCUMENT_ROLES: readonly Role[] = ["lawyer", "external_counsel"];

/** Sees every non-confidential record of the organization. */
export function hasOrganizationWideScope(ctx: AuthContext): boolean {
  return ctx.kind === "system" || ORG_WIDE_ROLES.includes(ctx.role);
}

/** Sees everything, including confidential and restricted records. */
export function seesConfidential(ctx: AuthContext): boolean {
  return ctx.kind === "system" || CONFIDENTIAL_ROLES.includes(ctx.role);
}

/** External law firm user: scoped by law firm, never by unit. */
export function isExternalCounsel(ctx: AuthContext): boolean {
  return ctx.kind === "user" && ctx.role === "external_counsel";
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
  if (isExternalCounsel(ctx)) return FALSE;
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
  /** Only legal processes have a law firm (rule 10). */
  lawFirmId?: AnyPgColumn;
};

export function scopedRecordWhere(ctx: AuthContext, t: ScopedTable): SQL {
  const base = all(eq(t.organizationId, ctx.organizationId), isNull(t.deletedAt));
  if (seesConfidential(ctx)) return base;
  const own = ctx.userId ? any(eq(t.responsibleId, ctx.userId), eq(t.createdById, ctx.userId)) : FALSE;
  if (isExternalCounsel(ctx)) {
    const firm = ctx.lawFirmId && t.lawFirmId ? eq(t.lawFirmId, ctx.lawFirmId) : FALSE;
    return all(base, any(own, firm));
  }
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
    lawFirmId?: string | null;
  },
): boolean {
  if (r.organizationId !== ctx.organizationId || r.deletedAt) return false;
  if (seesConfidential(ctx)) return true;
  if (ctx.userId && (r.responsibleId === ctx.userId || r.createdById === ctx.userId)) return true;
  if (isExternalCounsel(ctx)) return !!ctx.lawFirmId && r.lawFirmId === ctx.lawFirmId;
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
    isExternalCounsel(ctx) && ctx.lawFirmId
      ? inArray(
          d.processId,
          getDb()
            .select({ id: legalProcesses.id })
            .from(legalProcesses)
            .where(eq(legalProcesses.lawFirmId, ctx.lawFirmId)),
        )
      : undefined,
    inArray(
      d.occurrenceId,
      getDb().select({ id: occurrences.id }).from(occurrences).where(eq(occurrences.responsibleId, me)),
    ),
    inArray(d.contractId, getDb().select({ id: contracts.id }).from(contracts).where(eq(contracts.responsibleId, me))),
  );

  const levelOk = any(
    eq(d.confidentiality, "internal"),
    CONFIDENTIAL_DOCUMENT_ROLES.includes(ctx.role) ? eq(d.confidentiality, "confidential") : undefined,
    all(eq(d.confidentiality, "restricted"), responsibleOfParent),
  );
  // Rule 12 (PD-04): health documents only for the responsible person of a linked record.
  const categoryOk = any(sql`${d.category} <> 'sensitive_health'`, responsibleOfParent);

  const linksOk = parentsVisible(ctx, d);
  // Unlinked documents: visible org-wide (subject to confidentiality level).
  return all(base, any(eq(d.uploadedById, me), all(linksOk, levelOk, categoryOk)));
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
// Process-owned records (rule 11)
// ---------------------------------------------------------------------------

/**
 * Rows that belong to a process: organization + visible (and not deleted)
 * process + not soft-deleted themselves when the table has `deleted_at`.
 */
export function processChildWhere(
  ctx: AuthContext,
  t: { organizationId: AnyPgColumn; processId: AnyPgColumn; deletedAt?: AnyPgColumn },
): SQL {
  return all(
    eq(t.organizationId, ctx.organizationId),
    t.deletedAt ? isNull(t.deletedAt) : undefined,
    inArray(t.processId, visibleProcessIds(ctx)),
  );
}

export const valuationWhere = (ctx: AuthContext) => processChildWhere(ctx, processValuations);
export const guaranteeWhere = (ctx: AuthContext) => processChildWhere(ctx, processGuarantees);
export const riskAssessmentWhere = (ctx: AuthContext) => processChildWhere(ctx, processRiskAssessments);
export const settlementWhere = (ctx: AuthContext) => processChildWhere(ctx, settlements);
export const hearingWhere = (ctx: AuthContext) => processChildWhere(ctx, hearings);
export const intakeWhere = (ctx: AuthContext) => processChildWhere(ctx, caseIntakes);

export const visibleHearingIds = (ctx: AuthContext) =>
  getDb().select({ id: hearings.id }).from(hearings).where(hearingWhere(ctx));
export const visibleSettlementIds = (ctx: AuthContext) =>
  getDb().select({ id: settlements.id }).from(settlements).where(settlementWhere(ctx));
export const visibleValuationIds = (ctx: AuthContext) =>
  getDb().select({ id: processValuations.id }).from(processValuations).where(valuationWhere(ctx));
export const visibleGuaranteeIds = (ctx: AuthContext) =>
  getDb().select({ id: processGuarantees.id }).from(processGuarantees).where(guaranteeWhere(ctx));
export const visibleIntakeIds = (ctx: AuthContext) =>
  getDb().select({ id: caseIntakes.id }).from(caseIntakes).where(intakeWhere(ctx));

/** Case briefs: process visible AND every source document visible. */
export function caseBriefWhere(ctx: AuthContext): SQL {
  const b = caseBriefs;
  const base = processChildWhere(ctx, b);
  if (seesConfidential(ctx)) return base;
  return all(
    base,
    notExists(
      getDb()
        .select({ one: sql`1` })
        .from(caseBriefSources)
        .where(
          all(
            eq(caseBriefSources.briefId, b.id),
            eq(caseBriefSources.sourceType, "document_version"),
            notInArray(caseBriefSources.entityId, visibleDocumentIds(ctx)),
          ),
        ),
    ),
  );
}

export const visibleCaseBriefIds = (ctx: AuthContext) =>
  getDb().select({ id: caseBriefs.id }).from(caseBriefs).where(caseBriefWhere(ctx));

/** Simulated e-mails (rule 13). */
export function emailWhere(ctx: AuthContext): SQL {
  const m = emailMessages;
  const base = eq(m.organizationId, ctx.organizationId);
  if (seesConfidential(ctx)) return base;
  const mine = ctx.userId ? any(eq(m.toUserId, ctx.userId), eq(m.triggeredById, ctx.userId)) : FALSE;
  const aboutVisible = all(
    isNotNull(m.processId),
    inArray(m.processId, visibleProcessIds(ctx)),
    any(isNull(m.briefId), inArray(m.briefId, visibleCaseBriefIds(ctx))),
  );
  return all(base, any(mine, aboutVisible));
}

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
    all(eq(typeCol, "hearing"), inArray(idCol, visibleHearingIds(ctx))),
    all(eq(typeCol, "settlement"), inArray(idCol, visibleSettlementIds(ctx))),
    all(eq(typeCol, "valuation"), inArray(idCol, visibleValuationIds(ctx))),
    all(eq(typeCol, "guarantee"), inArray(idCol, visibleGuaranteeIds(ctx))),
    all(eq(typeCol, "case_brief"), inArray(idCol, visibleCaseBriefIds(ctx))),
    all(eq(typeCol, "intake"), inArray(idCol, visibleIntakeIds(ctx))),
  );
}
