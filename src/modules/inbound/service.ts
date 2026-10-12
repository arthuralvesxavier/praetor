/**
 * API de entrada (/api/v1): external systems push incoming cases.
 *
 * POST /api/v1/processos (scope intake:create)
 *   1. validate (zod, pt-BR field errors with full paths) -> 400;
 *   2. documents: base64, at most 20, MAX_UPLOAD_MB each, PDF/DOCX/TXT detected
 *      by magic bytes (the extension must match) -> 400;
 *   3. idempotency: same key + same Idempotency-Key -> the same response
 *      (replayed); same Idempotency-Key with another body -> 422;
 *   4. RN-01: the CNJ number already exists -> documents attached and a note on
 *      the latest intake, 200 "updated_existing" (never a duplicate process);
 *   5. otherwise: optional DataJud enrichment (empty fields only), then
 *      `registerIncomingProcess` with source "api" (distribution, preliminary
 *      analysis and simulated e-mail follow automatically) -> 201.
 * GET /api/v1/processos/{numero} (scope process:read): minimal status of a
 *   process RECEIVED THROUGH THE API by the same organization.
 *
 * The organization always comes from the key. Request bodies are never
 * stored or logged (only their SHA-256, for the idempotency check).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { cnjDigits, normalizeCnj } from "@/domain/cnj";
import {
  CASE_BRIEF_STATUS_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  type DocumentCategory,
  type InboundRequestStatus,
  type LegalArea,
  type PartyRole,
} from "@/domain/enums";
import { formatMoneyCents, pluralize } from "@/lib/format";
import { apiKeyContext, hasScope, type ApiKeyIdentity } from "@/modules/api-keys/service";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { applyCourtRecords, fetchCourtRecordsForCnj, originRecord } from "@/modules/court-sync/service";
import { parseCityState } from "@/modules/court-sync/mapping";
import { extensionOf, maxUploadBytes } from "@/modules/documents/file-types";
import { detectFileType } from "@/modules/documents/validation";
import { EFFECTIVE_INTAKE_STATUS_LABELS, effectiveIntakeStatus } from "@/modules/intake/status";
import type { AuthContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import {
  caseBriefs,
  caseIntakes,
  companies,
  inboundRequests,
  legalProcesses,
  processParties,
  users,
  type IntakeStep,
} from "@/server/db/schema";
import { env } from "@/server/env";
import { aliasLabel, courtAliasesForCnj, getCourtProvider, type CourtRecord } from "@/server/integrations/courts";
import { AppError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "@/server/services/audit";
import { INBOUND_MAX_DOCUMENTS, inboundProcessSchema, type InboundProcessValues } from "./schemas";

export const INBOUND_ENDPOINT_CREATE = "POST /api/v1/processos";
export const INBOUND_ENDPOINT_STATUS = "GET /api/v1/processos/{numero}";
/** Sum of the decoded files of one request (5 files at the maximum size). */
export const INBOUND_MAX_FILES_PER_REQUEST_FACTOR = 5;
/** A "processing" idempotency claim older than this is considered abandoned. */
const STALE_CLAIM_MS = 15 * 60_000;
/** Time budget of the DataJud enrichment inside the request. */
const ENRICH_TIMEOUT_MS = 20_000;

export type InboundResponse = { httpStatus: number; body: Record<string, unknown>; headers?: Record<string, string> };

export type InboundRequest = {
  /** Parsed JSON body. */
  payload: unknown;
  /** SHA-256 (hex) of the raw body. */
  requestHash: string;
  idempotencyKey: string | null;
  ipAddress: string | null;
};

export function inboundFileLimitBytes(): number {
  return maxUploadBytes(env().MAX_UPLOAD_MB);
}

/** Maximum accepted request body (base64 inflates 4/3, plus the JSON fields). */
export function inboundBodyLimitBytes(): number {
  return Math.ceil((inboundFileLimitBytes() * INBOUND_MAX_FILES_PER_REQUEST_FACTOR * 4) / 3) + 1024 * 1024;
}

export function errorResponse(
  httpStatus: number,
  code: string,
  message: string,
  extra: { fieldErrors?: Record<string, string[]>; headers?: Record<string, string> } = {},
): InboundResponse {
  return {
    httpStatus,
    body: { error: { code, message, ...(extra.fieldErrors ? { fieldErrors: extra.fieldErrors } : {}) } },
    headers: extra.headers,
  };
}

