/**
 * Executive dashboard aggregates.
 *
 * Every figure is computed with grouped SQL over the row-visibility scopes of
 * `@/server/auth/access`, so each role only sees what it may see (executives:
 * every non-confidential record; lawyers/analysts: their unit + own records).
 * Monetary values are the ones INFORMED in the records — never AI estimates.
 */
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, notLike, sql, type SQL } from "drizzle-orm";
import { entityHref, type EntityRef } from "@/domain/entities";
import {
  CONTRACT_STATUSES,
  LEGAL_AREAS,
  LOSS_PROBABILITIES,
  OCCURRENCE_STATUSES,
  PROCESS_PHASES,
  PROCESS_STATUSES,
  RISK_LEVELS,
  type ContractStatus,
  type EntityType,
  type LegalArea,
  type LossProbability,
  type OccurrenceStatus,
  type ProcessPhase,
  type ProcessStatus,
  type RiskLevel,
} from "@/domain/enums";
import { addDaysISO, todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import {
  analysisWhere,
  contractWhere,
  deadlineWhere,
  entityReferenceWhere,
  occurrenceWhere,
  processWhere,
  taskWhere,
} from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  aiAnalyses,
  auditLogs,
  contracts,
  deadlines,
  DEFAULT_ORGANIZATION_SETTINGS,
  legalProcesses,
  occurrences,
  organizations,
  tasks,
  users,
  type OrganizationSettings,
} from "@/server/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Occurrence statuses considered "in progress" (not resolved nor converted). */
export const OPEN_OCCURRENCE_STATUSES = ["open", "under_analysis", "action_plan", "monitoring"] as const satisfies readonly OccurrenceStatus[];
const OPEN_TASK_STATUSES = ["todo", "in_progress", "blocked"] as const;
/** Deadlines that count as real deadlines (AI suggestions only after human validation). */
const COUNTED_VALIDATION = ["not_required", "validated"] as const;

export type MoneyBucket = { count: number; claimCents: number; provisionCents: number };

export type DashboardData = {
  generatedAt: Date;
  today: string;
  settings: { upcomingDeadlineDays: number; contractExpirationDays: number };
  /** Which sections the user may consult (action permissions). */
  sections: { processes: boolean; occurrences: boolean; contracts: boolean; deadlines: boolean; tasks: boolean; analyses: boolean };
  processes: {
    total: number;
    active: number;
    byStatus: Record<ProcessStatus, number>;
    /** Active processes only. */
    byArea: Record<LegalArea, number>;
    /** Active processes only. */
    byPhase: Record<ProcessPhase, number>;
    /** Active processes only. */
    byRisk: Record<RiskLevel, number>;
  };
  occurrences: {
    total: number;
    /** Not resolved nor converted to process. */
    inProgress: number;
    byStatus: Record<OccurrenceStatus, number>;
    /** In-progress occurrences only. */
    byRisk: Record<RiskLevel, number>;
    convertedToProcess: number;
  };
  deadlines: {
    overdue: number;
    upcoming: number;
    pendingValidation: number;
    next: UpcomingDeadline[];
  };
  /** Informed values (claim/provision/exposure/contract value). Not AI estimates. */
  exposure: {
    activeProcesses: MoneyBucket & { withClaim: number };
    byRisk: Record<RiskLevel, MoneyBucket>;
    byLossProbability: Record<LossProbability | "unclassified", MoneyBucket>;
    occurrencesExposureCents: number;
    occurrencesWithExposure: number;
    activeContractsValueCents: number;
    activeContractsWithValue: number;
  };
  workload: { rows: WorkloadRow[]; unassigned: { tasks: number; deadlines: number } };
  contracts: {
    byStatus: Record<ContractStatus, number>;
    active: number;
    /** Active contracts ending within `contractExpirationDays`. */
    expiring: number;
    /** Still "active" but the end date has passed. */
    expiredStillActive: number;
  };
  analyses: { pendingReview: number; stale: number; failedLast7Days: number; running: number };
  activity: ActivityItem[];
};

