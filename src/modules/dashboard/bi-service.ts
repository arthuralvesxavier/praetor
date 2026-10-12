/**
 * BI aggregates for the executive dashboard, driven by filters (period, unit,
 * legal area, responsible person).
 *
 * Every query is bounded by the row-visibility scopes of `@/server/auth/access`
 * — each role only aggregates what it may see — and then narrowed by the
 * filters. Filters are plain conditions ANDed to the scope, so an id from
 * another organization can only produce empty results, never data.
 *
 * Filter semantics:
 * - unit / responsible: apply to processes, occurrences, contracts, deadlines and tasks;
 * - legal area / company: apply to processes and to deadlines/tasks linked to processes of that
 *   area/company (occurrences and contracts have neither);
 * - period: applies to flows (entries, closings, registrations, resolutions) and their
 *   deltas; stock indicators (active processes, exposure, open items) are the current state.
 *
 * Monetary values are the ones INFORMED in the records — never AI estimates.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, lte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  LOSS_PROBABILITIES,
  OCCURRENCE_CATEGORIES,
  PROCESS_PHASES,
  type LegalArea,
  type LossProbability,
  type OccurrenceCategory,
  type ProcessPhase,
  type RiskLevel,
} from "@/domain/enums";
import { addDaysISO, todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { contractWhere, deadlineWhere, occurrenceWhere, processWhere, taskWhere } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  contracts,
  deadlines,
  DEFAULT_ORGANIZATION_SETTINGS,
  legalProcesses,
  occurrences,
  organizations,
  tasks,
  users,
} from "@/server/db/schema";
import { buildBuckets, mondayOf, periodRange, type BiFilters, type Bucket, type PeriodRange } from "./bi-filters";

const OPEN_OCCURRENCE_STATUSES = ["open", "under_analysis", "action_plan", "monitoring"] as const;
const IN_PROGRESS_PROCESS_STATUSES = ["active", "suspended"] as const;
const OPEN_TASK_STATUSES = ["todo", "in_progress", "blocked"] as const;
const COUNTED_VALIDATION = ["not_required", "validated"] as const;
const DEADLINE_WEEKS = 8;
const TZ = "America/Sao_Paulo";

export type MoneyRow<K extends string> = { key: K; count: number; claimCents: number; provisionCents: number };

export type BiData = {
  generatedAt: Date;
  today: string;
  filters: BiFilters;
  range: PeriodRange;
  buckets: Bucket[];
  upcomingDays: number;
  contractDays: number;
  sections: { processes: boolean; occurrences: boolean; contracts: boolean; deadlines: boolean; tasks: boolean };
  kpis: {
    activeProcesses: number;
    newProcesses: number;
    newProcessesPrevious: number | null;
    closedProcesses: number;
    exposureClaimCents: number;
    exposureProvisionCents: number;
    activeWithClaim: number;
    openOccurrences: number;
    newOccurrences: number;
    newOccurrencesPrevious: number | null;
    resolvedOccurrences: number;
    occurrenceExposureCents: number;
    overdueDeadlines: number;
    upcomingDeadlines: number;
    pendingValidation: number;
    openTasks: number;
    overdueTasks: number;
    activeContracts: number;
    expiringContracts: number;
  };
  /** Aligned with `buckets`. */
  processFlow: { entered: number[]; closed: number[] };
  occurrenceFlow: { registered: number[]; resolved: number[] };
  riskProcesses: Record<RiskLevel, number>;
  riskOccurrences: Record<RiskLevel, number>;
  exposureByArea: MoneyRow<LegalArea>[];
  exposureByLoss: MoneyRow<LossProbability | "unclassified">[];
  byPhase: { key: ProcessPhase; count: number }[];
  occurrencesByCategory: { key: OccurrenceCategory; count: number }[];
  deadlineLoad: { overdue: number; weeks: { start: string; count: number }[] };
  workload: { userId: string; name: string; openDeadlines: number; overdueDeadlines: number; openTasks: number; overdueTasks: number }[];
  topExposure: {
    id: string;
    number: string;
    title: string;
    area: LegalArea;
    riskLevel: RiskLevel;
    claimCents: number;
    provisionCents: number;
    responsibleName: string | null;
  }[];
};

