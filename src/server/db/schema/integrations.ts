import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  ApiKeyScope,
  CourtSyncRunStatus,
  CourtSyncStatus,
  CourtSyncTrigger,
  InboundRequestStatus,
} from "@/domain/enums";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { organizations, users } from "./core";
import { legalProcesses } from "./legal";

// ---------------------------------------------------------------------------
// API de entrada (/api/v1): chaves e registro de requisições
// ---------------------------------------------------------------------------

/**
 * Chaves de API de sistemas externos. O valor completo ("prt_" + 32 bytes
 * aleatórios em base64url) é mostrado UMA vez na criação; o banco guarda só o
 * SHA-256 (`key_hash`) e o prefixo exibível (`key_prefix`). A organização vem
 * sempre da chave, nunca do corpo da requisição.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    /** Primeiros caracteres da chave, para reconhecer qual é (ex.: "prt_AbC1x2"). */
    keyPrefix: text("key_prefix").notNull(),
    /** SHA-256 (hex) da chave completa. */
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").$type<ApiKeyScope[]>().notNull().default([]),
    createdById: uuid("created_by_id").references(() => users.id),
    lastUsedAt: ts("last_used_at"),
    lastUsedIp: text("last_used_ip"),
    revokedAt: ts("revoked_at"),
    revokedById: uuid("revoked_by_id").references(() => users.id),
    expiresAt: ts("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_key_hash_uq").on(t.keyHash), index("api_keys_org_idx").on(t.organizationId)],
);

/**
 * Registro das requisições recebidas pela API de entrada (idempotência e
 * auditoria operacional). NUNCA guarda o corpo da requisição: só o resultado,
 * os ids gerados e o SHA-256 do corpo (para recusar a mesma chave de
 * idempotência com conteúdo diferente).
 */
export const inboundRequests = pgTable(
  "inbound_requests",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    /** Cabeçalho Idempotency-Key (único por chave de API quando informado). */
    idempotencyKey: text("idempotency_key"),
    /** SHA-256 do corpo recebido (nunca o corpo). */
    requestHash: text("request_hash"),
    /** Ex.: "POST /api/v1/processos". */
    endpoint: text("endpoint").notNull(),
    status: text("status").$type<InboundRequestStatus>().notNull(),
    httpStatus: integer("http_status"),
    processId: uuid("process_id").references(() => legalProcesses.id),
    intakeId: uuid("intake_id"),
    /** Código curto do erro (ex.: "validation", "rate_limited"); nunca mensagens com dados. */
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("inbound_requests_key_idempotency_uq")
      .on(t.apiKeyId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("inbound_requests_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Coleta nos tribunais (DataJud / CNJ)
// ---------------------------------------------------------------------------

/**
 * Graus em que o número foi encontrado na última consulta ("G1", "G2", "SUP"...),
 * com os valores que o tribunal informou para cada grau. Servem para apontar
 * uma divergência com o cadastro só quando o valor do tribunal é novo (uma
 * divergência já resolvida por alguém não volta a marcar o processo).
 * Um grau que uma consulta não devolveu (por exemplo, o TST fora do ar) é
 * mantido com os valores anteriores e `notReturnedSince` preenchido: dado
 * ausente nunca apaga o que o tribunal já informou.
 * Os campos opcionais faltam nas linhas gravadas antes de existirem.
 */
export type CourtInstanceFound = {
  grau: string;
  tribunal: string;
  alias: string;
  remoteUpdatedAt: string | null;
  courtDivision?: string | null;
  processClass?: string | null;
  filedAt?: string | null;
  /** ISO do primeiro check em que o grau não voltou (ausente/null: devolvido na última consulta). */
  notReturnedSince?: string | null;
};

/** Situação de cada processo no acompanhamento automático (uma linha por processo). */
export const courtSyncStates = pgTable(
  "court_sync_states",
  {
    processId: uuid("process_id")
      .primaryKey()
      .references(() => legalProcesses.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    /** Fonte consultada ("datajud"). */
    source: text("source").notNull().default("datajud"),
    status: text("status").$type<CourtSyncStatus>().notNull().default("pending"),
    lastCheckedAt: ts("last_checked_at"),
    lastFoundAt: ts("last_found_at"),
    /** Maior `dataHoraUltimaAtualizacao` informada pelo tribunal. */
    remoteUpdatedAt: ts("remote_updated_at"),
    instancesFound: jsonb("instances_found").$type<CourtInstanceFound[]>().notNull().default([]),
    /** Mensagem saneada (nunca parâmetros de consulta ou conteúdo). */
    lastError: text("last_error"),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    nextCheckAt: ts("next_check_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("court_sync_states_org_next_idx").on(t.organizationId, t.nextCheckAt)],
);

/** Execuções da coleta, uma linha por tribunal (alias do DataJud) e disparo. */
export const courtSyncRuns = pgTable(
  "court_sync_runs",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    source: text("source").notNull().default("datajud"),
    /** Alias do endpoint do DataJud (ex.: "trt10", "tst", "tjsp"). */
    tribunalAlias: text("tribunal_alias").notNull(),
    trigger: text("trigger").$type<CourtSyncTrigger>().notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    status: text("status").$type<CourtSyncRunStatus>().notNull().default("running"),
    checked: integer("checked").notNull().default(0),
    found: integer("found").notNull().default(0),
    notFound: integer("not_found").notNull().default(0),
    newMovements: integer("new_movements").notNull().default(0),
    phaseChanges: integer("phase_changes").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    /** Mensagem saneada. */
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("court_sync_runs_org_alias_idx").on(t.organizationId, t.tribunalAlias, t.startedAt)],
);
