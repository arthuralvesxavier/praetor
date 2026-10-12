import { authenticateRequest, clientIp, idempotencyKeyOf, readLimitedBody, toHttpResponse } from "@/modules/inbound/http";
import {
  INBOUND_ENDPOINT_CREATE,
  errorResponse,
  inboundBodyLimitBytes,
  receiveInboundProcess,
  recordRejectedRequest,
} from "@/modules/inbound/service";
import { logger } from "@/server/lib/logger";

/**
 * POST /api/v1/processos: an external system sends an incoming case.
 *
 * Outside the proxy (no session cookie): authenticated by API key
 * (`Authorization: Bearer <key>`, scope intake:create), per-key rate limit,
 * JSON body only (documents in base64), optional `Idempotency-Key`.
 * Contract: GET /api/v1/openapi.json and docs/API.md.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateRequest(request, INBOUND_ENDPOINT_CREATE);
  if (!auth.ok) return auth.response;
  const { identity } = auth;

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    await recordRejectedRequest(identity, INBOUND_ENDPOINT_CREATE, 415, "unsupported_media_type");
    return toHttpResponse(errorResponse(415, "unsupported_media_type", "Envie o corpo em JSON (Content-Type: application/json)."));
  }
  const idem = idempotencyKeyOf(request);
  if (!idem.ok) return idem.response;

  const body = await readLimitedBody(request, inboundBodyLimitBytes());
  if (!body.ok) {
    await recordRejectedRequest(identity, INBOUND_ENDPOINT_CREATE, 413, "payload_too_large");
    return body.response;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    await recordRejectedRequest(identity, INBOUND_ENDPOINT_CREATE, 400, "invalid_json");
    return toHttpResponse(errorResponse(400, "invalid_json", "O corpo não é um JSON válido."));
  }

  try {
    const result = await receiveInboundProcess(identity, {
      payload,
      requestHash: body.sha256,
      idempotencyKey: idem.key,
      ipAddress: clientIp(request),
    });
    return toHttpResponse(result);
  } catch (err) {
    logger.error("inbound_route_failed", { apiKeyId: identity.apiKeyId, error: err });
    return toHttpResponse(errorResponse(500, "internal", "Não foi possível registrar o processo agora. Tente de novo."));
  }
}
