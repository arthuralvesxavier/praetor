import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  ClosureReason,
  ContractStatus,
  ContractType,
  DataOrigin,
  LegalArea,
  LiabilityNature,
  LossProbability,
  ObligationStatus,
  OccurrenceCategory,
  OccurrenceStatus,
  PartyRole,
  ProcessEventType,
  ProcessInstance,
  ProcessPhase,
  ProcessStatus,
  RenewalType,
  RiskLevel,
} from "@/domain/enums";
import { createdAt, deletedAt, id, ts, updatedAt } from "./_columns";
import { companies, lawFirms, organizations, units, users } from "./core";

/** Money is stored as integer cents (BRL) to avoid floating point errors. */
export const cents = (name: string) => bigint(name, { mode: "number" });

// ---------------------------------------------------------------------------
// Contencioso
// ---------------------------------------------------------------------------

export const legalProcesses = pgTable(
  "legal_processes",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    /** Process number as informed (CNJ format NNNNNNN-DD.AAAA.J.TR.OOOO when applicable). */
    number: text("number").notNull(),
    title: text("title").notNull(),
    /** Tribunal (e.g. TJSP, TRT-2). Free text — no tribunal integration exists. */
    court: text("court").notNull(),
    /** Vara / órgão julgador. */
    courtDivision: text("court_division"),
    /** Comarca / jurisdição. */
    jurisdiction: text("jurisdiction"),
    area: text("area").$type<LegalArea>().notNull(),
    phase: text("phase").$type<ProcessPhase>().notNull(),
    status: text("status").$type<ProcessStatus>().notNull().default("active"),
    unitId: uuid("unit_id").references(() => units.id),
    responsibleId: uuid("responsible_id").references(() => users.id),
    /** Empresa do grupo que figura no processo (RNF-13). */
    companyId: uuid("company_id").references(() => companies.id),
    /** Escritório externo que patrocina o processo (RF-20/RF-21). */
    lawFirmId: uuid("law_firm_id").references(() => lawFirms.id),
    /** Instância atual. Os vínculos com cada grau ficam em `process_instances` (RN-01). */
    instance: text("instance").$type<ProcessInstance>(),
    /** Classe processual (ATOrd, ATSum, ROT, AIRR...). */
    processClass: text("process_class"),
    city: text("city"),
    /** UF (2 letras). */
    state: text("state"),
    /** Fase como veio da fonte (ex.: "Execução — ARQUIVADO def. …"), preservada para conferência. */
    phaseDetail: text("phase_detail"),
    /** Valor da causa (exposição declarada). Nunca somado ao liquidado (RN-02). Null = não informado. */
    claimAmountCents: cents("claim_amount_cents"),
    /** Valor liquidado/apurado oficial vigente (espelho da última valoração oficial). Null = não apurado (RN-03). */
    liquidatedAmountCents: cents("liquidated_amount_cents"),
    provisionAmountCents: cents("provision_amount_cents"),
    /** Percentual de risco vigente em pontos-base (5000 = 50%), espelho da última classificação oficial. */
    riskPercentageBp: integer("risk_percentage_bp"),
    riskLevel: text("risk_level").$type<RiskLevel>().notNull().default("medium"),
    lossProbability: text("loss_probability").$type<LossProbability>(),
    /** Free-text justification for the risk classification (human-entered). */
    riskRationale: text("risk_rationale"),
    filedAt: date("filed_at", { mode: "string" }),
    closedAt: date("closed_at", { mode: "string" }),
    /** Motivo de saída da carteira ativa (RF-06/RN-12). */
    closureReason: text("closure_reason").$type<ClosureReason>(),
    /** Marcado quando a fonte pede conferência ("VERIFICAR", "saiu do acervo"...) ou há divergência. */
    needsVerification: boolean("needs_verification").notNull().default(false),
    verificationNote: text("verification_note"),
    lastMovementAt: date("last_movement_at", { mode: "string" }),
    description: text("description"),
    /** Confidential records are only visible to admins, legal managers and the responsible user. */
    isConfidential: boolean("is_confidential").notNull().default(false),
    /** `manual` or `imported`. AI never creates processes. */
    dataOrigin: text("data_origin").$type<DataOrigin>().notNull().default("manual"),
    /** For imported data: where it came from (file name / integration id) — never a fabricated source. */
    externalSource: text("external_source"),
    externalId: text("external_id"),
    importedAt: ts("imported_at"),
    /** Lote de importação que criou o processo (sem FK para evitar ciclo de schema). */
    importBatchId: uuid("import_batch_id"),
    /** Blocks deletion by retention routines. */
    legalHold: boolean("legal_hold").notNull().default(false),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("legal_processes_org_number_uq").on(t.organizationId, t.number).where(sql`${t.deletedAt} is null`),
    index("legal_processes_org_status_idx").on(t.organizationId, t.status),
    index("legal_processes_org_unit_idx").on(t.organizationId, t.unitId),
    index("legal_processes_responsible_idx").on(t.responsibleId),
    index("legal_processes_org_company_idx").on(t.organizationId, t.companyId),
    index("legal_processes_org_court_idx").on(t.organizationId, t.court),
    index("legal_processes_org_phase_idx").on(t.organizationId, t.phase),
    index("legal_processes_law_firm_idx").on(t.lawFirmId),
  ],
);