/** zod issues -> { "partes.0.polo": ["..."] } (full paths, unlike flattenError). */
function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function links(processId: string | null, intakeId: string | null, number: string | null): Record<string, string> {
  const base = env().APP_URL.replace(/\/+$/, "");
  return {
    ...(processId ? { process: `${base}/processos/${processId}` } : {}),
    ...(intakeId ? { intake: `${base}/entrada/${intakeId}` } : {}),
    ...(number ? { status: `${base}/api/v1/processos/${cnjDigits(number)}` } : {}),
  };
}

async function logRequest(
  identity: ApiKeyIdentity,
  values: {
    endpoint: string;
    status: InboundRequestStatus;
    httpStatus: number;
    errorCode?: string | null;
    processId?: string | null;
    intakeId?: string | null;
    requestHash?: string | null;
  },
): Promise<void> {
  try {
    await getDb()
      .insert(inboundRequests)
      .values({
        organizationId: identity.organizationId,
        apiKeyId: identity.apiKeyId,
        endpoint: values.endpoint,
        status: values.status,
        httpStatus: values.httpStatus,
        errorCode: values.errorCode ?? null,
        processId: values.processId ?? null,
        intakeId: values.intakeId ?? null,
        requestHash: values.requestHash ?? null,
      });
  } catch (err) {
    logger.warn("inbound_request_log_failed", { apiKeyId: identity.apiKeyId, error: err });
  }
}

