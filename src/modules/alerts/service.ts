import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { AlertSeverity, AlertType, EntityType } from "@/domain/enums";
import { ALERT_SEVERITIES, ALERT_TYPES, ENTITY_TYPES } from "@/domain/enums";
import { entityHref, normalizePage, type EntityRef, type Page, type Paginated } from "@/domain/entities";
import type { AuthContext } from "@/server/auth/context";
import { entityReferenceWhere, REFERENCE_ENTITY_TYPES, type ReferenceEntityType } from "@/server/auth/access";
import { assertCan, can, type Permission } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { alerts, hearings, processGuarantees, processValuations, settlements, users } from "@/server/db/schema";
import { recordAudit } from "@/server/services/audit";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import {
  PROCESS_SECTION_IDS,
  processTabUrl,
  type ProcessSectionId,
  type ProcessTabKey,
} from "@/modules/processes/tabs";
import { ALERT_AREAS, ALERT_TYPES_BY_AREA, alertAreaOf, type AlertArea } from "./areas";

/**
 * Preventive alerts and the "painel de pendências" (TE-05). Created by routines
 * and services through `upsertAlert` (system), deduplicated while open by
 * `dedupeKey`. Visibility follows the referenced entity (entityReferenceWhere)
 * AND the read permission of its module (`visibleAlertsWhere`).
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

/** Tab of the process page and, when the content is not at its top, the section anchor. */
type ProcessTabTarget = { tab: ProcessTabKey; section: ProcessSectionId | null };

/**
 * Process-owned entities: the alert links to the tab (and section) of the process
 * page that shows the entity (keys of MODULE_CONTRACTS "Process detail tabs").
 */
const PROCESS_CHILD_TABS: Partial<Record<EntityType, ProcessTabTarget>> = {
  hearing: { tab: "prazos-e-audiencias", section: PROCESS_SECTION_IDS.hearings },
  settlement: { tab: "valores-e-acordos", section: PROCESS_SECTION_IDS.settlements },
  // Values (with the guarantees and the valuation history) open the "Valores e acordos" tab.
  guarantee: { tab: "valores-e-acordos", section: null },
  valuation: { tab: "valores-e-acordos", section: null },
};

/**
 * Alert types about a process whose natural destination is a specific tab (and
 * section) of the process page. Other `legal_process` alerts open the default tab.
 */
const PROCESS_TAB_BY_ALERT_TYPE: Partial<Record<AlertType, ProcessTabTarget>> = {
  valuation_pending_review: { tab: "valores-e-acordos", section: null },
  enforcement_without_value: { tab: "valores-e-acordos", section: null },
  // The alert asks to review the risk classification: its card in "Valores e acordos"
  // (the claims panel that changed it is in the same tab, `#pedidos`).
  claims_risk_review: { tab: "valores-e-acordos", section: PROCESS_SECTION_IDS.risk },
  snapshot_close_blocked: { tab: "valores-e-acordos", section: PROCESS_SECTION_IDS.risk },
  court_movement_relevant: { tab: "partes-e-andamento", section: PROCESS_SECTION_IDS.timeline },
  court_hearing_designated: { tab: "prazos-e-audiencias", section: PROCESS_SECTION_IDS.hearings },
  // R1 aprovado desatualizado: o botão "Gerar nova versão" fica na aba de documentos e análises.
  legal_report_outdated: { tab: "documentos-e-analises", section: PROCESS_SECTION_IDS.legalReport },
};

/**
 * Link of an alert whose entity has its own route (no database lookup).
 * Returns null for process-owned entities (hearing, settlement, guarantee,
 * valuation): those are resolved in batch by `resolveAlertHrefs`.
 */
export function alertHref(entityType: EntityType, entityId: string, type?: AlertType): string | null {
  if (entityType === "legal_process") {
    const target = type ? PROCESS_TAB_BY_ALERT_TYPE[type] : undefined;
    if (!target) return `/processos/${entityId}`;
    return processTabUrl(entityId, target.tab, target.section);
  }
  if (entityType === "deadline" && type === "deadline_pending_validation") return `/prazos?aba=validacao&prazo=${entityId}`;
  if (entityType === "case_brief") return `/analises-preliminares/${entityId}`;
  if (entityType === "intake") return `/entrada/${entityId}`;
  if (DIRECT_LINKABLE.has(entityType)) return entityHref({ type: entityType as EntityRef["type"], id: entityId });
  return null;
}

export type AlertLinkRow = { type: AlertType; entityType: EntityType; entityId: string };

/**
 * Key of ONE alert's link in the map returned by `resolveAlertHrefs`. The link
 * depends on the alert type (a process with a relevant movement and a
 * designated hearing has two alerts that open different tabs), so callers look
 * links up by this key, never by the entity alone.
 */
export function alertHrefKey(r: AlertLinkRow): string {
  return `${r.type}@${r.entityType}:${r.entityId}`;
}

/**
 * Links for a batch of alerts: one query per process-owned entity type present
 * (hearing / settlement / guarantee / valuation → process id), scoped to the
 * organization. Read each alert's link with `alertHrefKey(row)`.
 *
 * Also keyed by `${entityType}:${entityId}` (deprecated, for callers not yet
 * migrated): the link shared by every alert of that entity in the batch or,
 * when they differ, the entity's own link without a tab (`alertHref` without
 * type), never the tab of another alert type.
 */