const countAll = () => sql<number>`count(*)::int`;
const countIf = (cond: SQL) => sql<number>`(count(*) filter (where ${cond}))::int`;
const sumCents = (col: AnyPgColumn) => sql<string>`coalesce(sum(${col}), 0)::text`;
const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
const zeroRisk = (): Record<RiskLevel, number> => ({ low: 0, medium: 0, high: 0, critical: 0 });

/** Calendar date a process entered the portfolio: filing date, else registration date (São Paulo). */
const processEntry = sql`coalesce(${legalProcesses.filedAt}, (${legalProcesses.createdAt} at time zone ${TZ})::date)`;
const occurrenceResolved = sql`(${occurrences.resolvedAt} at time zone ${TZ})::date`;

function bucketExpr(granularity: "week" | "month", dateExpr: SQL | AnyPgColumn) {
  return sql<string>`to_char(date_trunc(${sql.raw(`'${granularity}'`)}, (${dateExpr})::timestamp), 'YYYY-MM-DD')`;
}

function between(dateExpr: SQL | AnyPgColumn, start: string, end: string): SQL {
  return sql`(${dateExpr}) between ${start}::date and ${end}::date`;
}

function align(buckets: Bucket[], rows: { b: string; n: number }[]): number[] {
  const map = new Map(rows.map((r) => [r.b, num(r.n)]));
  return buckets.map((b) => map.get(b.key) ?? 0);
}

export type BiOptions = { today?: string; now?: Date };

