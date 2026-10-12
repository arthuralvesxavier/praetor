import { and, count, desc, eq, ilike, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import type {
  OccurrenceCategory,
  OccurrenceStatus,
  ProcessStatus,
  RiskLevel,
} from "@/domain/enums";
import { todayISO } from "@/lib/format";
import { occurrenceWhere, processWhere, seesConfidential, taskWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { legalProcesses, occurrences, tasks, units, users } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import {
  createOccurrenceSchema,
  dateIssues,
  idSchema,
  occurrenceFiltersSchema,
  updateOccurrenceSchema,
  type CreateOccurrenceInput,
  type UpdateOccurrenceInput,
} from "./schemas";
import {
  isPreventiveIndicatorKey,
  parsePreventiveOrigin,
  PREVENTIVE_MARKER_PREFIX,
  preventiveOriginMarker,
  type PreventiveOrigin,
} from "./preventive-origin";

/**
 * Preventive legal work (jurídico preventivo): occurrences that are not
 * lawsuits (yet). Every function takes the caller's AuthContext first, checks
 * the action permission and applies the row-visibility scope from
 * `@/server/auth/access` to every query. Risk classification is always
 * human-entered; AI findings live only in analyses.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Process linked to an occurrence. Number/title are only exposed when the caller can see the process. */
export type LinkedProcessSummary = {
  id: string;
  visible: boolean;
  number: string | null;
  title: string | null;
  status: ProcessStatus | null;
};

export type OccurrenceListItem = {
  id: string;
  title: string;
  category: OccurrenceCategory;
  status: OccurrenceStatus;
  riskLevel: RiskLevel;
  areasInvolved: string[];
  responsibleId: string | null;
  responsibleName: string | null;
  unitId: string | null;
  unitName: string | null;
  estimatedExposureCents: number | null;
  occurredOn: string | null;
  reportedOn: string;
  isConfidential: boolean;
  linkedProcess: LinkedProcessSummary | null;
  /** Set when the occurrence was created from a preventive-intelligence indicator. */
  preventiveOrigin: PreventiveOrigin | null;
};

export type OccurrenceDetail = OccurrenceListItem & {
  facts: string;
  riskRationale: string | null;
  involvedParties: string | null;
  missingInformation: string[];
  reportedById: string | null;
  reportedByName: string | null;
  resolvedAt: Date | null;
  legalHold: boolean;
  createdAt: Date;
  updatedAt: Date;
  canEdit: boolean;
  canDelete: boolean;
  /** Only admins and legal managers may mark/unmark an occurrence as confidential. */
  canSetConfidential: boolean;
};

export type OccurrenceFilters = {
  q?: string;
  status?: OccurrenceStatus;
  category?: OccurrenceCategory;
  riskLevel?: RiskLevel | RiskLevel[];
  unitId?: string;
  responsibleId?: string;
  /** Only occurrences created from a preventive-intelligence indicator. */
  origin?: "preventive_intel";
} & Page;

export type OccurrenceStats = {
  open: number;
  actionPlan: number;
  highRisk: number;
  converted: number;
  total: number;
  /** Created from a preventive-intelligence indicator. */
  fromPreventiveIntel: number;
};

/** Latest visible occurrence created from an indicator (see `findPreventiveIntelOccurrences`). */
export type PreventiveIntelOccurrence = {
  id: string;
  title: string;
  status: OccurrenceStatus;
  createdAt: Date;
};

export type ActionPlanProgress = {
  /** Action plan tasks, excluding cancelled ones. */
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  overdue: number;
};

/** Fields whose change makes existing AI analyses of the occurrence outdated. */
const ANALYSIS_RELEVANT_FIELDS = [
  "title",
  "facts",
  "category",
  "status",
  "riskLevel",
  "riskRationale",
  "areasInvolved",
  "involvedParties",
  "missingInformation",
  "estimatedExposureCents",
  "occurredOn",
  "reportedOn",
  "linkedProcessId",
] as const;

const FIELD_LABELS: Record<string, string> = {
  title: "título",
  facts: "fatos",
  category: "categoria",
  status: "situação",
  riskLevel: "risco",
  riskRationale: "justificativa do risco",
  areasInvolved: "áreas envolvidas",
  involvedParties: "partes envolvidas",
  missingInformation: "informações faltantes",
  estimatedExposureCents: "exposição estimada",
  occurredOn: "data da ocorrência",
  reportedOn: "data do reporte",
  linkedProcessId: "vínculo com processo",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "Verifique os campos informados.",
      z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
    );
  }
  return parsed.data;
}

