import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  LegalReportStatus,
  LegalReportType,
  ProbabilityBand,
  ReportItemOrigin,
  ScenarioOrigin,
} from "@/domain/enums";
import type {
  LegalReportParameters,
  LegalReportScope,
  LegalReportSequenceKey,
  RecordSource,
  ReportItemData,
} from "@/domain/legal-reports";
import { createdAt, id, ts } from "./_columns";
import { organizations, users } from "./core";
import { documents, documentVersions } from "./documents";
import { legalProcesses } from "./legal";

/**
 * Relatórios jurídicos (PDF). IMUTÁVEIS depois de aprovados: não há caminho de
 * edição; gerar de novo cria uma nova versão (mesma referência, `version + 1`,
 * `supersedesId` = anterior) e a anterior passa a `superseded`, com PDF e hash
 * preservados. Gatilhos no banco (migração) recusam UPDATE de conteúdo, UPDATE
 * de relatório aprovado (exceto aprovado → substituído) e DELETE.
 *
 * `reference` é sequencial por organização, tipo e ano (ex.: R1-2026-0007),
 * alocada em transação por `legal_report_sequences`.
 */
export const legalReports = pgTable(
  "legal_reports",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    type: text("type").$type<LegalReportType>().notNull(),
    reference: text("reference").notNull(),
    referenceYear: integer("reference_year").notNull(),
    referenceNumber: integer("reference_number").notNull(),
    title: text("title").notNull(),
    /** Documento de teste do motor (não é relatório jurídico). */
    isSample: boolean("is_sample").notNull().default(false),
    scope: jsonb("scope").$type<LegalReportScope>().notNull(),
    /** Processo do escopo (R1), desnormalizado de `scope` para a visibilidade por linha. */
    processId: uuid("process_id").references(() => legalProcesses.id),
    /** Data-base: o conteúdo reflete o estado da base nesta data. */
    baseDate: date("base_date", { mode: "string" }).notNull(),
    parameters: jsonb("parameters").$type<LegalReportParameters>().notNull(),
    status: text("status").$type<LegalReportStatus>().notNull().default("pending_review"),
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => legalReports.id),
    /** Null = gerado pelo sistema. */
    generatedById: uuid("generated_by_id").references(() => users.id),
    generatedAt: ts("generated_at").notNull().defaultNow(),
    approvedById: uuid("approved_by_id").references(() => users.id),
    approvedAt: ts("approved_at"),
    /** Chave opaca do PDF no storage (`<org>/<relatório>/<arquivo>`). */
    pdfStorageKey: text("pdf_storage_key"),
    pdfSha256: text("pdf_sha256"),
    pdfSizeBytes: integer("pdf_size_bytes"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("legal_reports_org_reference_version_uq").on(t.organizationId, t.reference, t.version),
    uniqueIndex("legal_reports_supersedes_uq").on(t.supersedesId),
    index("legal_reports_org_generated_idx").on(t.organizationId, t.generatedAt),
    index("legal_reports_process_idx").on(t.processId),
    check(
      "legal_reports_status_ck",
      sql`${t.status} in ('draft', 'pending_review', 'approved', 'superseded')`,
    ),
    check("legal_reports_version_ck", sql`${t.version} >= 1`),
    check(
      "legal_reports_approved_ck",
      sql`${t.status} <> 'approved' or (${t.approvedById} is not null and ${t.approvedAt} is not null)`,
    ),
  ],
);

/**
 * Contador da referência sequencial por organização, tipo e ano (INSERT … ON CONFLICT DO UPDATE).
 * `type` é o tipo oficial ou `sample:<tipo>` (série própria do documento de teste do motor,
 * que não consome a numeração oficial).
 */
export const legalReportSequences = pgTable(
  "legal_report_sequences",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    type: text("type").$type<LegalReportSequenceKey>().notNull(),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.type, t.year] })],
);

/**
 * Itens do relatório. Toda afirmação tem origem; `pendingReason` preenchido =
 * item NÃO afirmado (confiança abaixo do limite, fonte não confirmada ou base
 * pendente), exibido em "Pendências do relatório". APPEND-ONLY.
 */
