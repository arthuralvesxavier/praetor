import type { NextRequest } from "next/server";
import { bool, str, strOrNull } from "@/lib/form";
import { errorSummary, isSameOrigin, jsonResponse, STATUS_BY_CODE } from "@/modules/imports/http";
import { MAX_IMPORT_BYTES, MAX_IMPORT_MB } from "@/modules/imports/schemas";
import { analyzeImport } from "@/modules/imports/service";
import { can } from "@/server/auth/permissions";
import { getCurrentUser } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * POST /api/imports/upload (multipart/form-data)
 *   file (.xlsx), companyId, defaultUnitId?, baseDate? (YYYY-MM-DD), distributeAfterCommit? ("on")
 *
 * Excluded from src/proxy.ts (bodies are not buffered there): this handler
 * authenticates, checks `import:run`, applies the same-origin (CSRF) check and
 * the 15 MB limit itself. Only ANALYZES the file — nothing is written to the
 * portfolio until the batch is confirmed.
 * Response: 201 { batchId } or { error, fieldErrors? }.
 */

const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

export async function POST(request: NextRequest): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return jsonResponse({ error: "Sessão expirada. Entre novamente." }, 401);
  if (!isSameOrigin(request)) return jsonResponse({ error: "Origem da requisição não permitida." }, 403);
  if (!can(ctx, "import:run")) return jsonResponse({ error: "Você não tem permissão para importar planilhas." }, 403);

  const tooLarge = `O arquivo excede o limite de ${MAX_IMPORT_MB} MB.`;
  const lengthHeader = request.headers.get("content-length");
  if (!lengthHeader || !/^\d+$/.test(lengthHeader)) {
    return jsonResponse({ error: "Não foi possível determinar o tamanho do envio. Tente novamente." }, 411);
  }
  if (Number(lengthHeader) > MAX_IMPORT_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return jsonResponse({ error: tooLarge, fieldErrors: { file: [tooLarge] } }, 413);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return jsonResponse({ error: "Formato de envio inválido." }, 415);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "Não foi possível ler o arquivo enviado. Tente novamente." }, 400);
  }

  const entry = form.get("file");
  if (!(entry instanceof File) || entry.size === 0) {
    const message = entry instanceof File ? "O arquivo está vazio." : "Selecione a planilha.";
    return jsonResponse({ error: message, fieldErrors: { file: [message] } }, 400);
  }
  if (entry.size > MAX_IMPORT_BYTES) return jsonResponse({ error: tooLarge, fieldErrors: { file: [tooLarge] } }, 413);

  try {
    const { batchId } = await analyzeImport(ctx, {
      file: { name: entry.name, bytes: new Uint8Array(await entry.arrayBuffer()) },
      companyId: str(form, "companyId") ?? "",
      defaultUnitId: strOrNull(form, "defaultUnitId"),
      baseDate: strOrNull(form, "baseDate"),
      distributeAfterCommit: bool(form, "distributeAfterCommit"),
    });
    return jsonResponse({ batchId }, 201);
  } catch (err) {
    if (err instanceof AppError) {
      return jsonResponse({ error: err.message, fieldErrors: err.fieldErrors }, STATUS_BY_CODE[err.code] ?? 400);
    }
    logger.error("import_upload_failed", { userId: ctx.userId, ...errorSummary(err) });
    return jsonResponse({ error: "Não foi possível analisar a planilha. Tente novamente." }, 500);
  }
}
