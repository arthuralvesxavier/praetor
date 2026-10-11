import { and, asc, count, desc, eq, gte, ilike, inArray, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type {
  DataOrigin,
  DeadlineKind,
  DeadlineStatus,
  Priority,
  TaskKind,
  TaskStatus,
  ValidationStatus,
} from "@/domain/enums";
import { entityHref, normalizePage, type LinkableEntityType, type Page, type Paginated } from "@/domain/entities";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  analysisWhere,
  contractWhere,
  deadlineWhere,
  documentWhere,
  occurrenceWhere,
  processWhere,
  seesConfidential,
  taskWhere,
} from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  aiAnalyses,
  contracts,
  deadlines,
  DEFAULT_ORGANIZATION_SETTINGS,
  documents,
  legalProcesses,
  occurrences,
  organizations,
  tasks,
  units,
  users,
} from "@/server/db/schema";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { monthRange } from "./calendar";
import {
  CLOSED_TASK_STATUSES,
  createTaskSchema,
  deadlineFiltersSchema,
  deadlineInputSchema,
  deadlineStatusSchema,
  monthSchema,
  suggestedDeadlineInputSchema,
  taskFiltersSchema,
  taskPatchSchema,
  validateDeadlineSchema,
  type DeadlineInput,
  type DeadlineSituation,
  type SuggestedDeadlineInput,
  type TaskInput,
  type TaskPatch,
  type ValidateDeadlineInput,
} from "./schemas";
import type { WorkLinkOptions, WorkUserOption } from "./types";

/**
 * Deadlines (prazos) and tasks (tarefas).
 *
 * Rules:
 * - Row visibility: `deadlineWhere` / `taskWhere` on every read and before every write.
 * - Linked records (process / occurrence / contract / document) must be visible to ctx;
 *   responsible / assignee must be an active user of the organization.
 * - AI-suggested deadlines are created as `pending_validation` and are NOT real
 *   deadlines until validated by someone with `deadline:validate`. The situation
 *   filters (overdue / upcoming / open) only consider `not_required | validated`.
 * - The system never computes legal deadlines: dates are typed by a person or
 *   quoted from a source by the AI and then validated by a person.
 */

export type { DeadlineInput, TaskInput } from "./schemas";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WorkLink = {
  type: LinkableEntityType | "document";
  id: string;
  /** null when the linked record is not visible to the current user. */
  label: string | null;
  href: string | null;
};

export type DeadlineListItem = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string;
  kind: DeadlineKind;
  status: DeadlineStatus;
  priority: Priority;
  origin: DataOrigin;
  validationStatus: ValidationStatus;
  responsibleId: string | null;
  responsibleName: string | null;
  unitId: string | null;
  processId: string | null;
  occurrenceId: string | null;
  contractId: string | null;
  links: WorkLink[];
  sourceAnalysisId: string | null;
  /** Whether the current user can open the source analysis. */
  sourceAnalysisVisible: boolean;
  /** Literal passage quoted by the AI; null when the source analysis is not visible to ctx. */
  sourceExcerpt: string | null;
  validatedByName: string | null;
  validatedAt: Date | null;
  validationNote: string | null;
  completedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  /** Manual or validated: counts as a real deadline (dashboards, alerts, situation filters). */
  countsAsDeadline: boolean;
  /** Open real deadline whose date has passed. */
  isOverdue: boolean;
  /** AI suggestion waiting for human validation. */
  isPendingValidation: boolean;
};

export type TaskListItem = {
  id: string;
  title: string;
  description: string | null;
  kind: TaskKind;
  status: TaskStatus;
  priority: Priority;
  dueDate: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  unitId: string | null;
  origin: DataOrigin;
  processId: string | null;
  occurrenceId: string | null;
  contractId: string | null;
  documentId: string | null;
  links: WorkLink[];
  sourceAnalysisId: string | null;
  completedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  isOverdue: boolean;
  /** The current user may delete the task (creator, admin or legal manager). */
  canDelete: boolean;
};

export type DeadlineFilters = {
  q?: string;
  situation?: DeadlineSituation;
  status?: DeadlineStatus;
  responsibleId?: string;
  origin?: DataOrigin;
  validationStatus?: ValidationStatus;
  /** Only manual/validated deadlines (excludes pending and rejected AI suggestions). */
  realOnly?: boolean;
  processId?: string;
  occurrenceId?: string;
  contractId?: string;
  from?: string;
  to?: string;
} & Page;

export type TaskFilters = {
  q?: string;
  status?: TaskStatus;
  assigneeId?: string;
  kind?: TaskKind;
  processId?: string;
  occurrenceId?: string;
  contractId?: string;
  overdue?: boolean;
  activeOnly?: boolean;
} & Page;

export type WorkSummary = {
  overdueDeadlines: number;
  upcomingDeadlines: number;
  openDeadlines: number;
  pendingValidation: number;
  overdueTasks: number;
  openTasks: number;
  upcomingDeadlineDays: number;
};

export type CalendarDeadline = {
  id: string;
  title: string;
  dueDate: string;
  kind: DeadlineKind;
  status: DeadlineStatus;
  priority: Priority;
  origin: DataOrigin;
  validationStatus: ValidationStatus;
  isOverdue: boolean;
  isPendingValidation: boolean;
};

export type CalendarTask = {
  id: string;
  title: string;
  dueDate: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: Priority;
  origin: DataOrigin;
  isOverdue: boolean;
};