export type UpcomingDeadline = {
  id: string;
  title: string;
  dueDate: string;
  origin: "manual" | "imported" | "ai_suggested" | "system";
  validationStatus: "not_required" | "pending_validation" | "validated" | "rejected";
  responsibleId: string | null;
  responsibleName: string | null;
  /** Linked record (only when visible to the user). */
  linked: { type: "legal_process" | "occurrence" | "contract"; label: string; href: string } | null;
  href: string;
};

export type WorkloadRow = {
  userId: string;
  name: string;
  openTasks: number;
  overdueTasks: number;
  openDeadlines: number;
  overdueDeadlines: number;
  total: number;
  overdue: number;
};

export type ActivityItem = {
  id: string;
  action: string;
  summary: string;
  actorName: string | null;
  entityType: EntityType;
  entityHref: string | null;
  createdAt: Date;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const countAll = () => sql<number>`count(*)::int`;
const countIf = (cond: SQL) => sql<number>`(count(*) filter (where ${cond}))::int`;
/** bigint sums arrive as numeric strings; coerce to number of cents. */
const sumCents = (col: AnyPgColumn, cond?: SQL) =>
  cond
    ? sql<string>`coalesce(sum(${col}) filter (where ${cond}), 0)::text`
    : sql<string>`coalesce(sum(${col}), 0)::text`;
const toNum = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

function zeroed<const K extends readonly string[]>(keys: K): Record<K[number], number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K[number], number>;
}
const emptyBucket = (): MoneyBucket => ({ count: 0, claimCents: 0, provisionCents: 0 });

function mergeSettings(raw: Partial<OrganizationSettings> | null | undefined) {
  const d = DEFAULT_ORGANIZATION_SETTINGS.alerts;
  const a: Partial<OrganizationSettings["alerts"]> = raw?.alerts ?? {};
  const days = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 3650 ? Math.floor(v) : fallback;
  return {
    upcomingDeadlineDays: days(a.upcomingDeadlineDays, d.upcomingDeadlineDays),
    contractExpirationDays: days(a.contractExpirationDays, d.contractExpirationDays),
  };
}

function inc<K extends string>(rec: Record<K, number>, key: K | null | undefined, n: number) {
  if (key != null && key in rec) rec[key] += n;
}

const LINKABLE_ENTITY_TYPES = ["legal_process", "occurrence", "contract", "document", "task", "deadline", "analysis"] as const;

