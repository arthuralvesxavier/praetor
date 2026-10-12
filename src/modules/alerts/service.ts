import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { AlertSeverity, AlertType, EntityType } from "@/domain/enums";
import { ALERT_SEVERITIES, ALERT_TYPES, ENTITY_TYPES } from "@/domain/enums";
import { entityHref, normalizePage, type EntityRef, type Page, type Paginated } from "@/domain/entities";
import type { AuthContext } from "@/server/auth/context";
import { entityReferenceWhere } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { alerts, hearings, processGuarantees, processValuations, settlements, users } from "@/server/db/schema";
import { recordAudit } from "@/server/services/audit";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { ALERT_AREAS, ALERT_TYPES_BY_AREA, alertAreaOf, type AlertArea } from "./areas";

/**
 * Preventive alerts and the "painel de pendências" (TE-05). Created by routines
 * and services through `upsertAlert` (system), deduplicated while open by
 * `dedupeKey`. Visibility follows the referenced entity (entityReferenceWhere).
 */

export type AlertItem = {
  id: string;
  type: AlertType;
  /** Area of the alerts center the type belongs to. */
  area: AlertArea;
  severity: AlertSeverity;
  title: string;
  message: string;
  entityType: EntityType;
  entityId: string;
  /** UI route of the referenced entity (or of its process tab), when it has one. */
  href: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  /** Null when resolved automatically by a routine. */
  resolvedByName: string | null;
};

export type AlertSituation = "open" | "resolved";

export type AlertCenterFilters = {
  type?: AlertType;
  severity?: AlertSeverity;
  /** Default "open". */
  situation?: AlertSituation;
  area?: AlertArea;
};

export type AlertAreaCount = { total: number; critical: number; warning: number };

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const DIRECT_LINKABLE: ReadonlySet<string> = new Set([
  "legal_process",
  "occurrence",
  "contract",
  "document",
  "task",
  "deadline",
  "analysis",
]);

/** Process-owned entities: the alert links to a tab of the process page. */
const PROCESS_CHILD_TABS: Partial<Record<EntityType, string>> = {
  hearing: "audiencias",
  settlement: "acordos",
  guarantee: "valores",
  valuation: "valores",
};

/** Alert types about a process whose natural destination is a specific process tab. */
const PROCESS_TAB_BY_ALERT_TYPE: Partial<Record<AlertType, string>> = {
  valuation_pending_review: "valores",
  enforcement_without_value: "valores",
};

/**
 * Link of an alert whose entity has its own route (no database lookup).
 * Returns null for process-owned entities (hearing, settlement, guarantee,
 * valuation) — those are resolved in batch by `resolveAlertHrefs`.
 */
export function alertHref(entityType: EntityType, entityId: string, type?: AlertType): string | null {
  if (entityType === "legal_process") {
    const tab = type ? PROCESS_TAB_BY_ALERT_TYPE[type] : undefined;
    return tab ? `/processos/${entityId}?aba=${tab}` : `/processos/${entityId}`;
  }
  if (entityType === "deadline" && type === "deadline_pending_validation") return `/prazos?aba=validacao&prazo=${entityId}`;
  if (entityType === "case_brief") return `/analises-preliminares/${entityId}`;
  if (entityType === "intake") return `/entrada/${entityId}`;
  if (DIRECT_LINKABLE.has(entityType)) return entityHref({ type: entityType as EntityRef["type"], id: entityId });
  return null;
}

/**
 * Links for a batch of alerts: one query per process-owned entity type present
 * (hearing / settlement / guarantee / valuation → process id), scoped to the
 * organization. Keyed by `${entityType}:${entityId}`.
 */