export const legalReportItems = pgTable(
  "legal_report_items",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    reportId: uuid("report_id")
      .notNull()
      .references(() => legalReports.id),
    section: text("section").notNull(),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    origin: text("origin").$type<ReportItemOrigin>().notNull(),
    documentId: uuid("document_id").references(() => documents.id),
    documentVersionId: uuid("document_version_id").references(() => documentVersions.id),
    page: integer("page"),
    /** Trecho literal (nunca gravado para documentos sensíveis: só referenciados). */
    excerpt: text("excerpt"),
    recordSource: jsonb("record_source").$type<RecordSource>(),
    /** Ids dos itens (deste relatório) dos quais a inferência deriva. */
    derivedFrom: jsonb("derived_from").$type<string[]>(),
    confidence: integer("confidence"),
    simulated: boolean("simulated").notNull().default(false),
    pendingReason: text("pending_reason"),
    data: jsonb("data").$type<ReportItemData>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("legal_report_items_report_idx").on(t.reportId, t.section, t.position),
    index("legal_report_items_document_idx").on(t.documentId),
    check(
      "legal_report_items_origin_ck",
      sql`${t.origin} in ('documented', 'record', 'inference', 'analysis', 'gap')`,
    ),
    check(
      "legal_report_items_confidence_ck",
      sql`${t.confidence} is null or (${t.confidence} between 0 and 100)`,
    ),
  ],
);

/**
 * Fontes do relatório e o resultado da conferência automática. Uma fonte
 * `confirmed = false` aparece na tabela "Não confirmado" e nunca serve de base
 * de afirmação. APPEND-ONLY.
 */
export const legalReportSources = pgTable(
  "legal_report_sources",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    reportId: uuid("report_id")
      .notNull()
      .references(() => legalReports.id),
    itemId: uuid("item_id").references(() => legalReportItems.id),
    /** Rótulo curto (F1, F2…). */
    reference: text("reference").notNull(),
    /** Descrição da fonte (documento, versão e página, ou cadastro). */
    source: text("source").notNull(),
    /** Caminho interno (ex.: /documentos/<id>); nunca URL externa. */
    url: text("url"),
    documentId: uuid("document_id").references(() => documents.id),
    documentVersionId: uuid("document_version_id").references(() => documentVersions.id),
    page: integer("page"),
    documentSha256: text("document_sha256"),
    /** PD-04: documento de saúde, só referenciado (o item não guarda trecho). */
    sensitive: boolean("sensitive").notNull().default(false),
    checkedAt: ts("checked_at").notNull(),
    confirmed: boolean("confirmed").notNull(),
    notConfirmedReason: text("not_confirmed_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("legal_report_sources_report_idx").on(t.reportId),
    check(
      "legal_report_sources_reason_ck",
      sql`${t.confirmed} or ${t.notConfirmedReason} is not null`,
    ),
  ],
);

/**
 * Cenários do processo com faixa de probabilidade. APPEND-ONLY e datado: um
 * novo cenário é um novo registro (nada é sobrescrito).
 */
export const processScenarios = pgTable(
  "process_scenarios",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id")
      .notNull()
      .references(() => legalProcesses.id),
    description: text("description").notNull(),
    probabilityBand: text("probability_band").$type<ProbabilityBand>().notNull(),
    percentMin: integer("percent_min").notNull(),
    percentMax: integer("percent_max").notNull(),
    comment: text("comment"),
    origin: text("origin").$type<ScenarioOrigin>().notNull(),
    /** Null = gerado pelo sistema. */
    authorId: uuid("author_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("process_scenarios_process_idx").on(t.processId, t.createdAt),
    check(
      "process_scenarios_percent_ck",
      sql`${t.percentMin} >= 0 and ${t.percentMax} <= 100 and ${t.percentMin} <= ${t.percentMax}`,
    ),
    check(
      "process_scenarios_band_ck",
      sql`${t.probabilityBand} in ('very_high', 'high', 'moderate', 'low', 'very_low')`,
    ),
    check("process_scenarios_origin_ck", sql`${t.origin} in ('system', 'manual')`),
  ],
);
