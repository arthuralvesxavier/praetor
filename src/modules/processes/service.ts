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
 * appends an official `claim` valuation (RF-09, allowed exception in
 * MODULE_CONTRACTS). `liquidatedAmountCents`, `provisionAmountCents`,
 * `lossProbability` and `riskPercentageBp` are mirrors maintained by the
 * contingency module and are never written by this service.
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
  type DataOrigin,
  type LegalArea,
  type LiabilityNature,
  type PartyRole,
  type ProcessEventType,
  type ProcessInstance,
  type ProcessPhase,
  type ProcessStatus,
  type RiskLevel,
} from "@/domain/enums";
import { formatNumber, todayISO } from "@/lib/format";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import { linkOccurrenceToProcess } from "@/modules/occurrences/service";
import { assertCompanyInOrg, assertLawFirmInOrg } from "@/modules/organization/service";
import { deadlineWhere, isExternalCounsel, occurrenceWhere, processWhere, seesConfidential } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  auditLogs,
  companies,
  deadlines,
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
  claimAmountCents: number | null;
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
  const distinct = async (col: AnyPgColumn): Promise<string[]> => {
    const rows = await db
      .selectDistinct({ value: col })
      .from(p)
      .where(and(processWhere(ctx), isNotNull(col), ne(col, "")))
      .orderBy(asc(col))
      .limit(500);
    return rows.map((r) => String(r.value));
  };
  const courts = await distinct(p.court);
  const classes = await distinct(p.processClass);
  const cities = await distinct(p.city);
  const states = await distinct(p.state);
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

function toInstanceItem(r: InstanceRow, canEdit: boolean): ProcessInstanceItem {
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

  const parties = await db
    .select()
    .from(processParties)
    .where(and(eq(processParties.processId, row.id), eq(processParties.organizationId, org)))
    .orderBy(asc(processParties.role), asc(processParties.name));
  const events = await db
    .select()
    .from(processEvents)
    .where(and(eq(processEvents.processId, row.id), eq(processEvents.organizationId, org)))
    .orderBy(desc(processEvents.occurredAt), desc(processEvents.createdAt));
  const instances = await db
    .select()
    .from(processInstances)
    .where(and(eq(processInstances.processId, row.id), eq(processInstances.organizationId, org)));
  const unitName = row.unitId
    ? ((
        await db
          .select({ name: units.name })
          .from(units)
          .where(and(eq(units.id, row.unitId), eq(units.organizationId, org)))
      )[0]?.name ?? null)
    : null;
  const companyName = row.companyId
    ? ((
        await db
          .select({ name: companies.name })
          .from(companies)
          .where(and(eq(companies.id, row.companyId), eq(companies.organizationId, org)))
      )[0]?.name ?? null)
    : null;
  const lawFirmName = row.lawFirmId
    ? ((
        await db
          .select({ name: lawFirms.name })
          .from(lawFirms)
          .where(and(eq(lawFirms.id, row.lawFirmId), eq(lawFirms.organizationId, org)))
      )[0]?.name ?? null)
    : null;

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
      .map((r) => toInstanceItem(r, canEdit))
      .sort((a, b) => instanceOrder(a.instance) - instanceOrder(b.instance)),
    permissions: {
      canEdit,
      canDelete: can(ctx, "process:delete") && !row.legalHold,
      canEditConfidential: canEdit && canEditProcessConfidentiality(ctx),
    },
  };
}

/** Contract: options for selects in other modules (documents, deadlines, tasks, contracts). */
export async function listProcessOptions(ctx: AuthContext): Promise<{ id: string; number: string; title: string }[]> {
  assertCan(ctx, "process:read");
  return getDb()
    .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
    .from(legalProcesses)
    .where(processWhere(ctx))
    .orderBy(asc(legalProcesses.number))
    .limit(1000);
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

  return getDb().transaction(async (tx) => {
    // Serializes concurrent views of the same process by the same user.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`process-view:${userId}:${process.id}`}))`);
    const since = new Date(Date.now() - CONFIDENTIAL_VIEW_WINDOW_MS);
    const [recent] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, ctx.organizationId),
          eq(auditLogs.actorId, userId),
          eq(auditLogs.action, CONFIDENTIAL_VIEW_ACTION),
          eq(auditLogs.entityId, process.id),
          gte(auditLogs.createdAt, since),
        ),
      )
      .limit(1);
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
// Value history: valor da causa (RF-09)
// ---------------------------------------------------------------------------

/**
 * Appends an official `claim` valuation (source manual, reviewed by the
 * editing user) and marks the previous official claim valuations as
 * superseded. With `amountCents = null` (valor da causa removed) only the
 * supersession happens. System contexts skip it (imports record their own).
 */