/**
 * Vínculos de instância (RN-01/RN-09): o número CNJ é a chave e o processo é
 * um só registro; cada grau em que tramitou/tramita é uma linha aqui, com o
 * órgão, a classe, a fase e os valores informados naquela instância.
 */
export const processInstances = pgTable(
  "process_instances",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id, { onDelete: "cascade" }),
    instance: text("instance").$type<ProcessInstance>().notNull(),
    court: text("court").notNull(),
    courtDivision: text("court_division"),
    city: text("city"),
    state: text("state"),
    processClass: text("process_class"),
    phase: text("phase").$type<ProcessPhase>(),
    phaseDetail: text("phase_detail"),
    claimAmountCents: cents("claim_amount_cents"),
    liquidatedAmountCents: cents("liquidated_amount_cents"),
    /** True for the instance where the process currently is. */
    isCurrent: boolean("is_current").notNull().default(false),
    origin: text("origin").$type<DataOrigin>().notNull().default("manual"),
    importBatchId: uuid("import_batch_id"),
    /** Aba e linha da planilha de origem (rastreabilidade da importação). */
    sourceSheet: text("source_sheet"),
    sourceRow: integer("source_row"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("process_instances_process_instance_uq").on(t.processId, t.instance),
    index("process_instances_org_idx").on(t.organizationId, t.instance),
  ],
);

export const processParties = pgTable(
  "process_parties",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").$type<PartyRole>().notNull(),
    /** CPF/CNPJ — personal data, optional. Mask in lists. */
    documentNumber: text("document_number"),
    /** True when the party is the organization itself / its client. */
    isClient: boolean("is_client").notNull().default(false),
    /** Natureza da responsabilidade (direta, solidária, subsidiária) — análise jurídica, opcional. */
    liabilityNature: text("liability_nature").$type<LiabilityNature>(),
    counselName: text("counsel_name"),
    createdAt: createdAt(),
  },
  (t) => [index("process_parties_process_idx").on(t.processId)],
);

/** Linha do tempo de movimentações. Only manual or imported entries — never AI-invented. */
export const processEvents = pgTable(
  "process_events",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id, { onDelete: "cascade" }),
    occurredAt: date("occurred_at", { mode: "string" }).notNull(),
    type: text("type").$type<ProcessEventType>().notNull(),
    title: text("title").notNull(),
    description: text("description"),
    origin: text("origin").$type<DataOrigin>().notNull().default("manual"),
    externalSource: text("external_source"),
    /** Código da tabela de movimentos do CNJ, quando conhecido (nunca inventado). */
    cnjMovementCode: integer("cnj_movement_code"),
    instance: text("instance").$type<ProcessInstance>(),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("process_events_process_idx").on(t.processId, t.occurredAt)],
);

