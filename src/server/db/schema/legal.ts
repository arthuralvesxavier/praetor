import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  ContractStatus,
  ContractType,
  DataOrigin,
  LegalArea,
  LossProbability,
  ObligationStatus,
  OccurrenceCategory,
  OccurrenceStatus,
  PartyRole,
  ProcessEventType,
  ProcessPhase,
  ProcessStatus,
  RenewalType,
  RiskLevel,
} from "@/domain/enums";
import { createdAt, deletedAt, id, ts, updatedAt } from "./_columns";
import { organizations, units, users } from "./core";

/** Money is stored as integer cents (BRL) to avoid floating point errors. */
const cents = (name: string) => bigint(name, { mode: "number" });

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
    claimAmountCents: cents("claim_amount_cents"),
    provisionAmountCents: cents("provision_amount_cents"),
    riskLevel: text("risk_level").$type<RiskLevel>().notNull().default("medium"),
    lossProbability: text("loss_probability").$type<LossProbability>(),
    /** Free-text justification for the risk classification (human-entered). */
    riskRationale: text("risk_rationale"),
    filedAt: date("filed_at", { mode: "string" }),
    closedAt: date("closed_at", { mode: "string" }),
    description: text("description"),
    /** Confidential records are only visible to admins, legal managers and the responsible user. */
    isConfidential: boolean("is_confidential").notNull().default(false),
    /** `manual` or `imported`. AI never creates processes. */
    dataOrigin: text("data_origin").$type<DataOrigin>().notNull().default("manual"),
    /** For imported data: where it came from (file name / integration id) — never a fabricated source. */
    externalSource: text("external_source"),
    externalId: text("external_id"),
    importedAt: ts("imported_at"),
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