async function recordClaimValuation(
  ctx: AuthContext,
  tx: DbOrTx,
  process: { id: string; instance: ProcessInstance | null },
  amountCents: number | null,
  reason: string,
): Promise<{ valuationId: string | null; supersededIds: string[] }> {
  if (ctx.kind !== "user" || !ctx.userId) return { valuationId: null, supersededIds: [] };
  const v = processValuations;
  const previous = await tx
    .select({ id: v.id })
    .from(v)
    .where(
      and(
        eq(v.organizationId, ctx.organizationId),
        eq(v.processId, process.id),
        eq(v.kind, "claim"),
        eq(v.status, "official"),
      ),
    )
    .orderBy(desc(v.createdAt));
  const supersededIds = previous.map((r) => r.id);
  if (supersededIds.length > 0) {
    await tx
      .update(v)
      .set({ status: "superseded" })
      .where(and(eq(v.organizationId, ctx.organizationId), inArray(v.id, supersededIds)));
  }
  if (amountCents === null) return { valuationId: null, supersededIds };
  const [row] = await tx
    .insert(v)
    .values({
      organizationId: ctx.organizationId,
      processId: process.id,
      kind: "claim",
      amountCents,
      baseDate: todayISO(),
      instance: process.instance,
      source: "manual",
      status: "official",
      isEstimate: false,
      reason,
      supersedesId: supersededIds[0] ?? null,
      createdById: ctx.userId,
      reviewedById: ctx.userId,
      reviewedAt: new Date(),
    })
    .returning({ id: v.id });
  return { valuationId: row.id, supersededIds };
}

// ---------------------------------------------------------------------------
// Process mutations
// ---------------------------------------------------------------------------

export async function createProcess(
  ctx: AuthContext,
  input: CreateProcessInput,
): Promise<{ id: string; occurrenceLinkError: string | null }> {
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
    claimAmountCents: v.claimAmountCents ?? null,
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
      const claim =
        row.claimAmountCents !== null
          ? await recordClaimValuation(ctx, tx, row, row.claimAmountCents, "Valor da causa informado no cadastro do processo.")
          : null;
      await recordAudit(
        ctx,
        {
          action: "legal_process.create",
          entityType: "legal_process",
          entityId: row.id,
          summary: `Processo ${row.number} cadastrado.`,
          changes: diffChanges(null, row, AUDIT_FIELDS),
          metadata: {
            ...(v.fromOccurrenceId ? { fromOccurrenceId: v.fromOccurrenceId } : {}),
            ...(claim?.valuationId ? { claimValuationId: claim.valuationId } : {}),
          },
        },
        tx,
      );
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

  return { id: created.id, occurrenceLinkError };
}

/** Fields a regular update may assign (mirrors maintained by the contingency module are excluded). */
const ASSIGNABLE_FIELDS = AUDIT_FIELDS.filter((k) => k !== "isConfidential");

/**
 * Partial update. Imported processes stay `dataOrigin: "imported"`; the audit
 * entry records that the change was made manually. Leaving the active
 * portfolio requires a closure reason (RN-12); returning to it clears the reason.
 */
export async function updateProcess(ctx: AuthContext, id: string, input: UpdateProcessInput): Promise<void> {
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

  const after = { ...before, ...patch } as ProcessRow;
  const changes = diffChanges(before, after, AUDIT_FIELDS);
  if (!changes) return;
  const changed = Object.keys(changes);
  const imported = before.dataOrigin === "imported";

  try {
    await getDb().transaction(async (tx) => {
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

      await recordAudit(
        ctx,
        {
          action: "legal_process.update",
          entityType: "legal_process",
          entityId: before.id,
          summary: imported
            ? `Processo ${before.number} (importado) alterado manualmente: ${fieldList(changed)}.`
            : `Processo ${before.number} alterado: ${fieldList(changed)}.`,
          changes,
          metadata: {
            dataOrigin: before.dataOrigin,
            manualChange: true,
            ...(claim?.valuationId ? { claimValuationId: claim.valuationId } : {}),
            ...(claim && claim.supersededIds.length > 0 ? { supersededValuationIds: claim.supersededIds } : {}),
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
      summary: `Processo ${before.number} retirado da carteira ativa — motivo: ${reasonLabel}.${
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

/** "Marcar para verificação": flags the process with a note of what must be checked. */
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
      summary: `Processo ${before.number} marcado para verificação.`,
    },
    null,
  );
}

/** "Concluir verificação": clears the flag; the conclusion note goes to the history. */
export async function resolveProcessVerification(
  ctx: AuthContext,
  id: string,
  input: ResolveVerificationInput = {},
): Promise<void> {
  assertCan(ctx, "process:write");
  const v = parse(resolveVerificationSchema, input);
  const before = await loadProcess(ctx, id);
  if (!before.needsVerification) throw new ConflictError("O processo não está marcado para verificação.");
  await applyLifecyclePatch(
    ctx,
    before,
    { needsVerification: false, verificationNote: null },
    {
      action: "legal_process.verification_resolve",
      summary: `Verificação do processo ${before.number} concluída.${v.note ? ` Conclusão: ${v.note}` : ""}`,
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

  return {
    processes: processes.map((r) => ({
      ...r,
      plaintiffCount: Number(r.plaintiffCount ?? 0),
      defendantCount: Number(r.defendantCount ?? 0),
    })),
    instances,
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
