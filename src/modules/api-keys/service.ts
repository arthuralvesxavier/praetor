/**
 * Chaves de API para sistemas externos (API de entrada /api/v1).
 *
 * - The full key ("prt_" + 32 random bytes, base64url) is returned ONCE by
 *   `createApiKey`; only its SHA-256 and a short display prefix are stored.
 * - The organization ALWAYS comes from the key (never from a request body).
 * - Management requires `admin:organization`; every create/revoke is audited
 *   (never the key itself).
 * - `authenticateApiKey` is the only system entry point (route handlers).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { API_KEY_SCOPE_LABELS, type ApiKeyScope, type InboundRequestStatus } from "@/domain/enums";
import { formatDate } from "@/lib/format";
import { type AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { apiKeys, inboundRequests, legalProcesses, organizations, users } from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "@/server/services/audit";
import { API_KEY_PATTERN, API_KEY_PREFIX, createApiKeySchema, type CreateApiKeyInput } from "./schemas";

/** Display prefix length (e.g. "prt_AbC123"). */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;
/** `last_used_at` is refreshed at most once per minute per key. */
const LAST_USED_REFRESH_MS = 60_000;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export type ApiKeyStatus = "active" | "revoked" | "expired";

export const API_KEY_STATUS_LABELS: Record<ApiKeyStatus, string> = {
  active: "Ativa",
  revoked: "Revogada",
  expired: "Expirada",
};

export type ApiKeyListItem = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  status: ApiKeyStatus;
  createdAt: Date;
  createdByName: string | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByName: string | null;
};

function statusOf(row: { revokedAt: Date | null; expiresAt: Date | null }, now = Date.now()): ApiKeyStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() <= now) return "expired";
  return "active";
}

export async function createApiKey(
  ctx: AuthContext,
  input: CreateApiKeyInput,
): Promise<{ id: string; key: string; keyPrefix: string; name: string }> {
  assertCan(ctx, "admin:organization");
  const parsed = createApiKeySchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(undefined, z.flattenError(parsed.error).fieldErrors as Record<string, string[]>);
  const v = parsed.data;
  const expiresAt = v.expiresOn ? new Date(`${v.expiresOn}T23:59:59.999Z`) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ValidationError(undefined, { expiresOn: ["A validade precisa ser uma data futura."] });
  }
  const key = generateApiKey();
  const keyPrefix = key.slice(0, DISPLAY_PREFIX_LENGTH);
  const id = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(apiKeys)
      .values({
        organizationId: ctx.organizationId,
        name: v.name,
        keyPrefix,
        keyHash: hashApiKey(key),
        scopes: v.scopes,
        createdById: ctx.userId,
        expiresAt,
      })
      .returning({ id: apiKeys.id });
    await recordAudit(
      ctx,
      {
        action: "api_key.create",
        entityType: "api_key",
        entityId: row.id,
        summary: `Chave de API "${v.name}" criada (${v.scopes.map((s) => API_KEY_SCOPE_LABELS[s]).join("; ")})${
          v.expiresOn ? `, válida até ${formatDate(v.expiresOn)}` : ""
        }.`,
        metadata: { keyPrefix, scopes: v.scopes, expiresOn: v.expiresOn ?? null },
      },
      tx,
    );
    return row.id;
  });
  return { id, key, keyPrefix, name: v.name };
}

export async function listApiKeys(ctx: AuthContext): Promise<ApiKeyListItem[]> {
  assertCan(ctx, "admin:organization");
  const creator = alias(users, "creator");
  const revoker = alias(users, "revoker");
  const rows = await getDb()
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      createdAt: apiKeys.createdAt,
      createdByName: creator.name,
      lastUsedAt: apiKeys.lastUsedAt,
      lastUsedIp: apiKeys.lastUsedIp,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      revokedByName: revoker.name,
    })
    .from(apiKeys)
    .leftJoin(creator, and(eq(creator.id, apiKeys.createdById), eq(creator.organizationId, ctx.organizationId)))
    .leftJoin(revoker, and(eq(revoker.id, apiKeys.revokedById), eq(revoker.organizationId, ctx.organizationId)))
    .where(eq(apiKeys.organizationId, ctx.organizationId))
    .orderBy(desc(apiKeys.createdAt));
  const now = Date.now();
  return rows.map((r) => ({ ...r, status: statusOf(r, now) }));
}

export async function revokeApiKey(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "admin:organization");
  if (!z.guid().safeParse(id).success) throw new NotFoundError("Chave não encontrada.");
  await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: apiKeys.id, name: apiKeys.name, revokedAt: apiKeys.revokedAt, keyPrefix: apiKeys.keyPrefix })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.organizationId, ctx.organizationId)))
      .for("update");
    if (!row) throw new NotFoundError("Chave não encontrada.");
    if (row.revokedAt) return;
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date(), revokedById: ctx.userId })
      .where(and(eq(apiKeys.id, row.id), eq(apiKeys.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "api_key.revoke",
        entityType: "api_key",
        entityId: row.id,
        summary: `Chave de API "${row.name}" revogada: requisições com ela passam a ser recusadas.`,
        metadata: { keyPrefix: row.keyPrefix },
      },
      tx,
    );
  });
}

