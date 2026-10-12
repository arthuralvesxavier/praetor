/**
 * Litigation portfolio (carteira de processos): legal processes, their
 * instances (one row per grau, RN-01/RN-09), parties, the manual/imported
 * timeline of movements, the active-portfolio lifecycle (RN-12) and exports.
 *
 * Conventions (docs/dev/MODULE_CONTRACTS.md): ctx first, assertCan, row
 * visibility through `processWhere(ctx)` on every query, zod validation of
 * every input, foreign ids checked against the organization, mutations in a
 * transaction with `recordAudit`. No tribunal integration exists: numbers are
 * stored as informed (CNJ shape and check digit are only *verified*, never
 * corrected) and movements are typed by users or imported from an informed
 * source.
 *
 * Values: `claimAmountCents` (valor da causa) is edited here and every change
 * appends a `claim` valuation (RF-09, allowed exception in MODULE_CONTRACTS
 * "Denormalized mirrors"). Only an identified person whose role has
 * `contingency:approve` makes it OFFICIAL (RN-11): the change supersedes the
 * previous official claims and `syncProcessMirrors` runs in the same
 * transaction (provision and the other mirrors follow). Anyone else (lawyers,
 * external counsel, analysts registering an intake through the delegated
 * context) records a PROPOSED claim for the review queue and the record does
 * not take the value: on create it stays "não informado", on an update it keeps
 * the current one, until the review queue approves the proposal (the approval
 * syncs the mirror; a rejection leaves the record untouched). Proposed values
 * therefore never reach totals, positions or exposure. A context without a
 * person (imports, inbound API) creates with the informed value and records no
 * valuation, and may not change it afterwards. A
 * removal by an approver stamps `cleared_on` on the superseded rows (positions
 * of later dates read "não informado"). `liquidatedAmountCents`,
 * `provisionAmountCents`, `lossProbability` and `riskPercentageBp` are mirrors
 * maintained by the contingency module and are never written by this service.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import {
  CLOSURE_REASON_LABELS,
  PARTY_ROLE_LABELS,
  PROCESS_EVENT_TYPE_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_INSTANCES,
  type ClosureReason,
  type ConfidentialityLevel,
  type DataOrigin,
  type DocumentCategory,
  type LegalArea,
  type LiabilityNature,
  type PartyRole,
  type ProcessEventType,
  type ProcessInstance,
  type ProcessPhase,
  type ProcessStatus,
  type RiskLevel,
} from "@/domain/enums";
import { formatMoneyCents, formatNumber, todayISO } from "@/lib/format";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import { syncProcessMirrors, type MirrorChanges } from "@/modules/contingency/internal";
import { linkOccurrenceToProcess } from "@/modules/occurrences/service";
import { assertCompanyInOrg, assertLawFirmInOrg } from "@/modules/organization/service";
import {
  deadlineWhere,
  documentWhere,
  isExternalCounsel,
  occurrenceWhere,
  processWhere,
  seesConfidential,
} from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  auditLogs,
  companies,
  deadlines,
  documents,
  lawFirms,
  legalProcesses,
  occurrences,
  processEvents,
  processInstances,
  processParties,
  processValuations,
  units,
  users,
} from "@/server/db/schema";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { diffChanges, recordAudit } from "@/server/services/audit";
import {
  areaFromOccurrenceCategory,
  closeProcessSchema,
  cnjCheck,
  createProcessSchema,
  flagVerificationSchema,
  isCnjNumberFormat,
  normalizeProcessNumber,
  partyInputSchema,
  PROCESS_FIELD_LABELS,
  processEventInputSchema,
  processFiltersSchema,
  processInstanceInputSchema,
  reactivateProcessSchema,
  resolveVerificationSchema,
  updateProcessSchema,
  type CloseProcessInput,
  type CnjCheck,
  type CreateProcessInput,
  type FlagVerificationInput,
  type PartyInput,
  type ProcessEventInput,
  type ProcessFilters,
  type ProcessInstanceInput,
  type ProcessMissingField,
  type ProcessSort,
  type ReactivateProcessInput,
  type ResolveVerificationInput,
  type UpdateProcessInput,
} from "./schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProcessRow = typeof legalProcesses.$inferSelect;
type InstanceRow = typeof processInstances.$inferSelect;

export type ProcessListItem = {
  id: string;
  number: string;
  /** False when the number does not follow the CNJ shape (shown as "fora do padrão CNJ"). */
  isCnjFormat: boolean;
  title: string;
  court: string;
  courtDivision: string | null;
  jurisdiction: string | null;
  area: LegalArea;
  phase: ProcessPhase;
  phaseDetail: string | null;
  status: ProcessStatus;
  closureReason: ClosureReason | null;
  riskLevel: RiskLevel;
  instance: ProcessInstance | null;
  processClass: string | null;
  city: string | null;
  state: string | null;
  /** Valor da causa. Null = não informado. */
  claimAmountCents: number | null;
  /** Valor liquidado/apurado oficial (mirror). Null = não apurado (RN-03). Never summed with the claim (RN-02). */
  liquidatedAmountCents: number | null;
  responsibleId: string | null;
  responsibleName: string | null;
  unitId: string | null;
  unitName: string | null;
  companyId: string | null;
  companyName: string | null;
  lawFirmId: string | null;
  lawFirmName: string | null;
  /** First plaintiff (polo ativo) and how many there are. */
  plaintiffName: string | null;
  plaintiffCount: number;
  /** First defendant (polo passivo) and how many there are. */
  defendantName: string | null;
  defendantCount: number;
  dataOrigin: DataOrigin;
  externalSource: string | null;
  isConfidential: boolean;
  needsVerification: boolean;
  filedAt: string | null;
  lastMovementAt: string | null;
  /** Open deadlines that count as real (manual or validated; pending AI suggestions excluded). */
  openDeadlineCount: number;
  nextDeadlineDate: string | null;
  updatedAt: Date;
};

/** Totals of the filtered set. Claim and liquidated are separate sums, never added together (RN-02). */
export type ProcessListSummary = {
  /** Processes (unique CNJ numbers, RN-01 — instances are never counted). */
  count: number;
  claimCents: number;
  /** Processes without valor da causa. */
  claimUnknown: number;
  liquidatedCents: number;
  /** Processes whose valor liquidado is not assessed (RN-03). */
  liquidatedUnknown: number;
  needsVerification: number;
};

export type ProcessFilterOptions = { courts: string[]; classes: string[]; cities: string[]; states: string[] };

export type ProcessPartyItem = {
  id: string;
  name: string;
  role: PartyRole;
  /** Digits only (CPF/CNPJ). Personal data: mask it in lists (`maskDocument`). */
  documentNumber: string | null;
  isClient: boolean;
  liabilityNature: LiabilityNature | null;
  counselName: string | null;
  createdAt: Date;
};

export type ProcessEventItem = {
  id: string;
  occurredAt: string;
  type: ProcessEventType;
  title: string;
  description: string | null;
  origin: DataOrigin;
  externalSource: string | null;
  instance: ProcessInstance | null;
  /** CNJ movement code, only when informed by a person or an informed source (never inferred). */
  cnjMovementCode: number | null;
  createdByName: string | null;
  createdAt: Date;
  /** Only manually registered movements can be removed; imported ones are read-only. */
  removable: boolean;
};

export type ProcessInstanceItem = {
  id: string;
  instance: ProcessInstance;
  court: string;
  courtDivision: string | null;
  city: string | null;
  state: string | null;
  processClass: string | null;
  phase: ProcessPhase | null;
  phaseDetail: string | null;
  /** Value stored on the link row (what the instance dialog edits). */
  claimAmountCents: number | null;
  /**
   * Computed on read: for the CURRENT instance without its own valor da causa, the valor da causa of the
   * process record (official value or import), e.g. right after the review queue approved a proposal
   * (the approval fills only the record). Null otherwise. Shown as "Valor do cadastro do processo".
   */
  claimFromRecordCents: number | null;
  liquidatedAmountCents: number | null;
  isCurrent: boolean;
  origin: DataOrigin;
  sourceSheet: string | null;
  sourceRow: number | null;
  /** Imported links are kept for traceability (edit them; undo the import to remove). */
  removable: boolean;
};

export type ProcessDetail = ProcessRow & {
  isCnjFormat: boolean;
  /** CNJ shape + check digit (an invalid digit is a warning, never corrected). */
  cnjCheck: CnjCheck;
  responsibleName: string | null;
  unitName: string | null;
  companyName: string | null;
  lawFirmName: string | null;
  createdByName: string | null;
  parties: ProcessPartyItem[];
  events: ProcessEventItem[];
  instances: ProcessInstanceItem[];
  permissions: { canEdit: boolean; canDelete: boolean; canEditConfidential: boolean };
};

export type ProcessSummary = { total: number; active: number; highRisk: number };

export type OccurrencePrefill = {
  occurrenceId: string;
  title: string;
  area: LegalArea | null;
  unitId: string | null;
  responsibleId: string | null;
  riskLevel: RiskLevel;
  riskRationale: string | null;
  description: string;
  isConfidential: boolean;
  alreadyLinkedProcessId: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOT_FOUND_MESSAGE = "Processo não encontrado ou sem permissão de acesso.";
const DUPLICATE_NUMBER_MESSAGE = "Já existe um processo com este número na organização.";
const INSTANCE_NOT_FOUND = "Instância não encontrada ou sem permissão de acesso.";

/** Carteira ativa (RN-12): active or suspended. */
export const ACTIVE_PORTFOLIO_STATUSES: readonly ProcessStatus[] = ["active", "suspended"];
const INACTIVE_STATUSES: ProcessStatus[] = ["archived", "closed"];

export function isInActivePortfolio(status: ProcessStatus): boolean {
  return ACTIVE_PORTFOLIO_STATUSES.includes(status);
}

/** Fields compared for audit diffs (updatedAt/createdAt are ignored by diffChanges). */
const AUDIT_FIELDS = [
  "number",
  "title",
  "court",
  "courtDivision",
  "jurisdiction",
  "area",
  "phase",
  "status",
  "filedAt",
  "closedAt",
  "unitId",
  "responsibleId",
  "claimAmountCents",
  "riskLevel",
  "riskRationale",
  "description",
  "isConfidential",
  "companyId",
  "lawFirmId",
  "instance",
  "processClass",
  "city",
  "state",
  "phaseDetail",
  "closureReason",
  "needsVerification",
  "verificationNote",
  "lastMovementAt",
] as const;

/** Changes to these fields make previous AI analyses of the process outdated. */
const STALE_FIELDS = new Set<string>(
  AUDIT_FIELDS.filter((f) => f !== "isConfidential" && f !== "needsVerification" && f !== "verificationNote"),
);

const PARTY_AUDIT_FIELDS = ["name", "role", "documentNumber", "isClient", "liabilityNature", "counselName"] as const;

const INSTANCE_AUDIT_FIELDS = [
  "instance",
  "court",
  "courtDivision",
  "city",
  "state",
  "processClass",
  "phase",
  "phaseDetail",
  "claimAmountCents",
  "liquidatedAmountCents",
  "isCurrent",
] as const;

const isUuid = (v: unknown): v is string => typeof v === "string" && z.guid().safeParse(v).success;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(undefined, z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  }
  return result.data;
}

