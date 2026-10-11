import type { EntityType } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";
import { getDb, type DbOrTx } from "@/server/db/client";
import { auditLogs } from "@/server/db/schema";

/**
 * Audit trail for relevant changes (create/update/delete of records, uploads,
 * downloads of documents, AI analysis requests/reviews, validations, admin
 * changes, logins). Call inside the same transaction as the change.
 *
 * Content safety: values of SENSITIVE_FIELDS are never stored, and long text
 * values are replaced by a marker — the audit log records THAT something
 * changed, not confidential content.
 */
const SENSITIVE_FIELDS = new Set(["passwordHash", "password", "extractedText", "documentNumber", "counterpartyDocument"]);
const IGNORED_FIELDS = new Set(["updatedAt", "createdAt"]);
const MAX_VALUE_LENGTH = 160;

export type AuditEntry = {
  action: string;
  entityType: EntityType;
  entityId?: string | null;
  summary: string;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  metadata?: Record<string, unknown>;
};

export async function recordAudit(ctx: AuthContext, entry: AuditEntry, db: DbOrTx = getDb()): Promise<void> {
  await db.insert(auditLogs).values({
    organizationId: ctx.organizationId,
    actorId: ctx.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary,
    changes: entry.changes ?? null,
    metadata: entry.metadata ?? null,
    ipAddress: ctx.ipAddress ?? null,
  });
}

function safeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_FIELDS.has(key)) return "[protegido]";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) return "[texto longo alterado]";
  if (Array.isArray(value) && JSON.stringify(value).length > MAX_VALUE_LENGTH) return "[lista alterada]";
  return value ?? null;
}

/**
 * Field-level diff between two versions of a row. Returns null when nothing
 * relevant changed. Pass `fields` to restrict the comparison.
 */
export function diffChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown>,
  fields?: readonly string[],
): Record<string, { from: unknown; to: unknown }> | null {
  const keys = fields ?? Object.keys(after);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    const from = before?.[key] ?? null;
    const to = after[key] ?? null;
    const same =
      from instanceof Date && to instanceof Date
        ? from.getTime() === to.getTime()
        : JSON.stringify(from) === JSON.stringify(to);
    if (!same) changes[key] = { from: safeValue(key, from), to: safeValue(key, to) };
  }
  return Object.keys(changes).length ? changes : null;
}