export async function getBiData(ctx: AuthContext, filters: BiFilters, opts: BiOptions = {}): Promise<BiData> {
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
  };

  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const alerts = { ...DEFAULT_ORGANIZATION_SETTINGS.alerts, ...(org?.settings?.alerts ?? {}) };
  // Same reading as `/prazos?situacao=proximos` (work service), so the "Prazos próximos" link lists the same deadlines.
  const rawUpcoming = alerts.upcomingDeadlineDays;
  const upcomingDays =
    typeof rawUpcoming === "number" && Number.isFinite(rawUpcoming) && rawUpcoming >= 0
      ? Math.min(365, Math.floor(rawUpcoming))
      : DEFAULT_ORGANIZATION_SETTINGS.alerts.upcomingDeadlineDays;
  // Same reading as `/contratos?vencendo=1` (contracts service).
  const rawContract = alerts.contractExpirationDays;
  const contractDays =
    typeof rawContract === "number" && Number.isFinite(rawContract) && rawContract >= 0
      ? Math.trunc(rawContract)
      : DEFAULT_ORGANIZATION_SETTINGS.alerts.contractExpirationDays;

  // --- filter conditions (scope first, then filters) ----------------------
  const p = legalProcesses;
  const o = occurrences;
  const d = deadlines;
  const t = tasks;
  const c = contracts;

  const procCond = and(
    processWhere(ctx),
    filters.unitId ? eq(p.unitId, filters.unitId) : undefined,
    filters.area ? eq(p.area, filters.area) : undefined,
    filters.responsibleId ? eq(p.responsibleId, filters.responsibleId) : undefined,
    filters.companyId ? eq(p.companyId, filters.companyId) : undefined,
  )!;
  const occCond = and(
    occurrenceWhere(ctx),
    filters.unitId ? eq(o.unitId, filters.unitId) : undefined,
    filters.responsibleId ? eq(o.responsibleId, filters.responsibleId) : undefined,
  )!;
  // Deadlines and tasks have no area/company: they follow the process they are linked to.
  const areaProcessIds =
    filters.area || filters.companyId
      ? db
          .select({ id: p.id })
          .from(p)
          .where(
            and(
              processWhere(ctx),
              filters.area ? eq(p.area, filters.area) : undefined,
              filters.companyId ? eq(p.companyId, filters.companyId) : undefined,
            ),
          )
      : null;
  const dlCond = and(
    deadlineWhere(ctx),
    filters.unitId ? eq(d.unitId, filters.unitId) : undefined,
    filters.responsibleId ? eq(d.responsibleId, filters.responsibleId) : undefined,
    areaProcessIds ? and(isNotNull(d.processId), inArray(d.processId, areaProcessIds)) : undefined,
  )!;
  const taskCond = and(
    taskWhere(ctx),
    filters.unitId ? eq(t.unitId, filters.unitId) : undefined,
    filters.responsibleId ? eq(t.assigneeId, filters.responsibleId) : undefined,
    areaProcessIds ? and(isNotNull(t.processId), inArray(t.processId, areaProcessIds)) : undefined,
  )!;
  const contractCond = and(
    contractWhere(ctx),
    filters.unitId ? eq(c.unitId, filters.unitId) : undefined,
    filters.responsibleId ? eq(c.responsibleId, filters.responsibleId) : undefined,
  )!;

  // --- period ------------------------------------------------------------
  let earliest: string | null = null;
  if (filters.period === "all") {
    const [ep, eo] = await Promise.all([
      sections.processes
        ? db.select({ v: sql<string | null>`min(${processEntry})::text` }).from(p).where(procCond)
        : [{ v: null }],
      sections.occurrences ? db.select({ v: sql<string | null>`min(${o.reportedOn})::text` }).from(o).where(occCond) : [{ v: null }],
    ]);
    earliest = [ep[0]?.v, eo[0]?.v].filter((v): v is string => Boolean(v)).sort()[0] ?? null;
  }
  const range = periodRange(filters.period, today, earliest);
  const buckets = buildBuckets(range);
  const g = range.granularity;
  const flowStart = buckets[0]?.start ?? range.start;
  const upcomingUntil = addDaysISO(today, upcomingDays);
  const contractUntil = addDaysISO(today, contractDays);
  const weekStart = mondayOf(today);
  const weekEnd = addDaysISO(weekStart, DEADLINE_WEEKS * 7 - 1);

  const [procStats, procFlowIn, procFlowOut, procPrev, procRisk, procArea, procLoss, procPhase, top] = sections.processes
    ? await Promise.all([
        db
          .select({
            active: countIf(eq(p.status, "active")),
            claim: sql<string>`coalesce(sum(${p.claimAmountCents}) filter (where ${p.status} = 'active'), 0)::text`,
            provision: sql<string>`coalesce(sum(${p.provisionAmountCents}) filter (where ${p.status} = 'active'), 0)::text`,
            withClaim: countIf(sql`${p.status} = 'active' and ${p.claimAmountCents} is not null`),
            entered: countIf(between(processEntry, range.start, range.end)),
            closed: countIf(and(isNotNull(p.closedAt), between(p.closedAt, range.start, range.end))!),
          })
          .from(p)
          .where(procCond),
        db
          .select({ b: bucketExpr(g, processEntry), n: countAll() })
          .from(p)
          .where(and(procCond, between(processEntry, flowStart, range.end)))
          .groupBy(sql`1`),
        db
          .select({ b: bucketExpr(g, p.closedAt), n: countAll() })
          .from(p)
          .where(and(procCond, isNotNull(p.closedAt), between(p.closedAt, flowStart, range.end)))
          .groupBy(sql`1`),
        range.previous
          ? db
              .select({ n: countAll() })
              .from(p)
              .where(and(procCond, between(processEntry, range.previous.start, range.previous.end)))
          : Promise.resolve(null),
        db
          .select({ k: p.riskLevel, n: countAll() })
          .from(p)
          .where(and(procCond, eq(p.status, "active")))
          .groupBy(p.riskLevel),
        db
          .select({ k: p.area, n: countAll(), claim: sumCents(p.claimAmountCents), provision: sumCents(p.provisionAmountCents) })
          .from(p)
          .where(and(procCond, eq(p.status, "active")))
          .groupBy(p.area),
        db
          .select({
            k: p.lossProbability,
            n: countAll(),
            claim: sumCents(p.claimAmountCents),
            provision: sumCents(p.provisionAmountCents),
          })
          .from(p)
          .where(and(procCond, eq(p.status, "active")))
          .groupBy(p.lossProbability),
        db
          .select({ k: p.phase, n: countAll() })
          .from(p)
          .where(and(procCond, inArray(p.status, [...IN_PROGRESS_PROCESS_STATUSES])))
          .groupBy(p.phase),
        db
          .select({
            id: p.id,
            number: p.number,
            title: p.title,
            area: p.area,
            riskLevel: p.riskLevel,
            claim: p.claimAmountCents,
            provision: p.provisionAmountCents,
            responsibleName: users.name,
          })
          .from(p)
          .leftJoin(users, and(eq(users.id, p.responsibleId), eq(users.organizationId, ctx.organizationId)))
          .where(and(procCond, eq(p.status, "active"), isNotNull(p.claimAmountCents)))
          .orderBy(desc(p.claimAmountCents))
          .limit(8),
      ])
    : [null, [], [], null, [], [], [], [], []];

  const [occStats, occFlowIn, occFlowOut, occPrev, occRisk, occCategory] = sections.occurrences
    ? await Promise.all([
        db
          .select({
            open: countIf(inArray(o.status, [...OPEN_OCCURRENCE_STATUSES])),
            exposure: sql<string>`coalesce(sum(${o.estimatedExposureCents}) filter (where ${o.status} in ('open','under_analysis','action_plan','monitoring')), 0)::text`,
            registered: countIf(between(o.reportedOn, range.start, range.end)),
            resolved: countIf(and(isNotNull(o.resolvedAt), between(occurrenceResolved, range.start, range.end))!),
          })
          .from(o)
          .where(occCond),
        db
          .select({ b: bucketExpr(g, o.reportedOn), n: countAll() })
          .from(o)
          .where(and(occCond, between(o.reportedOn, flowStart, range.end)))
          .groupBy(sql`1`),
        db
          .select({ b: bucketExpr(g, occurrenceResolved), n: countAll() })
          .from(o)
          .where(and(occCond, isNotNull(o.resolvedAt), between(occurrenceResolved, flowStart, range.end)))
          .groupBy(sql`1`),
        range.previous
          ? db
              .select({ n: countAll() })
              .from(o)
              .where(and(occCond, between(o.reportedOn, range.previous.start, range.previous.end)))
          : Promise.resolve(null),
        db
          .select({ k: o.riskLevel, n: countAll() })
          .from(o)
          .where(and(occCond, inArray(o.status, [...OPEN_OCCURRENCE_STATUSES])))
          .groupBy(o.riskLevel),
        db
          .select({ k: o.category, n: countAll() })
          .from(o)
          .where(and(occCond, inArray(o.status, [...OPEN_OCCURRENCE_STATUSES])))
          .groupBy(o.category),
      ])
    : [null, [], [], null, [], []];

  const counted = and(eq(d.status, "open"), inArray(d.validationStatus, [...COUNTED_VALIDATION]))!;
  const [dlStats, dlWeeks, dlByUser] = sections.deadlines
    ? await Promise.all([
        db
          .select({
            overdue: countIf(and(counted, lt(d.dueDate, today))!),
            upcoming: countIf(and(counted, gte(d.dueDate, today), lte(d.dueDate, upcomingUntil))!),
            pending: countIf(and(eq(d.status, "open"), eq(d.validationStatus, "pending_validation"))!),
          })
          .from(d)
          .where(dlCond),
        db
          .select({ b: bucketExpr("week", d.dueDate), n: countAll() })
          .from(d)
          .where(and(dlCond, counted, gte(d.dueDate, today), lte(d.dueDate, weekEnd)))
          .groupBy(sql`1`),
        db
          .select({ userId: d.responsibleId, open: countAll(), overdue: countIf(lt(d.dueDate, today)) })
          .from(d)
          .where(and(dlCond, counted, isNotNull(d.responsibleId)))
          .groupBy(d.responsibleId),
      ])
    : [null, [], []];

  const [taskStats, taskByUser] = sections.tasks
    ? await Promise.all([
        db
          .select({
            open: countAll(),
            overdue: countIf(and(isNotNull(t.dueDate), lt(t.dueDate, today))!),
          })
          .from(t)
          .where(and(taskCond, inArray(t.status, [...OPEN_TASK_STATUSES]))),
        db
          .select({
            userId: t.assigneeId,
            open: countAll(),
            overdue: countIf(and(isNotNull(t.dueDate), lt(t.dueDate, today))!),
          })
          .from(t)
          .where(and(taskCond, inArray(t.status, [...OPEN_TASK_STATUSES]), isNotNull(t.assigneeId)))
          .groupBy(t.assigneeId),
      ])
    : [null, []];

  const contractStats = sections.contracts
    ? await db
        .select({
          active: countIf(eq(c.status, "active")),
          expiring: countIf(and(eq(c.status, "active"), isNotNull(c.endDate), gte(c.endDate, today), lte(c.endDate, contractUntil))!),
        })
        .from(c)
        .where(contractCond)
    : null;

  // --- workload by responsible -----------------------------------------
  const byUser = new Map<string, { openDeadlines: number; overdueDeadlines: number; openTasks: number; overdueTasks: number }>();
  const row = (id: string) => {
    let r = byUser.get(id);
    if (!r) byUser.set(id, (r = { openDeadlines: 0, overdueDeadlines: 0, openTasks: 0, overdueTasks: 0 }));
    return r;
  };
  for (const r of dlByUser) if (r.userId) Object.assign(row(r.userId), { openDeadlines: num(r.open), overdueDeadlines: num(r.overdue) });
  for (const r of taskByUser)
    if (r.userId) {
      const x = row(r.userId);
      x.openTasks = num(r.open);
      x.overdueTasks = num(r.overdue);
    }
  const ranked = [...byUser.entries()]
    .map(([userId, r]) => ({ userId, ...r }))
    .sort(
      (a, b) =>
        b.overdueDeadlines + b.overdueTasks - (a.overdueDeadlines + a.overdueTasks) ||
        b.openDeadlines + b.openTasks - (a.openDeadlines + a.openTasks),
    )
    .slice(0, 10);
  const names = ranked.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.organizationId, ctx.organizationId), inArray(users.id, ranked.map((r) => r.userId))))
    : [];
  const nameById = new Map(names.map((u) => [u.id, u.name]));

  // --- shape ---------------------------------------------------------------
  const riskProcesses = zeroRisk();
  for (const r of procRisk) riskProcesses[r.k] += num(r.n);
  const riskOccurrences = zeroRisk();
  for (const r of occRisk) riskOccurrences[r.k] += num(r.n);

  const weekMap = new Map(dlWeeks.map((r) => [r.b, num(r.n)]));
  const ps = procStats?.[0];
  const os = occStats?.[0];

  return {
    generatedAt: now,
    today,
    filters,
    range,
    buckets,
    upcomingDays,
    contractDays,
    sections,
    kpis: {
      activeProcesses: num(ps?.active),
      newProcesses: num(ps?.entered),
      newProcessesPrevious: procPrev ? num(procPrev[0]?.n) : null,
      closedProcesses: num(ps?.closed),
      exposureClaimCents: num(ps?.claim),
      exposureProvisionCents: num(ps?.provision),
      activeWithClaim: num(ps?.withClaim),
      openOccurrences: num(os?.open),
      newOccurrences: num(os?.registered),
      newOccurrencesPrevious: occPrev ? num(occPrev[0]?.n) : null,
      resolvedOccurrences: num(os?.resolved),
      occurrenceExposureCents: num(os?.exposure),
      overdueDeadlines: num(dlStats?.[0]?.overdue),
      upcomingDeadlines: num(dlStats?.[0]?.upcoming),
      pendingValidation: num(dlStats?.[0]?.pending),
      openTasks: num(taskStats?.[0]?.open),
      overdueTasks: num(taskStats?.[0]?.overdue),
      activeContracts: num(contractStats?.[0]?.active),
      expiringContracts: num(contractStats?.[0]?.expiring),
    },
    processFlow: { entered: align(buckets, procFlowIn), closed: align(buckets, procFlowOut) },
    occurrenceFlow: { registered: align(buckets, occFlowIn), resolved: align(buckets, occFlowOut) },
    riskProcesses,
    riskOccurrences,
    exposureByArea: procArea
      .map((r) => ({ key: r.k, count: num(r.n), claimCents: num(r.claim), provisionCents: num(r.provision) }))
      .sort((a, b) => b.claimCents - a.claimCents || b.count - a.count),
    exposureByLoss: [...LOSS_PROBABILITIES, "unclassified" as const].map((key) => {
      const r = procLoss.find((x) => (x.k ?? "unclassified") === key);
      return { key, count: num(r?.n), claimCents: num(r?.claim), provisionCents: num(r?.provision) };
    }),
    byPhase: PROCESS_PHASES.map((key) => ({
      key,
      count: num(procPhase.find((r) => r.k === key)?.n),
    })),
    occurrencesByCategory: OCCURRENCE_CATEGORIES.map((key) => ({
      key,
      count: num(occCategory.find((r) => r.k === key)?.n),
    }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count),
    deadlineLoad: {
      overdue: num(dlStats?.[0]?.overdue),
      weeks: Array.from({ length: DEADLINE_WEEKS }, (_, i) => {
        const start = addDaysISO(weekStart, i * 7);
        return { start, count: weekMap.get(start) ?? 0 };
      }),
    },
    workload: ranked
      .filter((r) => nameById.has(r.userId))
      .map((r) => ({ ...r, name: nameById.get(r.userId) ?? "" })),
    topExposure: top.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      area: r.area,
      riskLevel: r.riskLevel,
      claimCents: num(r.claim),
      provisionCents: num(r.provision),
      responsibleName: r.responsibleName ?? null,
    })),
  };
}