/** Records a refused request (401 is not recorded: there is no key). */
export async function recordRejectedRequest(
  identity: ApiKeyIdentity,
  endpoint: string,
  httpStatus: number,
  errorCode: string,
): Promise<void> {
  await logRequest(identity, { endpoint, status: "rejected", httpStatus, errorCode });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

type DecodedDocument = { title: string; category: DocumentCategory; file: { name: string; bytes: Uint8Array } };

const KIND_BY_EXTENSION: Record<string, "pdf" | "docx" | "text"> = { pdf: "pdf", docx: "docx", txt: "text" };

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1).replace(".", ",")} MB`;
}

export function decodeInboundDocuments(
  docs: InboundProcessValues["documentos"],
  limits: { perFileBytes: number; totalBytes: number },
): { ok: true; documents: DecodedDocument[] } | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  const out: DecodedDocument[] = [];
  let total = 0;
  docs.forEach((d, i) => {
    const key = `documentos.${i}`;
    const ext = extensionOf(d.nomeArquivo);
    const expected = KIND_BY_EXTENSION[ext];
    if (!expected) {
      fieldErrors[`${key}.nomeArquivo`] = ["Use arquivos .pdf, .docx ou .txt."];
      return;
    }
    const cleaned = d.conteudoBase64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) {
      fieldErrors[`${key}.conteudoBase64`] = ["O conteúdo precisa estar em base64."];
      return;
    }
    const approx = Math.floor((cleaned.length * 3) / 4);
    if (approx > limits.perFileBytes + 3) {
      fieldErrors[`${key}.conteudoBase64`] = [`O arquivo excede o limite de ${formatMb(limits.perFileBytes)}.`];
      return;
    }
    const bytes = new Uint8Array(Buffer.from(cleaned.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    if (bytes.byteLength === 0) {
      fieldErrors[`${key}.conteudoBase64`] = ["O arquivo está vazio."];
      return;
    }
    if (bytes.byteLength > limits.perFileBytes) {
      fieldErrors[`${key}.conteudoBase64`] = [`O arquivo excede o limite de ${formatMb(limits.perFileBytes)}.`];
      return;
    }
    const kind = detectFileType(bytes);
    if (kind !== expected) {
      fieldErrors[`${key}.conteudoBase64`] = [
        kind === null
          ? "Conteúdo não reconhecido: envie PDF, DOCX ou texto simples."
          : `O conteúdo não corresponde à extensão .${ext} do arquivo.`,
      ];
      return;
    }
    total += bytes.byteLength;
    out.push({ title: d.titulo, category: d.categoria ?? "other", file: { name: d.nomeArquivo, bytes } });
  });
  if (total > limits.totalBytes) {
    (fieldErrors.documentos ??= []).push(`A soma dos arquivos excede ${formatMb(limits.totalBytes)} por requisição.`);
  }
  return Object.keys(fieldErrors).length > 0 ? { ok: false, fieldErrors } : { ok: true, documents: out };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

type Claim = { kind: "claimed"; rowId: string } | { kind: "none" } | { kind: "response"; response: InboundResponse };

async function claimIdempotency(identity: ApiKeyIdentity, req: InboundRequest): Promise<Claim> {
  if (!req.idempotencyKey) return { kind: "none" };
  const db = getDb();
  try {
    const [row] = await db
      .insert(inboundRequests)
      .values({
        organizationId: identity.organizationId,
        apiKeyId: identity.apiKeyId,
        idempotencyKey: req.idempotencyKey,
        requestHash: req.requestHash,
        endpoint: INBOUND_ENDPOINT_CREATE,
        status: "processing",
      })
      .returning({ id: inboundRequests.id });
    return { kind: "claimed", rowId: row.id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const [existing] = await db
    .select()
    .from(inboundRequests)
    .where(and(eq(inboundRequests.apiKeyId, identity.apiKeyId), eq(inboundRequests.idempotencyKey, req.idempotencyKey)))
    .limit(1);
  if (!existing) return { kind: "none" };
  if (existing.requestHash !== req.requestHash) {
    await logRequest(identity, {
      endpoint: INBOUND_ENDPOINT_CREATE,
      status: "rejected",
      httpStatus: 422,
      errorCode: "idempotency_conflict",
      requestHash: req.requestHash,
    });
    return {
      kind: "response",
      response: errorResponse(422, "idempotency_conflict", "Esta Idempotency-Key já foi usada com outro conteúdo. Gere uma chave nova para um envio diferente."),
    };
  }
  const abandoned = existing.status === "processing" && Date.now() - existing.updatedAt.getTime() > STALE_CLAIM_MS;
  if (existing.status === "failed" || abandoned) {
    const taken = await db
      .update(inboundRequests)
      .set({ status: "processing", httpStatus: null, errorCode: null, updatedAt: new Date() })
      .where(and(eq(inboundRequests.id, existing.id), eq(inboundRequests.status, existing.status)))
      .returning({ id: inboundRequests.id });
    if (taken[0]) return { kind: "claimed", rowId: existing.id };
  }
  if (existing.status === "processing" || existing.status === "failed") {
    return {
      kind: "response",
      response: errorResponse(409, "request_in_progress", "Uma requisição com esta Idempotency-Key ainda está em processamento. Tente de novo em instantes.", {
        headers: { "Retry-After": "5" },
      }),
    };
  }
  await logRequest(identity, {
    endpoint: INBOUND_ENDPOINT_CREATE,
    status: "duplicate",
    httpStatus: existing.httpStatus ?? 200,
    processId: existing.processId,
    intakeId: existing.intakeId,
    requestHash: req.requestHash,
  });
  const [p] = existing.processId
    ? await db.select({ number: legalProcesses.number }).from(legalProcesses).where(eq(legalProcesses.id, existing.processId))
    : [];
  return {
    kind: "response",
    response: {
      httpStatus: existing.httpStatus ?? 200,
      body: {
        processId: existing.processId,
        intakeId: existing.intakeId,
        status: existing.status,
        number: p?.number ?? null,
        replayed: true,
        links: links(existing.processId, existing.intakeId, p?.number ?? null),
      },
      headers: { "Idempotent-Replayed": "true" },
    },
  };
}

async function finishClaim(
  claim: Claim,
  identity: ApiKeyIdentity,
  req: InboundRequest,
  values: { status: InboundRequestStatus; httpStatus: number; processId?: string | null; intakeId?: string | null; errorCode?: string | null },
): Promise<void> {
  if (claim.kind !== "claimed") {
    await logRequest(identity, { endpoint: INBOUND_ENDPOINT_CREATE, requestHash: req.requestHash, ...values });
    return;
  }
  // A refused request releases its Idempotency-Key (the client may fix the data and retry with it).
  const release = values.status === "rejected";
  await getDb()
    .update(inboundRequests)
    .set({
      status: values.status,
      httpStatus: values.httpStatus,
      processId: values.processId ?? null,
      intakeId: values.intakeId ?? null,
      errorCode: values.errorCode ?? null,
      updatedAt: new Date(),
      ...(release ? { idempotencyKey: null } : {}),
    })
    .where(eq(inboundRequests.id, claim.rowId));
}

// ---------------------------------------------------------------------------
// POST /api/v1/processos
// ---------------------------------------------------------------------------

const ROLE_BY_POLO: Record<string, PartyRole> = {
  ativo: "plaintiff",
  passivo: "defendant",
  terceiro: "third_party",
  ministerio_publico: "public_prosecutor",
};

const sameName = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Company of the group that is the defendant: by CNPJ (empresaCnpj, then the
 * CNPJ of a passive party), else by exact name (empresaNome, then the passive
 * parties). Only active companies of the key's organization.
 */
async function resolveCompany(
  organizationId: string,
  cnpjs: (string | null | undefined)[],
  names: (string | null | undefined)[],
): Promise<{ id: string; name: string } | null> {
  const db = getDb();
  for (const cnpj of cnpjs) {
    if (!cnpj) continue;
    const [byDoc] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(
        and(
          eq(companies.organizationId, organizationId),
          eq(companies.isActive, true),
          sql`upper(regexp_replace(coalesce(${companies.document}, ''), '[^0-9A-Za-z]', '', 'g')) = ${cnpj.toUpperCase()}`,
        ),
      )
      .limit(1);
    if (byDoc) return byDoc;
  }
  for (const name of names) {
    if (!name) continue;
    const [byName] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), eq(companies.isActive, true), sql`lower(${companies.name}) = lower(${name.trim()})`))
      .limit(1);
    if (byName) return byName;
  }
  return null;
}

type Enrichment = {
  status: "applied" | "not_found" | "unavailable" | "disabled" | "inactive" | "unsupported";
  records: CourtRecord[];
  filled: string[];
};

const ENRICHMENT_LABELS: Record<Enrichment["status"], string> = {
  applied: "dados completados pelo DataJud (somente campos vazios)",
  not_found: "número ainda não encontrado no DataJud (a coleta tenta de novo depois)",
  unavailable: "DataJud indisponível no momento (a coleta tenta de novo depois)",
  disabled: "enriquecimento pelo DataJud desativado nas configurações",
  inactive: "coleta no DataJud inativa (sem DATAJUD_API_KEY)",
  unsupported: "número sem consulta disponível no DataJud",
};

async function enrichFromCourt(number: string, enabled: boolean): Promise<Enrichment> {
  if (!getCourtProvider()) return { status: "inactive", records: [], filled: [] };
  if (!enabled) return { status: "disabled", records: [], filled: [] };
  const fetched = await fetchCourtRecordsForCnj(number, {
    attempts: 1,
    timeoutMs: Math.min(env().DATAJUD_TIMEOUT_MS, ENRICH_TIMEOUT_MS),
  });
  if (fetched.status === "unsupported") return { status: "unsupported", records: [], filled: [] };
  if (fetched.status !== "ok") return { status: "inactive", records: [], filled: [] };
  if (fetched.records.length > 0) return { status: "applied", records: fetched.records, filled: [] };
  return { status: fetched.errors.length > 0 ? "unavailable" : "not_found", records: [], filled: [] };
}

function defaultCourt(number: string): string | null {
  // Only suggests the acronym (J.TR digits); a wrong check digit is flagged by the intake.
  const a = courtAliasesForCnj(number, { allowInvalidCheckDigit: true });
  return a.supported ? aliasLabel(a.primary) : null;
}

function defaultArea(number: string): LegalArea {
  return cnjDigits(number).charAt(13) === "5" ? "labor" : "other";
}

export async function receiveInboundProcess(identity: ApiKeyIdentity, req: InboundRequest): Promise<InboundResponse> {
  const endpoint = INBOUND_ENDPOINT_CREATE;
  if (!hasScope(identity, "intake:create")) {
    await recordRejectedRequest(identity, endpoint, 403, "forbidden_scope");
    return errorResponse(403, "forbidden", "A chave de API não tem a permissão intake:create.");
  }
  const parsed = inboundProcessSchema.safeParse(req.payload);
  if (!parsed.success) {
    await logRequest(identity, { endpoint, status: "rejected", httpStatus: 400, errorCode: "validation", requestHash: req.requestHash });
    return errorResponse(400, "validation", "Verifique os campos informados.", { fieldErrors: fieldErrorsOf(parsed.error) });
  }
  const v = parsed.data;
  if (v.documentos.length > INBOUND_MAX_DOCUMENTS) {
    return errorResponse(400, "validation", "Verifique os campos informados.", {
      fieldErrors: { documentos: [`Envie no máximo ${INBOUND_MAX_DOCUMENTS} documentos por requisição.`] },
    });
  }
  const perFile = inboundFileLimitBytes();
  const decoded = decodeInboundDocuments(v.documentos, { perFileBytes: perFile, totalBytes: perFile * INBOUND_MAX_FILES_PER_REQUEST_FACTOR });
  if (!decoded.ok) {
    await logRequest(identity, { endpoint, status: "rejected", httpStatus: 400, errorCode: "documents", requestHash: req.requestHash });
    return errorResponse(400, "validation", "Verifique os documentos enviados.", { fieldErrors: decoded.fieldErrors });
  }

  const claim = await claimIdempotency(identity, req);
  if (claim.kind === "response") return claim.response;

  const ctx = apiKeyContext(identity, req.ipAddress);
  try {
    const [existing] = await getDb()
      .select({ id: legalProcesses.id, number: legalProcesses.number })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.organizationId, identity.organizationId), eq(legalProcesses.number, v.numero), isNull(legalProcesses.deletedAt)))
      .limit(1);
    const response = existing
      ? await attachToExisting(ctx, identity, existing, v, decoded.documents)
      : await registerNew(ctx, identity, v, decoded.documents);
    await finishClaim(claim, identity, req, {
      status: response.status,
      httpStatus: response.httpStatus,
      processId: response.processId,
      intakeId: response.intakeId,
    });
    return {
      httpStatus: response.httpStatus,
      body: {
        processId: response.processId,
        intakeId: response.intakeId,
        status: response.status,
        number: v.numero,
        documents: response.documents,
        ...(response.datajud ? { datajud: response.datajud } : {}),
        links: links(response.processId, response.intakeId, v.numero),
      },
    };
  } catch (err) {
    if (err instanceof AppError) {
      const httpStatus = err.code === "conflict" ? 409 : err.code === "forbidden" ? 403 : 400;
      await finishClaim(claim, identity, req, { status: "rejected", httpStatus, errorCode: err.code });
      return errorResponse(httpStatus, err.code, err.message, { fieldErrors: err.fieldErrors });
    }
    logger.error("inbound_process_failed", { apiKeyId: identity.apiKeyId, error: err });
    await finishClaim(claim, identity, req, { status: "failed", httpStatus: 500, errorCode: "internal" });
    return errorResponse(500, "internal", "Não foi possível registrar o processo agora. Tente de novo; a mesma Idempotency-Key pode ser reutilizada.");
  }
}

type HandlerResult = {
  httpStatus: number;
  status: InboundRequestStatus;
  processId: string;
  intakeId: string | null;
  documents: number;
  datajud?: string;
};

async function uploadAll(ctx: AuthContext, processId: string, docs: DecodedDocument[]): Promise<string[]> {
  if (docs.length === 0) return [];
  const { uploadDocument } = await import("@/modules/documents/service");
  const ids: string[] = [];
  for (const d of docs) {
    const { documentId } = await uploadDocument(ctx, { title: d.title, category: d.category, processId, file: d.file });
    ids.push(documentId);
  }
  return ids;
}

function originNote(identity: ApiKeyIdentity, v: InboundProcessValues): string {
  return `Enviado pelo sistema ${v.origem.sistema}${v.origem.referencia ? ` (referência ${v.origem.referencia})` : ""} com a chave de API "${identity.name}".`;
}

/** RN-01: the number exists. Attach the documents and leave a note; nothing else is overwritten. */
async function attachToExisting(
  ctx: AuthContext,
  identity: ApiKeyIdentity,
  process: { id: string; number: string },
  v: InboundProcessValues,
  docs: DecodedDocument[],
): Promise<HandlerResult> {
  const documentIds = await uploadAll(ctx, process.id, docs);
  const db = getDb();
  const [intake] = await db
    .select({ id: caseIntakes.id, status: caseIntakes.status })
    .from(caseIntakes)
    .where(and(eq(caseIntakes.processId, process.id), eq(caseIntakes.organizationId, identity.organizationId)))
    .orderBy(desc(caseIntakes.receivedAt))
    .limit(1);
  const detail =
    `Novo envio por API para um processo já cadastrado: ${pluralize(documentIds.length, "documento anexado", "documentos anexados")}. ` +
    `${originNote(identity, v)} Os dados do cadastro não foram alterados.`;
  await db.transaction(async (tx) => {
    if (intake) {
      const step: IntakeStep = { status: intake.status, at: new Date().toISOString(), detail, actorName: ctx.name };
      await tx
        .update(caseIntakes)
        .set({ steps: sql`${caseIntakes.steps} || ${JSON.stringify([step])}::jsonb` })
        .where(and(eq(caseIntakes.id, intake.id), eq(caseIntakes.organizationId, identity.organizationId)));
    }
    await recordAudit(
      ctx,
      {
        action: "inbound.update_existing",
        entityType: "legal_process",
        entityId: process.id,
        summary: `Processo ${process.number} recebido de novo por API (chave "${identity.name}", sistema ${v.origem.sistema}): ${pluralize(documentIds.length, "documento anexado", "documentos anexados")}; cadastro mantido.`,
        metadata: {
          // Name shown as the author in the history (no user: actorId is null).
          actorLabel: ctx.name,
          apiKeyId: identity.apiKeyId,
          apiKeyName: identity.name,
          system: v.origem.sistema,
          reference: v.origem.referencia ?? null,
          documents: documentIds.length,
          intakeId: intake?.id ?? null,
        },
      },
      tx,
    );
  });
  return { httpStatus: 200, status: "updated_existing", processId: process.id, intakeId: intake?.id ?? null, documents: documentIds.length };
}

async function registerNew(ctx: AuthContext, identity: ApiKeyIdentity, v: InboundProcessValues, docs: DecodedDocument[]): Promise<HandlerResult> {
  const plaintiff = v.partes.find((p) => p.polo === "ativo");
  if (!plaintiff) throw new ValidationError(undefined, { partes: ["Informe ao menos uma parte no polo ativo."] });
  const passive = v.partes.filter((p) => p.polo === "passivo");
  const company = await resolveCompany(
    identity.organizationId,
    [v.empresaCnpj, ...passive.map((p) => (p.documento && p.documento.length === 14 ? p.documento : null))],
    [v.empresaNome, ...passive.map((p) => p.nome)],
  );
  const defendantName = company?.name ?? v.empresaNome ?? passive[0]?.nome ?? null;
  if (!defendantName) {
    throw new ValidationError(undefined, {
      partes: ["Informe a parte ré (polo passivo) ou a empresa (empresaCnpj ou empresaNome)."],
    });
  }

  const org = await loadOrganization(identity.organizationId);
  const settings = org.settings.integrations.datajud;
  const enrichment = await enrichFromCourt(v.numero, settings.enabled && settings.enrichOnIntake);
  const fields = {
    court: v.tribunal ?? null,
    courtDivision: v.orgaoJulgador ?? null,
    city: v.cidade ?? null,
    state: v.uf ?? null,
    processClass: v.classe ?? null,
    filedAt: v.ajuizadoEm ?? null,
  };
  if (enrichment.records.length > 0) {
    const origin = originRecord(enrichment.records);
    const fill = (key: keyof typeof fields, value: string | null | undefined) => {
      if (!fields[key] && value) {
        fields[key] = value;
        enrichment.filled.push(key);
      }
    };
    fill("court", origin.tribunal);
    fill("courtDivision", origin.courtDivision?.name?.slice(0, 200));
    if (origin.processClass?.name && origin.processClass.name.length <= 40) fill("processClass", origin.processClass.name);
    fill("filedAt", origin.filedAt);
    const place = parseCityState(origin.courtDivision?.name);
    if (place && !fields.city && !fields.state) {
      fill("city", place.city);
      fill("state", place.state);
    }
  }
  const court = fields.court ?? defaultCourt(v.numero);
  if (!court) {
    throw new ValidationError(undefined, {
      tribunal: ["Informe o tribunal: não foi possível identificá-lo pelo número."],
    });
  }

  const notes = [
    originNote(identity, v),
    `DataJud: ${ENRICHMENT_LABELS[enrichment.status]}.`,
    company ? null : v.empresaCnpj ? "O CNPJ informado não corresponde a uma empresa ativa cadastrada." : null,
    company ? `Empresa do grupo identificada: ${company.name}.` : null,
    v.valorDaCausa != null ? `Valor da causa informado pelo sistema de origem: ${formatMoneyCents(v.valorDaCausa)}.` : null,
  ];
  const { registerIncomingProcess } = await import("@/modules/intake/service");
  const result = await registerIncomingProcess(ctx, {
    number: v.numero,
    court,
    courtDivision: fields.courtDivision,
    city: fields.city,
    state: fields.state,
    processClass: fields.processClass,
    area: v.area ?? defaultArea(v.numero),
    phase: v.fase ?? "knowledge",
    instance: v.instancia ?? "first",
    companyId: company?.id ?? null,
    claimAmountCents: v.valorDaCausa ?? null,
    filedAt: fields.filedAt,
    plaintiffName: plaintiff.nome,
    defendantName,
    description: v.observacao ?? null,
    source: "api",
    documents: docs.map((d) => ({ title: d.title, category: d.category, file: d.file })),
    receivedNote: notes.filter(Boolean).join(" "),
  });

  await addRemainingParties(ctx, result.processId, v, plaintiff, defendantName);

  let datajud: string = ENRICHMENT_LABELS[enrichment.status];
  if (enrichment.records.length > 0) {
    try {
      await applyCourtRecords(identity.organizationId, result.processId, enrichment.records, { trigger: "api", settings });
    } catch (err) {
      // The process is registered; the routine collects the movements later.
      logger.warn("inbound_court_apply_failed", { processId: result.processId, error: err });
      datajud = "dados do DataJud serão importados na próxima coleta";
    }
  }

  await recordAudit(ctx, {
    action: "inbound.receive",
    entityType: "intake",
    entityId: result.intakeId,
    summary: `Processo ${v.numero} recebido por API (chave "${identity.name}", sistema ${v.origem.sistema}): ${pluralize(result.documentIds.length, "documento", "documentos")}.`,
    metadata: {
      actorLabel: ctx.name,
      apiKeyId: identity.apiKeyId,
      apiKeyName: identity.name,
      system: v.origem.sistema,
      reference: v.origem.referencia ?? null,
      processId: result.processId,
      documents: result.documentIds.length,
      datajud: enrichment.status,
      filledFromDatajud: enrichment.filled,
    },
  });
  return {
    httpStatus: 201,
    status: "accepted",
    processId: result.processId,
    intakeId: result.intakeId,
    documents: result.documentIds.length,
    datajud,
  };
}

/** Parties beyond the plaintiff and defendant created by the intake, plus their CPF/CNPJ. */
async function addRemainingParties(
  ctx: AuthContext,
  processId: string,
  v: InboundProcessValues,
  plaintiff: InboundProcessValues["partes"][number],
  defendantName: string,
): Promise<void> {
  const { addParty, updateParty } = await import("@/modules/processes/service");
  const existing = await getDb()
    .select({ id: processParties.id, name: processParties.name, role: processParties.role, isClient: processParties.isClient })
    .from(processParties)
    .where(and(eq(processParties.processId, processId), eq(processParties.organizationId, ctx.organizationId)));
  let plaintiffDone = false;
  let defendantDone = false;
  for (const party of v.partes) {
    const role = ROLE_BY_POLO[party.polo];
    if (!plaintiffDone && party === plaintiff) {
      plaintiffDone = true;
      const row = existing.find((e) => e.role === "plaintiff" && sameName(e.name, party.nome));
      if (row && party.documento) await updateParty(ctx, row.id, { name: row.name, role: row.role, documentNumber: party.documento, isClient: row.isClient });
      continue;
    }
    if (!defendantDone && role === "defendant" && sameName(party.nome, defendantName)) {
      defendantDone = true;
      const row = existing.find((e) => e.role === "defendant" && sameName(e.name, defendantName));
      if (row && party.documento) await updateParty(ctx, row.id, { name: row.name, role: row.role, documentNumber: party.documento, isClient: row.isClient });
      continue;
    }
    await addParty(ctx, processId, { name: party.nome, role, documentNumber: party.documento ?? null });
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/processos/{numero}
// ---------------------------------------------------------------------------

export async function getInboundProcessStatus(identity: ApiKeyIdentity, rawNumber: string): Promise<InboundResponse> {
  const endpoint = INBOUND_ENDPOINT_STATUS;
  if (!hasScope(identity, "process:read")) {
    await recordRejectedRequest(identity, endpoint, 403, "forbidden_scope");
    return errorResponse(403, "forbidden", "A chave de API não tem a permissão process:read.");
  }
  let decoded = "";
  try {
    decoded = decodeURIComponent(rawNumber ?? "");
  } catch {
    decoded = "";
  }
  const number = normalizeCnj(decoded);
  if (!number) return errorResponse(400, "validation", "Informe o número no padrão CNJ (20 dígitos, com ou sem pontuação).");
  const db = getDb();
  const notFound = errorResponse(404, "not_found", "Processo não encontrado entre os recebidos por API desta organização.");
  const [p] = await db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      status: legalProcesses.status,
      phase: legalProcesses.phase,
      instance: legalProcesses.instance,
      responsibleName: users.name,
    })
    .from(legalProcesses)
    .leftJoin(users, and(eq(users.id, legalProcesses.responsibleId), eq(users.organizationId, identity.organizationId)))
    .where(and(eq(legalProcesses.organizationId, identity.organizationId), eq(legalProcesses.number, number), isNull(legalProcesses.deletedAt)))
    .limit(1);
  if (!p) return notFound;
  const [sent] = await db
    .select({ id: inboundRequests.id })
    .from(inboundRequests)
    .where(
      and(
        eq(inboundRequests.organizationId, identity.organizationId),
        eq(inboundRequests.processId, p.id),
        inArray(inboundRequests.status, ["accepted", "updated_existing"]),
      ),
    )
    .limit(1);
  if (!sent) return notFound;
  const [intake] = await db
    .select({ id: caseIntakes.id, status: caseIntakes.status, receivedAt: caseIntakes.receivedAt, briefId: caseIntakes.briefId })
    .from(caseIntakes)
    .where(and(eq(caseIntakes.processId, p.id), eq(caseIntakes.organizationId, identity.organizationId)))
    .orderBy(desc(caseIntakes.receivedAt))
    .limit(1);
  const [brief] = intake?.briefId
    ? await db
        .select({ status: caseBriefs.status })
        .from(caseBriefs)
        .where(and(eq(caseBriefs.id, intake.briefId), eq(caseBriefs.organizationId, identity.organizationId)))
    : [];
  await logRequest(identity, { endpoint, status: "consulted", httpStatus: 200, processId: p.id, intakeId: intake?.id ?? null });
  const effective = intake ? effectiveIntakeStatus(intake.status, brief?.status ?? null) : null;
  return {
    httpStatus: 200,
    body: {
      number: p.number,
      processId: p.id,
      status: p.status,
      statusLabel: PROCESS_STATUS_LABELS[p.status] ?? p.status,
      phase: p.phase,
      phaseLabel: PROCESS_PHASE_LABELS[p.phase] ?? p.phase,
      instance: p.instance,
      instanceLabel: p.instance ? (PROCESS_INSTANCE_LABELS[p.instance] ?? p.instance) : null,
      responsibleName: p.responsibleName ?? null,
      intake: intake
        ? {
            id: intake.id,
            status: effective,
            statusLabel: effective ? EFFECTIVE_INTAKE_STATUS_LABELS[effective] : null,
            receivedAt: intake.receivedAt.toISOString(),
          }
        : null,
      preliminaryAnalysis: brief
        ? { status: brief.status, statusLabel: CASE_BRIEF_STATUS_LABELS[brief.status], simulated: true }
        : null,
      links: links(p.id, intake?.id ?? null, p.number),
    },
  };
}
