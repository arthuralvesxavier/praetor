import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { env } from "@/server/env";
import { UnauthenticatedError } from "@/server/lib/errors";
import { authenticate, resolveSession, revokeSession } from "@/server/services/auth";
import type { UserContext } from "./context";
import { assertCan, can, type Permission } from "./permissions";

/**
 * Next.js glue for authentication. Every page, server action and route
 * handler that touches data must obtain its context from here:
 *
 *   pages:          const ctx = await requirePageContext("process:read");
 *   server actions: const ctx = await requireActionContext("process:write");
 *   route handlers: const ctx = await getCurrentUser(); if (!ctx) return 401
 *
 * The proxy (src/proxy.ts) only does an optimistic cookie-presence redirect;
 * it is NOT an authorization layer.
 */

export const SESSION_COOKIE = "praetor_session";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/** Current user or null. Memoized per request. */
export const getCurrentUser = cache(async (): Promise<UserContext | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const ctx = await resolveSession(token);
  if (ctx) ctx.ipAddress = await clientIp();
  return ctx;
});

/** For pages/layouts: redirects to /login when signed out and to /sem-permissao when lacking the permission. */
export async function requirePageContext(permission?: Permission): Promise<UserContext> {
  const ctx = await getCurrentUser();
  if (!ctx) redirect("/login");
  if (permission && !can(ctx, permission)) redirect("/sem-permissao");
  return ctx;
}

/** For server actions: throws (caught by toActionError) instead of redirecting. */
export async function requireActionContext(permission?: Permission): Promise<UserContext> {
  const ctx = await getCurrentUser();
  if (!ctx) throw new UnauthenticatedError();
  if (permission) assertCan(ctx, permission);
  return ctx;
}

export async function signIn(email: string, password: string): Promise<void> {
  const h = await headers();
  const { token, expiresAt } = await authenticate({
    email,
    password,
    ipAddress: await clientIp(),
    userAgent: h.get("user-agent"),
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().APP_URL.startsWith("https://"),
    path: "/",
    expires: expiresAt,
  });
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const ctx = await getCurrentUser();
  await revokeSession(token, ctx);
  jar.delete(SESSION_COOKIE);
}