function fieldError(field: string, message: string): ValidationError {
  return new ValidationError("Verifique os campos informados.", { [field]: [message] });
}

/** Ids that are not UUIDs can never match a row: answer "not found" without querying. */
function assertId(id: string, message?: string): string {
  if (!idSchema.safeParse(id).success) throw new NotFoundError(message);
  return id;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function shortTitle(title: string): string {
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

const responsibleUser = alias(users, "occ_responsible_user");
const reporterUser = alias(users, "occ_reporter_user");

/**
 * Base query with display joins. Joined users/units are restricted to the
 * caller's organization; the linked process is joined only when visible to
 * the caller (otherwise only its id is known).
 */
function selectOccurrences(ctx: AuthContext, db: DbOrTx) {
  return db
    .select({
      o: occurrences,
      responsibleName: responsibleUser.name,
      reportedByName: reporterUser.name,
      unitName: units.name,
      processId: legalProcesses.id,
      processNumber: legalProcesses.number,
      processTitle: legalProcesses.title,
      processStatus: legalProcesses.status,
    })
    .from(occurrences)
    .leftJoin(
      responsibleUser,
      and(eq(responsibleUser.id, occurrences.responsibleId), eq(responsibleUser.organizationId, ctx.organizationId)),
    )
    .leftJoin(
      reporterUser,
      and(eq(reporterUser.id, occurrences.reportedById), eq(reporterUser.organizationId, ctx.organizationId)),
    )
    .leftJoin(units, and(eq(units.id, occurrences.unitId), eq(units.organizationId, ctx.organizationId)))
    .leftJoin(legalProcesses, and(eq(legalProcesses.id, occurrences.linkedProcessId), processWhere(ctx)));
}

type SelectedRow = Awaited<ReturnType<ReturnType<typeof selectOccurrences>["where"]>>[number];

function toListItem(r: SelectedRow): OccurrenceListItem {
  const o = r.o;
  return {
    id: o.id,
    title: o.title,
    category: o.category,
    status: o.status,
    riskLevel: o.riskLevel,
    areasInvolved: o.areasInvolved ?? [],
    responsibleId: o.responsibleId,
    responsibleName: r.responsibleName,
    unitId: o.unitId,
    unitName: r.unitName,
    estimatedExposureCents: o.estimatedExposureCents,
    occurredOn: o.occurredOn,
    reportedOn: o.reportedOn,
    isConfidential: o.isConfidential,
    linkedProcess: o.linkedProcessId
      ? {
          id: o.linkedProcessId,
          visible: r.processId !== null,
          number: r.processNumber,
          title: r.processTitle,
          status: r.processStatus,
        }
      : null,
    preventiveOrigin: parsePreventiveOrigin(o.facts),
  };
}

/** ILIKE pattern matching the origin marker of indicator-created occurrences (no user input involved). */
const PREVENTIVE_MARKER_PATTERN = `%${escapeLike(PREVENTIVE_MARKER_PREFIX)}%`;

type OccurrenceRow = typeof occurrences.$inferSelect;

/** Loads an occurrence visible to ctx (locking it for update inside a transaction). */
async function loadVisibleForUpdate(ctx: AuthContext, id: string, tx: DbOrTx): Promise<OccurrenceRow> {
  assertId(id);
  const [row] = await tx
    .select()
    .from(occurrences)
    .where(and(eq(occurrences.id, id), occurrenceWhere(ctx)))
    .for("update");
  if (!row) throw new NotFoundError("Ocorrência não encontrada ou sem permissão de acesso.");
  return row;
}

async function assertUnitInOrganization(ctx: AuthContext, db: DbOrTx, unitId: string): Promise<void> {
  const [unit] = await db
    .select({ id: units.id, isActive: units.isActive })
    .from(units)
    .where(and(eq(units.id, unitId), eq(units.organizationId, ctx.organizationId)));
  if (!unit) throw fieldError("unitId", "Unidade não encontrada.");
  if (!unit.isActive) throw fieldError("unitId", "Esta unidade está inativa.");
}

async function assertActiveUserInOrganization(
  ctx: AuthContext,
  db: DbOrTx,
  userId: string,
  field: "responsibleId" | "reportedById",
): Promise<void> {
  const [user] = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId)));
  if (!user) throw fieldError(field, "Usuário não encontrado nesta organização.");
  if (!user.isActive) throw fieldError(field, "Este usuário está inativo.");
}

