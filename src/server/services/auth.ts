import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { AuthContext, UserContext } from "@/server/auth/context";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { getDb } from "@/server/db/client";
import { organizations, sessions, users } from "@/server/db/schema";
import { env } from "@/server/env";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "./audit";

/**
 * Framework-agnostic authentication: credential check, opaque DB-backed
 * sessions and session resolution. Cookie handling lives in
 * src/server/auth/session.ts (Next.js specific).
 */

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Simple in-memory throttle for login attempts (per process). Production with
// several instances should move this to a shared store — see docs/SECURITY.md.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function throttleKey(email: string, ip: string | null | undefined) {
  return `${email}|${ip ?? "-"}`;
}

function isThrottled(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function registerFailure(key: string) {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < Date.now()) attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else entry.count += 1;
}

let dummyHash: Promise<string> | undefined;

export class InvalidCredentialsError extends AppError {
  constructor(message = "E-mail ou senha inválidos.") {
    super(message, "unauthenticated");
  }
}

export async function authenticate(input: {
  email: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; expiresAt: Date; userId: string }> {
  const email = input.email.trim().toLowerCase();
  const key = throttleKey(email, input.ipAddress);
  if (isThrottled(key)) {
    throw new InvalidCredentialsError("Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.");
  }

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Always run a hash verification to keep timing similar for unknown e-mails.
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  const valid = user ? await verifyPassword(user.passwordHash, input.password) : (await verifyPassword(await dummyHash, input.password), false);

  if (!user || !valid || !user.isActive) {
    registerFailure(key);
    logger.warn("auth.login_failed", { userId: user?.id ?? null, reason: !user ? "unknown_email" : !valid ? "bad_password" : "inactive" });
    if (user) {
      await recordAudit(
        { kind: "user", userId: user.id, organizationId: user.organizationId, role: user.role, unitId: user.unitId, name: user.name, email: user.email, isDemoOrganization: false, ipAddress: input.ipAddress },
        { action: "auth.login_failed", entityType: "user", entityId: user.id, summary: "Tentativa de acesso sem sucesso" },
      );
    }
    throw new InvalidCredentialsError();
  }

  attempts.delete(key);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 3600 * 1000);
  await db.insert(sessions).values({
    id: hashToken(token),
    userId: user.id,
    organizationId: user.organizationId,
    expiresAt,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  // Opportunistic cleanup of expired sessions.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await recordAudit(
    { kind: "user", userId: user.id, organizationId: user.organizationId, role: user.role, unitId: user.unitId, name: user.name, email: user.email, isDemoOrganization: false, ipAddress: input.ipAddress },
    { action: "auth.login", entityType: "user", entityId: user.id, summary: "Acesso ao sistema" },
  );
  return { token, expiresAt, userId: user.id };
}

/** Resolves a raw session token to the user's context, or null if invalid/expired/inactive. */
export async function resolveSession(token: string | undefined | null): Promise<UserContext | null> {
  if (!token) return null;
  const db = getDb();
  const [row] = await db
    .select({
      userId: users.id,
      organizationId: users.organizationId,
      role: users.role,
      unitId: users.unitId,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
      isDemo: organizations.isDemo,
      sessionOrg: sessions.organizationId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.isActive || row.sessionOrg !== row.organizationId) return null;
  return {
    kind: "user",
    userId: row.userId,
    organizationId: row.organizationId,
    role: row.role,
    unitId: row.unitId,
    name: row.name,
    email: row.email,
    isDemoOrganization: row.isDemo,
  };
}

export async function revokeSession(token: string | undefined | null, ctx?: AuthContext | null): Promise<void> {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.id, hashToken(token)));
  if (ctx) await recordAudit(ctx, { action: "auth.logout", entityType: "user", entityId: ctx.userId, summary: "Saída do sistema" });
}

/** Revokes every session of a user (on deactivation, role or password change). */
export async function revokeUserSessions(userId: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.userId, userId));
}