export async function resolveAlertHrefs(
  organizationId: string,
  rows: { type: AlertType; entityType: EntityType; entityId: string }[],
  db: DbOrTx = getDb(),
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const pending: Partial<Record<EntityType, Set<string>>> = {};
  for (const r of rows) {
    const key = `${r.entityType}:${r.entityId}`;
    if (PROCESS_CHILD_TABS[r.entityType]) {
      (pending[r.entityType] ??= new Set()).add(r.entityId);
      continue;
    }
    if (!out.has(key)) out.set(key, alertHref(r.entityType, r.entityId, r.type));
  }

  const lookups: { type: EntityType; run: (ids: string[]) => Promise<{ id: string; processId: string }[]> }[] = [
    {
      type: "hearing",
      run: (ids) =>
        db
          .select({ id: hearings.id, processId: hearings.processId })
          .from(hearings)
          .where(and(inArray(hearings.id, ids), eq(hearings.organizationId, organizationId))),
    },
    {
      type: "settlement",
      run: (ids) =>
        db
          .select({ id: settlements.id, processId: settlements.processId })
          .from(settlements)
          .where(and(inArray(settlements.id, ids), eq(settlements.organizationId, organizationId))),
    },
    {
      type: "guarantee",
      run: (ids) =>
        db
          .select({ id: processGuarantees.id, processId: processGuarantees.processId })
          .from(processGuarantees)
          .where(and(inArray(processGuarantees.id, ids), eq(processGuarantees.organizationId, organizationId))),
    },
    {
      type: "valuation",
      run: (ids) =>
        db
          .select({ id: processValuations.id, processId: processValuations.processId })
          .from(processValuations)
          .where(and(inArray(processValuations.id, ids), eq(processValuations.organizationId, organizationId))),
    },
  ];

  await Promise.all(
    lookups.map(async ({ type, run }) => {
      const ids = pending[type];
      if (!ids || ids.size === 0) return;
      const found = await run([...ids]);
      const byId = new Map(found.map((f) => [f.id, f.processId]));
      for (const id of ids) {
        const processId = byId.get(id);
        out.set(`${type}:${id}`, processId ? `/processos/${processId}?aba=${PROCESS_CHILD_TABS[type]}` : null);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const resolverUser = alias(users, "alert_resolver");

function visibleAlertsWhere(ctx: AuthContext): SQL {
  return and(eq(alerts.organizationId, ctx.organizationId), entityReferenceWhere(ctx, alerts.entityType, alerts.entityId))!;
}

const SEVERITY_RANK = sql`case ${alerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`;

function selectAlertRows(ctx: AuthContext, where: SQL | undefined) {
  return getDb()
    .select({ a: alerts, resolvedByName: resolverUser.name })
    .from(alerts)
    .leftJoin(
      resolverUser,
      and(eq(resolverUser.id, alerts.resolvedById), eq(resolverUser.organizationId, ctx.organizationId)),
    )
    .where(where);
}

type AlertRow = Awaited<ReturnType<typeof selectAlertRows>>[number];

async function mapAlertRows(ctx: AuthContext, rows: AlertRow[]): Promise<AlertItem[]> {
  const hrefs = await resolveAlertHrefs(
    ctx.organizationId,
    rows.map((r) => ({ type: r.a.type, entityType: r.a.entityType, entityId: r.a.entityId })),
  );
  return rows.map(({ a, resolvedByName }) => ({
    id: a.id,
    type: a.type,
    area: alertAreaOf(a.type),
    severity: a.severity,
    title: a.title,
    message: a.message,
    entityType: a.entityType,
    entityId: a.entityId,
    href: hrefs.get(`${a.entityType}:${a.entityId}`) ?? null,
    createdAt: a.createdAt,
    resolvedAt: a.resolvedAt,
    resolvedByName: resolvedByName ?? null,
  }));
}

const listSchema = z.object({
  openOnly: z.boolean().optional(),
  limit: z.number().int().optional(),
});

export async function listAlerts(ctx: AuthContext, filters: { openOnly?: boolean; limit?: number } = {}): Promise<AlertItem[]> {
  assertCan(ctx, "dashboard:read");
  const f = listSchema.parse(filters);
  const openOnly = f.openOnly ?? true;
  const limit = Math.min(200, Math.max(1, f.limit ?? 50));
  const rows = await selectAlertRows(ctx, and(visibleAlertsWhere(ctx), openOnly ? isNull(alerts.resolvedAt) : undefined))
    .orderBy(SEVERITY_RANK, desc(alerts.createdAt), asc(alerts.id))
    .limit(limit);
  return mapAlertRows(ctx, rows);
}

const centerFiltersSchema = z.object({
  type: z.enum(ALERT_TYPES).optional(),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  situation: z.enum(["open", "resolved"]).optional(),
  area: z.enum(ALERT_AREAS).optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

function parseCenterFilters(filters: unknown) {
  const r = centerFiltersSchema.safeParse(filters ?? {});
  if (!r.success) throw new ValidationError("Filtros inválidos.", z.flattenError(r.error).fieldErrors as Record<string, string[]>);
  return r.data;
}

function centerWhere(ctx: AuthContext, f: z.output<typeof centerFiltersSchema>, opts: { ignoreArea?: boolean } = {}): SQL {
  const situation = f.situation ?? "open";
  return and(
    visibleAlertsWhere(ctx),
    situation === "open" ? isNull(alerts.resolvedAt) : isNotNull(alerts.resolvedAt),
    f.type ? eq(alerts.type, f.type) : undefined,
    f.severity ? eq(alerts.severity, f.severity) : undefined,
    f.area && !opts.ignoreArea ? inArray(alerts.type, [...ALERT_TYPES_BY_AREA[f.area]]) : undefined,
  )!;
}

function centerOrder(situation: AlertSituation) {
  return situation === "resolved"
    ? [desc(alerts.resolvedAt), desc(alerts.createdAt), asc(alerts.id)]
    : [SEVERITY_RANK, desc(alerts.createdAt), asc(alerts.id)];
}

/** Alerts center list (one area, one type, or everything), paginated. */
export async function listAlertsPaged(ctx: AuthContext, filters: AlertCenterFilters & Page = {}): Promise<Paginated<AlertItem>> {
  assertCan(ctx, "dashboard:read");
  const f = parseCenterFilters(filters);
  const { page, pageSize, offset } = normalizePage(f);
  const where = centerWhere(ctx, f);
  const [{ total }] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(alerts)
    .where(where);
  const rows = await selectAlertRows(ctx, where)
    .orderBy(...centerOrder(f.situation ?? "open"))
    .limit(pageSize)
    .offset(offset);
  return { items: await mapAlertRows(ctx, rows), total, page, pageSize };
}

/** Counts per area (respecting type/severity/situation, ignoring the area filter). */
export async function countAlertsByArea(
  ctx: AuthContext,
  filters: Omit<AlertCenterFilters, "area"> = {},
): Promise<Record<AlertArea, AlertAreaCount>> {
  assertCan(ctx, "dashboard:read");
  const f = parseCenterFilters(filters);
  const rows = await getDb()
    .select({
      type: alerts.type,
      total: sql<number>`count(*)::int`,
      critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical')::int`,
      warning: sql<number>`count(*) filter (where ${alerts.severity} = 'warning')::int`,
    })
    .from(alerts)
    .where(centerWhere(ctx, f, { ignoreArea: true }))
    .groupBy(alerts.type);
  const out = Object.fromEntries(ALERT_AREAS.map((a) => [a, { total: 0, critical: 0, warning: 0 }])) as Record<
    AlertArea,
    AlertAreaCount
  >;
  for (const r of rows) {
    const bucket = out[alertAreaOf(r.type)];
    bucket.total += r.total;
    bucket.critical += r.critical;
    bucket.warning += r.warning;
  }
  return out;
}

export type AlertGroup = { area: AlertArea; count: AlertAreaCount; items: AlertItem[] };

/** First `perGroup` alerts of every area that has alerts (most severe / most recent first). */
export async function listAlertGroups(
  ctx: AuthContext,
  filters: Omit<AlertCenterFilters, "area"> = {},
  perGroup = 5,
  /** Counts already computed with the same filters (`countAlertsByArea`), to skip the query. */
  precomputed?: Record<AlertArea, AlertAreaCount>,
): Promise<AlertGroup[]> {
  assertCan(ctx, "dashboard:read");
  const f = parseCenterFilters(filters);
  const limit = Math.min(20, Math.max(1, Math.floor(perGroup)));
  const counts = precomputed ?? (await countAlertsByArea(ctx, filters));
  const areas = ALERT_AREAS.filter((a) => counts[a].total > 0);
  const groups = await Promise.all(
    areas.map(async (area) => {
      const rows = await selectAlertRows(ctx, centerWhere(ctx, { ...f, area }))
        .orderBy(...centerOrder(f.situation ?? "open"))
        .limit(limit);
      return { area, count: counts[area], items: await mapAlertRows(ctx, rows) };
    }),
  );
  return groups;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function resolveAlert(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "alert:resolve");
  const parsed = z.guid().safeParse(id);
  if (!parsed.success) throw new NotFoundError("Alerta não encontrado ou sem permissão de acesso.");
  await getDb().transaction(async (tx) => {
    const [alert] = await tx
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.id, parsed.data),
          eq(alerts.organizationId, ctx.organizationId),
          entityReferenceWhere(ctx, alerts.entityType, alerts.entityId),
        ),
      );
    if (!alert) throw new NotFoundError("Alerta não encontrado ou sem permissão de acesso.");
    if (alert.resolvedAt) return;
    await tx
      .update(alerts)
      .set({ resolvedAt: new Date(), resolvedById: ctx.userId })
      .where(and(eq(alerts.id, alert.id), eq(alerts.organizationId, ctx.organizationId), isNull(alerts.resolvedAt)));
    await recordAudit(
      ctx,
      {
        action: "alert.resolve",
        entityType: alert.entityType,
        entityId: alert.entityId,
        summary: `Alerta resolvido: ${alert.title}`,
        metadata: { alertId: alert.id, alertType: alert.type },
      },
      tx,
    );
  });
}

const upsertSchema = z.object({
  organizationId: z.guid(),
  type: z.enum(ALERT_TYPES),
  severity: z.enum(ALERT_SEVERITIES),
  title: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(2000),
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.guid(),
  dedupeKey: z.string().trim().min(1).max(300),
});

/** System: creates the alert, or refreshes title/message/severity of the open alert with the same dedupe key. */
export async function upsertAlert(
  input: {
    organizationId: string;
    type: AlertType;
    severity: AlertSeverity;
    title: string;
    message: string;
    entityType: EntityType;
    entityId: string;
    dedupeKey: string;
  },
  db: DbOrTx = getDb(),
): Promise<void> {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Alerta inválido.", z.flattenError(parsed.error).fieldErrors);
  const v = parsed.data;
  await db
    .insert(alerts)
    .values(v)
    .onConflictDoUpdate({
      target: [alerts.organizationId, alerts.dedupeKey],
      targetWhere: sql`resolved_at is null`,
      set: { title: v.title, message: v.message, severity: v.severity, type: v.type },
    });
}

/** System: resolves the open alerts with the given dedupe keys. Returns how many were resolved. */
export async function resolveAlertsByDedupeKeys(
  organizationId: string,
  keys: string[],
  db: DbOrTx = getDb(),
): Promise<number> {
  if (!keys.length) return 0;
  const rows = await db
    .update(alerts)
    .set({ resolvedAt: new Date() })
    .where(and(eq(alerts.organizationId, organizationId), inArray(alerts.dedupeKey, keys), isNull(alerts.resolvedAt)))
    .returning({ id: alerts.id });
  return rows.length;
}

/**
 * System: resolves open alerts of the given types whose dedupe key is not in
 * `keepKeys` (their condition no longer holds). Returns how many were resolved.
 */
export async function resolveStaleAlerts(
  organizationId: string,
  types: AlertType[],
  keepKeys: string[],
  db: DbOrTx = getDb(),
): Promise<number> {
  const rows = await db
    .update(alerts)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(alerts.organizationId, organizationId),
        inArray(alerts.type, types),
        isNull(alerts.resolvedAt),
        keepKeys.length ? notInArray(alerts.dedupeKey, keepKeys) : undefined,
      ),
    )
    .returning({ id: alerts.id });
  return rows.length;
}

/** Open alerts visible to ctx (header bell). */
export async function countOpenAlerts(ctx: AuthContext): Promise<{ total: number; critical: number }> {
  if (!can(ctx, "dashboard:read")) return { total: 0, critical: 0 };
  const [row] = await getDb()
    .select({
      total: sql<number>`count(*)::int`,
      critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical')::int`,
    })
    .from(alerts)
    .where(and(visibleAlertsWhere(ctx), isNull(alerts.resolvedAt)));
  return { total: row?.total ?? 0, critical: row?.critical ?? 0 };
}