function relevantChangeReason(changes: Record<string, unknown> | null): string | null {
  if (!changes) return null;
  const changed = ANALYSIS_RELEVANT_FIELDS.filter((f) => f in changes);
  if (changed.length === 0) return null;
  return `Ocorrência alterada (${changed.map((f) => FIELD_LABELS[f] ?? f).join(", ")}).`;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listOccurrences(ctx: AuthContext, filters: OccurrenceFilters = {}): Promise<Paginated<OccurrenceListItem>> {
  assertCan(ctx, "occurrence:read");
  const f = parseOrThrow(occurrenceFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage({ page: f.page, pageSize: f.pageSize });
  const db = getDb();

  const risk = f.riskLevel === undefined ? undefined : Array.isArray(f.riskLevel) ? f.riskLevel : [f.riskLevel];
  const pattern = f.q ? `%${escapeLike(f.q)}%` : undefined;
  const conds: (SQL | undefined)[] = [
    occurrenceWhere(ctx),
    f.status ? eq(occurrences.status, f.status) : undefined,
    f.category ? eq(occurrences.category, f.category) : undefined,
    risk && risk.length > 0 ? inArray(occurrences.riskLevel, risk) : undefined,
    f.unitId ? eq(occurrences.unitId, f.unitId) : undefined,
    f.responsibleId ? eq(occurrences.responsibleId, f.responsibleId) : undefined,
    f.origin === "preventive_intel" ? ilike(occurrences.facts, PREVENTIVE_MARKER_PATTERN) : undefined,
    pattern
      ? or(
          ilike(occurrences.title, pattern),
          ilike(occurrences.facts, pattern),
          ilike(occurrences.involvedParties, pattern),
          sql`${occurrences.areasInvolved}::text ilike ${pattern}`,
        )
      : undefined,
  ];
  const where = and(...conds);

  const [{ total }] = await db.select({ total: count() }).from(occurrences).where(where);
  const rows = await selectOccurrences(ctx, db)
    .where(where)
    .orderBy(desc(occurrences.reportedOn), desc(occurrences.createdAt), desc(occurrences.id))
    .limit(pageSize)
    .offset(offset);

  return { items: rows.map(toListItem), total: Number(total), page, pageSize };
}

/** KPI counters for the /preventivo header (each one matches a filter deep link). */
export async function getOccurrenceStats(ctx: AuthContext): Promise<OccurrenceStats> {
  assertCan(ctx, "occurrence:read");
  const s = occurrences.status;
  const [row] = await getDb()
    .select({
      total: count(),
      open: sql<number>`count(*) filter (where ${s} = 'open')`.mapWith(Number),
      actionPlan: sql<number>`count(*) filter (where ${s} = 'action_plan')`.mapWith(Number),
      highRisk: sql<number>`count(*) filter (where ${occurrences.riskLevel} in ('high', 'critical'))`.mapWith(Number),
      converted: sql<number>`count(*) filter (where ${s} = 'converted_to_process')`.mapWith(Number),
      fromPreventiveIntel: sql<number>`count(*) filter (where ${occurrences.facts} ilike ${PREVENTIVE_MARKER_PATTERN})`.mapWith(
        Number,
      ),
    })
    .from(occurrences)
    .where(occurrenceWhere(ctx));
  return {
    total: Number(row?.total ?? 0),
    open: row?.open ?? 0,
    actionPlan: row?.actionPlan ?? 0,
    highRisk: row?.highRisk ?? 0,
    converted: row?.converted ?? 0,
    fromPreventiveIntel: row?.fromPreventiveIntel ?? 0,
  };
}

/**
 * Latest occurrence visible to ctx created from each preventive-intelligence
 * indicator key (keys without an occurrence are absent from the map). When
 * `openOnly`, resolved occurrences are ignored.
 */
export async function findPreventiveIntelOccurrences(
  ctx: AuthContext,
  keys: readonly string[],
  opts: { openOnly?: boolean } = {},
): Promise<Map<string, PreventiveIntelOccurrence>> {
  assertCan(ctx, "occurrence:read");
  const valid = [...new Set(keys)].filter(isPreventiveIndicatorKey);
  const found = new Map<string, PreventiveIntelOccurrence>();
  if (valid.length === 0) return found;

  const rows = await getDb()
    .select({
      id: occurrences.id,
      title: occurrences.title,
      status: occurrences.status,
      facts: occurrences.facts,
      createdAt: occurrences.createdAt,
    })
    .from(occurrences)
    .where(
      and(
        occurrenceWhere(ctx),
        opts.openOnly ? notInArray(occurrences.status, ["resolved"]) : undefined,
        or(...valid.map((k) => ilike(occurrences.facts, `%${escapeLike(preventiveOriginMarker(k))}%`))),
      ),
    )
    .orderBy(desc(occurrences.createdAt), desc(occurrences.id));

  for (const r of rows) {
    const origin = parsePreventiveOrigin(r.facts);
    if (!origin || !valid.includes(origin.key) || found.has(origin.key)) continue;
    found.set(origin.key, { id: r.id, title: r.title, status: r.status, createdAt: r.createdAt });
  }
  return found;
}

export async function getOccurrence(ctx: AuthContext, id: string): Promise<OccurrenceDetail> {
  assertCan(ctx, "occurrence:read");
  assertId(id);
  const [row] = await selectOccurrences(ctx, getDb()).where(and(eq(occurrences.id, id), occurrenceWhere(ctx)));
  if (!row) throw new NotFoundError("Ocorrência não encontrada ou sem permissão de acesso.");
  const o = row.o;
  return {
    ...toListItem(row),
    facts: o.facts,
    riskRationale: o.riskRationale,
    involvedParties: o.involvedParties,
    missingInformation: o.missingInformation ?? [],
    reportedById: o.reportedById,
    reportedByName: row.reportedByName,
    resolvedAt: o.resolvedAt,
    legalHold: o.legalHold,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    canEdit: can(ctx, "occurrence:write"),
    canDelete: can(ctx, "occurrence:delete") && !o.legalHold,
    canSetConfidential: seesConfidential(ctx),
  };
}

/** Options for selects in other modules (e.g. linking a contract or document to an occurrence). */
export async function listOccurrenceOptions(ctx: AuthContext): Promise<{ id: string; title: string }[]> {
  assertCan(ctx, "occurrence:read");
  return getDb()
    .select({ id: occurrences.id, title: occurrences.title })
    .from(occurrences)
    .where(occurrenceWhere(ctx))
    .orderBy(desc(occurrences.reportedOn), desc(occurrences.createdAt))
    .limit(500);
}

/** Progress of the occurrence's action plan (tasks of kind `action_plan`), scoped to the tasks ctx can see. */
export async function getActionPlanProgress(ctx: AuthContext, occurrenceId: string): Promise<ActionPlanProgress | null> {
  assertCan(ctx, "occurrence:read");
  assertId(occurrenceId);
  const db = getDb();
  const [visible] = await db
    .select({ id: occurrences.id })
    .from(occurrences)
    .where(and(eq(occurrences.id, occurrenceId), occurrenceWhere(ctx)));
  if (!visible) throw new NotFoundError("Ocorrência não encontrada ou sem permissão de acesso.");
  if (!can(ctx, "task:read")) return null;

  const today = todayISO();
  const st = tasks.status;
  const [row] = await db
    .select({
      total: count(),
      done: sql<number>`count(*) filter (where ${st} = 'done')`.mapWith(Number),
      inProgress: sql<number>`count(*) filter (where ${st} = 'in_progress')`.mapWith(Number),
      blocked: sql<number>`count(*) filter (where ${st} = 'blocked')`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${st} not in ('done', 'cancelled') and ${tasks.dueDate} < ${today})`.mapWith(
        Number,
      ),
    })
    .from(tasks)
    .where(
      and(
        taskWhere(ctx),
        eq(tasks.occurrenceId, occurrenceId),
        eq(tasks.kind, "action_plan"),
        notInArray(tasks.status, ["cancelled"]),
      ),
    );
  return {
    total: Number(row?.total ?? 0),
    done: row?.done ?? 0,
    inProgress: row?.inProgress ?? 0,
    blocked: row?.blocked ?? 0,
    overdue: row?.overdue ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createOccurrence(ctx: AuthContext, input: CreateOccurrenceInput): Promise<{ id: string }> {
  assertCan(ctx, "occurrence:write");
  const v = parseOrThrow(createOccurrenceSchema, input);

  if (v.isConfidential && !seesConfidential(ctx)) {
    throw fieldError("isConfidential", "Apenas administradores e gestores jurídicos podem marcar uma ocorrência como confidencial.");
  }
  if (v.status === "converted_to_process") {
    throw fieldError("status", "Para converter em processo, vincule a ocorrência a um processo depois de cadastrá-la.");
  }

  return getDb().transaction(async (tx) => {
    if (v.unitId) await assertUnitInOrganization(ctx, tx, v.unitId);
    if (v.responsibleId) await assertActiveUserInOrganization(ctx, tx, v.responsibleId, "responsibleId");
    const reportedById = v.reportedById ?? ctx.userId;
    if (reportedById) await assertActiveUserInOrganization(ctx, tx, reportedById, "reportedById");

    const values = {
      title: v.title,
      facts: v.facts,
      category: v.category,
      status: v.status,
      riskLevel: v.riskLevel,
      riskRationale: v.riskRationale,
      areasInvolved: v.areasInvolved,
      involvedParties: v.involvedParties,
      missingInformation: v.missingInformation,
      estimatedExposureCents: v.estimatedExposureCents,
      unitId: v.unitId,
      responsibleId: v.responsibleId,
      reportedById,
      occurredOn: v.occurredOn,
      reportedOn: v.reportedOn,
      isConfidential: v.isConfidential,
      resolvedAt: v.status === "resolved" ? new Date() : null,
    };
    const [created] = await tx
      .insert(occurrences)
      .values({ ...values, organizationId: ctx.organizationId, createdById: ctx.userId })
      .returning({ id: occurrences.id });

    await recordAudit(
      ctx,
      {
        action: "occurrence.create",
        entityType: "occurrence",
        entityId: created.id,
        summary: `Ocorrência "${shortTitle(v.title)}" cadastrada.`,
        changes: diffChanges(null, values),
      },
      tx,
    );
    return { id: created.id };
  });
}

export async function updateOccurrence(ctx: AuthContext, id: string, input: UpdateOccurrenceInput): Promise<void> {
  assertCan(ctx, "occurrence:write");
  assertId(id);
  const v = parseOrThrow(updateOccurrenceSchema, input);

  await getDb().transaction(async (tx) => {
    const existing = await loadVisibleForUpdate(ctx, id, tx);

    const patch: Partial<OccurrenceRow> = {};
    for (const [key, value] of Object.entries(v)) {
      if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
    }

    // Confidentiality can only be changed by roles that see confidential records.
    if (patch.isConfidential !== undefined && patch.isConfidential !== existing.isConfidential && !seesConfidential(ctx)) {
      throw fieldError(
        "isConfidential",
        "Apenas administradores e gestores jurídicos podem alterar a confidencialidade da ocorrência.",
      );
    }

    // Foreign ids: validate only when they change (records may keep a now-inactive user/unit).
    if (patch.unitId && patch.unitId !== existing.unitId) await assertUnitInOrganization(ctx, tx, patch.unitId);
    if (patch.responsibleId && patch.responsibleId !== existing.responsibleId) {
      await assertActiveUserInOrganization(ctx, tx, patch.responsibleId, "responsibleId");
    }
    if (patch.reportedById && patch.reportedById !== existing.reportedById) {
      await assertActiveUserInOrganization(ctx, tx, patch.reportedById, "reportedById");
    }

    // Status rules.
    if (patch.status !== undefined && patch.status !== existing.status) {
      if (patch.status === "converted_to_process" && !existing.linkedProcessId) {
        throw fieldError("status", "Para converter em processo, use a aba “Vínculo com processo”.");
      }
      if (patch.status === "resolved") patch.resolvedAt = new Date();
      else if (existing.status === "resolved") patch.resolvedAt = null;
    }

    // Date coherence, checked on the merged values when a date changes.
    const occurredOn = patch.occurredOn !== undefined ? patch.occurredOn : existing.occurredOn;
    const reportedOn = patch.reportedOn ?? existing.reportedOn;
    if (occurredOn !== existing.occurredOn || reportedOn !== existing.reportedOn) {
      const issues = dateIssues(occurredOn, reportedOn);
      if (issues.length > 0) {
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of issues) (fieldErrors[issue.path[0]] ??= []).push(issue.message);
        throw new ValidationError("Verifique os campos informados.", fieldErrors);
      }
    }

    const changes = diffChanges(existing, { ...existing, ...patch }, Object.keys(patch));
    if (!changes) return;

    const changedPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => key in changes)) as Partial<OccurrenceRow>;
    await tx
      .update(occurrences)
      .set(changedPatch)
      .where(and(eq(occurrences.id, id), eq(occurrences.organizationId, ctx.organizationId)));

    await recordAudit(
      ctx,
      {
        action: "occurrence.update",
        entityType: "occurrence",
        entityId: id,
        summary: `Ocorrência "${shortTitle(patch.title ?? existing.title)}" atualizada.`,
        changes,
      },
      tx,
    );

    const reason = relevantChangeReason(changes);
    if (reason) await markAnalysesStaleForEntity({ organizationId: ctx.organizationId, entityId: id, reason }, tx);
  });
}

/** Soft delete. Requires `occurrence:delete`; occurrences under legal hold cannot be deleted. */
export async function deleteOccurrence(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "occurrence:delete");
  assertId(id);
  await getDb().transaction(async (tx) => {
    const existing = await loadVisibleForUpdate(ctx, id, tx);
    if (existing.legalHold) {
      throw new ConflictError("Esta ocorrência está sob preservação legal (legal hold) e não pode ser excluída.");
    }
    await tx
      .update(occurrences)
      .set({ deletedAt: new Date() })
      .where(and(eq(occurrences.id, id), eq(occurrences.organizationId, ctx.organizationId), isNull(occurrences.deletedAt)));
    await recordAudit(
      ctx,
      {
        action: "occurrence.delete",
        entityType: "occurrence",
        entityId: id,
        summary: `Ocorrência "${shortTitle(existing.title)}" excluída.`,
      },
      tx,
    );
  });
}

/**
 * Links the occurrence to an existing judicial process (visible to ctx) and
 * marks it as converted. Contract: `@/modules/occurrences/service`.
 */
export async function linkOccurrenceToProcess(ctx: AuthContext, occurrenceId: string, processId: string): Promise<void> {
  assertCan(ctx, "occurrence:write");
  assertId(occurrenceId);
  assertId(processId, "Processo não encontrado ou sem permissão de acesso.");

  await getDb().transaction(async (tx) => {
    const existing = await loadVisibleForUpdate(ctx, occurrenceId, tx);
    const [process] = await tx
      .select({ id: legalProcesses.id, number: legalProcesses.number })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, processId), processWhere(ctx)));
    if (!process) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");

    const patch = { linkedProcessId: process.id, status: "converted_to_process" as const, resolvedAt: null };
    const changes = diffChanges(existing, { ...existing, ...patch }, Object.keys(patch));
    if (!changes) return;

    await tx
      .update(occurrences)
      .set(patch)
      .where(and(eq(occurrences.id, occurrenceId), eq(occurrences.organizationId, ctx.organizationId)));

    await recordAudit(
      ctx,
      {
        action: "occurrence.link_process",
        entityType: "occurrence",
        entityId: occurrenceId,
        summary: `Ocorrência "${shortTitle(existing.title)}" vinculada ao processo ${process.number}.`,
        changes,
        metadata: { processId: process.id },
      },
      tx,
    );
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: occurrenceId, reason: "Ocorrência vinculada a um processo judicial." },
      tx,
    );
  });
}

/** Removes the process link. A "converted" occurrence goes back to "under analysis". */
export async function unlinkOccurrenceFromProcess(ctx: AuthContext, occurrenceId: string): Promise<void> {
  assertCan(ctx, "occurrence:write");
  assertId(occurrenceId);

  await getDb().transaction(async (tx) => {
    const existing = await loadVisibleForUpdate(ctx, occurrenceId, tx);
    if (!existing.linkedProcessId) throw new ConflictError("A ocorrência não está vinculada a um processo.");

    const patch = {
      linkedProcessId: null,
      status: existing.status === "converted_to_process" ? ("under_analysis" as const) : existing.status,
    };
    const changes = diffChanges(existing, { ...existing, ...patch }, Object.keys(patch));

    await tx
      .update(occurrences)
      .set(patch)
      .where(and(eq(occurrences.id, occurrenceId), eq(occurrences.organizationId, ctx.organizationId)));

    await recordAudit(
      ctx,
      {
        action: "occurrence.unlink_process",
        entityType: "occurrence",
        entityId: occurrenceId,
        summary: `Vínculo da ocorrência "${shortTitle(existing.title)}" com processo removido.`,
        changes,
        metadata: { processId: existing.linkedProcessId },
      },
      tx,
    );
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: occurrenceId, reason: "Vínculo da ocorrência com processo removido." },
      tx,
    );
  });
}