function auditEntityHref(type: EntityType, id: string | null): string | null {
  if (!id) return null;
  return (LINKABLE_ENTITY_TYPES as readonly string[]).includes(type)
    ? entityHref({ type: type as EntityRef["type"], id })
    : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type DashboardOptions = {
  /** Reference "today" ("YYYY-MM-DD"); defaults to today in America/Sao_Paulo. For tests. */
  today?: string;
  /** Reference instant; defaults to now. For tests. */
  now?: Date;
};

export async function getDashboardData(ctx: AuthContext, opts: DashboardOptions = {}): Promise<DashboardData> {
  assertCan(ctx, "dashboard:read");
  const db = getDb();
  const now = opts.now ?? new Date();
  const today = opts.today && /^\d{4}-\d{2}-\d{2}$/.test(opts.today) ? opts.today : todayISO(now);

  const sections = {
    processes: can(ctx, "process:read"),
    occurrences: can(ctx, "occurrence:read"),
    contracts: can(ctx, "contract:read"),
    deadlines: can(ctx, "deadline:read"),
    tasks: can(ctx, "task:read"),
    analyses: can(ctx, "analysis:read"),
  };

  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const settings = mergeSettings(org?.settings);
  const upcomingUntil = addDaysISO(today, settings.upcomingDeadlineDays);
  const contractUntil = addDaysISO(today, settings.contractExpirationDays);

  const [processes, occ, dl, workload, contractStats, analyses, activity] = await Promise.all([
    sections.processes ? loadProcesses(ctx) : null,
    sections.occurrences ? loadOccurrences(ctx) : null,
    sections.deadlines ? loadDeadlines(ctx, today, upcomingUntil) : null,
    loadWorkload(ctx, today, sections),
    sections.contracts ? loadContracts(ctx, today, contractUntil) : null,
    sections.analyses ? loadAnalyses(ctx, now) : null,
    loadActivity(ctx),
  ]);

  return {
    generatedAt: now,
    today,
    settings,
    sections,
    processes: processes?.summary ?? {
      total: 0,
      active: 0,
      byStatus: zeroed(PROCESS_STATUSES),
      byArea: zeroed(LEGAL_AREAS),
      byPhase: zeroed(PROCESS_PHASES),
      byRisk: zeroed(RISK_LEVELS),
    },
    occurrences: occ?.summary ?? {
      total: 0,
      inProgress: 0,
      byStatus: zeroed(OCCURRENCE_STATUSES),
      byRisk: zeroed(RISK_LEVELS),
      convertedToProcess: 0,
    },
    deadlines: dl ?? { overdue: 0, upcoming: 0, pendingValidation: 0, next: [] },
    exposure: {
      activeProcesses: processes?.exposure.active ?? { ...emptyBucket(), withClaim: 0 },
      byRisk: processes?.exposure.byRisk ?? emptyRiskBuckets(),
      byLossProbability: processes?.exposure.byLoss ?? emptyLossBuckets(),
      occurrencesExposureCents: occ?.exposureCents ?? 0,
      occurrencesWithExposure: occ?.withExposure ?? 0,
      activeContractsValueCents: contractStats?.activeValueCents ?? 0,
      activeContractsWithValue: contractStats?.activeWithValue ?? 0,
    },
    workload,
    contracts: contractStats?.summary ?? { byStatus: zeroed(CONTRACT_STATUSES), active: 0, expiring: 0, expiredStillActive: 0 },
    analyses: analyses ?? { pendingReview: 0, stale: 0, failedLast7Days: 0, running: 0 },
    activity,
  };
}

function emptyRiskBuckets(): Record<RiskLevel, MoneyBucket> {
  return Object.fromEntries(RISK_LEVELS.map((r) => [r, emptyBucket()])) as Record<RiskLevel, MoneyBucket>;
}
function emptyLossBuckets(): Record<LossProbability | "unclassified", MoneyBucket> {
  return Object.fromEntries([...LOSS_PROBABILITIES, "unclassified"].map((r) => [r, emptyBucket()])) as Record<
    LossProbability | "unclassified",
    MoneyBucket
  >;
}

// --- Processes -------------------------------------------------------------

async function loadProcesses(ctx: AuthContext) {
  const p = legalProcesses;
  // One grouped query; the number of groups is bounded by the enum sizes.
  const rows = await getDb()
    .select({
      status: p.status,
      area: p.area,
      phase: p.phase,
      riskLevel: p.riskLevel,
      lossProbability: p.lossProbability,
      count: countAll(),
      withClaim: countIf(sql`${p.claimAmountCents} is not null`),
      claim: sumCents(p.claimAmountCents),
      provision: sumCents(p.provisionAmountCents),
    })
    .from(p)
    .where(processWhere(ctx))
    .groupBy(p.status, p.area, p.phase, p.riskLevel, p.lossProbability);

  const summary = {
    total: 0,
    active: 0,
    byStatus: zeroed(PROCESS_STATUSES),
    byArea: zeroed(LEGAL_AREAS),
    byPhase: zeroed(PROCESS_PHASES),
    byRisk: zeroed(RISK_LEVELS),
  };
  const active = { ...emptyBucket(), withClaim: 0 };
  const byRisk = emptyRiskBuckets();
  const byLoss = emptyLossBuckets();

  for (const r of rows) {
    const n = toNum(r.count);
    summary.total += n;
    inc(summary.byStatus, r.status, n);
    if (r.status !== "active") continue;
    summary.active += n;
    inc(summary.byArea, r.area, n);
    inc(summary.byPhase, r.phase, n);
    inc(summary.byRisk, r.riskLevel, n);
    const claim = toNum(r.claim);
    const provision = toNum(r.provision);
    active.count += n;
    active.withClaim += toNum(r.withClaim);
    active.claimCents += claim;
    active.provisionCents += provision;
    const rb = byRisk[r.riskLevel];
    if (rb) {
      rb.count += n;
      rb.claimCents += claim;
      rb.provisionCents += provision;
    }
    const lb = byLoss[r.lossProbability ?? "unclassified"] ?? byLoss.unclassified;
    lb.count += n;
    lb.claimCents += claim;
    lb.provisionCents += provision;
  }
  return { summary, exposure: { active, byRisk, byLoss } };
}

// --- Occurrences -----------------------------------------------------------

async function loadOccurrences(ctx: AuthContext) {
  const o = occurrences;
  const rows = await getDb()
    .select({
      status: o.status,
      riskLevel: o.riskLevel,
      count: countAll(),
      withExposure: countIf(sql`${o.estimatedExposureCents} is not null`),
      exposure: sumCents(o.estimatedExposureCents),
    })
    .from(o)
    .where(occurrenceWhere(ctx))
    .groupBy(o.status, o.riskLevel);

  const summary = {
    total: 0,
    inProgress: 0,
    byStatus: zeroed(OCCURRENCE_STATUSES),
    byRisk: zeroed(RISK_LEVELS),
    convertedToProcess: 0,
  };
  let exposureCents = 0;
  let withExposure = 0;
  const open = OPEN_OCCURRENCE_STATUSES as readonly string[];
  for (const r of rows) {
    const n = toNum(r.count);
    summary.total += n;
    inc(summary.byStatus, r.status, n);
    if (r.status === "converted_to_process") summary.convertedToProcess += n;
    if (!open.includes(r.status)) continue;
    summary.inProgress += n;
    inc(summary.byRisk, r.riskLevel, n);
    exposureCents += toNum(r.exposure);
    withExposure += toNum(r.withExposure);
  }
  return { summary, exposureCents, withExposure };
}

// --- Deadlines -------------------------------------------------------------

async function loadDeadlines(ctx: AuthContext, today: string, upcomingUntil: string) {
  const d = deadlines;
  const db = getDb();
  const counted = and(eq(d.status, "open"), inArray(d.validationStatus, [...COUNTED_VALIDATION]))!;

  const [counts] = await db
    .select({
      overdue: countIf(and(counted, lt(d.dueDate, today))!),
      upcoming: countIf(and(counted, gte(d.dueDate, today), lte(d.dueDate, upcomingUntil))!),
      pendingValidation: countIf(and(eq(d.status, "open"), eq(d.validationStatus, "pending_validation"))!),
    })
    .from(d)
    .where(deadlineWhere(ctx));

  // Linked records are joined with their own visibility scope: a responsible
  // person may see a deadline whose parent record they cannot see.
  const rows = await db
    .select({
      id: d.id,
      title: d.title,
      dueDate: d.dueDate,
      origin: d.origin,
      validationStatus: d.validationStatus,
      responsibleId: d.responsibleId,
      responsibleName: users.name,
      processId: legalProcesses.id,
      processNumber: legalProcesses.number,
      processTitle: legalProcesses.title,
      occurrenceId: occurrences.id,
      occurrenceTitle: occurrences.title,
      contractId: contracts.id,
      contractTitle: contracts.title,
    })
    .from(d)
    .leftJoin(users, and(eq(users.id, d.responsibleId), eq(users.organizationId, ctx.organizationId)))
    .leftJoin(legalProcesses, and(eq(legalProcesses.id, d.processId), processWhere(ctx)))
    .leftJoin(occurrences, and(eq(occurrences.id, d.occurrenceId), occurrenceWhere(ctx)))
    .leftJoin(contracts, and(eq(contracts.id, d.contractId), contractWhere(ctx)))
    .where(and(deadlineWhere(ctx), counted, gte(d.dueDate, today)))
    .orderBy(asc(d.dueDate), asc(d.createdAt))
    .limit(8);

  const next: UpcomingDeadline[] = rows.map((r) => {
    let linked: UpcomingDeadline["linked"] = null;
    if (r.processId) {
      linked = {
        type: "legal_process",
        label: `${r.processNumber ?? ""} · ${r.processTitle ?? ""}`,
        href: entityHref({ type: "legal_process", id: r.processId }),
      };
    } else if (r.occurrenceId) {
      linked = { type: "occurrence", label: r.occurrenceTitle ?? "", href: entityHref({ type: "occurrence", id: r.occurrenceId }) };
    } else if (r.contractId) {
      linked = { type: "contract", label: r.contractTitle ?? "", href: entityHref({ type: "contract", id: r.contractId }) };
    }
    return {
      id: r.id,
      title: r.title,
      dueDate: r.dueDate,
      origin: r.origin,
      validationStatus: r.validationStatus,
      responsibleId: r.responsibleId,
      responsibleName: r.responsibleName ?? null,
      linked,
      href: entityHref({ type: "deadline", id: r.id }),
    };
  });

  return {
    overdue: toNum(counts?.overdue),
    upcoming: toNum(counts?.upcoming),
    pendingValidation: toNum(counts?.pendingValidation),
    next,
  };
}

// --- Workload by responsible -----------------------------------------------

async function loadWorkload(
  ctx: AuthContext,
  today: string,
  sections: { tasks: boolean; deadlines: boolean },
): Promise<DashboardData["workload"]> {
  const db = getDb();
  const t = tasks;
  const d = deadlines;

  const [taskRows, deadlineRows] = await Promise.all([
    sections.tasks
      ? db
          .select({
            userId: t.assigneeId,
            open: countAll(),
            overdue: countIf(and(isNotNull(t.dueDate), lt(t.dueDate, today))!),
          })
          .from(t)
          .where(and(taskWhere(ctx), inArray(t.status, [...OPEN_TASK_STATUSES])))
          .groupBy(t.assigneeId)
      : [],
    sections.deadlines
      ? db
          .select({
            userId: d.responsibleId,
            open: countAll(),
            overdue: countIf(lt(d.dueDate, today)),
          })
          .from(d)
          .where(and(deadlineWhere(ctx), eq(d.status, "open"), inArray(d.validationStatus, [...COUNTED_VALIDATION])))
          .groupBy(d.responsibleId)
      : [],
  ]);

  const unassigned = { tasks: 0, deadlines: 0 };
  const byUser = new Map<string, Omit<WorkloadRow, "name" | "total" | "overdue">>();
  const get = (id: string) => {
    let row = byUser.get(id);
    if (!row) {
      row = { userId: id, openTasks: 0, overdueTasks: 0, openDeadlines: 0, overdueDeadlines: 0 };
      byUser.set(id, row);
    }
    return row;
  };
  for (const r of taskRows) {
    if (!r.userId) {
      unassigned.tasks += toNum(r.open);
      continue;
    }
    const row = get(r.userId);
    row.openTasks += toNum(r.open);
    row.overdueTasks += toNum(r.overdue);
  }
  for (const r of deadlineRows) {
    if (!r.userId) {
      unassigned.deadlines += toNum(r.open);
      continue;
    }
    const row = get(r.userId);
    row.openDeadlines += toNum(r.open);
    row.overdueDeadlines += toNum(r.overdue);
  }

  const ranked = [...byUser.values()]
    .map((r) => ({ ...r, total: r.openTasks + r.openDeadlines, overdue: r.overdueTasks + r.overdueDeadlines }))
    .sort((a, b) => b.overdue - a.overdue || b.total - a.total)
    .slice(0, 10);

  if (ranked.length === 0) return { rows: [], unassigned };

  // Names only for users of the same organization (ids came from scoped rows).
  const names = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, ctx.organizationId), inArray(users.id, ranked.map((r) => r.userId))));
  const nameById = new Map(names.map((u) => [u.id, u.name]));

  return {
    rows: ranked
      .filter((r) => nameById.has(r.userId))
      .map((r) => ({ ...r, name: nameById.get(r.userId) ?? "" })),
    unassigned,
  };
}