export type CalendarData = { month: string; today: string; deadlines: CalendarDeadline[]; tasks: CalendarTask[] };

export type { FixedWorkLink, WorkLinkOptions, WorkUserOption } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REAL_VALIDATION: ValidationStatus[] = ["not_required", "validated"];
const LIST_HARD_LIMIT = 1000;

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(undefined, z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  }
  return result.data;
}

const uuidSchema = z.guid();

/** Ids that are not uuids can never exist: answer as "not found" (and avoid a SQL cast error). */
function parseIdOrNotFound(id: unknown): string {
  const r = uuidSchema.safeParse(id);
  if (!r.success) throw new NotFoundError();
  return r.data;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function countsAsDeadline(validationStatus: ValidationStatus): boolean {
  return validationStatus === "not_required" || validationStatus === "validated";
}

async function loadUpcomingDeadlineDays(ctx: AuthContext, db: DbOrTx = getDb()): Promise<number> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const days = org?.settings?.alerts?.upcomingDeadlineDays;
  return typeof days === "number" && Number.isFinite(days) && days >= 0
    ? Math.min(365, Math.floor(days))
    : DEFAULT_ORGANIZATION_SETTINGS.alerts.upcomingDeadlineDays;
}

type LinkIds = {
  processId?: string | null;
  occurrenceId?: string | null;
  contractId?: string | null;
  documentId?: string | null;
};

/** Every linked record must belong to the organization AND be visible to ctx. Same message either way. */
async function assertLinksVisible(ctx: AuthContext, db: DbOrTx, links: LinkIds): Promise<void> {
  const errors: Record<string, string[]> = {};
  if (links.processId) {
    const [r] = await db
      .select({ id: legalProcesses.id })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, links.processId), processWhere(ctx)))
      .limit(1);
    if (!r) errors.processId = ["Processo não encontrado ou sem permissão de acesso."];
  }
  if (links.occurrenceId) {
    const [r] = await db
      .select({ id: occurrences.id })
      .from(occurrences)
      .where(and(eq(occurrences.id, links.occurrenceId), occurrenceWhere(ctx)))
      .limit(1);
    if (!r) errors.occurrenceId = ["Ocorrência não encontrada ou sem permissão de acesso."];
  }
  if (links.contractId) {
    const [r] = await db
      .select({ id: contracts.id })
      .from(contracts)
      .where(and(eq(contracts.id, links.contractId), contractWhere(ctx)))
      .limit(1);
    if (!r) errors.contractId = ["Contrato não encontrado ou sem permissão de acesso."];
  }
  if (links.documentId) {
    const [r] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, links.documentId), documentWhere(ctx)))
      .limit(1);
    if (!r) errors.documentId = ["Documento não encontrado ou sem permissão de acesso."];
  }
  if (Object.keys(errors).length > 0) {
    throw new ValidationError("O vínculo informado não foi encontrado ou você não tem acesso a ele.", errors);
  }
}

async function assertActiveUser(
  ctx: AuthContext,
  db: DbOrTx,
  userId: string,
  field: string,
): Promise<{ id: string; unitId: string | null }> {
  const [u] = await db
    .select({ id: users.id, unitId: users.unitId })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)))
    .limit(1);
  if (!u) {
    throw new ValidationError("Responsável inválido.", { [field]: ["Selecione um usuário ativo da organização."] });
  }
  return u;
}

async function assertUnit(ctx: AuthContext, db: DbOrTx, unitId: string): Promise<void> {
  const [u] = await db
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.id, unitId), eq(units.organizationId, ctx.organizationId)))
    .limit(1);
  if (!u) throw new ValidationError("Unidade inválida.", { unitId: ["Selecione uma unidade da organização."] });
}

/** unitId: explicit input (validated) → the responsible's unit → ctx.unitId. */
async function resolveUnitId(
  ctx: AuthContext,
  db: DbOrTx,
  unitId: string | null | undefined,
  person: { unitId: string | null } | null,
): Promise<string | null> {
  if (unitId) {
    await assertUnit(ctx, db, unitId);
    return unitId;
  }
  return person?.unitId ?? ctx.unitId ?? null;
}

/** Source analysis of an AI suggestion must exist in the org and be visible to ctx. */
async function assertAnalysisVisible(ctx: AuthContext, db: DbOrTx, analysisId: string): Promise<void> {
  const [a] = await db
    .select({ id: aiAnalyses.id })
    .from(aiAnalyses)
    .where(and(eq(aiAnalyses.id, analysisId), analysisWhere(ctx)))
    .limit(1);
  if (!a) {
    throw new ValidationError("Análise de origem não encontrada.", {
      sourceAnalysisId: ["Análise de origem não encontrada ou sem permissão de acesso."],
    });
  }
}

async function visibleAnalysisIdSet(ctx: AuthContext, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: aiAnalyses.id })
    .from(aiAnalyses)
    .where(and(inArray(aiAnalyses.id, unique), analysisWhere(ctx)));
  return new Set(rows.map((r) => r.id));
}

type LinkColumnsRow = {
  processId: string | null;
  occurrenceId: string | null;
  contractId: string | null;
  documentId?: string | null;
  pId: string | null;
  pNumber: string | null;
  pTitle: string | null;
  oId: string | null;
  oTitle: string | null;
  cId: string | null;
  cTitle: string | null;
  cCounterparty: string | null;
  dId?: string | null;
  dTitle?: string | null;
};

