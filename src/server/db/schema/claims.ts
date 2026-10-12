import { date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  ClaimCategory,
  ClaimOrigin,
  ClaimRiskLinkKind,
  ClaimStatus,
  CorrectionIndex,
  LossProbability,
  ProcessInstance,
} from "@/domain/enums";
import { createdAt, deletedAt, id, ts, updatedAt } from "./_columns";
import { caseBriefs } from "./briefs";
import { processRiskAssessments } from "./contingency";
import { organizations, users } from "./core";
import { cents, legalProcesses } from "./legal";

/**
 * Pedidos do processo (verbas pleiteadas). O risco é avaliado POR PEDIDO e o
 * risco do processo deriva deles (pior classificação; provisão = soma de
 * base × percentual dos pedidos avaliados). Pedidos sugeridos pela análise
 * preliminar (`ai_suggested`) entram como `pending_confirmation` e só contam
 * depois de confirmados por uma pessoa. Exclusão = soft delete (lançamento
 * indevido), sempre auditada.
 */
export const processClaims = pgTable(
  "process_claims",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    /** Verba pleiteada, como descrita na petição. */
    description: text("description").notNull(),
    category: text("category").$type<ClaimCategory>(),
    /** Valor atribuído ao pedido na data-base. Null = não quantificado (nunca zero). */
    claimedAmountCents: cents("claimed_amount_cents"),
    /** Data-base do valor do pedido (o valor atualizado é calculado na leitura, nunca gravado). */
    amountBaseDate: date("amount_base_date", { mode: "string" }),
    /**
     * Índice de atualização escolhido pela pessoa (`CORRECTION_INDEXES`; null = sem índice informado).
     * O sistema não aplica regra sobre qual índice vale para cada caso.
     */
    correctionIndex: text("correction_index").$type<CorrectionIndex>(),
    instance: text("instance").$type<ProcessInstance>(),
    origin: text("origin").$type<ClaimOrigin>().notNull().default("manual"),
    status: text("status").$type<ClaimStatus>().notNull().default("confirmed"),
    /** Análise preliminar de onde o pedido foi sugerido (origin ai_suggested). */
    sourceBriefId: uuid("source_brief_id").references(() => caseBriefs.id),
    /** Posição do pedido em `content.claims` da análise (deduplicação). */
    sourceIndex: integer("source_index"),
    /** Rótulo da origem fixado na criação (ex.: "análise preliminar v2, simulação"). Nunca contém texto de documento. */
    sourceNote: text("source_note"),
    confirmedById: uuid("confirmed_by_id").references(() => users.id),
    confirmedAt: ts("confirmed_at"),
    dismissedById: uuid("dismissed_by_id").references(() => users.id),
    dismissedAt: ts("dismissed_at"),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("process_claims_process_idx").on(t.processId, t.createdAt),
    index("process_claims_org_status_idx").on(t.organizationId, t.status),
    uniqueIndex("process_claims_brief_item_uq").on(t.sourceBriefId, t.sourceIndex),
  ],
);

/**
 * Avaliação de risco de um pedido. APPEND-ONLY: nova avaliação = novo registro
 * datado; a vigente é a de maior `effectiveFrom <= hoje` (desempate pela
 * criação). Sempre com parecer e pessoa identificada.
 */
export const processClaimAssessments = pgTable(
  "process_claim_assessments",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    claimId: uuid("claim_id").notNull().references(() => processClaims.id),
    /** Denormalizado do pedido (visibilidade por processo e consultas por processo). */
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    classification: text("classification").$type<LossProbability>().notNull(),
    /** Percentual aplicado em pontos-base (5000 = 50%). */
    percentageBp: integer("percentage_bp").notNull(),
    /** Base usada (padrão: valor do pedido). Null = pedido não quantificado (fica fora da soma, nunca zero). */
    baseAmountCents: cents("base_amount_cents"),
    /** Data-base da base usada. */
    baseDate: date("base_date", { mode: "string" }),
    /** Índice de atualização da base (padrão: o do pedido). */
    correctionIndex: text("correction_index").$type<CorrectionIndex>(),
    opinion: text("opinion").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    /** Versão das regras de risco vigente quando registrada (RNF-14). */
    rulesVersion: integer("rules_version").notNull().default(1),
    assessedById: uuid("assessed_by_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("process_claim_assessments_claim_idx").on(t.claimId, t.effectiveFrom),
    index("process_claim_assessments_process_idx").on(t.processId),
  ],
);

/**
 * Ligação entre uma classificação de risco do processo (`process_risk_assessments`)
 * e os pedidos: `derived` = registrada automaticamente a partir dos pedidos;
 * `override` = definida manualmente, diferente da derivada, com justificativa
 * (o parecer da classificação). `basisFingerprint` identifica as avaliações de
 * pedido vigentes no momento: quando muda com um override em vigor, o
 * override é mantido e sinalizado para revisão. APPEND-ONLY.
 */
export const processClaimRiskLinks = pgTable(
  "process_claim_risk_links",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    riskAssessmentId: uuid("risk_assessment_id")
      .notNull()
      .references(() => processRiskAssessments.id),
    kind: text("kind").$type<ClaimRiskLinkKind>().notNull(),
    /** Resultado da derivação no momento do registro. */
    derivedClassification: text("derived_classification").$type<LossProbability>(),
    derivedPercentageBp: integer("derived_percentage_bp"),
    derivedProvisionCents: cents("derived_provision_cents"),
    quantifiedBaseCents: cents("quantified_base_cents"),
    unquantifiedCount: integer("unquantified_count").notNull().default(0),
    unassessedCount: integer("unassessed_count").notNull().default(0),
    basisFingerprint: text("basis_fingerprint").notNull(),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("process_claim_risk_links_process_idx").on(t.processId, t.createdAt),
    uniqueIndex("process_claim_risk_links_assessment_uq").on(t.riskAssessmentId),
  ],
);
