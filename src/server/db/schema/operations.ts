import { boolean, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type {
  AssignmentMethod,
  DataOrigin,
  HearingKind,
  HearingMode,
  HearingStatus,
  IntakeSource,
  IntakeStatus,
  LegalArea,
  ProcessInstance,
} from "@/domain/enums";
import { createdAt, deletedAt, id, ts, updatedAt } from "./_columns";
import { lawFirms, organizations, units, users } from "./core";
import { legalProcesses } from "./legal";

/** Audiências e sessões de julgamento. Visibilidade herdada do processo. */
export const hearings = pgTable(
  "hearings",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    kind: text("kind").$type<HearingKind>().notNull(),
    mode: text("mode").$type<HearingMode>().notNull().default("in_person"),
    status: text("status").$type<HearingStatus>().notNull().default("scheduled"),
    scheduledAt: ts("scheduled_at").notNull(),
    location: text("location"),
    /** Link da sala virtual, quando informado por uma pessoa. */
    meetingUrl: text("meeting_url"),
    responsibleId: uuid("responsible_id").references(() => users.id),
    notes: text("notes"),
    outcome: text("outcome"),
    origin: text("origin").$type<DataOrigin>().notNull().default("manual"),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("hearings_org_scheduled_idx").on(t.organizationId, t.scheduledAt),
    index("hearings_process_idx").on(t.processId),
  ],
);

/** Critérios de uma regra de distribuição. Campos vazios/ausentes não restringem. */
export type DistributionCriteria = {
  courts?: string[];
  areas?: LegalArea[];
  companyIds?: string[];
  unitIds?: string[];
  /** UF (2 letras). */
  states?: string[];
  cities?: string[];
  instances?: ProcessInstance[];
  processClasses?: string[];
  minClaimCents?: number | null;
  maxClaimCents?: number | null;
};

/** Para quem a regra distribui. */
export type DistributionAssignment = {
  /** `fixed`: sempre o primeiro de `userIds`; `round_robin`: rodízio; `least_loaded`: menor carteira ativa. */
  method: "fixed" | "round_robin" | "least_loaded";
  userIds: string[];
  /** Escritório externo a vincular ao processo (opcional). */
  lawFirmId?: string | null;
  /** Unidade a atribuir quando o processo não tem unidade (opcional). */
  unitId?: string | null;
};

/** Regras de distribuição de demandas (RF-20). Avaliadas por `priority` crescente; a primeira que casa vence. */
export const distributionRules = pgTable(
  "distribution_rules",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    description: text("description"),
    priority: integer("priority").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    criteria: jsonb("criteria").$type<DistributionCriteria>().notNull().default({}),
    assignment: jsonb("assignment").$type<DistributionAssignment>().notNull(),
    /** Posição do rodízio (round robin). */
    rrCursor: integer("rr_cursor").notNull().default(0),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("distribution_rules_org_idx").on(t.organizationId, t.priority)],
);

/** One step of the intake timeline (shown in the UI as the pipeline history). */
export type IntakeStep = {
  status: IntakeStatus;
  /** ISO timestamp. */
  at: string;
  /** pt-BR description of what happened. Never contains document text. */
  detail: string;
  actorName: string | null;
};

/**
 * Entrada de processo (pipeline): recebido → responsável definido → leitura
 * dos documentos e análise preliminar (simulada) → e-mail ao advogado
 * (simulado) → revisão → aprovação. Visibilidade herdada do processo.
 */
export const caseIntakes = pgTable(
  "case_intakes",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    processId: uuid("process_id").notNull().references(() => legalProcesses.id),
    source: text("source").$type<IntakeSource>().notNull(),
    status: text("status").$type<IntakeStatus>().notNull().default("received"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    assignedToId: uuid("assigned_to_id").references(() => users.id),
    assignmentMethod: text("assignment_method").$type<AssignmentMethod>(),
    distributionRuleId: uuid("distribution_rule_id").references(() => distributionRules.id),
    assignedLawFirmId: uuid("assigned_law_firm_id").references(() => lawFirms.id),
    assignedUnitId: uuid("assigned_unit_id").references(() => units.id),
    /** Explicação pt-BR de por que este responsável foi escolhido. */
    assignmentReason: text("assignment_reason"),
    assignedAt: ts("assigned_at"),
    briefId: uuid("brief_id"),
    lastEmailId: uuid("last_email_id"),
    steps: jsonb("steps").$type<IntakeStep[]>().notNull().default([]),
    errorMessage: text("error_message"),
    createdById: uuid("created_by_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("case_intakes_org_status_idx").on(t.organizationId, t.status, t.receivedAt),
    index("case_intakes_process_idx").on(t.processId),
  ],
);