function fieldError(field: string, message: string): ValidationError {
  return new ValidationError(undefined, { [field]: [message] });
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; e && typeof e === "object" && i < 5; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Only admin and legal manager (and system jobs) may set or change confidentiality. */
export function canEditProcessConfidentiality(ctx: AuthContext): boolean {
  return seesConfidential(ctx);
}

/** External counsel cannot move a process to another law firm (their portfolio is defined by it). */
export function canChangeProcessLawFirm(ctx: AuthContext): boolean {
  return !isExternalCounsel(ctx);
}

function fieldList(keys: readonly string[]): string {
  return keys.map((k) => PROCESS_FIELD_LABELS[k] ?? k).join(", ");
}

function instanceOrder(instance: ProcessInstance): number {
  return PROCESS_INSTANCES.indexOf(instance);
}

async function loadProcess(ctx: AuthContext, id: string, db: DbOrTx = getDb()): Promise<ProcessRow> {
  if (!isUuid(id)) throw new NotFoundError(NOT_FOUND_MESSAGE);
  const [row] = await db
    .select()
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, id), processWhere(ctx)));
  if (!row) throw new NotFoundError(NOT_FOUND_MESSAGE);
  return row;
}

/** Uniqueness is organization-wide (DB unique index), regardless of the user's visibility. */
async function assertNumberAvailable(ctx: AuthContext, number: string, exceptId?: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(
      and(
        eq(legalProcesses.organizationId, ctx.organizationId),
        eq(legalProcesses.number, number),
        isNull(legalProcesses.deletedAt),
        exceptId ? ne(legalProcesses.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (row) throw new ConflictError(DUPLICATE_NUMBER_MESSAGE);
}

async function assertUnitOfOrganization(ctx: AuthContext, unitId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.id, unitId), eq(units.organizationId, ctx.organizationId), eq(units.isActive, true)))
    .limit(1);
  if (!row) throw fieldError("unitId", "Selecione uma unidade ativa da organização.");
}

async function assertActiveUserOfOrganization(ctx: AuthContext, userId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)))
    .limit(1);
  if (!row) throw fieldError("responsibleId", "Selecione um usuário ativo da organização como responsável.");
}

async function loadVisibleOccurrence(ctx: AuthContext, occurrenceId: string): Promise<{ isConfidential: boolean }> {
  const message = "Ocorrência não encontrada ou sem permissão de acesso.";
  if (!can(ctx, "occurrence:read")) throw fieldError("fromOccurrenceId", message);
  const [row] = await getDb()
    .select({ id: occurrences.id, isConfidential: occurrences.isConfidential })
    .from(occurrences)
    .where(and(eq(occurrences.id, occurrenceId), occurrenceWhere(ctx)))
    .limit(1);
  if (!row) throw fieldError("fromOccurrenceId", message);
  return row;
}

/**
 * Law firm for a new process. External counsel always register processes of
 * their own firm (rule 10 of access.ts: otherwise they would lose access).
 */
function lawFirmForCreate(ctx: AuthContext, requested: string | null | undefined): string | null {
  if (!isExternalCounsel(ctx)) return requested ?? null;
  if (!ctx.lawFirmId) throw fieldError("lawFirmId", "Seu usuário não está vinculado a um escritório externo.");
  if (requested && requested !== ctx.lawFirmId) {
    throw fieldError("lawFirmId", "Escritórios externos só cadastram processos do próprio escritório.");
  }
  return ctx.lawFirmId;
}

async function userNameMap(organizationId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), inArray(users.id, unique)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function searchCondition(q: string): SQL {
  const p = legalProcesses;
  const pattern = `%${escapeLike(q)}%`;
  const conds: SQL[] = [
    ilike(p.number, pattern),
    ilike(p.title, pattern),
    ilike(p.court, pattern),
    ilike(p.courtDivision, pattern),
    ilike(p.jurisdiction, pattern),
    ilike(p.city, pattern),
    ilike(p.processClass, pattern),
    ilike(p.description, pattern),
    exists(
      getDb()
        .select({ one: sql`1` })
        .from(processParties)
        .where(
          and(
            eq(processParties.processId, p.id),
            eq(processParties.organizationId, p.organizationId),
            ilike(processParties.name, pattern),
          ),
        ),
    ),
  ];
  // "00012345620248260100" finds "0001234-56.2024.8.26.0100" (number typed without punctuation).
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 4 && /^[\d.\-\s/]+$/.test(q)) {
    conds.push(sql`regexp_replace(${p.number}, '[^0-9]', '', 'g') like ${`%${digits}%`}`);
  }
  return or(...conds) ?? sql`false`;
}

type ParsedFilters = z.output<typeof processFiltersSchema>;

/**
 * `pendencia=<field>`: the field is empty on the process — null, or blank text
 * for court and city. Same rule as the dashboard's "Pendências de cadastro"
 * (`@/modules/dashboard/portfolio-service`), which keeps these processes out of its charts.
 */
function missingFieldCondition(field: ProcessMissingField): SQL {
  const p = legalProcesses;
  switch (field) {
    case "court":
      return sql`coalesce(${p.court}, '') ~ '^[[:space:]]*$'`;
    case "city":
      return sql`coalesce(${p.city}, '') ~ '^[[:space:]]*$'`;
    case "instance":
      return isNull(p.instance);
    case "phase":
      return isNull(p.phase);
    case "company":
      return isNull(p.companyId);
    case "unit":
      return isNull(p.unitId);
  }
}

/** WHERE of the portfolio list, its summary and its export (always includes the row scope). */
function listWhere(ctx: AuthContext, f: ParsedFilters): SQL {
  const p = legalProcesses;
  return (
    and(
      processWhere(ctx),
      f.q ? searchCondition(f.q) : undefined,
      f.status ? eq(p.status, f.status) : undefined,
      f.area ? eq(p.area, f.area) : undefined,
      f.phase ? eq(p.phase, f.phase) : undefined,
      f.riskLevel ? eq(p.riskLevel, f.riskLevel) : undefined,
      f.unitId ? eq(p.unitId, f.unitId) : undefined,
      f.responsibleId ? eq(p.responsibleId, f.responsibleId) : undefined,
      f.court ? eq(p.court, f.court) : undefined,
      f.instance ? eq(p.instance, f.instance) : undefined,
      f.city ? eq(p.city, f.city) : undefined,
      f.state ? eq(p.state, f.state) : undefined,
      f.companyId ? eq(p.companyId, f.companyId) : undefined,
      f.lawFirmId ? eq(p.lawFirmId, f.lawFirmId) : undefined,
      f.processClass ? eq(p.processClass, f.processClass) : undefined,
      f.claimMinCents !== undefined ? gte(p.claimAmountCents, f.claimMinCents) : undefined,
      f.claimMaxCents !== undefined ? lte(p.claimAmountCents, f.claimMaxCents) : undefined,
      f.liquidated === "with" ? isNotNull(p.liquidatedAmountCents) : undefined,
      f.liquidated === "without" ? isNull(p.liquidatedAmountCents) : undefined,
      f.missingField ? missingFieldCondition(f.missingField) : undefined,
      f.needsVerification ? eq(p.needsVerification, true) : undefined,
      f.portfolio === "active" ? inArray(p.status, [...ACTIVE_PORTFOLIO_STATUSES]) : undefined,
      f.portfolio === "closed" ? inArray(p.status, INACTIVE_STATUSES) : undefined,
    ) ?? sql`true`
  );
}

function orderBy(sort: ProcessSort | undefined): SQL[] {
  const p = legalProcesses;
  switch (sort) {
    case "number_asc":
      return [asc(p.number), asc(p.id)];
    case "claim_desc":
      return [sql`${p.claimAmountCents} desc nulls last`, asc(p.number)];
    case "claim_asc":
      return [sql`${p.claimAmountCents} asc nulls last`, asc(p.number)];
    case "liquidated_desc":
      return [sql`${p.liquidatedAmountCents} desc nulls last`, asc(p.number)];
    case "liquidated_asc":
      return [sql`${p.liquidatedAmountCents} asc nulls last`, asc(p.number)];
    case "filed_desc":
      return [sql`${p.filedAt} desc nulls last`, asc(p.number)];
    case "filed_asc":
      return [sql`${p.filedAt} asc nulls last`, asc(p.number)];
    case "last_movement_desc":
      return [sql`${p.lastMovementAt} desc nulls last`, desc(p.updatedAt), desc(p.id)];
    default:
      return [desc(p.updatedAt), desc(p.id)];
  }
}

/** First party of a side (by registration order), as a correlated subquery. */
function firstPartyField(role: PartyRole, column: "name" | "documentNumber") {
  const pp = processParties;
  const col = column === "name" ? pp.name : pp.documentNumber;
  return sql<string | null>`(select ${col} from ${pp} where ${pp.processId} = ${legalProcesses.id} and ${pp.role} = ${role} order by ${pp.createdAt} asc, ${pp.name} asc limit 1)`;
}

