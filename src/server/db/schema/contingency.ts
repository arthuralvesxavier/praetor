import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  DataOrigin,
  GuaranteeKind,
  GuaranteeStatus,
  InstallmentStatus,
  LossProbability,
  ProcessInstance,
  ProcessPhase,
  SettlementStatus,
  SnapshotStatus,
  ValuationKind,
  ValuationSource,
  ValuationStatus,
} from "@/domain/enums";
import type { SnapshotMetrics, SnapshotParams } from "@/domain/contingency";
import { createdAt, deletedAt, id, ts, updatedAt } from "./_columns";
import { companies, organizations, units, users } from "./core";
import { documents } from "./documents";
import { cents, legalProcesses } from "./legal";

/**
 * Valorações (RF-07/RF-09). APPEND-ONLY: o valor nunca é sobrescrito; nova
 * apuração é novo registro e a anterior passa a `superseded`. Só o status (e os
 * campos de conferência) mudam, sempre com auditoria. Um valor `official` exige
 * `reviewedById` (RN-11). Extinção por satisfação = nova valoração `liquidated`
 * de valor 0 com motivo de quitação (RN-06).
 */
export const processValuations = pgTable(
  "process_valuations",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    kind: text("kind").$type<ValuationKind>().notNull(),
    amountCents: cents("amount_cents").notNull(),
    /** Data a que o cálculo se refere. */
    baseDate: date("base_date", { mode: "string" }).notNull(),
    instance: text("instance").$type<ProcessInstance>(),
    source: text("source").$type<ValuationSource>().notNull(),
    status: text("status").$type<ValuationStatus>().notNull().default("proposed"),
    /** RN-07: estimativas nunca entram em relatório contábil sem ressalva. */
    isEstimate: boolean("is_estimate").notNull().default(false),
    /** Motivo / observação (ex.: "Quitação", "Divergência entre abas da planilha"). */
    reason: text("reason"),
    documentId: uuid("document_id").references(() => documents.id),
    documentVersionId: uuid("document_version_id"),
    /** Página da peça onde o valor foi lido. */
    page: integer("page"),
    /** Trecho literal (até 500 caracteres) que embasou a leitura. */
    excerpt: text("excerpt"),
    /** Confiança da extração automática (0–100). Null para lançamentos manuais. */
    confidence: integer("confidence"),
    importBatchId: uuid("import_batch_id"),
    briefId: uuid("brief_id"),
    /** Valoração oficial que esta substituiu. */
    supersedesId: uuid("supersedes_id"),
    createdById: uuid("created_by_id").references(() => users.id),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("process_valuations_process_idx").on(t.processId, t.kind, t.createdAt),
    index("process_valuations_org_status_idx").on(t.organizationId, t.status),
  ],
);

/** Garantias e deduções (RF-10). Só garantias `linked` abatem a exposição (RN-04). */
export const processGuarantees = pgTable(
  "process_guarantees",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    kind: text("kind").$type<GuaranteeKind>().notNull(),
    amountCents: cents("amount_cents").notNull(),
    status: text("status").$type<GuaranteeStatus>().notNull().default("linked"),
    depositedAt: date("deposited_at", { mode: "string" }),
    statusChangedAt: date("status_changed_at", { mode: "string" }),
    description: text("description"),
    documentId: uuid("document_id").references(() => documents.id),
    origin: text("origin").$type<DataOrigin>().notNull().default("manual"),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("process_guarantees_process_idx").on(t.processId)],
);

/**
 * Classificação de risco (RF-11). APPEND-ONLY com vigência: a classificação
 * vigente numa data é a de maior `effectiveFrom` <= data entre as oficiais.
 * Sugestões automáticas (RF-12) entram como `proposed` e nunca valem sozinhas.
 */