export type InboundRequestItem = {
  id: string;
  createdAt: Date;
  apiKeyName: string;
  endpoint: string;
  status: InboundRequestStatus;
  httpStatus: number | null;
  processId: string | null;
  processNumber: string | null;
  intakeId: string | null;
  errorCode: string | null;
};

/** Latest requests received by the inbound API (no payloads are ever stored). */
export async function listInboundRequests(ctx: AuthContext, opts: { limit?: number } = {}): Promise<InboundRequestItem[]> {
  assertCan(ctx, "admin:organization");
  const limit = Math.max(1, Math.min(200, opts.limit ?? 25));
  return getDb()
    .select({
      id: inboundRequests.id,
      createdAt: inboundRequests.createdAt,
      apiKeyName: apiKeys.name,
      endpoint: inboundRequests.endpoint,
      status: inboundRequests.status,
      httpStatus: inboundRequests.httpStatus,
      processId: inboundRequests.processId,
      processNumber: legalProcesses.number,
      intakeId: inboundRequests.intakeId,
      errorCode: inboundRequests.errorCode,
    })
    .from(inboundRequests)
    .innerJoin(apiKeys, eq(apiKeys.id, inboundRequests.apiKeyId))
    .leftJoin(
      legalProcesses,
      and(eq(legalProcesses.id, inboundRequests.processId), eq(legalProcesses.organizationId, ctx.organizationId)),
    )
    .where(eq(inboundRequests.organizationId, ctx.organizationId))
    .orderBy(desc(inboundRequests.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Authentication (route handlers only)
// ---------------------------------------------------------------------------

export type ApiKeyIdentity = {
  apiKeyId: string;
  organizationId: string;
  name: string;
  scopes: ApiKeyScope[];
  isDemoOrganization: boolean;
};

/**
 * Resolves a raw key from `Authorization: Bearer <key>`. Returns null for a
 * malformed, unknown, revoked or expired key (the caller answers 401 without
 * saying which). Never logs the key.
 */
export async function authenticateApiKey(rawKey: string | null | undefined, opts: { ipAddress?: string | null } = {}): Promise<ApiKeyIdentity | null> {
  const key = (rawKey ?? "").trim();
  if (!API_KEY_PATTERN.test(key)) return null;
  const db = getDb();
  const [row] = await db
    .select({
      id: apiKeys.id,
      organizationId: apiKeys.organizationId,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      isDemo: organizations.isDemo,
    })
    .from(apiKeys)
    .innerJoin(organizations, eq(organizations.id, apiKeys.organizationId))
    .where(eq(apiKeys.keyHash, hashApiKey(key)))
    .limit(1);
  if (!row || statusOf(row) !== "active") return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
    try {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date(), lastUsedIp: opts.ipAddress?.slice(0, 64) ?? null })
        .where(eq(apiKeys.id, row.id));
    } catch (err) {
      logger.warn("api_key_last_used_update_failed", { apiKeyId: row.id, error: err });
    }
  }
  return {
    apiKeyId: row.id,
    organizationId: row.organizationId,
    name: row.name,
    scopes: (row.scopes ?? []).filter((s): s is ApiKeyScope => s in API_KEY_SCOPE_LABELS),
    isDemoOrganization: row.isDemo,
  };
}

export function hasScope(identity: ApiKeyIdentity, scope: ApiKeyScope): boolean {
  return identity.scopes.includes(scope);
}

/**
 * System context bound to the key's organization. The name ("API: <key>")
 * appears as the actor of intake steps; audit rows carry the key in metadata.
 */
export function apiKeyContext(identity: ApiKeyIdentity, ipAddress: string | null = null): AuthContext {
  return {
    kind: "system",
    userId: null,
    organizationId: identity.organizationId,
    role: "admin",
    unitId: null,
    lawFirmId: null,
    name: `API: ${identity.name}`,
    email: null,
    isDemoOrganization: identity.isDemoOrganization,
    ipAddress,
  };
}

/** Number of requests per status in the last 24 h (admin page). */
export async function countRecentInboundRequests(ctx: AuthContext): Promise<Record<string, number>> {
  assertCan(ctx, "admin:organization");
  const rows = await getDb()
    .select({ status: inboundRequests.status, n: sql<number>`count(*)::int` })
    .from(inboundRequests)
    .where(and(eq(inboundRequests.organizationId, ctx.organizationId), sql`${inboundRequests.createdAt} > now() - interval '24 hours'`))
    .groupBy(inboundRequests.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}