// ---------------------------------------------------------------------------
// Jurídico preventivo
// ---------------------------------------------------------------------------

export const occurrences = pgTable(
  "occurrences",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    title: text("title").notNull(),
    /** Narrative of the facts as reported. */
    facts: text("facts").notNull(),
    category: text("category").$type<OccurrenceCategory>().notNull(),
    status: text("status").$type<OccurrenceStatus>().notNull().default("open"),
    riskLevel: text("risk_level").$type<RiskLevel>().notNull().default("medium"),
    riskRationale: text("risk_rationale"),
    /** Internal areas involved (e.g. "RH", "Comercial"). */
    areasInvolved: jsonb("areas_involved").$type<string[]>().notNull().default([]),
    /** External people/companies involved, free text. */
    involvedParties: text("involved_parties"),
    /** Information the team knows is missing (manually tracked; AI may suggest more in analyses). */
    missingInformation: jsonb("missing_information").$type<string[]>().notNull().default([]),
    estimatedExposureCents: cents("estimated_exposure_cents"),
    unitId: uuid("unit_id").references(() => units.id),
    responsibleId: uuid("responsible_id").references(() => users.id),
    reportedById: uuid("reported_by_id").references(() => users.id),
    occurredOn: date("occurred_on", { mode: "string" }),
    reportedOn: date("reported_on", { mode: "string" }).notNull(),
    /** Set when the occurrence became (or was linked to) a judicial process. */
    linkedProcessId: uuid("linked_process_id").references(() => legalProcesses.id),
    isConfidential: boolean("is_confidential").notNull().default(false),
    resolvedAt: ts("resolved_at"),
    legalHold: boolean("legal_hold").notNull().default(false),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("occurrences_org_status_idx").on(t.organizationId, t.status),
    index("occurrences_org_unit_idx").on(t.organizationId, t.unitId),
  ],
);

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    title: text("title").notNull(),
    counterparty: text("counterparty").notNull(),
    counterpartyDocument: text("counterparty_document"),
    type: text("type").$type<ContractType>().notNull(),
    status: text("status").$type<ContractStatus>().notNull().default("draft"),
    unitId: uuid("unit_id").references(() => units.id),
    responsibleId: uuid("responsible_id").references(() => users.id),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    renewalType: text("renewal_type").$type<RenewalType>().notNull().default("none"),
    /** Days before `endDate` by which renewal/termination notice must be given. */
    renewalNoticeDays: bigint("renewal_notice_days", { mode: "number" }),
    valueCents: cents("value_cents"),
    riskLevel: text("risk_level").$type<RiskLevel>().notNull().default("low"),
    description: text("description"),
    linkedProcessId: uuid("linked_process_id").references(() => legalProcesses.id),
    linkedOccurrenceId: uuid("linked_occurrence_id").references(() => occurrences.id),
    isConfidential: boolean("is_confidential").notNull().default(false),
    legalHold: boolean("legal_hold").notNull().default(false),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("contracts_org_status_idx").on(t.organizationId, t.status),
    index("contracts_org_end_idx").on(t.organizationId, t.endDate),
  ],
);

export const contractObligations = pgTable(
  "contract_obligations",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    responsibleId: uuid("responsible_id").references(() => users.id),
    dueDate: date("due_date", { mode: "string" }),
    /** Free-text recurrence description (e.g. "mensal"). No automatic recurrence engine yet. */
    recurrence: text("recurrence"),
    status: text("status").$type<ObligationStatus>().notNull().default("pending"),
    origin: text("origin").$type<DataOrigin>().notNull().default("manual"),
    sourceAnalysisId: uuid("source_analysis_id"),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("contract_obligations_contract_idx").on(t.contractId)],
);
