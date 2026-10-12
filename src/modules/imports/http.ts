/**
 * Small helpers for the import route handlers (server only).
 */
import type { NextRequest } from "next/server";
import type { AppErrorCode } from "@/server/lib/errors";
import { env } from "@/server/env";

export const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  validation: 400,
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unauthenticated: 401,
  budget_exceeded: 429,
};

export function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** CSRF defense for state-changing routes: the request must come from our own origin. */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = hostOf(request.headers.get("origin"));
  if (!origin) return false;
  const allowed = new Set<string>();
  const appHost = hostOf(env().APP_URL);
  if (appHost) allowed.add(appHost);
  const requestHost = request.headers.get("host")?.toLowerCase();
  if (requestHost) allowed.add(requestHost);
  allowed.add(request.nextUrl.host.toLowerCase());
  return allowed.has(origin);
}

function asciiFileName(name: string, fallback: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._ ()-]/g, "_")
    .replace(/_+/g, "_")
    .trim();
  return ascii || fallback;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `Content-Disposition: attachment` with an ASCII fallback and the exact UTF-8 name (RFC 6266 / 5987). */
export function attachmentDisposition(fileName: string, fallback = "arquivo"): string {
  return `attachment; filename="${asciiFileName(fileName, fallback)}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

/** Log-safe error description (never the message: database errors embed query parameters). */
export function errorSummary(err: unknown): { errorName: string; errorCode: string | null } {
  if (!(err instanceof Error)) return { errorName: "unknown", errorCode: null };
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  return { errorName: err.name, errorCode: typeof code === "string" ? code : null };
}
