import { buildOpenApiDocument } from "@/modules/inbound/openapi";
import { env } from "@/server/env";

/** GET /api/v1/openapi.json: public contract of the inbound API (no authentication, no data). */
export async function GET(): Promise<Response> {
  const e = env();
  return Response.json(buildOpenApiDocument({ serverUrl: e.APP_URL.replace(/\/+$/, ""), maxUploadMb: e.MAX_UPLOAD_MB }), {
    headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}