export const processRiskAssessments = pgTable(
  "process_risk_assessments",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    classification: text("classification").$type<LossProbability>().notNull(),
    /** Percentual aplicado em pontos-base (5000 = 50%). */
    percentageBp: integer("percentage_bp").notNull(),
    /** Parecer (fundamento da classificação) — exigido por auditoria. */
    opinion: text("opinion").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    status: text("status").$type<ValuationStatus>().notNull().default("official"),
    origin: text("origin").$type<DataOrigin>().notNull().default("manual"),
    /** Versão das regras de risco vigente quando registrada (RNF-14). */
    rulesVersion: integer("rules_version").notNull().default(1),
    assessedById: uuid("assessed_by_id").references(() => users.id),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("process_risk_assessments_process_idx").on(t.processId, t.effectiveFrom)],
);

/** Acordos (proposta → negociação → firmado/homologado → cumprido/descumprido). */
export const settlements = pgTable(
  "settlements",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    status: text("status").$type<SettlementStatus>().notNull().default("proposal"),
    /** Valor total proposto/acordado. Null = ainda não definido. */
    totalAmountCents: cents("total_amount_cents"),
    installmentsCount: integer("installments_count"),
    proposedAt: date("proposed_at", { mode: "string" }),
    signedAt: date("signed_at", { mode: "string" }),
    homologatedAt: date("homologated_at", { mode: "string" }),
    notes: text("notes"),
    responsibleId: uuid("responsible_id").references(() => users.id),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("settlements_process_idx").on(t.processId),
    index("settlements_org_status_idx").on(t.organizationId, t.status),
  ],
);

export const settlementInstallments = pgTable(
  "settlement_installments",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    settlementId: uuid("settlement_id").notNull().references(() => settlements.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    amountCents: cents("amount_cents").notNull(),
    status: text("status").$type<InstallmentStatus>().notNull().default("pending"),
    paidAt: date("paid_at", { mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("settlement_installments_number_uq").on(t.settlementId, t.number),
    index("settlement_installments_org_due_idx").on(t.organizationId, t.dueDate),
  ],
);

/**
 * Fechamento mensal (RN-10). Uma competência `closed` é IMUTÁVEL: relatórios
 * dessa competência são lidos daqui, nunca recalculados (RN-05).
 */
export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    /** Competência `YYYY-MM`. */
    period: text("period").notNull(),
    /** Data-base (último dia da competência). */
    referenceDate: date("reference_date", { mode: "string" }).notNull(),
    status: text("status").$type<SnapshotStatus>().notNull().default("preview"),
    metrics: jsonb("metrics").$type<SnapshotMetrics>().notNull(),
    /** Parâmetros de risco usados (percentuais + versão das regras). */
    params: jsonb("params").$type<SnapshotParams>().notNull(),
    generatedAt: ts("generated_at").notNull().defaultNow(),
    generatedById: uuid("generated_by_id").references(() => users.id),
    closedAt: ts("closed_at"),
    closedById: uuid("closed_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("portfolio_snapshots_org_period_uq").on(t.organizationId, t.period)],
);

/** Posição de cada processo na data-base da competência (memória de cálculo). */
export const portfolioSnapshotItems = pgTable(
  "portfolio_snapshot_items",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    snapshotId: uuid("snapshot_id").notNull().references(() => portfolioSnapshots.id, { onDelete: "cascade" }),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    number: text("number").notNull(),
    companyId: uuid("company_id").references(() => companies.id),
    unitId: uuid("unit_id").references(() => units.id),
    court: text("court"),
    instance: text("instance").$type<ProcessInstance>(),
    phase: text("phase").$type<ProcessPhase>(),
    city: text("city"),
    isConfidential: boolean("is_confidential").notNull().default(false),
    classification: text("classification").$type<LossProbability>(),
    percentageBp: integer("percentage_bp"),
    claimAmountCents: cents("claim_amount_cents"),
    liquidatedAmountCents: cents("liquidated_amount_cents"),
    guaranteesCents: cents("guarantees_cents").notNull().default(0),
    exposureCents: cents("exposure_cents"),
    exposureIsEstimate: boolean("exposure_is_estimate").notNull().default(false),
    provisionCents: cents("provision_cents"),
    provisionIsEstimate: boolean("provision_is_estimate").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("portfolio_snapshot_items_snapshot_idx").on(t.snapshotId),
    index("portfolio_snapshot_items_process_idx").on(t.processId),
  ],
);