function buildLinks(r: LinkColumnsRow): WorkLink[] {
  const links: WorkLink[] = [];
  if (r.processId) {
    const visible = r.pId !== null;
    links.push({
      type: "legal_process",
      id: r.processId,
      label: visible ? `${r.pNumber} — ${r.pTitle}` : null,
      href: visible ? entityHref({ type: "legal_process", id: r.processId }) : null,
    });
  }
  if (r.occurrenceId) {
    const visible = r.oId !== null;
    links.push({
      type: "occurrence",
      id: r.occurrenceId,
      label: visible ? r.oTitle : null,
      href: visible ? entityHref({ type: "occurrence", id: r.occurrenceId }) : null,
    });
  }
  if (r.contractId) {
    const visible = r.cId !== null;
    links.push({
      type: "contract",
      id: r.contractId,
      label: visible ? `${r.cTitle}${r.cCounterparty ? ` (${r.cCounterparty})` : ""}` : null,
      href: visible ? entityHref({ type: "contract", id: r.contractId }) : null,
    });
  }
  if (r.documentId) {
    const visible = r.dId != null;
    links.push({
      type: "document",
      id: r.documentId,
      label: visible ? (r.dTitle ?? null) : null,
      href: visible ? entityHref({ type: "document", id: r.documentId }) : null,
    });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Deadlines — queries
// ---------------------------------------------------------------------------

const responsibleUser = alias(users, "responsible_user");
const validatorUser = alias(users, "validator_user");
const assigneeUser = alias(users, "assignee_user");

function deadlineSituationCondition(situation: DeadlineSituation, today: string, upcomingDays: number): SQL {
  const real = and(eq(deadlines.status, "open"), inArray(deadlines.validationStatus, REAL_VALIDATION));
  switch (situation) {
    case "overdue":
      return and(real, lt(deadlines.dueDate, today))!;
    case "upcoming":
      return and(real, gte(deadlines.dueDate, today), lte(deadlines.dueDate, addDaysISO(today, upcomingDays)))!;
    case "open":
      return real!;
  }
}

function selectDeadlineRows(ctx: AuthContext, where: SQL | undefined) {
  return getDb()
    .select({
      d: deadlines,
      responsibleName: responsibleUser.name,
      validatedByName: validatorUser.name,
      pId: legalProcesses.id,
      pNumber: legalProcesses.number,
      pTitle: legalProcesses.title,
      oId: occurrences.id,
      oTitle: occurrences.title,
      cId: contracts.id,
      cTitle: contracts.title,
      cCounterparty: contracts.counterparty,
    })
    .from(deadlines)
    .leftJoin(
      responsibleUser,
      and(eq(responsibleUser.id, deadlines.responsibleId), eq(responsibleUser.organizationId, ctx.organizationId)),
    )
    .leftJoin(
      validatorUser,
      and(eq(validatorUser.id, deadlines.validatedById), eq(validatorUser.organizationId, ctx.organizationId)),
    )
    .leftJoin(legalProcesses, and(eq(legalProcesses.id, deadlines.processId), processWhere(ctx)))
    .leftJoin(occurrences, and(eq(occurrences.id, deadlines.occurrenceId), occurrenceWhere(ctx)))
    .leftJoin(contracts, and(eq(contracts.id, deadlines.contractId), contractWhere(ctx)))
    .where(where);
}

type DeadlineRow = Awaited<ReturnType<typeof selectDeadlineRows>>[number];

async function mapDeadlineRows(ctx: AuthContext, rows: DeadlineRow[], today: string): Promise<DeadlineListItem[]> {
  const visibleAnalyses = await visibleAnalysisIdSet(
    ctx,
    rows.map((r) => r.d.sourceAnalysisId).filter((id): id is string => Boolean(id)),
  );
  return rows.map((r) => {
    const d = r.d;
    const real = countsAsDeadline(d.validationStatus);
    const analysisVisible = d.sourceAnalysisId ? visibleAnalyses.has(d.sourceAnalysisId) : false;
    return {
      id: d.id,
      title: d.title,
      description: d.description,
      dueDate: d.dueDate,
      kind: d.kind,
      status: d.status,
      priority: d.priority,
      origin: d.origin,
      validationStatus: d.validationStatus,
      responsibleId: d.responsibleId,
      responsibleName: r.responsibleName,
      unitId: d.unitId,
      processId: d.processId,
      occurrenceId: d.occurrenceId,
      contractId: d.contractId,
      links: buildLinks({ ...r, processId: d.processId, occurrenceId: d.occurrenceId, contractId: d.contractId }),
      sourceAnalysisId: d.sourceAnalysisId,
      sourceAnalysisVisible: analysisVisible,
      // The excerpt quotes a source document: only shown when ctx can see the whole analysis (and so its sources).
      sourceExcerpt: d.sourceAnalysisId ? (analysisVisible ? d.sourceExcerpt : null) : d.sourceExcerpt,
      validatedByName: r.validatedByName,
      validatedAt: d.validatedAt,
      validationNote: d.validationNote,
      completedAt: d.completedAt,
      createdById: d.createdById,
      createdAt: d.createdAt,
      countsAsDeadline: real,
      isOverdue: real && d.status === "open" && d.dueDate < today,
      isPendingValidation: d.validationStatus === "pending_validation",
    };
  });
}

export async function listDeadlines(ctx: AuthContext, filters: DeadlineFilters = {}): Promise<Paginated<DeadlineListItem>> {
  assertCan(ctx, "deadline:read");
  const f = parseOrThrow(deadlineFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const today = todayISO();
  const upcomingDays = f.situation === "upcoming" ? await loadUpcomingDeadlineDays(ctx) : 0;

  const where = and(
    deadlineWhere(ctx),
    f.situation ? deadlineSituationCondition(f.situation, today, upcomingDays) : undefined,
    f.realOnly ? inArray(deadlines.validationStatus, REAL_VALIDATION) : undefined,
    f.status ? eq(deadlines.status, f.status) : undefined,
    f.responsibleId ? eq(deadlines.responsibleId, f.responsibleId) : undefined,
    f.origin ? eq(deadlines.origin, f.origin) : undefined,
    f.validationStatus ? eq(deadlines.validationStatus, f.validationStatus) : undefined,
    f.processId ? eq(deadlines.processId, f.processId) : undefined,
    f.occurrenceId ? eq(deadlines.occurrenceId, f.occurrenceId) : undefined,
    f.contractId ? eq(deadlines.contractId, f.contractId) : undefined,
    f.from ? gte(deadlines.dueDate, f.from) : undefined,
    f.to ? lte(deadlines.dueDate, f.to) : undefined,
    f.q ? ilike(deadlines.title, `%${escapeLike(f.q)}%`) : undefined,
  );

  const [{ total }] = await getDb().select({ total: count() }).from(deadlines).where(where);
  const rows = await selectDeadlineRows(ctx, where)
    .orderBy(
      sql`case when ${deadlines.status} = 'open' then 0 else 1 end`,
      asc(deadlines.dueDate),
      desc(deadlines.createdAt),
      asc(deadlines.id),
    )
    .limit(pageSize)
    .offset(offset);

  return { items: await mapDeadlineRows(ctx, rows, today), total, page, pageSize };
}

export async function getDeadline(ctx: AuthContext, id: string): Promise<DeadlineListItem> {
  assertCan(ctx, "deadline:read");
  const deadlineId = parseIdOrNotFound(id);
  const rows = await selectDeadlineRows(ctx, and(eq(deadlines.id, deadlineId), deadlineWhere(ctx))).limit(1);
  if (rows.length === 0) throw new NotFoundError("Prazo não encontrado ou sem permissão de acesso.");
  const [item] = await mapDeadlineRows(ctx, rows, todayISO());
  return item;
}

/** Counts for tabs, stat cards and dashboards. Pending AI suggestions are counted separately. */
export async function getWorkSummary(ctx: AuthContext): Promise<WorkSummary> {
  assertCan(ctx, "deadline:read");
  const db = getDb();
  const today = todayISO();
  const upcomingDays = await loadUpcomingDeadlineDays(ctx);
  const countDeadlines = async (cond: SQL | undefined) =>
    (await db.select({ n: count() }).from(deadlines).where(and(deadlineWhere(ctx), cond)))[0].n;

  const [overdueDeadlines, upcomingDeadlines, openDeadlines, pendingValidation] = await Promise.all([
    countDeadlines(deadlineSituationCondition("overdue", today, upcomingDays)),
    countDeadlines(deadlineSituationCondition("upcoming", today, upcomingDays)),
    countDeadlines(deadlineSituationCondition("open", today, upcomingDays)),
    countDeadlines(and(eq(deadlines.status, "open"), eq(deadlines.validationStatus, "pending_validation"))),
  ]);

  let overdueTasks = 0;
  let openTasks = 0;
  if (can(ctx, "task:read")) {
    const active = notInArray(tasks.status, [...CLOSED_TASK_STATUSES]);
    const [[o], [a]] = await Promise.all([
      db.select({ n: count() }).from(tasks).where(and(taskWhere(ctx), active, lt(tasks.dueDate, today))),
      db.select({ n: count() }).from(tasks).where(and(taskWhere(ctx), active)),
    ]);
    overdueTasks = o.n;
    openTasks = a.n;
  }

  return {
    overdueDeadlines,
    upcomingDeadlines,
    openDeadlines,
    pendingValidation,
    overdueTasks,
    openTasks,
    upcomingDeadlineDays: upcomingDays,
  };
}

// ---------------------------------------------------------------------------
// Deadlines — mutations
// ---------------------------------------------------------------------------

async function loadDeadlineForWrite(ctx: AuthContext, db: DbOrTx, id: string) {
  const deadlineId = parseIdOrNotFound(id);
  const [row] = await db
    .select()
    .from(deadlines)
    .where(and(eq(deadlines.id, deadlineId), deadlineWhere(ctx)))
    .limit(1);
  if (!row) throw new NotFoundError("Prazo não encontrado ou sem permissão de acesso.");
  return row;
}

const DEADLINE_AUDIT_FIELDS = [
  "title",
  "dueDate",
  "kind",
  "status",
  "priority",
  "origin",
  "validationStatus",
  "responsibleId",
  "unitId",
  "processId",
  "occurrenceId",
  "contractId",
  "sourceAnalysisId",
] as const;

/** Manual deadline (origin manual, no validation required). */
export async function createDeadline(ctx: AuthContext, input: DeadlineInput): Promise<{ id: string }> {
  assertCan(ctx, "deadline:write");
  const v = parseOrThrow(deadlineInputSchema, input);
  return getDb().transaction(async (tx) => {
    await assertLinksVisible(ctx, tx, v);
    const responsible = v.responsibleId ? await assertActiveUser(ctx, tx, v.responsibleId, "responsibleId") : null;
    const unitId = await resolveUnitId(ctx, tx, v.unitId, responsible);
    const values = {
      organizationId: ctx.organizationId,
      title: v.title,
      description: v.description || null,
      dueDate: v.dueDate,
      kind: v.kind,
      status: "open" as const,
      priority: v.priority ?? "medium",
      origin: "manual" as const,
      validationStatus: "not_required" as const,
      responsibleId: v.responsibleId ?? null,
      unitId,
      processId: v.processId ?? null,
      occurrenceId: v.occurrenceId ?? null,
      contractId: v.contractId ?? null,
      createdById: ctx.userId,
    };
    const [row] = await tx.insert(deadlines).values(values).returning({ id: deadlines.id });
    await recordAudit(
      ctx,
      {
        action: "deadline.create",
        entityType: "deadline",
        entityId: row.id,
        summary: `Prazo "${v.title}" cadastrado manualmente`,
        changes: diffChanges(null, values, DEADLINE_AUDIT_FIELDS),
      },
      tx,
    );
    return { id: row.id };
  });
}

/**
 * AI-suggested deadline: origin ai_suggested + pending_validation. Requires the
 * source analysis and the literal source excerpt. It never counts as a real
 * deadline until validated (`validateDeadline`).
 */
export async function createSuggestedDeadline(ctx: AuthContext, input: SuggestedDeadlineInput): Promise<{ id: string }> {
  assertCan(ctx, "deadline:write");
  const v = parseOrThrow(suggestedDeadlineInputSchema, input);
  return getDb().transaction(async (tx) => {
    await assertAnalysisVisible(ctx, tx, v.sourceAnalysisId);
    await assertLinksVisible(ctx, tx, v);
    const values = {
      organizationId: ctx.organizationId,
      title: v.title,
      description: v.description || null,
      dueDate: v.dueDate,
      kind: v.kind,
      status: "open" as const,
      priority: v.priority ?? "medium",
      origin: "ai_suggested" as const,
      validationStatus: "pending_validation" as const,
      responsibleId: null,
      unitId: ctx.unitId ?? null,
      processId: v.processId ?? null,
      occurrenceId: v.occurrenceId ?? null,
      contractId: v.contractId ?? null,
      sourceAnalysisId: v.sourceAnalysisId,
      sourceExcerpt: v.sourceExcerpt,
      createdById: ctx.userId,
    };
    const [row] = await tx.insert(deadlines).values(values).returning({ id: deadlines.id });
    await recordAudit(
      ctx,
      {
        action: "deadline.suggest",
        entityType: "deadline",
        entityId: row.id,
        summary: "Prazo sugerido pela IA registrado para validação humana",
        // Title, description and excerpt come from the AI answer / source document: never audited.
        changes: diffChanges(
          null,
          values,
          DEADLINE_AUDIT_FIELDS.filter((f) => f !== "title"),
        ),
        metadata: { sourceAnalysisId: v.sourceAnalysisId },
      },
      tx,
    );
    return { id: row.id };
  });
}

/**
 * Human validation of an AI-suggested deadline (deadline:validate). Only items
 * pending validation. "validated" may adjust the date (the original is kept in
 * the audit trail); "rejected" requires a note and cancels the item.
 */
export async function validateDeadline(ctx: AuthContext, id: string, input: ValidateDeadlineInput): Promise<void> {
  assertCan(ctx, "deadline:validate");
  const v = parseOrThrow(validateDeadlineSchema, input);
  await getDb().transaction(async (tx) => {
    const before = await loadDeadlineForWrite(ctx, tx, id);
    if (before.validationStatus !== "pending_validation") {
      throw new ConflictError("Este prazo não está aguardando validação.");
    }
    const responsible =
      v.decision === "validated" && v.responsibleId
        ? await assertActiveUser(ctx, tx, v.responsibleId, "responsibleId")
        : null;

    const now = new Date();
    const patch =
      v.decision === "validated"
        ? {
            validationStatus: "validated" as const,
            dueDate: v.dueDate ?? before.dueDate,
            responsibleId: responsible ? responsible.id : before.responsibleId,
            unitId: before.unitId ?? responsible?.unitId ?? null,
            validatedById: ctx.userId,
            validatedAt: now,
            validationNote: v.note || null,
          }
        : {
            validationStatus: "rejected" as const,
            status: "cancelled" as const,
            validatedById: ctx.userId,
            validatedAt: now,
            validationNote: v.note || null,
          };

    const updated = await tx
      .update(deadlines)
      .set(patch)
      .where(and(eq(deadlines.id, before.id), eq(deadlines.validationStatus, "pending_validation")))
      .returning({ id: deadlines.id });
    if (updated.length === 0) throw new ConflictError("Este prazo já foi validado ou rejeitado por outra pessoa.");

    const dateAdjusted = v.decision === "validated" && before.dueDate !== patch.dueDate;
    await recordAudit(
      ctx,
      {
        action: "deadline.validate",
        entityType: "deadline",
        entityId: before.id,
        summary:
          v.decision === "validated"
            ? dateAdjusted
              ? "Prazo sugerido pela IA validado com ajuste de data"
              : "Prazo sugerido pela IA validado"
            : "Prazo sugerido pela IA rejeitado",
        changes: diffChanges(before, { ...before, ...patch }, [
          "validationStatus",
          "status",
          "dueDate",
          "responsibleId",
          "validationNote",
        ]),
        metadata: {
          decision: v.decision,
          originalDueDate: before.dueDate,
          dateAdjusted,
          sourceAnalysisId: before.sourceAnalysisId,
        },
      },
      tx,
    );
  });
}

/** open / done / cancelled. AI suggestions pending validation must be validated or rejected instead. */
export async function setDeadlineStatus(ctx: AuthContext, id: string, status: DeadlineStatus): Promise<void> {
  assertCan(ctx, "deadline:write");
  const next = parseOrThrow(deadlineStatusSchema, status);
  await getDb().transaction(async (tx) => {
    const before = await loadDeadlineForWrite(ctx, tx, id);
    if (!countsAsDeadline(before.validationStatus)) {
      throw new ConflictError(
        before.validationStatus === "pending_validation"
          ? "Prazos sugeridos pela IA precisam ser validados ou rejeitados antes de mudar de situação."
          : "Prazos rejeitados não podem ser reabertos.",
      );
    }
    if (before.status === next) return;
    const patch = { status: next, completedAt: next === "done" ? new Date() : null };
    await tx.update(deadlines).set(patch).where(eq(deadlines.id, before.id));
    await recordAudit(
      ctx,
      {
        action: "deadline.status",
        entityType: "deadline",
        entityId: before.id,
        summary:
          next === "done"
            ? `Prazo "${before.title}" marcado como cumprido`
            : next === "cancelled"
              ? `Prazo "${before.title}" cancelado`
              : `Prazo "${before.title}" reaberto`,
        changes: diffChanges(before, { ...before, ...patch }, ["status", "completedAt"]),
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Tasks — queries
// ---------------------------------------------------------------------------

function selectTaskRows(ctx: AuthContext, where: SQL | undefined) {
  return getDb()
    .select({
      t: tasks,
      assigneeName: assigneeUser.name,
      pId: legalProcesses.id,
      pNumber: legalProcesses.number,
      pTitle: legalProcesses.title,
      oId: occurrences.id,
      oTitle: occurrences.title,
      cId: contracts.id,
      cTitle: contracts.title,
      cCounterparty: contracts.counterparty,
      dId: documents.id,
      dTitle: documents.title,
    })
    .from(tasks)
    .leftJoin(assigneeUser, and(eq(assigneeUser.id, tasks.assigneeId), eq(assigneeUser.organizationId, ctx.organizationId)))
    .leftJoin(legalProcesses, and(eq(legalProcesses.id, tasks.processId), processWhere(ctx)))
    .leftJoin(occurrences, and(eq(occurrences.id, tasks.occurrenceId), occurrenceWhere(ctx)))
    .leftJoin(contracts, and(eq(contracts.id, tasks.contractId), contractWhere(ctx)))
    .leftJoin(documents, and(eq(documents.id, tasks.documentId), documentWhere(ctx)))
    .where(where);
}

type TaskRow = Awaited<ReturnType<typeof selectTaskRows>>[number];

function isTaskOverdue(t: { status: TaskStatus; dueDate: string | null }, today: string): boolean {
  return t.dueDate !== null && t.dueDate < today && !(CLOSED_TASK_STATUSES as readonly string[]).includes(t.status);
}

function canDeleteTask(ctx: AuthContext, t: { createdById: string | null }): boolean {
  if (!can(ctx, "task:write")) return false;
  return seesConfidential(ctx) || (ctx.userId !== null && t.createdById === ctx.userId);
}

function mapTaskRows(ctx: AuthContext, rows: TaskRow[], today: string): TaskListItem[] {
  return rows.map((r) => {
    const t = r.t;
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      kind: t.kind,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      assigneeId: t.assigneeId,
      assigneeName: r.assigneeName,
      unitId: t.unitId,
      origin: t.origin,
      processId: t.processId,
      occurrenceId: t.occurrenceId,
      contractId: t.contractId,
      documentId: t.documentId,
      links: buildLinks({
        ...r,
        processId: t.processId,
        occurrenceId: t.occurrenceId,
        contractId: t.contractId,
        documentId: t.documentId,
      }),
      sourceAnalysisId: t.sourceAnalysisId,
      completedAt: t.completedAt,
      createdById: t.createdById,
      createdAt: t.createdAt,
      isOverdue: isTaskOverdue(t, today),
      canDelete: canDeleteTask(ctx, t),
    };
  });
}

export async function listTasks(ctx: AuthContext, filters: TaskFilters = {}): Promise<Paginated<TaskListItem>> {
  assertCan(ctx, "task:read");
  const f = parseOrThrow(taskFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const today = todayISO();
  const active = notInArray(tasks.status, [...CLOSED_TASK_STATUSES]);

  const where = and(
    taskWhere(ctx),
    f.status ? eq(tasks.status, f.status) : undefined,
    f.assigneeId ? eq(tasks.assigneeId, f.assigneeId) : undefined,
    f.kind ? eq(tasks.kind, f.kind) : undefined,
    f.processId ? eq(tasks.processId, f.processId) : undefined,
    f.occurrenceId ? eq(tasks.occurrenceId, f.occurrenceId) : undefined,
    f.contractId ? eq(tasks.contractId, f.contractId) : undefined,
    f.overdue ? and(active, lt(tasks.dueDate, today)) : undefined,
    f.activeOnly ? active : undefined,
    f.q ? ilike(tasks.title, `%${escapeLike(f.q)}%`) : undefined,
  );

  const [{ total }] = await getDb().select({ total: count() }).from(tasks).where(where);
  const rows = await selectTaskRows(ctx, where)
    .orderBy(
      sql`case when ${tasks.status} in ('done', 'cancelled') then 1 else 0 end`,
      sql`${tasks.dueDate} asc nulls last`,
      desc(tasks.createdAt),
      asc(tasks.id),
    )
    .limit(pageSize)
    .offset(offset);

  return { items: mapTaskRows(ctx, rows, today), total, page, pageSize };
}

export async function getTask(ctx: AuthContext, id: string): Promise<TaskListItem> {
  assertCan(ctx, "task:read");
  const taskId = parseIdOrNotFound(id);
  const rows = await selectTaskRows(ctx, and(eq(tasks.id, taskId), taskWhere(ctx))).limit(1);
  if (rows.length === 0) throw new NotFoundError("Tarefa não encontrada ou sem permissão de acesso.");
  return mapTaskRows(ctx, rows, todayISO())[0];
}

// ---------------------------------------------------------------------------
// Tasks — mutations
// ---------------------------------------------------------------------------

/** Description is never audited (it may hold AI-suggested text or confidential notes). */
const TASK_AUDIT_FIELDS = [
  "title",
  "kind",
  "status",
  "priority",
  "dueDate",
  "assigneeId",
  "unitId",
  "processId",
  "occurrenceId",
  "contractId",
  "documentId",
  "origin",
  "sourceAnalysisId",
  "completedAt",
] as const;

async function loadTaskForWrite(ctx: AuthContext, db: DbOrTx, id: string) {
  const taskId = parseIdOrNotFound(id);
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), taskWhere(ctx)))
    .limit(1);
  if (!row) throw new NotFoundError("Tarefa não encontrada ou sem permissão de acesso.");
  return row;
}

export async function createTask(
  ctx: AuthContext,
  input: TaskInput & { origin?: "manual" | "ai_suggested"; sourceAnalysisId?: string | null },
): Promise<{ id: string }> {
  assertCan(ctx, "task:write");
  const v = parseOrThrow(createTaskSchema, input);
  const origin = v.origin ?? "manual";
  if (origin === "ai_suggested" && !v.sourceAnalysisId) {
    throw new ValidationError(undefined, { sourceAnalysisId: ["Informe a análise de origem da sugestão."] });
  }
  return getDb().transaction(async (tx) => {
    if (v.sourceAnalysisId) await assertAnalysisVisible(ctx, tx, v.sourceAnalysisId);
    await assertLinksVisible(ctx, tx, v);
    const assignee = v.assigneeId ? await assertActiveUser(ctx, tx, v.assigneeId, "assigneeId") : null;
    const unitId = await resolveUnitId(ctx, tx, v.unitId, assignee);
    const values = {
      organizationId: ctx.organizationId,
      title: v.title,
      description: v.description || null,
      kind: v.kind ?? "general",
      status: "todo" as const,
      priority: v.priority ?? "medium",
      dueDate: v.dueDate ?? null,
      assigneeId: v.assigneeId ?? null,
      unitId,
      origin,
      processId: v.processId ?? null,
      occurrenceId: v.occurrenceId ?? null,
      contractId: v.contractId ?? null,
      documentId: v.documentId ?? null,
      sourceAnalysisId: v.sourceAnalysisId ?? null,
      createdById: ctx.userId,
    };
    const [row] = await tx.insert(tasks).values(values).returning({ id: tasks.id });
    await recordAudit(
      ctx,
      {
        action: "task.create",
        entityType: "task",
        entityId: row.id,
        summary: origin === "ai_suggested" ? "Tarefa sugerida pela IA criada" : `Tarefa "${v.title}" criada`,
        // AI-suggested titles are part of the AI answer: not audited.
        changes: diffChanges(
          null,
          values,
          origin === "ai_suggested" ? TASK_AUDIT_FIELDS.filter((f) => f !== "title") : TASK_AUDIT_FIELDS,
        ),
      },
      tx,
    );
    return { id: row.id };
  });
}

export async function updateTask(ctx: AuthContext, id: string, patch: TaskPatch): Promise<void> {
  assertCan(ctx, "task:write");
  const v = parseOrThrow(taskPatchSchema, patch);
  await getDb().transaction(async (tx) => {
    const before = await loadTaskForWrite(ctx, tx, id);

    const next: Partial<typeof tasks.$inferInsert> = {};
    if (v.title !== undefined) next.title = v.title;
    if (v.description !== undefined) next.description = v.description || null;
    if (v.kind !== undefined) next.kind = v.kind;
    if (v.priority !== undefined) next.priority = v.priority;
    if (v.dueDate !== undefined) next.dueDate = v.dueDate ?? null;

    const linkChanges: LinkIds = {};
    for (const key of ["processId", "occurrenceId", "contractId", "documentId"] as const) {
      if (v[key] !== undefined && (v[key] ?? null) !== before[key]) {
        linkChanges[key] = v[key] ?? null;
        next[key] = v[key] ?? null;
      }
    }
    await assertLinksVisible(ctx, tx, linkChanges);

    if (v.assigneeId !== undefined && (v.assigneeId ?? null) !== before.assigneeId) {
      if (v.assigneeId) await assertActiveUser(ctx, tx, v.assigneeId, "assigneeId");
      next.assigneeId = v.assigneeId ?? null;
    }
    if (v.unitId !== undefined && (v.unitId ?? null) !== before.unitId) {
      if (v.unitId) await assertUnit(ctx, tx, v.unitId);
      next.unitId = v.unitId ?? null;
    }
    if (v.status !== undefined && v.status !== before.status) {
      next.status = v.status;
      next.completedAt = v.status === "done" ? new Date() : null;
    }

    const changes = diffChanges(before, { ...before, ...next }, TASK_AUDIT_FIELDS);
    if (!changes) return;
    await tx.update(tasks).set(next).where(eq(tasks.id, before.id));

    const onlyStatus = Object.keys(changes).every((k) => k === "status" || k === "completedAt");
    await recordAudit(
      ctx,
      {
        action: onlyStatus ? "task.status" : "task.update",
        entityType: "task",
        entityId: before.id,
        summary: onlyStatus ? `Status da tarefa "${before.title}" alterado` : `Tarefa "${before.title}" atualizada`,
        changes,
      },
      tx,
    );
  });
}

/** Soft delete. Only the creator, admins and legal managers. Prefer cancelling (status) to keep history. */
export async function deleteTask(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "task:write");
  await getDb().transaction(async (tx) => {
    const before = await loadTaskForWrite(ctx, tx, id);
    if (!canDeleteTask(ctx, before)) {
      throw new ForbiddenError("Somente quem criou a tarefa, gestores jurídicos e administradores podem excluí-la.");
    }
    await tx.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, before.id));
    await recordAudit(
      ctx,
      { action: "task.delete", entityType: "task", entityId: before.id, summary: `Tarefa "${before.title}" excluída` },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** Deadlines (incl. pending AI suggestions, flagged) and tasks due in the month. Cancelled items are omitted. */
export async function listCalendarItems(ctx: AuthContext, month: string): Promise<CalendarData> {
  assertCan(ctx, "deadline:read");
  const m = parseOrThrow(monthSchema, month);
  const { from, to } = monthRange(m);
  const today = todayISO();
  const db = getDb();

  const deadlineRows = await db
    .select({
      id: deadlines.id,
      title: deadlines.title,
      dueDate: deadlines.dueDate,
      kind: deadlines.kind,
      status: deadlines.status,
      priority: deadlines.priority,
      origin: deadlines.origin,
      validationStatus: deadlines.validationStatus,
    })
    .from(deadlines)
    .where(
      and(
        deadlineWhere(ctx),
        gte(deadlines.dueDate, from),
        lte(deadlines.dueDate, to),
        ne(deadlines.status, "cancelled"),
        ne(deadlines.validationStatus, "rejected"),
      ),
    )
    .orderBy(asc(deadlines.dueDate), asc(deadlines.title))
    .limit(LIST_HARD_LIMIT);

  const taskRows = can(ctx, "task:read")
    ? await db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          kind: tasks.kind,
          status: tasks.status,
          priority: tasks.priority,
          origin: tasks.origin,
        })
        .from(tasks)
        .where(and(taskWhere(ctx), gte(tasks.dueDate, from), lte(tasks.dueDate, to), ne(tasks.status, "cancelled")))
        .orderBy(asc(tasks.dueDate), asc(tasks.title))
        .limit(LIST_HARD_LIMIT)
    : [];

  return {
    month: m,
    today,
    deadlines: deadlineRows.map((d) => {
      const real = countsAsDeadline(d.validationStatus);
      return {
        ...d,
        isOverdue: real && d.status === "open" && d.dueDate < today,
        isPendingValidation: d.validationStatus === "pending_validation",
      };
    }),
    tasks: taskRows
      .filter((t): t is typeof t & { dueDate: string } => t.dueDate !== null)
      .map((t) => ({ ...t, isOverdue: isTaskOverdue(t, today) })),
  };
}

// ---------------------------------------------------------------------------
// Form options (scoped)
// ---------------------------------------------------------------------------

/** Active users of the organization (responsible / assignee selects). */
export async function listWorkUserOptions(ctx: AuthContext): Promise<WorkUserOption[]> {
  if (!can(ctx, "deadline:read") && !can(ctx, "task:read")) throw new ForbiddenError();
  return getDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)))
    .orderBy(asc(users.name))
    .limit(LIST_HARD_LIMIT);
}

/** Records the user can link a deadline/task to (only visible ones). */
export async function listWorkLinkOptions(ctx: AuthContext): Promise<WorkLinkOptions> {
  if (!can(ctx, "deadline:write") && !can(ctx, "task:write")) throw new ForbiddenError();
  const db = getDb();
  const limit = 300;
  const [processes, occs, ctrs] = await Promise.all([
    can(ctx, "process:read")
      ? db
          .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
          .from(legalProcesses)
          .where(and(processWhere(ctx), or(eq(legalProcesses.status, "active"), eq(legalProcesses.status, "suspended"))))
          .orderBy(desc(legalProcesses.updatedAt))
          .limit(limit)
      : [],
    can(ctx, "occurrence:read")
      ? db
          .select({ id: occurrences.id, title: occurrences.title })
          .from(occurrences)
          .where(and(occurrenceWhere(ctx), notInArray(occurrences.status, ["resolved", "converted_to_process"])))
          .orderBy(desc(occurrences.updatedAt))
          .limit(limit)
      : [],
    can(ctx, "contract:read")
      ? db
          .select({ id: contracts.id, title: contracts.title, counterparty: contracts.counterparty })
          .from(contracts)
          .where(and(contractWhere(ctx), notInArray(contracts.status, ["terminated"])))
          .orderBy(desc(contracts.updatedAt))
          .limit(limit)
      : [],
  ]);
  return {
    processes: processes.map((p) => ({ id: p.id, label: `${p.number} — ${p.title}` })),
    occurrences: occs.map((o) => ({ id: o.id, label: o.title })),
    contracts: ctrs.map((c) => ({ id: c.id, label: `${c.title} (${c.counterparty})` })),
  };
}

