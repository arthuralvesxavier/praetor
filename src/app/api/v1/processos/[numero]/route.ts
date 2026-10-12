import { authenticateRequest, toHttpResponse } from "@/modules/inbound/http";
import { INBOUND_ENDPOINT_STATUS, errorResponse, getInboundProcessStatus } from "@/modules/inbound/service";
import { logger } from "@/server/lib/logger";

/**
 * GET /api/v1/processos/{numero}: minimal status of a process sent through
 * the API by this organization (scope process:read). Number with or without
 * punctuation. Outside the proxy; authenticated by API key.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/processos/[numero]">): Promise<Response> {
  const auth = await authenticateRequest(request, INBOUND_ENDPOINT_STATUS);
  if (!auth.ok) return auth.response;
  const { numero } = await ctx.params;
  try {
    return toHttpResponse(await getInboundProcessStatus(auth.identity, numero));
  } catch (err) {
    logger.error("inbound_status_failed", { apiKeyId: auth.identity.apiKeyId, error: err });
    return toHttpResponse(errorResponse(500, "internal", "Não foi possível consultar o processo agora. Tente de novo."));
  }
}