// --- Contracts -------------------------------------------------------------

async function loadContracts(ctx: AuthContext, today: string, contractUntil: string) {
  const c = contracts;
  const rows = await getDb()
    .select({
      status: c.status,
      count: countAll(),
      expiring: countIf(and(isNotNull(c.endDate), gte(c.endDate, today), lte(c.endDate, contractUntil))!),
      expired: countIf(and(isNotNull(c.endDate), lt(c.endDate, today))!),
      withValue: countIf(sql`${c.valueCents} is not null`),
      value: sumCents(c.valueCents),
    })
    .from(c)
    .where(contractWhere(ctx))
    .groupBy(c.status);

  const summary = { byStatus: zeroed(CONTRACT_STATUSES), active: 0, expiring: 0, expiredStillActive: 0 };
  let activeValueCents = 0;
  let activeWithValue = 0;
  for (const r of rows) {
    const n = toNum(r.count);
    inc(summary.byStatus, r.status, n);
    if (r.status !== "active") continue;
    summary.active += n;
    summary.expiring += toNum(r.expiring);
    summary.expiredStillActive += toNum(r.expired);
    activeValueCents += toNum(r.value);
    activeWithValue += toNum(r.withValue);
  }
  return { summary, activeValueCents, activeWithValue };
}

// --- AI analyses -----------------------------------------------------------

