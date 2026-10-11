import type { NextRequest } from "next/server";
import type { ConfidentialityLevel, DocumentCategory } from "@/domain/enums";
import { str, strOrNull } from "@/lib/form";
import { maxUploadBytes } from "@/modules/documents/file-types";
import { errorSummary } from "@/modules/documents/log";
import { addDocumentVersion, uploadDocument } from "@/modules/documents/service";
import { getCurrentUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { AppError, type AppErrorCode } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * POST /api/documents/upload (multipart/form-data, field "file").
 *
 *   new document:  title, category, description?, confidentiality?, processId?, occurrenceId?, contractId?
 *   new version:   documentId, changeNote?
 *
 * Excluded from src/proxy.ts (so bodies are not buffered there): this handler
 * authenticates, applies a CSRF origin check and the size limit itself.
 * Response: 201 { documentId, versionId, versionNumber } or { error, fieldErrors? }.
 */

/** Room for the other multipart fields and boundaries on top of the file size limit. */
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  validation: 400,
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unauthenticated: 401,
  budget_exceeded: 429,
};

function json(body: unknown, status: number): Response {
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

/** CSRF defense: the request must come from our own origin (APP_URL or the request host). */
function isSameOrigin(request: NextRequest): boolean {
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

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1).replace(".", ",")} MB`;
}

export async function POST(request: NextRequest): Promise<Response> {
  const ctx = await getCurrentUser();
  if (!ctx) return json({ error: "Sessão expirada. Entre novamente." }, 401);
  if (!isSameOrigin(request)) return json({ error: "Origem da requisição não permitida." }, 403);

  const limit = maxUploadBytes(env().MAX_UPLOAD_MB);
  const tooLarge = `O arquivo excede o limite de ${formatMb(limit)}.`;
  const lengthHeader = request.headers.get("content-length");
  if (!lengthHeader || !/^\d+$/.test(lengthHeader)) {
    return json({ error: "Não foi possível determinar o tamanho do envio. Tente novamente." }, 411);
  }
  if (Number(lengthHeader) > limit + MULTIPART_OVERHEAD_BYTES) {
    return json({ error: tooLarge, fieldErrors: { file: [tooLarge] } }, 413);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return json({ error: "Formato de envio inválido." }, 415);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Não foi possível ler o arquivo enviado. Tente novamente." }, 400);
  }

  const entry = form.get("file");
  if (!(entry instanceof File) || entry.size === 0) {
    const message = entry instanceof File ? "O arquivo está vazio." : "Selecione um arquivo.";
    return json({ error: message, fieldErrors: { file: [message] } }, 400);
  }
  if (entry.size > limit) return json({ error: tooLarge, fieldErrors: { file: [tooLarge] } }, 413);

  try {
    const file = { name: entry.name, bytes: new Uint8Array(await entry.arrayBuffer()) };
    const documentId = str(form, "documentId");
    if (documentId) {
      const result = await addDocumentVersion(ctx, documentId, { changeNote: strOrNull(form, "changeNote"), file });
      return json({ documentId, versionId: result.versionId, versionNumber: result.versionNumber }, 201);
    }
    const result = await uploadDocument(ctx, {
      title: str(form, "title") ?? "",
      // Enum values are validated by the service (unknown values -> field error).
      category: str(form, "category") as DocumentCategory,
      description: strOrNull(form, "description"),
      confidentiality: (str(form, "confidentiality") ?? "internal") as ConfidentialityLevel,
      processId: strOrNull(form, "processId"),
      occurrenceId: strOrNull(form, "occurrenceId"),
      contractId: strOrNull(form, "contractId"),
      file,
    });
    return json({ documentId: result.documentId, versionId: result.versionId, versionNumber: 1 }, 201);
  } catch (err) {
    if (err instanceof AppError) {
      return json({ error: err.message, fieldErrors: err.fieldErrors }, STATUS_BY_CODE[err.code] ?? 400);
    }
    logger.error("document_upload_failed", { userId: ctx.userId, ...errorSummary(err) });
    return json({ error: "Não foi possível enviar o arquivo. Tente novamente." }, 500);
  }
}
