import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AlertSeverity, AlertType, EntityType } from "@/domain/enums";
import { ALERT_SEVERITIES, ALERT_TYPES, ENTITY_TYPES } from "@/domain/enums";
import { entityHref, type EntityRef } from "@/domain/entities";
import type { AuthContext } from "@/server/auth/context";
import { entityReferenceWhere } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { alerts } from "@/server/db/schema";
import { recordAudit } from "@/server/services/audit";
import { NotFoundError, ValidationError } from "@/server/lib/errors";

/**
 * Preventive alerts. Created by routines and analyses through `upsertAlert`
 * (system), deduplicated while open by `dedupeKey`. Visibility follows the
 * referenced entity (entityReferenceWhere).
 */

export type AlertItem = {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  entityType: EntityType;
  entityId: string;
  /** UI route of the referenced entity, when it has one. */
  href: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

const LINKABLE: ReadonlySet<string> = new Set(["legal_process", "occurrence", "contract", "document", "task", "deadline", "analysis"]);

export function alertHref(entityType: EntityType, entityId: string): string | null {
  return LINKABLE.has(entityType) ? entityHref({ type: entityType as EntityRef["type"], id: entityId }) : null;
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
  const rows = await getDb()
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.organizationId, ctx.organizationId),
        entityReferenceWhere(ctx, alerts.entityType, alerts.entityId),
        openOnly ? isNull(alerts.resolvedAt) : undefined,
      ),
    )
    .orderBy(
      sql`case ${alerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`,
      desc(alerts.createdAt),
      asc(alerts.id),
    )
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    severity: r.severity,
    title: r.title,
    message: r.message,
    entityType: r.entityType,
    entityId: r.entityId,
    href: alertHref(r.entityType, r.entityId),
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  }));
}

export async function resolveAlert(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "alert:resolve");
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError();
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
  organizationId: z.uuid(),
  type: z.enum(ALERT_TYPES),
  severity: z.enum(ALERT_SEVERITIES),
  title: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(2000),
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.uuid(),
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
    .where(
      and(
        eq(alerts.organizationId, ctx.organizationId),
        isNull(alerts.resolvedAt),
        entityReferenceWhere(ctx, alerts.entityType, alerts.entityId),
      ),
    );
  return { total: row?.total ?? 0, critical: row?.critical ?? 0 };
}