async function loadAnalyses(ctx: AuthContext, now: Date) {
  const a = aiAnalyses;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [row] = await getDb()
    .select({
      pendingReview: countIf(and(eq(a.status, "succeeded"), eq(a.reviewStatus, "pending_review"))!),
      stale: countIf(and(eq(a.status, "succeeded"), eq(a.isStale, true))!),
      failedLast7Days: countIf(and(eq(a.status, "failed"), sql`coalesce(${a.completedAt}, ${a.createdAt}) >= ${since}`)!),
      running: countIf(inArray(a.status, ["queued", "running"])),
    })
    .from(a)
    .where(analysisWhere(ctx));
  return {
    pendingReview: toNum(row?.pendingReview),
    stale: toNum(row?.stale),
    failedLast7Days: toNum(row?.failedLast7Days),
    running: toNum(row?.running),
  };
}

// --- Recent activity -------------------------------------------------------

async function loadActivity(ctx: AuthContext): Promise<ActivityItem[]> {
  const l = auditLogs;
  const rows = await getDb()
    .select({
      id: l.id,
      action: l.action,
      summary: l.summary,
      entityType: l.entityType,
      entityId: l.entityId,
      createdAt: l.createdAt,
      actorName: users.name,
    })
    .from(l)
    .leftJoin(users, and(eq(users.id, l.actorId), eq(users.organizationId, ctx.organizationId)))
    .where(
      and(
        eq(l.organizationId, ctx.organizationId),
        notLike(l.action, "auth.%"),
        entityReferenceWhere(ctx, l.entityType, l.entityId),
      ),
    )
    .orderBy(desc(l.createdAt))
    .limit(12);

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    summary: r.summary,
    actorName: r.actorName ?? null,
    entityType: r.entityType,
    entityHref: auditEntityHref(r.entityType, r.entityId),
    createdAt: r.createdAt,
  }));
}