export async function resolveAlertHrefs(
  organizationId: string,
  rows: readonly AlertLinkRow[],
  db: DbOrTx = getDb(),
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const pending: Partial<Record<EntityType, Set<string>>> = {};
  const childRows: AlertLinkRow[] = [];
  /** Entity key -> link of each of its alerts (direct links). */
  const byEntity = new Map<string, Set<string | null>>();
  for (const r of rows) {
    if (PROCESS_CHILD_TABS[r.entityType]) {
      (pending[r.entityType] ??= new Set()).add(r.entityId);
      childRows.push(r);
      continue;
    }
    const href = alertHref(r.entityType, r.entityId, r.type);
    out.set(alertHrefKey(r), href);
    const entityKey = `${r.entityType}:${r.entityId}`;
    let links = byEntity.get(entityKey);
    if (!links) byEntity.set(entityKey, (links = new Set()));
    links.add(href);
  }
  for (const [entityKey, links] of byEntity) {
    const [entityType, entityId] = entityKey.split(":") as [EntityType, string];
    out.set(entityKey, links.size === 1 ? [...links][0] : alertHref(entityType, entityId));
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
      const target = PROCESS_CHILD_TABS[type]!;
      for (const id of ids) {
        const processId = byId.get(id);
        out.set(`${type}:${id}`, processId ? processTabUrl(processId, target.tab, target.section) : null);
      }
    }),
  );
  // Process-owned entities: the tab depends on the entity type only.
  for (const r of childRows) out.set(alertHrefKey(r), out.get(`${r.entityType}:${r.entityId}`) ?? null);
  return out;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const resolverUser = alias(users, "alert_resolver");

/**
 * Read permission required to see an alert about each entity type (rule 9 of
 * access.ts): the alert title and message describe the referenced record, so
 * a role without access to the module (e.g. the accountant and contracts,
 * deadlines, tasks and AI analyses; the executive and preliminary analyses)
 * does not see its alerts. Types missing here are never visible.
 */
export const ALERT_ENTITY_READ_PERMISSION: Readonly<Record<ReferenceEntityType, Permission>> = {
  legal_process: "process:read",
  hearing: "process:read",
  intake: "process:read",
  occurrence: "occurrence:read",
  contract: "contract:read",
  document: "document:read",
  task: "task:read",
  deadline: "deadline:read",
  analysis: "analysis:read",
  case_brief: "brief:read",
  valuation: "contingency:read",
  guarantee: "contingency:read",
  settlement: "contingency:read",
};

/** Entity types whose alerts `ctx` may see (by module read permission). */
export function alertEntityTypesFor(ctx: AuthContext): ReferenceEntityType[] {
  return REFERENCE_ENTITY_TYPES.filter((type) => can(ctx, ALERT_ENTITY_READ_PERMISSION[type]));
}

/**
 * Alerts visible to `ctx`: organization + read permission on the referenced
 * module + row visibility of the referenced entity. Every alert read (center,
 * area counts, header bell, daily digest, dashboard) must use it so the
 * numbers agree. `onlyTypes` narrows the entity types further (e.g. to the
 * types present among the open alerts) without ever widening them.
 */
export function visibleAlertsWhere(ctx: AuthContext, onlyTypes?: readonly EntityType[]): SQL {
  const permitted = alertEntityTypesFor(ctx);
  const types = onlyTypes ? permitted.filter((t) => onlyTypes.includes(t)) : permitted;
  return and(
    eq(alerts.organizationId, ctx.organizationId),
    types.length ? inArray(alerts.entityType, types) : sql`false`,
    entityReferenceWhere(ctx, alerts.entityType, alerts.entityId, { types }),
  )!;
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
    href: hrefs.get(alertHrefKey(a)) ?? null,
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
      .where(and(eq(alerts.id, parsed.data), visibleAlertsWhere(ctx)));
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

/**
 * System: creates the alert, or refreshes title/message/severity/type of the
 * open alert with the same dedupe key. An open alert whose content did not
 * change is not rewritten (daily routines re-upsert every condition).
 */
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
      setWhere: sql`alerts.title is distinct from excluded.title or alerts.message is distinct from excluded.message or alerts.severity is distinct from excluded.severity or alerts.type is distinct from excluded.type`,
    });
}

/**
 * `column IN (<keys>)` with the whole list bound as ONE jsonb parameter: a
 * bound `IN ($1, …, $n)` list fails above 65,535 items (16-bit parameter
 * count of the PostgreSQL wire protocol), which a large portfolio can reach.
 */
function inKeyList(column: typeof alerts.dedupeKey, keys: readonly string[]): SQL {
  return sql`${column} in (select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`;
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
    .where(and(eq(alerts.organizationId, organizationId), isNull(alerts.resolvedAt), inKeyList(alerts.dedupeKey, keys)))
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
        keepKeys.length ? sql`not (${inKeyList(alerts.dedupeKey, keepKeys)})` : undefined,
      ),
    )
    .returning({ id: alerts.id });
  return rows.length;
}

/**
 * Open alerts visible to ctx (header bell, rendered on every page of the app,
 * and the daily digest). Same scope as the alerts center; to keep it cheap the
 * visibility condition is built only for the entity types that actually have
 * open alerts in the organization (and that ctx may read).
 */
export async function countOpenAlerts(ctx: AuthContext): Promise<{ total: number; critical: number }> {
  if (!can(ctx, "dashboard:read")) return { total: 0, critical: 0 };
  const permitted = alertEntityTypesFor(ctx);
  if (permitted.length === 0) return { total: 0, critical: 0 };
  const db = getDb();
  const present = await db
    .selectDistinct({ type: alerts.entityType })
    .from(alerts)
    .where(
      and(eq(alerts.organizationId, ctx.organizationId), isNull(alerts.resolvedAt), inArray(alerts.entityType, permitted)),
    );
  if (present.length === 0) return { total: 0, critical: 0 };
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical')::int`,
    })
    .from(alerts)
    .where(and(isNull(alerts.resolvedAt), visibleAlertsWhere(ctx, present.map((p) => p.type))));
  return { total: row?.total ?? 0, critical: row?.critical ?? 0 };
}