function partyCount(role: PartyRole) {
  const pp = processParties;
  return sql<number>`(select count(*) from ${pp} where ${pp.processId} = ${legalProcesses.id} and ${pp.role} = ${role})`.mapWith(
    Number,
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listProcesses(
  ctx: AuthContext,
  filters: ProcessFilters & Page = {},
): Promise<Paginated<ProcessListItem>> {
  assertCan(ctx, "process:read");
  const f = parse(processFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage({ page: f.page, pageSize: f.pageSize });
  const p = legalProcesses;
  const where = listWhere(ctx, f);

  const db = getDb();
  const [{ total }] = await db.select({ total: count() }).from(p).where(where);
  const rows = await db
    .select({
      id: p.id,
      number: p.number,
      title: p.title,
      court: p.court,
      courtDivision: p.courtDivision,
      jurisdiction: p.jurisdiction,
      area: p.area,
      phase: p.phase,
      phaseDetail: p.phaseDetail,
      status: p.status,
      closureReason: p.closureReason,
      riskLevel: p.riskLevel,
      instance: p.instance,
      processClass: p.processClass,
      city: p.city,
      state: p.state,
      claimAmountCents: p.claimAmountCents,
      liquidatedAmountCents: p.liquidatedAmountCents,
      responsibleId: p.responsibleId,
      responsibleName: users.name,
      unitId: p.unitId,
      unitName: units.name,
      companyId: p.companyId,
      companyName: companies.name,
      lawFirmId: p.lawFirmId,
      lawFirmName: lawFirms.name,
      plaintiffName: firstPartyField("plaintiff", "name"),
      plaintiffCount: partyCount("plaintiff"),
      defendantName: firstPartyField("defendant", "name"),
      defendantCount: partyCount("defendant"),
      dataOrigin: p.dataOrigin,
      externalSource: p.externalSource,
      isConfidential: p.isConfidential,
      needsVerification: p.needsVerification,
      filedAt: p.filedAt,
      lastMovementAt: p.lastMovementAt,
      updatedAt: p.updatedAt,
    })
    .from(p)
    .leftJoin(users, and(eq(users.id, p.responsibleId), eq(users.organizationId, ctx.organizationId)))
    .leftJoin(units, and(eq(units.id, p.unitId), eq(units.organizationId, ctx.organizationId)))
    .leftJoin(companies, and(eq(companies.id, p.companyId), eq(companies.organizationId, ctx.organizationId)))
    .leftJoin(lawFirms, and(eq(lawFirms.id, p.lawFirmId), eq(lawFirms.organizationId, ctx.organizationId)))
    .where(where)
    .orderBy(...orderBy(f.sort))
    .limit(pageSize)
    .offset(offset);

  const stats = new Map<string, { open: number; next: string | null }>();
  if (rows.length > 0) {
    const statRows = await db
      .select({
        processId: deadlines.processId,
        open: count(),
        next: sql<string | null>`to_char(min(${deadlines.dueDate}), 'YYYY-MM-DD')`,
      })
      .from(deadlines)
      .where(
        and(
          inArray(
            deadlines.processId,
            rows.map((r) => r.id),
          ),
          eq(deadlines.status, "open"),
          inArray(deadlines.validationStatus, ["not_required", "validated"]),
          deadlineWhere(ctx),
        ),
      )
      .groupBy(deadlines.processId);
    for (const s of statRows) if (s.processId) stats.set(s.processId, { open: Number(s.open), next: s.next });
  }

  return {
    items: rows.map((r) => ({
      ...r,
      plaintiffCount: Number(r.plaintiffCount ?? 0),
      defendantCount: Number(r.defendantCount ?? 0),
      isCnjFormat: isCnjNumberFormat(r.number),
      openDeadlineCount: stats.get(r.id)?.open ?? 0,
      nextDeadlineDate: stats.get(r.id)?.next ?? null,
    })),
    total: Number(total),
    page,
    pageSize,
  };
}

/** Totals of the filtered portfolio (summary strip). Same scope and filters as `listProcesses`. */
export async function summarizeProcesses(ctx: AuthContext, filters: ProcessFilters = {}): Promise<ProcessListSummary> {
  assertCan(ctx, "process:read");
  const f = parse(processFiltersSchema, filters);
  const p = legalProcesses;
  const [row] = await getDb()
    .select({
      count: sql<number>`count(distinct ${p.number})`.mapWith(Number),
      claimCents: sql<number>`coalesce(sum(${p.claimAmountCents}), 0)`.mapWith(Number),
      claimUnknown: sql<number>`count(*) filter (where ${p.claimAmountCents} is null)`.mapWith(Number),
      liquidatedCents: sql<number>`coalesce(sum(${p.liquidatedAmountCents}), 0)`.mapWith(Number),
      liquidatedUnknown: sql<number>`count(*) filter (where ${p.liquidatedAmountCents} is null)`.mapWith(Number),
      needsVerification: sql<number>`count(*) filter (where ${p.needsVerification})`.mapWith(Number),
    })
    .from(p)
    .where(listWhere(ctx, f));
  return {
    count: row?.count ?? 0,
    claimCents: row?.claimCents ?? 0,
    claimUnknown: row?.claimUnknown ?? 0,
    liquidatedCents: row?.liquidatedCents ?? 0,
    liquidatedUnknown: row?.liquidatedUnknown ?? 0,
    needsVerification: row?.needsVerification ?? 0,
  };
}

/** Distinct values of the visible portfolio for the filter selects. */
export async function getProcessFilterOptions(ctx: AuthContext): Promise<ProcessFilterOptions> {
  assertCan(ctx, "process:read");
  const db = getDb();
  const p = legalProcesses;
  // Every distinct value (no silent cap: a filter option missing from the list cannot be chosen).
  const distinct = async (col: AnyPgColumn): Promise<string[]> => {
    const rows = await db
      .selectDistinct({ value: col })
      .from(p)
      .where(and(processWhere(ctx), isNotNull(col), ne(col, "")))
      .orderBy(asc(col));
    return rows.map((r) => String(r.value));
  };
  const [courts, classes, cities, states] = await Promise.all([
    distinct(p.court),
    distinct(p.processClass),
    distinct(p.city),
    distinct(p.state),
  ]);
  return { courts, classes, cities, states };
}

/** Counters for the list header (over every process the user can see, ignoring filters). */
export async function getProcessSummary(ctx: AuthContext): Promise<ProcessSummary> {
  assertCan(ctx, "process:read");
  const p = legalProcesses;
  const [row] = await getDb()
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${p.status} = 'active')`.mapWith(Number),
      highRisk: sql<number>`count(*) filter (where ${p.riskLevel} in ('high', 'critical') and ${p.status} in ('active', 'suspended'))`.mapWith(
        Number,
      ),
    })
    .from(p)
    .where(processWhere(ctx));
  return { total: Number(row?.total ?? 0), active: row?.active ?? 0, highRisk: row?.highRisk ?? 0 };
}

/**
 * Valor da causa of the current instance computed on read: the link row's own value, or the record's
 * when the row has none (the record follows the official valuation; the link row is a snapshot taken
 * when it was created). Used by the detail page and the per-instance export sheet.
 */
export function currentInstanceClaimFallback(
  instance: { isCurrent: boolean; claimAmountCents: number | null },
  recordClaimCents: number | null,
): number | null {
  return instance.isCurrent && instance.claimAmountCents === null ? recordClaimCents : null;
}

function toInstanceItem(r: InstanceRow, canEdit: boolean, recordClaimCents: number | null): ProcessInstanceItem {
  return {
    id: r.id,
    instance: r.instance,
    court: r.court,
    courtDivision: r.courtDivision,
    city: r.city,
    state: r.state,
    processClass: r.processClass,
    phase: r.phase,
    phaseDetail: r.phaseDetail,
    claimAmountCents: r.claimAmountCents,
    claimFromRecordCents: currentInstanceClaimFallback(r, recordClaimCents),
    liquidatedAmountCents: r.liquidatedAmountCents,
    isCurrent: r.isCurrent,
    origin: r.origin,
    sourceSheet: r.sourceSheet,
    sourceRow: r.sourceRow,
    removable: canEdit && r.origin !== "imported",
  };
}

export async function getProcess(ctx: AuthContext, id: string): Promise<ProcessDetail> {
  assertCan(ctx, "process:read");
  const row = await loadProcess(ctx, id);
  const db = getDb();
  const org = ctx.organizationId;

  const nameOf = async (rows: Promise<{ name: string }[]>) => (await rows)[0]?.name ?? null;
  const [parties, events, instances, unitName, companyName, lawFirmName] = await Promise.all([
    db
      .select()
      .from(processParties)
      .where(and(eq(processParties.processId, row.id), eq(processParties.organizationId, org)))
      .orderBy(asc(processParties.role), asc(processParties.name)),
    // One timeline for every instance of the CNJ (RN-01): most recent first; same day, latest recorded first.
    db
      .select()
      .from(processEvents)
      .where(and(eq(processEvents.processId, row.id), eq(processEvents.organizationId, org)))
      .orderBy(desc(processEvents.occurredAt), desc(processEvents.createdAt), desc(processEvents.id)),
    db
      .select()
      .from(processInstances)
      .where(and(eq(processInstances.processId, row.id), eq(processInstances.organizationId, org))),
    row.unitId
      ? nameOf(db.select({ name: units.name }).from(units).where(and(eq(units.id, row.unitId), eq(units.organizationId, org))))
      : null,
    row.companyId
      ? nameOf(
          db
            .select({ name: companies.name })
            .from(companies)
            .where(and(eq(companies.id, row.companyId), eq(companies.organizationId, org))),
        )
      : null,
    row.lawFirmId
      ? nameOf(
          db
            .select({ name: lawFirms.name })
            .from(lawFirms)
            .where(and(eq(lawFirms.id, row.lawFirmId), eq(lawFirms.organizationId, org))),
        )
      : null,
  ]);

  const names = await userNameMap(org, [row.responsibleId, row.createdById, ...events.map((e) => e.createdById)]);
  const canEdit = can(ctx, "process:write");

  return {
    ...row,
    isCnjFormat: isCnjNumberFormat(row.number),
    cnjCheck: cnjCheck(row.number),
    responsibleName: row.responsibleId ? (names.get(row.responsibleId) ?? null) : null,
    unitName,
    companyName,
    lawFirmName,
    createdByName: row.createdById ? (names.get(row.createdById) ?? null) : null,
    parties: parties.map((pt) => ({
      id: pt.id,
      name: pt.name,
      role: pt.role,
      documentNumber: pt.documentNumber,
      isClient: pt.isClient,
      liabilityNature: pt.liabilityNature,
      counselName: pt.counselName,
      createdAt: pt.createdAt,
    })),
    events: events.map((e) => ({
      id: e.id,
      occurredAt: e.occurredAt,
      type: e.type,
      title: e.title,
      description: e.description,
      origin: e.origin,
      externalSource: e.externalSource,
      instance: e.instance,
      cnjMovementCode: e.cnjMovementCode,
      createdByName: e.createdById ? (names.get(e.createdById) ?? null) : null,
      createdAt: e.createdAt,
      removable: canEdit && e.origin === "manual",
    })),
    instances: instances
      .map((r) => toInstanceItem(r, canEdit, row.claimAmountCents))
      .sort((a, b) => instanceOrder(a.instance) - instanceOrder(b.instance)),
    permissions: {
      canEdit,
      canDelete: can(ctx, "process:delete") && !row.legalHold,
      canEditConfidential: canEdit && canEditProcessConfidentiality(ctx),
    },
  };
}

export type ProcessOption = { id: string; number: string; title: string };

/**
 * Contract: options for selects in other modules (documents, deadlines, tasks, contracts).
 * Every visible process, ordered by number: no silent cap (a process missing from a select
 * cannot be linked). For large portfolios prefer `searchProcessOptions` (search + "N de M").
 */
export async function listProcessOptions(ctx: AuthContext): Promise<ProcessOption[]> {
  assertCan(ctx, "process:read");
  return getDb()
    .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
    .from(legalProcesses)
    .where(processWhere(ctx))
    .orderBy(asc(legalProcesses.number), asc(legalProcesses.id));
}

/** Default page of `searchProcessOptions`. */
export const PROCESS_OPTIONS_LIMIT = 50;

export type ProcessOptionsPage = {
  /** Matching options (at most `limit`), plus the `includeIds` that are visible, in number order. */
  items: ProcessOption[];
  /** Visible processes matching `q` (the UI says "mostrando N de M" when `total > shown`). */
  total: number;
  /** Matching options returned (without the extra `includeIds`). */
  shown: number;
};

/**
 * Search-as-you-type options: number (with or without punctuation) or title, scoped by
 * `processWhere`. `includeIds` keeps the currently selected processes in the list even when
 * they do not match the search (only the visible ones).
 */
export async function searchProcessOptions(
  ctx: AuthContext,
  opts: { q?: string | null; includeIds?: readonly string[]; limit?: number } = {},
): Promise<ProcessOptionsPage> {
  assertCan(ctx, "process:read");
  const p = legalProcesses;
  const q = opts.q?.trim() ?? "";
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? PROCESS_OPTIONS_LIMIT)), 500);
  let match: SQL | undefined;
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    const digits = q.replace(/\D/g, "");
    match = or(
      ilike(p.number, pattern),
      ilike(p.title, pattern),
      digits.length >= 4 && /^[\d.\-\s/]+$/.test(q) ? sql`regexp_replace(${p.number}, '[^0-9]', '', 'g') like ${`%${digits}%`}` : undefined,
    );
  }
  const where = and(processWhere(ctx), match);
  const db = getDb();
  const include = [...new Set(opts.includeIds ?? [])].filter(isUuid);
  const [rows, [totalRow], extra] = await Promise.all([
    db
      .select({ id: p.id, number: p.number, title: p.title })
      .from(p)
      .where(where)
      .orderBy(asc(p.number), asc(p.id))
      .limit(limit),
    db.select({ n: count() }).from(p).where(where),
    include.length > 0
      ? db
          .select({ id: p.id, number: p.number, title: p.title })
          .from(p)
          .where(and(processWhere(ctx), inArray(p.id, include)))
      : Promise.resolve([] as ProcessOption[]),
  ]);
  const seen = new Set(rows.map((r) => r.id));
  const items = [...rows, ...extra.filter((r) => !seen.has(r.id))].sort(
    (a, b) => a.number.localeCompare(b.number) || a.id.localeCompare(b.id),
  );
  return { items, total: Number(totalRow?.n ?? 0), shown: rows.length };
}

/**
 * Data to pre-fill "Novo processo" from a preventive occurrence
 * (`/processos/novo?ocorrencia=<id>`). Returns null when the occurrence does
 * not exist or is not visible (never reveals existence).
 */
export async function getOccurrencePrefill(ctx: AuthContext, occurrenceId: string): Promise<OccurrencePrefill | null> {
  assertCan(ctx, "process:write");
  if (!can(ctx, "occurrence:read") || !isUuid(occurrenceId)) return null;
  const [o] = await getDb()
    .select({
      id: occurrences.id,
      title: occurrences.title,
      facts: occurrences.facts,
      category: occurrences.category,
      unitId: occurrences.unitId,
      responsibleId: occurrences.responsibleId,
      riskLevel: occurrences.riskLevel,
      riskRationale: occurrences.riskRationale,
      isConfidential: occurrences.isConfidential,
      linkedProcessId: occurrences.linkedProcessId,
    })
    .from(occurrences)
    .where(and(eq(occurrences.id, occurrenceId), occurrenceWhere(ctx)))
    .limit(1);
  if (!o) return null;
  return {
    occurrenceId: o.id,
    title: o.title,
    area: areaFromOccurrenceCategory(o.category),
    unitId: o.unitId,
    responsibleId: o.responsibleId,
    riskLevel: o.riskLevel,
    riskRationale: o.riskRationale,
    description: o.facts,
    isConfidential: o.isConfidential,
    alreadyLinkedProcessId: o.linkedProcessId,
  };
}

// ---------------------------------------------------------------------------
// Confidential access log (TE-10)
// ---------------------------------------------------------------------------

export const CONFIDENTIAL_VIEW_ACTION = "legal_process.view_confidential";
const CONFIDENTIAL_VIEW_WINDOW_MS = 60 * 60 * 1000;

/**
 * Records that the current user opened a confidential process (at most one
 * entry per user per process per hour). Returns true when an entry was
 * written. Call it from the pages that show the process data.
 */
export async function recordConfidentialProcessView(ctx: AuthContext, processId: string): Promise<boolean> {
  assertCan(ctx, "process:read");
  if (ctx.kind !== "user" || !ctx.userId) return false;
  const userId = ctx.userId;
  const process = await loadProcess(ctx, processId);
  if (!process.isConfidential) return false;

  // entity_type + entity_id lets the lookup use audit_entity_idx.
  const recentView = (db: DbOrTx) =>
    db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, ctx.organizationId),
          eq(auditLogs.entityType, "legal_process"),
          eq(auditLogs.entityId, process.id),
          eq(auditLogs.actorId, userId),
          eq(auditLogs.action, CONFIDENTIAL_VIEW_ACTION),
          gte(auditLogs.createdAt, new Date(Date.now() - CONFIDENTIAL_VIEW_WINDOW_MS)),
        ),
      )
      .limit(1);
  // Most renders find a recent entry: answer without opening a transaction or taking the lock.
  if ((await recentView(getDb())).length > 0) return false;

  return getDb().transaction(async (tx) => {
    // Serializes concurrent views of the same process by the same user.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`process-view:${userId}:${process.id}`}))`);
    const [recent] = await recentView(tx);
    if (recent) return false;
    await recordAudit(
      ctx,
      {
        action: CONFIDENTIAL_VIEW_ACTION,
        entityType: "legal_process",
        entityId: process.id,
        summary: `Consulta ao processo sigiloso ${process.number}.`,
        metadata: { role: ctx.role },
      },
      tx,
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// Downloads of sensitive documents (P2.12)
// ---------------------------------------------------------------------------

/** Rows shown on the process page; the total is always reported. */
export const SENSITIVE_DOWNLOAD_LOG_LIMIT = 20;

export type SensitiveDownloadItem = {
  id: string;
  documentId: string;
  documentTitle: string;
  category: DocumentCategory;
  confidentiality: ConfidentialityLevel;
  versionNumber: number | null;
  /** Who downloaded (null = the user no longer exists). */
  actorName: string | null;
  at: Date;
};

export type SensitiveDownloadLog = {
  /** Sensitive documents of the process the viewer can see (0 = nothing to show). */
  sensitiveDocuments: number;
  total: number;
  items: SensitiveDownloadItem[];
};

/**
 * Who downloaded the SENSITIVE documents of a process and when: health documents
 * (`sensitive_health`) and documents classified `confidential` or `restricted`.
 * Reads the `document.download` audit entries, restricted to the documents the viewer
 * can see (`documentWhere`) of a process the viewer can see (`processWhere`); the audit
 * summary (which carries the title as typed at download time) is never returned.
 */
export async function listSensitiveDocumentDownloads(
  ctx: AuthContext,
  processId: string,
  opts: { limit?: number } = {},
): Promise<SensitiveDownloadLog> {
  assertCan(ctx, "process:read");
  assertCan(ctx, "document:read");
  const process = await loadProcess(ctx, processId);
  const d = documents;
  const docScope = and(
    eq(d.processId, process.id),
    documentWhere(ctx),
    or(eq(d.category, "sensitive_health"), inArray(d.confidentiality, ["confidential", "restricted"])),
  );
  const db = getDb();
  const [docs] = await db.select({ n: count() }).from(d).where(docScope);
  const sensitiveDocuments = Number(docs?.n ?? 0);
  if (sensitiveDocuments === 0) return { sensitiveDocuments, total: 0, items: [] };

  const where = and(
    eq(auditLogs.organizationId, ctx.organizationId),
    eq(auditLogs.entityType, "document"),
    eq(auditLogs.action, "document.download"),
    docScope,
  );
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? SENSITIVE_DOWNLOAD_LOG_LIMIT)), 200);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        documentId: d.id,
        documentTitle: d.title,
        category: d.category,
        confidentiality: d.confidentiality,
        versionNumber: sql<number | null>`(${auditLogs.metadata} ->> 'versionNumber')::int`,
        actorName: users.name,
        at: auditLogs.createdAt,
      })
      .from(auditLogs)
      .innerJoin(d, eq(d.id, auditLogs.entityId))
      .leftJoin(users, and(eq(users.id, auditLogs.actorId), eq(users.organizationId, ctx.organizationId)))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit),
    db.select({ n: count() }).from(auditLogs).innerJoin(d, eq(d.id, auditLogs.entityId)).where(where),
  ]);
  return {
    sensitiveDocuments,
    total: Number(totalRow?.n ?? 0),
    items: rows.map((r) => ({ ...r, actorName: r.actorName ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Value history: valor da causa (RF-09)
// ---------------------------------------------------------------------------

/**
 * True when `ctx` is an identified person whose ROLE may make values official
 * (`contingency:approve`, RN-11). The delegated intake context (`kind: "system"`
 * with the analyst's user id, see intake/service `processContext`) is judged by
 * the person's role, never by the system bypass of `can`.
 */
export function canMakeClaimOfficial(ctx: AuthContext): boolean {
  return ctx.userId !== null && can({ kind: "user", role: ctx.role }, "contingency:approve");
}

/** Message of a removal attempted by someone who cannot make values official. */
export const CLAIM_REMOVAL_NEEDS_APPROVER =
  "A remoção do valor da causa precisa ser feita por quem confere valores (gestão jurídica, contabilidade ou administração).";

/** Message of a change of the valor da causa by a context without an identified person. */
export const CLAIM_CHANGE_NEEDS_PERSON =
  "O valor da causa só pode ser alterado por uma pessoa identificada, pela tela do processo ou pela conferência de valores.";

/**
 * True when the valor da causa informed by `ctx` goes to the review queue instead of the
 * record: an identified person whose role cannot make values official.
 */
function claimGoesToReview(ctx: AuthContext): boolean {
  return ctx.userId !== null && !canMakeClaimOfficial(ctx);
}

export type ClaimValuationResult = {
  valuationId: string | null;
  /** `official` (approver), `proposed` (review queue) or null (nothing recorded). */
  status: "official" | "proposed" | null;
  /** True when an identical pending proposal already existed (nothing new was inserted). */
  reusedProposal: boolean;
  supersededIds: string[];
  /** Mirror fields changed by `syncProcessMirrors` (approvers only). */
  mirrors: MirrorChanges;
};

/** Source of a valor da causa recorded from the process form or the intake. */
export type ClaimValuationSource = "manual" | "simulation";

/** Reason of the claim valuation recorded when a process is created. */
const CREATE_CLAIM_REASON: Record<ClaimValuationSource, string> = {
  manual: "Valor da causa informado no cadastro do processo.",
  simulation: "Valor da causa simulado (demonstração) na entrada do processo. Não é um valor real.",
};

const NO_CLAIM_VALUATION: ClaimValuationResult = {
  valuationId: null,
  status: null,
  reusedProposal: false,
  supersededIds: [],
  mirrors: null,
};

/**
 * Value history of the valor da causa (RF-09), inside the caller's transaction.
 *
 * - Approver (`canMakeClaimOfficial`): appends an OFFICIAL `claim` valuation (source
 *   manual, reviewed by the person), supersedes the previous official claims and runs
 *   `syncProcessMirrors` (provision, risk and liquidated mirrors follow the new value).
 *   With `amountCents = null` (valor da causa removed) only the supersession happens and
 *   the superseded rows get `cleared_on = today` (the value stops counting from today on).
 * - Anyone else: appends a PROPOSED claim valuation for the review queue (no reviewer, no
 *   supersession, mirrors untouched). An identical pending proposal (same source) is reused. A
 *   removal cannot be proposed (callers refuse it before, see `CLAIM_REMOVAL_NEEDS_APPROVER`).
 *   Callers keep the proposed amount OFF the record (`claimAmountCents`), so it never
 *   counts before the approval nor after a rejection.
 * - Contexts without a person (imports, inbound API) record nothing here (`createProcess`
 *   keeps the informed value on the record; `updateProcess` refuses a change).
 * - `source` is `manual` for a value typed by the person and `simulation` for a value the
 *   intake demonstration generated (`createProcess` option `claimSource`): the queue, the band
 *   and BI then label it "Extração simulada (demonstração)" and bulk approval refuses it.
 */
async function recordClaimValuation(
  ctx: AuthContext,
  tx: DbOrTx,
  process: { id: string; instance: ProcessInstance | null },
  amountCents: number | null,
  reason: string,
  source: ClaimValuationSource = "manual",
): Promise<ClaimValuationResult> {
  if (!ctx.userId) return NO_CLAIM_VALUATION;
  const userId = ctx.userId;
  const v = processValuations;
  const claimsOfProcess = and(eq(v.organizationId, ctx.organizationId), eq(v.processId, process.id), eq(v.kind, "claim"));

  if (!canMakeClaimOfficial(ctx)) {
    if (amountCents === null) return NO_CLAIM_VALUATION;
    const [pending] = await tx
      .select({ id: v.id })
      .from(v)
      .where(and(claimsOfProcess, eq(v.status, "proposed"), eq(v.source, source), eq(v.amountCents, amountCents)))
      .limit(1);
    if (pending) return { ...NO_CLAIM_VALUATION, valuationId: pending.id, status: "proposed", reusedProposal: true };
    const [row] = await tx
      .insert(v)
      .values({
        organizationId: ctx.organizationId,
        processId: process.id,
        kind: "claim",
        amountCents,
        baseDate: todayISO(),
        instance: process.instance,
        source,
        status: "proposed",
        isEstimate: false,
        reason,
        createdById: userId,
      })
      .returning({ id: v.id });
    return { ...NO_CLAIM_VALUATION, valuationId: row.id, status: "proposed" };
  }

  const previous = await tx
    .select({ id: v.id })
    .from(v)
    .where(and(claimsOfProcess, eq(v.status, "official")))
    .orderBy(desc(v.createdAt));
  const supersededIds = previous.map((r) => r.id);
  if (supersededIds.length > 0) {
    await tx
      .update(v)
      // A removal has no successor: the date tells positions from when the value no longer counts.
      .set(amountCents === null ? { status: "superseded", clearedOn: todayISO() } : { status: "superseded" })
      .where(and(eq(v.organizationId, ctx.organizationId), inArray(v.id, supersededIds)));
  }
  let valuationId: string | null = null;
  if (amountCents !== null) {
    const [row] = await tx
      .insert(v)
      .values({
        organizationId: ctx.organizationId,
        processId: process.id,
        kind: "claim",
        amountCents,
        baseDate: todayISO(),
        instance: process.instance,
        source,
        status: "official",
        isEstimate: false,
        reason,
        supersedesId: supersededIds[0] ?? null,
        createdById: userId,
        reviewedById: userId,
        reviewedAt: new Date(),
      })
      .returning({ id: v.id });
    valuationId = row.id;
  }
  const mirrors = await syncProcessMirrors(ctx.organizationId, process.id, tx);
  return {
    valuationId,
    status: valuationId ? "official" : null,
    reusedProposal: false,
    supersededIds,
    mirrors,
  };
}

/** Audit diff + the mirror fields `syncProcessMirrors` changed in the same transaction. */
function withMirrorChanges(
  changes: Record<string, { from: unknown; to: unknown }> | null,
  mirrors: MirrorChanges,
): Record<string, { from: unknown; to: unknown }> | null {
  if (!mirrors) return changes;
  const out = { ...(changes ?? {}) };
  for (const [key, change] of Object.entries(mirrors)) {
    out[key] = out[key] ? { from: out[key].from, to: change.to } : change;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Process mutations
// ---------------------------------------------------------------------------

/** Server-only options of `createProcess` (never read from a form). */
export type CreateProcessOptions = {
  /**
   * Origin of the informed valor da causa: `simulation` when the intake demonstration generated it
   * (the valuation is labeled as simulated); `manual` (default) when a person typed it.
   */
  claimSource?: ClaimValuationSource;
};

export async function createProcess(
  ctx: AuthContext,
  input: CreateProcessInput,
  options: CreateProcessOptions = {},
): Promise<{ id: string; occurrenceLinkError: string | null; claimValuationStatus: ClaimValuationResult["status"] }> {
  assertCan(ctx, "process:write");
  const v = parse(createProcessSchema, input);
  const number = normalizeProcessNumber(v.number);

  await assertNumberAvailable(ctx, number);
  if (v.unitId) await assertUnitOfOrganization(ctx, v.unitId);
  if (v.responsibleId) await assertActiveUserOfOrganization(ctx, v.responsibleId);
  if (v.companyId) await assertCompanyInOrg(ctx, v.companyId);
  const lawFirmId = lawFirmForCreate(ctx, v.lawFirmId);
  if (lawFirmId) await assertLawFirmInOrg(ctx, lawFirmId);
  const origin = v.fromOccurrenceId ? await loadVisibleOccurrence(ctx, v.fromOccurrenceId) : null;

  // A process created from a confidential occurrence carries the same facts:
  // it stays confidential unless an admin / legal manager decides otherwise.
  const isConfidential = canEditProcessConfidentiality(ctx)
    ? (v.isConfidential ?? origin?.isConfidential ?? false)
    : (origin?.isConfidential ?? false);

  const status = v.status ?? "active";
  const informedClaimCents = v.claimAmountCents ?? null;
  const claimSource: ClaimValuationSource = options.claimSource ?? "manual";
  const claimLabel = claimSource === "simulation" ? "Valor da causa simulado (demonstração)" : "Valor da causa";
  // A non-approver's valor da causa is only a proposal: the record (and the instance row)
  // stays "não informado" until the review queue approves it, so it never enters a total.
  const proposedClaimCents = informedClaimCents !== null && claimGoesToReview(ctx) ? informedClaimCents : null;
  const values = {
    organizationId: ctx.organizationId,
    number,
    title: v.title,
    court: v.court,
    courtDivision: v.courtDivision ?? null,
    jurisdiction: v.jurisdiction ?? null,
    area: v.area,
    phase: v.phase,
    status,
    filedAt: v.filedAt ?? null,
    closedAt: v.closedAt ?? null,
    unitId: v.unitId ?? null,
    responsibleId: v.responsibleId ?? null,
    claimAmountCents: proposedClaimCents !== null ? null : informedClaimCents,
    riskLevel: v.riskLevel ?? "medium",
    riskRationale: v.riskRationale ?? null,
    description: v.description ?? null,
    isConfidential,
    companyId: v.companyId ?? null,
    lawFirmId,
    instance: v.instance ?? null,
    processClass: v.processClass ?? null,
    city: v.city ?? null,
    state: v.state ?? null,
    phaseDetail: v.phaseDetail ?? null,
    closureReason: isInActivePortfolio(status) ? null : (v.closureReason ?? null),
    needsVerification: v.needsVerification ?? false,
    verificationNote: v.verificationNote ?? null,
    lastMovementAt: v.lastMovementAt ?? null,
    dataOrigin: "manual" as const,
    createdById: ctx.userId,
  } satisfies typeof legalProcesses.$inferInsert;

  let created: ProcessRow;
  let claimStatus: ClaimValuationResult["status"] = null;
  try {
    created = await getDb().transaction(async (tx) => {
      const [row] = await tx.insert(legalProcesses).values(values).returning();
      // RN-01: the current instance is also a link row (one per grau).
      if (row.instance) {
        await tx.insert(processInstances).values({
          organizationId: ctx.organizationId,
          processId: row.id,
          instance: row.instance,
          court: row.court,
          courtDivision: row.courtDivision,
          city: row.city,
          state: row.state,
          processClass: row.processClass,
          phase: row.phase,
          phaseDetail: row.phaseDetail,
          claimAmountCents: row.claimAmountCents,
          isCurrent: true,
          origin: "manual",
        });
      }
      // An approver's valor da causa becomes an OFFICIAL valuation (mirrors synced); anyone
      // else's becomes a proposal in the review queue and the record stays without it.
      const claim =
        informedClaimCents !== null
          ? await recordClaimValuation(ctx, tx, row, informedClaimCents, CREATE_CLAIM_REASON[claimSource], claimSource)
          : null;
      const proposed = claim?.status === "proposed" && claim.valuationId ? claim.valuationId : null;
      await recordAudit(
        ctx,
        {
          action: "legal_process.create",
          entityType: "legal_process",
          entityId: row.id,
          summary: proposed
            ? `Processo ${row.number} cadastrado. ${claimLabel} de ${formatMoneyCents(informedClaimCents)} enviado para conferência.`
            : `Processo ${row.number} cadastrado.`,
          changes: withMirrorChanges(diffChanges(null, row, AUDIT_FIELDS), claim?.mirrors ?? null),
          metadata: {
            ...(v.fromOccurrenceId ? { fromOccurrenceId: v.fromOccurrenceId } : {}),
            ...(claim?.valuationId ? { claimValuationId: claim.valuationId, claimValuationStatus: claim.status } : {}),
          },
        },
        tx,
      );
      if (proposed) {
        // Same audit shape as contingency `proposeValuation` and the update below.
        await recordAudit(
          ctx,
          {
            action: "valuation.propose",
            entityType: "legal_process",
            entityId: row.id,
            summary: `${claimLabel} de ${formatMoneyCents(informedClaimCents)} proposto para conferência no processo ${row.number}.`,
            metadata: { valuationId: proposed, source: claimSource, fromProcessForm: true },
          },
          tx,
        );
      }
      claimStatus = claim?.status ?? null;
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(DUPLICATE_NUMBER_MESSAGE);
    throw err;
  }

  let occurrenceLinkError: string | null = null;
  if (v.fromOccurrenceId) {
    try {
      await linkOccurrenceToProcess(ctx, v.fromOccurrenceId, created.id);
    } catch (err) {
      occurrenceLinkError =
        err instanceof AppError ? err.message : "Não foi possível vincular a ocorrência ao processo.";
      logger.warn("process_occurrence_link_failed", {
        processId: created.id,
        occurrenceId: v.fromOccurrenceId,
        error: err,
      });
    }
  }

  return { id: created.id, occurrenceLinkError, claimValuationStatus: claimStatus };
}

/** Fields a regular update may assign (mirrors maintained by the contingency module are excluded). */
const ASSIGNABLE_FIELDS = AUDIT_FIELDS.filter((k) => k !== "isConfidential");

export type UpdateProcessResult = {
  /** Valuation recorded for a changed valor da causa (official for approvers, proposed otherwise). */
  claimValuation: { id: string; status: "official" | "proposed" } | null;
};

/**
 * Partial update. Imported processes stay `dataOrigin: "imported"`; the audit
 * entry records that the change was made manually. Leaving the active
 * portfolio requires a closure reason (RN-12); returning to it clears the reason.
 *
 * Valor da causa: an approver's change is official at once (mirrors synced in the
 * same transaction); anyone else's change becomes a PROPOSED claim valuation and the
 * record keeps the current value until the review queue approves it (a removal needs
 * an approver: `CLAIM_REMOVAL_NEEDS_APPROVER`). A context without a person cannot change
 * it (`CLAIM_CHANGE_NEEDS_PERSON`), so the mirrors are always synced with the record.
 */
export async function updateProcess(ctx: AuthContext, id: string, input: UpdateProcessInput): Promise<UpdateProcessResult> {
  assertCan(ctx, "process:write");
  const v = parse(updateProcessSchema, input);
  const before = await loadProcess(ctx, id);

  const patch: Partial<typeof legalProcesses.$inferInsert> = {};
  for (const key of ASSIGNABLE_FIELDS) {
    const value = v[key];
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  if (v.isConfidential !== undefined && canEditProcessConfidentiality(ctx)) {
    patch.isConfidential = v.isConfidential;
  }
  if (patch.number !== undefined) patch.number = normalizeProcessNumber(patch.number);

  if (patch.lawFirmId !== undefined && patch.lawFirmId !== before.lawFirmId && !canChangeProcessLawFirm(ctx)) {
    throw fieldError("lawFirmId", "Escritórios externos não podem alterar o escritório que patrocina o processo.");
  }

  // RN-12: active portfolio <-> closure reason.
  const nextStatus = patch.status ?? before.status;
  if (patch.status !== undefined && patch.status !== before.status) {
    if (isInActivePortfolio(nextStatus)) {
      if (!isInActivePortfolio(before.status)) {
        patch.closureReason = null;
        if (patch.closedAt === undefined) patch.closedAt = null;
      }
    } else {
      const reason = patch.closureReason !== undefined ? patch.closureReason : before.closureReason;
      if (!reason) throw fieldError("closureReason", "Informe o motivo da saída da carteira ativa.");
      if (patch.closedAt === undefined && !before.closedAt) patch.closedAt = todayISO();
    }
  } else if (patch.closureReason && isInActivePortfolio(nextStatus)) {
    throw fieldError("closureReason", "O motivo de saída só se aplica a processos fora da carteira ativa.");
  } else if (patch.closureReason === null && before.closureReason && !isInActivePortfolio(nextStatus)) {
    throw fieldError("closureReason", "Informe o motivo da saída da carteira ativa.");
  }

  const filedAt = patch.filedAt !== undefined ? patch.filedAt : before.filedAt;
  const closedAt = patch.closedAt !== undefined ? patch.closedAt : before.closedAt;
  if (filedAt && closedAt && closedAt < filedAt) {
    throw fieldError("closedAt", "A data de encerramento não pode ser anterior à distribuição.");
  }
  const lastMovementAt = patch.lastMovementAt !== undefined ? patch.lastMovementAt : before.lastMovementAt;
  if (filedAt && lastMovementAt && lastMovementAt < filedAt) {
    throw fieldError("lastMovementAt", "A última movimentação não pode ser anterior à distribuição.");
  }
  if (patch.number !== undefined && patch.number !== before.number) {
    await assertNumberAvailable(ctx, patch.number, before.id);
  }
  if (patch.unitId && patch.unitId !== before.unitId) await assertUnitOfOrganization(ctx, patch.unitId);
  if (patch.responsibleId && patch.responsibleId !== before.responsibleId) {
    await assertActiveUserOfOrganization(ctx, patch.responsibleId);
  }
  if (patch.companyId && patch.companyId !== before.companyId) await assertCompanyInOrg(ctx, patch.companyId);
  if (patch.lawFirmId && patch.lawFirmId !== before.lawFirmId) await assertLawFirmInOrg(ctx, patch.lawFirmId);

  // Valor da causa: only an approver changes the record (official valuation + mirrors in the
  // transaction below). Another person's change becomes a proposal and the record keeps the
  // current value until it is approved; a context without a person cannot change it at all.
  let proposedClaimCents: number | null = null;
  if (patch.claimAmountCents !== undefined && patch.claimAmountCents !== before.claimAmountCents) {
    if (!ctx.userId) throw fieldError("claimAmountCents", CLAIM_CHANGE_NEEDS_PERSON);
    if (claimGoesToReview(ctx)) {
      if (patch.claimAmountCents === null) throw fieldError("claimAmountCents", CLAIM_REMOVAL_NEEDS_APPROVER);
      proposedClaimCents = patch.claimAmountCents;
      delete patch.claimAmountCents;
    }
  }

  const after = { ...before, ...patch } as ProcessRow;
  const changes = diffChanges(before, after, AUDIT_FIELDS);
  if (!changes && proposedClaimCents === null) return { claimValuation: null };
  const changed = changes ? Object.keys(changes) : [];
  const imported = before.dataOrigin === "imported";
  let claimValuation: UpdateProcessResult["claimValuation"] = null;

  try {
    await getDb().transaction(async (tx) => {
      if (proposedClaimCents !== null) {
        const proposal = await recordClaimValuation(
          ctx,
          tx,
          after,
          proposedClaimCents,
          "Valor da causa alterado no cadastro do processo.",
        );
        if (proposal.valuationId) claimValuation = { id: proposal.valuationId, status: "proposed" };
        if (proposal.valuationId && !proposal.reusedProposal) {
          // Same audit shape as contingency `proposeValuation` (shows in the process "Histórico").
          await recordAudit(
            ctx,
            {
              action: "valuation.propose",
              entityType: "legal_process",
              entityId: before.id,
              summary: `Valor da causa de ${formatMoneyCents(proposedClaimCents)} proposto para conferência no processo ${before.number}.`,
              metadata: { valuationId: proposal.valuationId, source: "manual", fromProcessForm: true },
            },
            tx,
          );
        }
      }
      if (!changes) return;

      const updated = await tx
        .update(legalProcesses)
        .set(patch)
        .where(and(eq(legalProcesses.id, before.id), processWhere(ctx)))
        .returning({ id: legalProcesses.id });
      if (updated.length === 0) throw new NotFoundError(NOT_FOUND_MESSAGE);

      let createdInstanceId: string | null = null;
      if (changes.instance) {
        if (after.instance) {
          // RN-01: the new current instance also becomes a link row when it does not exist yet.
          const [existing] = await tx
            .select({ id: processInstances.id })
            .from(processInstances)
            .where(and(eq(processInstances.processId, before.id), eq(processInstances.instance, after.instance)))
            .limit(1);
          if (!existing) {
            const [created] = await tx
              .insert(processInstances)
              .values({
                organizationId: ctx.organizationId,
                processId: before.id,
                instance: after.instance,
                court: after.court,
                courtDivision: after.courtDivision,
                city: after.city,
                state: after.state,
                processClass: after.processClass,
                phase: after.phase,
                phaseDetail: after.phaseDetail,
                claimAmountCents: after.claimAmountCents,
                isCurrent: true,
                origin: "manual",
              })
              .returning({ id: processInstances.id });
            createdInstanceId = created.id;
          }
        }
        await tx
          .update(processInstances)
          .set({ isCurrent: after.instance ? sql`${processInstances.instance} = ${after.instance}` : false })
          .where(and(eq(processInstances.processId, before.id), eq(processInstances.organizationId, ctx.organizationId)));
      }

      // A claim change reaches here only for an approver: official valuation + mirrors synced.
      const claim = changes.claimAmountCents
        ? await recordClaimValuation(
            ctx,
            tx,
            after,
            after.claimAmountCents,
            after.claimAmountCents === null
              ? "Valor da causa removido do cadastro do processo."
              : "Valor da causa alterado no cadastro do processo.",
          )
        : null;
      if (claim?.valuationId && claim.status) claimValuation = { id: claim.valuationId, status: claim.status };

      await recordAudit(
        ctx,
        {
          action: "legal_process.update",
          entityType: "legal_process",
          entityId: before.id,
          summary: imported
            ? `Processo ${before.number} (importado) alterado manualmente: ${fieldList(changed)}.`
            : `Processo ${before.number} alterado: ${fieldList(changed)}.`,
          changes: withMirrorChanges(changes, claim?.mirrors ?? null),
          metadata: {
            dataOrigin: before.dataOrigin,
            manualChange: true,
            ...(claim?.valuationId ? { claimValuationId: claim.valuationId } : {}),
            ...(claim && claim.supersededIds.length > 0 ? { supersededValuationIds: claim.supersededIds } : {}),
            ...(claimValuation?.status === "proposed" ? { proposedClaimValuationId: claimValuation.id } : {}),
            ...(createdInstanceId ? { createdInstanceId } : {}),
          },
        },
        tx,
      );

      const relevant = changed.filter((k) => STALE_FIELDS.has(k));
      if (relevant.length > 0) {
        await markAnalysesStaleForEntity(
          {
            organizationId: ctx.organizationId,
            entityId: before.id,
            reason: `Dados do processo alterados: ${fieldList(relevant)}`,
          },
          tx,
        );
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(DUPLICATE_NUMBER_MESSAGE);
    throw err;
  }
  return { claimValuation };
}

/** Soft delete. Blocked while the process is under legal hold. */
export async function deleteProcess(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "process:delete");
  const before = await loadProcess(ctx, id);
  if (before.legalHold) {
    throw new ConflictError("Este processo está sob retenção legal (legal hold) e não pode ser excluído.");
  }
  await getDb().transaction(async (tx) => {
    const deleted = await tx
      .update(legalProcesses)
      .set({ deletedAt: new Date() })
      .where(and(eq(legalProcesses.id, before.id), processWhere(ctx)))
      .returning({ id: legalProcesses.id });
    if (deleted.length === 0) throw new NotFoundError(NOT_FOUND_MESSAGE);
    await recordAudit(
      ctx,
      {
        action: "legal_process.delete",
        entityType: "legal_process",
        entityId: before.id,
        summary: `Processo ${before.number} excluído.`,
        metadata: { dataOrigin: before.dataOrigin },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Active portfolio lifecycle (RN-12 / RF-06) and verification flag
// ---------------------------------------------------------------------------

async function applyLifecyclePatch(
  ctx: AuthContext,
  before: ProcessRow,
  patch: Partial<typeof legalProcesses.$inferInsert>,
  audit: { action: string; summary: string; metadata?: Record<string, unknown> },
  staleReason: string | null,
): Promise<void> {
  const fields = Object.keys(patch);
  const changes = diffChanges(before, { ...before, ...patch }, fields);
  await getDb().transaction(async (tx) => {
    const updated = await tx
      .update(legalProcesses)
      .set(patch)
      .where(and(eq(legalProcesses.id, before.id), processWhere(ctx)))
      .returning({ id: legalProcesses.id });
    if (updated.length === 0) throw new NotFoundError(NOT_FOUND_MESSAGE);
    await recordAudit(
      ctx,
      {
        action: audit.action,
        entityType: "legal_process",
        entityId: before.id,
        summary: audit.summary,
        changes,
        metadata: audit.metadata,
      },
      tx,
    );
    if (staleReason) {
      await markAnalysesStaleForEntity(
        { organizationId: ctx.organizationId, entityId: before.id, reason: staleReason },
        tx,
      );
    }
  });
}

/**
 * "Retirar da carteira ativa": status `closed` + closure reason + date. With
 * `lost_patronage` the process left the portfolio because the patronage was
 * lost (saída do acervo); history, values and documents are kept (RN-12).
 */
export async function closeProcess(ctx: AuthContext, id: string, input: CloseProcessInput): Promise<void> {
  assertCan(ctx, "process:write");
  const v = parse(closeProcessSchema, input);
  const before = await loadProcess(ctx, id);
  if (!isInActivePortfolio(before.status)) throw new ConflictError("O processo já está fora da carteira ativa.");
  const today = todayISO();
  const closedAt = v.closedAt ?? today;
  if (closedAt > today) throw fieldError("closedAt", "A data de saída não pode ser futura.");
  if (before.filedAt && closedAt < before.filedAt) {
    throw fieldError("closedAt", "A data de saída não pode ser anterior à distribuição.");
  }
  const reasonLabel = CLOSURE_REASON_LABELS[v.closureReason];
  await applyLifecyclePatch(
    ctx,
    before,
    { status: "closed", closureReason: v.closureReason, closedAt },
    {
      action: "legal_process.close",
      summary: `Processo ${before.number} retirado da carteira ativa. Motivo: ${reasonLabel}.${
        v.note ? ` Observação: ${v.note}` : ""
      }`,
      metadata: { closureReason: v.closureReason, previousStatus: before.status },
    },
    `Processo retirado da carteira ativa (${reasonLabel})`,
  );
}

/** "Reativar": back to the active portfolio (status active); the closure reason and date are cleared. */
export async function reactivateProcess(ctx: AuthContext, id: string, input: ReactivateProcessInput = {}): Promise<void> {
  assertCan(ctx, "process:write");
  const v = parse(reactivateProcessSchema, input);
  const before = await loadProcess(ctx, id);
  if (isInActivePortfolio(before.status)) throw new ConflictError("O processo já está na carteira ativa.");
  await applyLifecyclePatch(
    ctx,
    before,
    { status: "active", closureReason: null, closedAt: null },
    {
      action: "legal_process.reactivate",
      summary: `Processo ${before.number} reativado na carteira ativa.${v.note ? ` Observação: ${v.note}` : ""}`,
      metadata: {
        previousStatus: before.status,
        ...(before.closureReason ? { previousClosureReason: before.closureReason } : {}),
      },
    },
    "Processo reativado na carteira ativa",
  );
}

/** "Marcar para conferência": flags the process with a note of what must be checked. */
export async function flagProcessForVerification(
  ctx: AuthContext,
  id: string,
  input: FlagVerificationInput,
): Promise<void> {
  assertCan(ctx, "process:write");
  const v = parse(flagVerificationSchema, input);
  const before = await loadProcess(ctx, id);
  if (before.needsVerification && before.verificationNote === v.note) return;
  await applyLifecyclePatch(
    ctx,
    before,
    { needsVerification: true, verificationNote: v.note },
    {
      action: "legal_process.verification_flag",
      summary: `Processo ${before.number} marcado para conferência.`,
    },
    null,
  );
}

/** "Concluir conferência": clears the flag; the conclusion note goes to the history. */
export async function resolveProcessVerification(
  ctx: AuthContext,
  id: string,
  input: ResolveVerificationInput = {},
): Promise<void> {
  assertCan(ctx, "process:write");
  const v = parse(resolveVerificationSchema, input);
  const before = await loadProcess(ctx, id);
  if (!before.needsVerification) throw new ConflictError("O processo não está marcado para conferência.");
  await applyLifecyclePatch(
    ctx,
    before,
    { needsVerification: false, verificationNote: null },
    {
      action: "legal_process.verification_resolve",
      summary: `Conferência do processo ${before.number} concluída.${v.note ? ` Conclusão: ${v.note}` : ""}`,
    },
    null,
  );
}

// ---------------------------------------------------------------------------
// Instances (vínculos de instância, RN-01/RN-09)
// ---------------------------------------------------------------------------

async function loadInstance(ctx: AuthContext, instanceId: string, db: DbOrTx = getDb()) {
  if (!isUuid(instanceId)) throw new NotFoundError(INSTANCE_NOT_FOUND);
  const [row] = await db
    .select({ instance: processInstances, process: legalProcesses })
    .from(processInstances)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processInstances.processId))
    .where(
      and(
        eq(processInstances.id, instanceId),
        eq(processInstances.organizationId, ctx.organizationId),
        processWhere(ctx),
      ),
    );
  if (!row) throw new NotFoundError(INSTANCE_NOT_FOUND);
  return row;
}

function duplicateInstance(instance: ProcessInstance): ConflictError {
  return new ConflictError(
    `Este processo já tem um vínculo com o ${PROCESS_INSTANCE_LABELS[instance]}. Edite o vínculo existente.`,
  );
}

/** Makes `instance` the current one: flags on the link rows + `legal_processes.instance`. */
async function setCurrentInstance(ctx: AuthContext, tx: DbOrTx, processId: string, instance: ProcessInstance) {
  await tx
    .update(processInstances)
    .set({ isCurrent: sql`${processInstances.instance} = ${instance}` })
    .where(and(eq(processInstances.processId, processId), eq(processInstances.organizationId, ctx.organizationId)));
  await tx
    .update(legalProcesses)
    .set({ instance })
    .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, ctx.organizationId)));
}

export async function addProcessInstance(
  ctx: AuthContext,
  processId: string,
  input: ProcessInstanceInput,
): Promise<{ id: string }> {
  assertCan(ctx, "process:write");
  const v = parse(processInstanceInputSchema, input);
  const process = await loadProcess(ctx, processId);
  const [existing] = await getDb()
    .select({ id: processInstances.id })
    .from(processInstances)
    .where(and(eq(processInstances.processId, process.id), eq(processInstances.instance, v.instance)))
    .limit(1);
  if (existing) throw duplicateInstance(v.instance);
  const isCurrent = v.isCurrent ?? process.instance === v.instance;

  try {
    return await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(processInstances)
        .values({
          organizationId: ctx.organizationId,
          processId: process.id,
          instance: v.instance,
          court: v.court,
          courtDivision: v.courtDivision ?? null,
          city: v.city ?? null,
          state: v.state ?? null,
          processClass: v.processClass ?? null,
          phase: v.phase ?? null,
          phaseDetail: v.phaseDetail ?? null,
          claimAmountCents: v.claimAmountCents ?? null,
          liquidatedAmountCents: v.liquidatedAmountCents ?? null,
          isCurrent,
          origin: "manual",
        })
        .returning();
      if (isCurrent) await setCurrentInstance(ctx, tx, process.id, row.instance);
      await recordAudit(
        ctx,
        {
          action: "legal_process.instance_add",
          entityType: "legal_process",
          entityId: process.id,
          summary: `Vínculo com o ${PROCESS_INSTANCE_LABELS[row.instance]} incluído no processo ${process.number}.`,
          changes: diffChanges(null, row, INSTANCE_AUDIT_FIELDS),
          metadata: { instanceId: row.id },
        },
        tx,
      );
      await markProcessStale(process.id, ctx, "Instâncias do processo alteradas", tx);
      return { id: row.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateInstance(v.instance);
    throw err;
  }
}

export async function updateProcessInstance(
  ctx: AuthContext,
  instanceId: string,
  input: ProcessInstanceInput,
): Promise<{ processId: string }> {
  assertCan(ctx, "process:write");
  const v = parse(processInstanceInputSchema, input);
  const { instance: before, process } = await loadInstance(ctx, instanceId);
  if (v.instance !== before.instance) {
    const [clash] = await getDb()
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(
        and(
          eq(processInstances.processId, process.id),
          eq(processInstances.instance, v.instance),
          ne(processInstances.id, before.id),
        ),
      )
      .limit(1);
    if (clash) throw duplicateInstance(v.instance);
  }
  const patch = {
    instance: v.instance,
    court: v.court,
    courtDivision: v.courtDivision ?? null,
    city: v.city ?? null,
    state: v.state ?? null,
    processClass: v.processClass ?? null,
    phase: v.phase ?? null,
    phaseDetail: v.phaseDetail ?? null,
    claimAmountCents: v.claimAmountCents ?? null,
    liquidatedAmountCents: v.liquidatedAmountCents ?? null,
    isCurrent: v.isCurrent ?? before.isCurrent,
  };
  const changes = diffChanges(before, patch, INSTANCE_AUDIT_FIELDS);
  if (!changes) return { processId: process.id };

  try {
    await getDb().transaction(async (tx) => {
      await tx
        .update(processInstances)
        .set(patch)
        .where(and(eq(processInstances.id, before.id), eq(processInstances.organizationId, ctx.organizationId)));
      if (patch.isCurrent) await setCurrentInstance(ctx, tx, process.id, patch.instance);
      await recordAudit(
        ctx,
        {
          action: "legal_process.instance_update",
          entityType: "legal_process",
          entityId: process.id,
          summary:
            before.origin === "imported"
              ? `Vínculo (importado) com o ${PROCESS_INSTANCE_LABELS[patch.instance]} alterado manualmente no processo ${process.number}.`
              : `Vínculo com o ${PROCESS_INSTANCE_LABELS[patch.instance]} alterado no processo ${process.number}.`,
          changes,
          metadata: { instanceId: before.id, origin: before.origin, manualChange: true },
        },
        tx,
      );
      await markProcessStale(process.id, ctx, "Instâncias do processo alteradas", tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateInstance(v.instance);
    throw err;
  }
  return { processId: process.id };
}

export async function removeProcessInstance(ctx: AuthContext, instanceId: string): Promise<{ processId: string }> {
  assertCan(ctx, "process:write");
  const { instance: row, process } = await loadInstance(ctx, instanceId);
  if (row.origin === "imported") {
    throw new ConflictError(
      "Vínculos importados de planilha ficam preservados para rastreabilidade. Edite os dados ou desfaça a importação.",
    );
  }
  await getDb().transaction(async (tx) => {
    await tx
      .delete(processInstances)
      .where(and(eq(processInstances.id, row.id), eq(processInstances.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "legal_process.instance_remove",
        entityType: "legal_process",
        entityId: process.id,
        summary: `Vínculo com o ${PROCESS_INSTANCE_LABELS[row.instance]} removido do processo ${process.number}.`,
        changes: diffChanges(row, {}, INSTANCE_AUDIT_FIELDS),
        metadata: { instanceId: row.id },
      },
      tx,
    );
    await markProcessStale(process.id, ctx, "Instâncias do processo alteradas", tx);
  });
  return { processId: process.id };
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

async function loadParty(ctx: AuthContext, partyId: string) {
  if (!isUuid(partyId)) throw new NotFoundError("Parte não encontrada ou sem permissão de acesso.");
  const [row] = await getDb()
    .select({ party: processParties, processNumber: legalProcesses.number })
    .from(processParties)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processParties.processId))
    .where(
      and(eq(processParties.id, partyId), eq(processParties.organizationId, ctx.organizationId), processWhere(ctx)),
    );
  if (!row) throw new NotFoundError("Parte não encontrada ou sem permissão de acesso.");
  return row;
}

async function markProcessStale(processId: string, ctx: AuthContext, reason: string, tx: DbOrTx) {
  await markAnalysesStaleForEntity({ organizationId: ctx.organizationId, entityId: processId, reason }, tx);
}

export async function addParty(ctx: AuthContext, processId: string, input: PartyInput): Promise<{ id: string }> {
  assertCan(ctx, "process:write");
  const v = parse(partyInputSchema, input);
  const process = await loadProcess(ctx, processId);
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(processParties)
      .values({
        organizationId: ctx.organizationId,
        processId: process.id,
        name: v.name,
        role: v.role,
        documentNumber: v.documentNumber ?? null,
        isClient: v.isClient ?? false,
        liabilityNature: v.liabilityNature ?? null,
        counselName: v.counselName ?? null,
      })
      .returning();
    await recordAudit(
      ctx,
      {
        action: "legal_process.party_add",
        entityType: "legal_process",
        entityId: process.id,
        summary: `Parte "${row.name}" (${PARTY_ROLE_LABELS[row.role]}) adicionada ao processo ${process.number}.`,
        changes: diffChanges(null, row, PARTY_AUDIT_FIELDS),
        metadata: { partyId: row.id },
      },
      tx,
    );
    await markProcessStale(process.id, ctx, "Partes do processo alteradas", tx);
    return { id: row.id };
  });
}

export async function updateParty(ctx: AuthContext, partyId: string, input: PartyInput): Promise<{ processId: string }> {
  assertCan(ctx, "process:write");
  const v = parse(partyInputSchema, input);
  const { party: before, processNumber } = await loadParty(ctx, partyId);
  const patch = {
    name: v.name,
    role: v.role,
    documentNumber: v.documentNumber ?? null,
    isClient: v.isClient ?? false,
    liabilityNature: v.liabilityNature ?? null,
    counselName: v.counselName ?? null,
  };
  const changes = diffChanges(before, patch, PARTY_AUDIT_FIELDS);
  if (!changes) return { processId: before.processId };
  await getDb().transaction(async (tx) => {
    await tx
      .update(processParties)
      .set(patch)
      .where(and(eq(processParties.id, before.id), eq(processParties.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "legal_process.party_update",
        entityType: "legal_process",
        entityId: before.processId,
        summary: `Parte "${patch.name}" do processo ${processNumber} alterada.`,
        changes,
        metadata: { partyId: before.id },
      },
      tx,
    );
    await markProcessStale(before.processId, ctx, "Partes do processo alteradas", tx);
  });
  return { processId: before.processId };
}

export async function removeParty(ctx: AuthContext, partyId: string): Promise<{ processId: string }> {
  assertCan(ctx, "process:write");
  const { party, processNumber } = await loadParty(ctx, partyId);
  await getDb().transaction(async (tx) => {
    await tx
      .delete(processParties)
      .where(and(eq(processParties.id, party.id), eq(processParties.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "legal_process.party_remove",
        entityType: "legal_process",
        entityId: party.processId,
        summary: `Parte "${party.name}" removida do processo ${processNumber}.`,
        changes: diffChanges(party, {}, PARTY_AUDIT_FIELDS),
        metadata: { partyId: party.id },
      },
      tx,
    );
    await markProcessStale(party.processId, ctx, "Partes do processo alteradas", tx);
  });
  return { processId: party.processId };
}

// ---------------------------------------------------------------------------
// Timeline (movimentações) — manual entries only; imported ones are read-only
// ---------------------------------------------------------------------------

export async function addProcessEvent(
  ctx: AuthContext,
  processId: string,
  input: ProcessEventInput,
): Promise<{ id: string }> {
  assertCan(ctx, "process:write");
  const v = parse(processEventInputSchema, input);
  const process = await loadProcess(ctx, processId);
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(processEvents)
      .values({
        organizationId: ctx.organizationId,
        processId: process.id,
        occurredAt: v.occurredAt,
        type: v.type,
        title: v.title,
        description: v.description ?? null,
        instance: v.instance ?? null,
        cnjMovementCode: v.cnjMovementCode ?? null,
        origin: "manual",
        createdById: ctx.userId,
      })
      .returning();
    await recordAudit(
      ctx,
      {
        action: "legal_process.event_add",
        entityType: "legal_process",
        entityId: process.id,
        summary: `Movimentação manual (${PROCESS_EVENT_TYPE_LABELS[row.type]}) registrada no processo ${process.number}.`,
        changes: diffChanges(null, row, ["occurredAt", "type", "title", "instance", "cnjMovementCode"]),
        metadata: { eventId: row.id },
      },
      tx,
    );
    // Touch the process so it surfaces as recently updated; a court movement (not an
    // internal note) newer than the stored one becomes the "última movimentação".
    const touch: Partial<typeof legalProcesses.$inferInsert> = { updatedAt: new Date() };
    if (row.type !== "note" && (!process.lastMovementAt || row.occurredAt > process.lastMovementAt)) {
      touch.lastMovementAt = row.occurredAt;
    }
    await tx
      .update(legalProcesses)
      .set(touch)
      .where(and(eq(legalProcesses.id, process.id), eq(legalProcesses.organizationId, ctx.organizationId)));
    await markProcessStale(process.id, ctx, "Nova movimentação registrada no processo", tx);
    return { id: row.id };
  });
}

export async function removeProcessEvent(ctx: AuthContext, eventId: string): Promise<{ processId: string }> {
  assertCan(ctx, "process:write");
  if (!isUuid(eventId)) throw new NotFoundError("Movimentação não encontrada ou sem permissão de acesso.");
  const [found] = await getDb()
    .select({ event: processEvents, processNumber: legalProcesses.number })
    .from(processEvents)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processEvents.processId))
    .where(and(eq(processEvents.id, eventId), eq(processEvents.organizationId, ctx.organizationId), processWhere(ctx)));
  if (!found) throw new NotFoundError("Movimentação não encontrada ou sem permissão de acesso.");
  const { event, processNumber } = found;
  if (event.origin !== "manual") {
    throw new ConflictError("Movimentações importadas são somente leitura e não podem ser removidas.");
  }
  await getDb().transaction(async (tx) => {
    await tx
      .delete(processEvents)
      .where(and(eq(processEvents.id, event.id), eq(processEvents.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "legal_process.event_remove",
        entityType: "legal_process",
        entityId: event.processId,
        summary: `Movimentação manual (${PROCESS_EVENT_TYPE_LABELS[event.type]}) removida do processo ${processNumber}.`,
        changes: diffChanges(event, {}, ["occurredAt", "type", "title"]),
        metadata: { eventId: event.id },
      },
      tx,
    );
    await markProcessStale(event.processId, ctx, "Movimentação removida do processo", tx);
  });
  return { processId: event.processId };
}

// ---------------------------------------------------------------------------
// Export (RF-17)
// ---------------------------------------------------------------------------

export const PROCESS_EXPORT_LIMIT = 20_000;
export type ProcessExportFormat = "csv" | "xlsx";

export type ProcessExportRow = {
  id: string;
  number: string;
  title: string;
  court: string;
  courtDivision: string | null;
  city: string | null;
  state: string | null;
  instance: ProcessInstance | null;
  processClass: string | null;
  area: LegalArea;
  phase: ProcessPhase;
  phaseDetail: string | null;
  status: ProcessStatus;
  closureReason: ClosureReason | null;
  needsVerification: boolean;
  isConfidential: boolean;
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  companyName: string | null;
  responsibleName: string | null;
  lawFirmName: string | null;
  unitName: string | null;
  plaintiffName: string | null;
  plaintiffCount: number;
  /** Digits only — the export masks it (maskDocument). */
  plaintiffDocument: string | null;
  defendantName: string | null;
  defendantCount: number;
  defendantDocument: string | null;
  filedAt: string | null;
  dataOrigin: DataOrigin;
};

export type ProcessExportInstanceRow = {
  processId: string;
  instance: ProcessInstance;
  court: string;
  courtDivision: string | null;
  city: string | null;
  state: string | null;
  processClass: string | null;
  phase: ProcessPhase | null;
  phaseDetail: string | null;
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  isCurrent: boolean;
};

export type ProcessExportData = {
  processes: ProcessExportRow[];
  instances: ProcessExportInstanceRow[];
};

/** Filters recorded in the export audit entry (no free-text search terms, no data). */
function auditFilters(f: ParsedFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    if (value === undefined || key === "page" || key === "pageSize") continue;
    if (key === "q") out.textSearch = true;
    else out[key] = value;
  }
  return out;
}

/**
 * Rows of the filtered portfolio for CSV/XLSX export (same scope, filters and
 * order as the list, without pagination) + the instance links of those
 * processes. Records the `legal_process.export` audit entry (filters and
 * count only).
 */
export async function exportProcesses(
  ctx: AuthContext,
  filters: ProcessFilters,
  format: ProcessExportFormat,
): Promise<ProcessExportData> {
  assertCan(ctx, "process:read");
  const f = parse(processFiltersSchema, filters);
  const p = legalProcesses;
  const db = getDb();
  const where = listWhere(ctx, f);

  const [{ total }] = await db.select({ total: count() }).from(p).where(where);
  if (Number(total) > PROCESS_EXPORT_LIMIT) {
    throw new ValidationError(
      `A exportação está limitada a ${formatNumber(PROCESS_EXPORT_LIMIT)} processos por arquivo. Refine os filtros.`,
    );
  }

  const processes = await db
    .select({
      id: p.id,
      number: p.number,
      title: p.title,
      court: p.court,
      courtDivision: p.courtDivision,
      city: p.city,
      state: p.state,
      instance: p.instance,
      processClass: p.processClass,
      area: p.area,
      phase: p.phase,
      phaseDetail: p.phaseDetail,
      status: p.status,
      closureReason: p.closureReason,
      needsVerification: p.needsVerification,
      isConfidential: p.isConfidential,
      claimAmountCents: p.claimAmountCents,
      liquidatedAmountCents: p.liquidatedAmountCents,
      companyName: companies.name,
      responsibleName: users.name,
      lawFirmName: lawFirms.name,
      unitName: units.name,
      plaintiffName: firstPartyField("plaintiff", "name"),
      plaintiffCount: partyCount("plaintiff"),
      plaintiffDocument: firstPartyField("plaintiff", "documentNumber"),
      defendantName: firstPartyField("defendant", "name"),
      defendantCount: partyCount("defendant"),
      defendantDocument: firstPartyField("defendant", "documentNumber"),
      filedAt: p.filedAt,
      dataOrigin: p.dataOrigin,
    })
    .from(p)
    .leftJoin(users, and(eq(users.id, p.responsibleId), eq(users.organizationId, ctx.organizationId)))
    .leftJoin(units, and(eq(units.id, p.unitId), eq(units.organizationId, ctx.organizationId)))
    .leftJoin(companies, and(eq(companies.id, p.companyId), eq(companies.organizationId, ctx.organizationId)))
    .leftJoin(lawFirms, and(eq(lawFirms.id, p.lawFirmId), eq(lawFirms.organizationId, ctx.organizationId)))
    .where(where)
    .orderBy(...orderBy(f.sort ?? "number_asc"));

  const instances =
    processes.length > 0
      ? await db
          .select({
            processId: processInstances.processId,
            instance: processInstances.instance,
            court: processInstances.court,
            courtDivision: processInstances.courtDivision,
            city: processInstances.city,
            state: processInstances.state,
            processClass: processInstances.processClass,
            phase: processInstances.phase,
            phaseDetail: processInstances.phaseDetail,
            claimAmountCents: processInstances.claimAmountCents,
            liquidatedAmountCents: processInstances.liquidatedAmountCents,
            isCurrent: processInstances.isCurrent,
          })
          .from(processInstances)
          .where(
            and(
              eq(processInstances.organizationId, ctx.organizationId),
              inArray(processInstances.processId, db.select({ id: p.id }).from(p).where(where)),
            ),
          )
      : [];

  await recordAudit(ctx, {
    action: "legal_process.export",
    entityType: "legal_process",
    entityId: null,
    summary: `Carteira de processos exportada (${format.toUpperCase()}): ${formatNumber(processes.length)} processo(s).`,
    metadata: { format, count: processes.length, filters: auditFilters(f) },
  });

  // The current instance without its own valor da causa shows the record's (same rule as the detail page).
  const recordClaim = new Map(processes.map((r) => [r.id, r.claimAmountCents]));
  return {
    processes: processes.map((r) => ({
      ...r,
      plaintiffCount: Number(r.plaintiffCount ?? 0),
      defendantCount: Number(r.defendantCount ?? 0),
    })),
    instances: instances.map((i) => ({
      ...i,
      claimAmountCents: i.claimAmountCents ?? currentInstanceClaimFallback(i, recordClaim.get(i.processId) ?? null),
    })),
  };
}

// ---------------------------------------------------------------------------
// Global search (header search box)
// ---------------------------------------------------------------------------

export type ProcessSearchResult = {
  id: string;
  number: string;
  title: string;
  court: string;
  status: ProcessListItem["status"];
};

/** Quick search by CNJ number (with or without punctuation), title or party name, within the visible portfolio. */
export async function searchProcesses(ctx: AuthContext, q: string, limit = 8): Promise<ProcessSearchResult[]> {
  assertCan(ctx, "process:read");
  const term = q.trim().slice(0, 120);
  if (term.length < 2) return [];
  const p = legalProcesses;
  return getDb()
    .select({ id: p.id, number: p.number, title: p.title, court: p.court, status: p.status })
    .from(p)
    .where(and(processWhere(ctx), searchCondition(term)))
    .orderBy(desc(p.updatedAt), asc(p.id))
    .limit(Math.min(25, Math.max(1, limit)));
}
