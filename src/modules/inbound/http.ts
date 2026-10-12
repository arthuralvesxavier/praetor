/**
 * HTTP glue shared by the /api/v1 route handlers (Web Request/Response only,
 * no `next/*`). Authentication is by API key on EVERY request: the routes are
 * outside the proxy and never read the session cookie.
 */
import { createHash } from "node:crypto";
import { authenticateApiKey, type ApiKeyIdentity } from "@/modules/api-keys/service";
import { consumeInboundQuota } from "./rate-limit";
import { errorResponse, recordRejectedRequest, type InboundResponse } from "./service";

export function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

export function toHttpResponse(res: InboundResponse): Response {
  return Response.json(res.body, {
    status: res.httpStatus,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(res.headers ?? {}) },
  });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/** 401 (missing/invalid/revoked/expired key) or 429 (per-key limit), else the identity. */
export async function authenticateRequest(
  request: Request,
  endpoint: string,
): Promise<{ ok: true; identity: ApiKeyIdentity } | { ok: false; response: Response }> {
  const identity = await authenticateApiKey(bearer(request), { ipAddress: clientIp(request) });
  if (!identity) {
    return {
      ok: false,
      response: toHttpResponse(
        errorResponse(401, "unauthorized", "Chave de API ausente, inválida, revogada ou expirada. Envie Authorization: Bearer <chave>.", {
          headers: { "WWW-Authenticate": 'Bearer realm="praetor-api"' },
        }),
      ),
    };
  }
  const quota = consumeInboundQuota(identity.apiKeyId);
  if (!quota.ok) {
    await recordRejectedRequest(identity, endpoint, 429, "rate_limited");
    return {
      ok: false,
      response: toHttpResponse(
        errorResponse(429, "rate_limited", "Limite de requisições por minuto atingido para esta chave. Tente de novo em instantes.", {
          headers: { "Retry-After": String(quota.retryAfterSeconds) },
        }),
      ),
    };
  }
  return { ok: true, identity };
}

/**
 * Reads the body up to `limit` bytes (even without Content-Length) and returns
 * its text and SHA-256. The body is never logged nor stored.
 */
export async function readLimitedBody(
  request: Request,
  limit: number,
): Promise<{ ok: true; text: string; sha256: string } | { ok: false; response: Response }> {
  const tooLarge = () =>
    toHttpResponse(errorResponse(413, "payload_too_large", `O corpo da requisição excede o limite de ${Math.floor(limit / (1024 * 1024))} MB.`));
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) return { ok: false, response: tooLarge() };
  if (!request.body) return { ok: true, text: "", sha256: createHash("sha256").update("").digest("hex") };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, response: tooLarge() };
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return { ok: true, text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Idempotency-Key: 1 to 200 visible ASCII characters. */
export function idempotencyKeyOf(request: Request): { ok: true; key: string | null } | { ok: false; response: Response } {
  const raw = request.headers.get("idempotency-key");
  if (raw === null) return { ok: true, key: null };
  const key = raw.trim();
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) {
    return {
      ok: false,
      response: toHttpResponse(errorResponse(400, "invalid_idempotency_key", "Idempotency-Key inválida: use de 1 a 200 caracteres visíveis (ASCII).")),
    };
  }
  return { ok: true, key };
}
