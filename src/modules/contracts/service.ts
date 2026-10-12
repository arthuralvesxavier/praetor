import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type {
  ContractStatus,
  ContractType,
  DataOrigin,
  DocumentCategory,
  ObligationStatus,
  RenewalType,
  RiskLevel,
} from "@/domain/enums";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import { addDaysISO, formatDate, maskDocument, todayISO } from "@/lib/format";
import { resolveAlertsByDedupeKeys } from "@/modules/alerts/service";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import type { AuthContext } from "@/server/auth/context";
import { contractWhere, documentWhere, occurrenceWhere, processWhere, seesConfidential } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  auditLogs,
  contractObligations,
  contracts,
  DEFAULT_ORGANIZATION_SETTINGS,
  documents,
  legalProcesses,
  occurrences,
  organizations,
  units,
  users,
} from "@/server/db/schema";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import {
  effectiveObligationStatus,
  isOpenObligation,
  nextDueDate,
  OPEN_OBLIGATION_STATUSES,
  parseRecurrence,
  type ObligationRecurrence,
} from "./obligations";
import {
  contractInputSchema,
  idSchema,
  listContractsSchema,
  obligationInputSchema,
  obligationPatchSchema,
  renewContractSchema,
  terminateContractSchema,
  type ContractData,
  type ContractInput,
  type ListContractsFilters,
  type ObligationInput,
  type ObligationPatch,
  type RenewContractInput,
  type TerminateContractInput,
} from "./schemas";
import { contractNoticeInfo, contractVigencyState, daysToEnd, noticeDeadline, type NoticeInfo, type VigencyState } from "./vigencia";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Earliest open obligation of a contract (by due date; undated ones last). */
export type NextObligationSummary = {
  id: string;
  description: string;
  dueDate: string | null;
  /** Effective status (computed from the due date). */
  status: ObligationStatus;
};

export type ContractListItem = {
  id: string;
  title: string;
  counterparty: string;
  /** Masked for lists (LGPD minimization): CPF partially hidden, CNPJ formatted. */
  counterpartyDocumentMasked: string | null;
  type: ContractType;
  status: ContractStatus;
  startDate: string | null;
  endDate: string | null;
  renewalType: RenewalType;
  renewalNoticeDays: number | null;
  valueCents: number | null;
  riskLevel: RiskLevel;
  isConfidential: boolean;
  responsibleId: string | null;
  responsibleName: string | null;
  unitName: string | null;
  /** Open obligations (pending or overdue). */
  pendingObligations: number;
  /** Open obligations past their due date (computed). */
  overdueObligations: number;
  nextObligation: NextObligationSummary | null;
  vigency: VigencyState;
  daysToEnd: number | null;
  /** Renewal/termination notice (end date − notice days) and its state. */
  notice: NoticeInfo;
};

export type ContractObligationItem = {
  id: string;
  description: string;
  responsibleId: string | null;
  responsibleName: string | null;
  dueDate: string | null;
  /** Stored text (canonical pt-BR word or legacy free text). */
  recurrence: string | null;
  recurrenceKind: ObligationRecurrence | "custom";
  /** Stored status. */
  status: ObligationStatus;
  /** Status shown in the UI: "overdue" computed from the due date. */
  effectiveStatus: ObligationStatus;
  origin: DataOrigin;
  sourceAnalysisId: string | null;
  /** Due date of the occurrence "Cumprir e gerar próxima" would create (null when not applicable). */
  nextDueDate: string | null;
  /** Why the next occurrence cannot be generated (pt-BR), when `nextDueDate` is set but blocked. */
  nextBlockedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Summary of a linked process/occurrence. `visible: false` when the user cannot open it (label is then generic). */
export type LinkedRecordSummary = { id: string; label: string; visible: boolean };

export type ContractDetail = Omit<ContractListItem, "counterpartyDocumentMasked"> & {
  /** Full CPF/CNPJ (digits) — only on the detail page. */
  counterpartyDocument: string | null;
  description: string | null;
  unitId: string | null;
  linkedProcessId: string | null;
  linkedOccurrenceId: string | null;
  linkedProcess: LinkedRecordSummary | null;
  linkedOccurrence: LinkedRecordSummary | null;
  legalHold: boolean;
  createdById: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  noticeDeadline: string | null;
  /** Organization setting used to compute the "vencendo" and "aviso próximo" states. */
  expirationDays: number;
  obligations: ContractObligationItem[];
};

export type ContractKpis = {
  /** Active contracts already started and not past their end date. */
  active: number;
  /** Active contracts ending within `expirationDays` days (today included). */
  expiring: number;
  /** Status "expired", or active with end date before today. */
  expired: number;
  /** Active contracts in force whose notice date is within `expirationDays` days or already reached. */
  noticeSoon: number;
  /** Pending or overdue obligations of visible contracts. */
  pendingObligations: number;
  /** Open obligations past their due date. */
  overdueObligations: number;
  expirationDays: number;
};

export type ContractListFilters = ListContractsFilters & {
  /** Status "expired" or active with end date in the past (module-specific URL param `vencidos=1`). */
  overdue?: boolean;
} & Page;

/** Renewal / termination recorded for a contract (from the audit trail). */
export type ContractLifecycleEvent = {
  id: string;
  kind: "renewal" | "termination";
  createdAt: Date;
  actorName: string | null;
  previousEndDate: string | null;
  /** Renewal: new end date. */
  newEndDate: string | null;
  /** Termination: effective date. */
  terminationDate: string | null;
  /** Linked document (aditivo, distrato, notificação); `visible: false` when ctx cannot open it. */
  document: { id: string; title: string; visible: boolean } | null;
  note: string | null;
};

export type ContractDocumentOption = { id: string; title: string; category: DocumentCategory };

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const flat = z.flattenError(r.error) as { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(flat.fieldErrors)) if (v && v.length) fieldErrors[k] = v;
    throw new ValidationError(flat.formErrors[0] ?? "Verifique os campos informados.", fieldErrors);
  }
  return r.data;
}

function parseId(id: string): string {
  const r = idSchema.safeParse(id);
  // An invalid id can never match a record: same answer as "not found / not visible".
  if (!r.success) throw new NotFoundError();
  return r.data;
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Organization setting `alerts.contractExpirationDays` (with default). */
async function contractExpirationDays(organizationId: string, db: DbOrTx = getDb()): Promise<number> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const raw = org?.settings?.alerts?.contractExpirationDays;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? Math.trunc(raw)
    : DEFAULT_ORGANIZATION_SETTINGS.alerts.contractExpirationDays;
}

const OPEN_STATUSES = [...OPEN_OBLIGATION_STATUSES];

function expiringCondition(today: string, days: number): SQL {
  return and(
    eq(contracts.status, "active"),
    isNotNull(contracts.endDate),
    gte(contracts.endDate, today),
    lte(contracts.endDate, addDaysISO(today, days)),
  ) as SQL;
}

function overdueCondition(today: string): SQL {
  return or(
    eq(contracts.status, "expired"),
    and(eq(contracts.status, "active"), isNotNull(contracts.endDate), lt(contracts.endDate, today)),
  ) as SQL;
}

/**
 * Active contract still in force whose notice date (end − notice days) is within
 * the window or already reached. Mirrors `contractNoticeInfo` state soon|passed.
 */
function noticeSoonCondition(today: string, days: number): SQL {
  return and(
    eq(contracts.status, "active"),
    isNotNull(contracts.endDate),
    gte(contracts.endDate, today),
    isNotNull(contracts.renewalNoticeDays),
    gt(contracts.renewalNoticeDays, 0),
    sql`(${contracts.endDate} - ${contracts.renewalNoticeDays}::int) <= ${addDaysISO(today, days)}::date`,
  ) as SQL;
}

/** Open obligation past its due date (or manually marked overdue without a due date). Mirrors `effectiveObligationStatus`. */
function overdueObligationCondition(today: string): SQL {
  return and(
    inArray(contractObligations.status, OPEN_STATUSES),
    or(
      and(isNotNull(contractObligations.dueDate), lt(contractObligations.dueDate, today)),
      and(isNull(contractObligations.dueDate), eq(contractObligations.status, "overdue")),
    ),
  ) as SQL;
}

async function assertUserInOrg(ctx: AuthContext, userId: string, field: string, db: DbOrTx): Promise<void> {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)));
  if (!u) throw new ValidationError("Verifique os campos informados.", { [field]: ["Selecione um usuário ativo da organização."] });
}

async function assertUnitInOrg(ctx: AuthContext, unitId: string, db: DbOrTx): Promise<void> {
  const [u] = await db
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.id, unitId), eq(units.organizationId, ctx.organizationId)));
  if (!u) throw new ValidationError("Verifique os campos informados.", { unitId: ["Selecione uma unidade da organização."] });
}

async function assertProcessVisible(ctx: AuthContext, processId: string, db: DbOrTx): Promise<void> {
  const [p] = await db
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), processWhere(ctx)));
  if (!p) throw new ValidationError("Verifique os campos informados.", { linkedProcessId: ["Processo não encontrado ou sem acesso."] });
}

async function assertOccurrenceVisible(ctx: AuthContext, occurrenceId: string, db: DbOrTx): Promise<void> {
  const [o] = await db
    .select({ id: occurrences.id })
    .from(occurrences)
    .where(and(eq(occurrences.id, occurrenceId), occurrenceWhere(ctx)));
  if (!o) {
    throw new ValidationError("Verifique os campos informados.", { linkedOccurrenceId: ["Ocorrência não encontrada ou sem acesso."] });
  }
}

/** The document must be linked to this contract and visible to ctx. */
async function assertContractDocument(ctx: AuthContext, contractId: string, documentId: string, field: string, db: DbOrTx) {
  const [d] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.contractId, contractId), documentWhere(ctx)));
  if (!d) {
    throw new ValidationError("Verifique os campos informados.", {
      [field]: ["Selecione um documento vinculado a este contrato."],
    });
  }
  return d;
}

/**
 * Validates every foreign id of the input. On update, ids that did not change
 * are not re-checked (the user may keep a link to a record they cannot open).
 */
async function validateContractReferences(
  ctx: AuthContext,
  data: ContractData,
  before: Pick<ContractData, "unitId" | "responsibleId" | "linkedProcessId" | "linkedOccurrenceId"> | null,
  db: DbOrTx,
): Promise<void> {
  if (data.unitId && data.unitId !== before?.unitId) await assertUnitInOrg(ctx, data.unitId, db);
  if (data.responsibleId && data.responsibleId !== before?.responsibleId) {
    await assertUserInOrg(ctx, data.responsibleId, "responsibleId", db);
  }
  if (data.linkedProcessId && data.linkedProcessId !== before?.linkedProcessId) {
    await assertProcessVisible(ctx, data.linkedProcessId, db);
  }
  if (data.linkedOccurrenceId && data.linkedOccurrenceId !== before?.linkedOccurrenceId) {
    await assertOccurrenceVisible(ctx, data.linkedOccurrenceId, db);
  }
}

const CONFIDENTIAL_ERROR = "Somente administradores e gestores jurídicos podem alterar a confidencialidade de contratos.";

/** Loads a visible, non-deleted contract row or throws NotFoundError. */
async function loadContract(ctx: AuthContext, id: string, db: DbOrTx = getDb()) {
  const [row] = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, parseId(id)), contractWhere(ctx)));
  if (!row) throw new NotFoundError();
  return row;
}

/** Loads an obligation whose contract is visible to ctx, or throws NotFoundError. */
async function loadObligation(ctx: AuthContext, obligationId: string, db: DbOrTx = getDb()) {
  const [row] = await db
    .select({ obligation: contractObligations, contract: contracts })
    .from(contractObligations)
    .innerJoin(contracts, eq(contracts.id, contractObligations.contractId))
    .where(
      and(
        eq(contractObligations.id, parseId(obligationId)),
        eq(contractObligations.organizationId, ctx.organizationId),
        contractWhere(ctx),
      ),
    );
  if (!row) throw new NotFoundError();
  return { obligation: row.obligation, contract: row.contract, contractTitle: row.contract.title };
}

/** Next occurrence of a recurring open obligation, and why it cannot be generated (if so). */
function planNextOccurrence(
  o: { status: ObligationStatus; dueDate: string | null; recurrence: string | null },
  contract: { status: ContractStatus; endDate: string | null },
): { kind: ObligationRecurrence | "custom"; nextDueDate: string | null; blockedReason: string | null } {
  const { kind } = parseRecurrence(o.recurrence);
  if (!isOpenObligation(o.status) || kind === "none" || kind === "custom") {
    return { kind, nextDueDate: null, blockedReason: null };
  }
  const next = nextDueDate(o.dueDate, kind);
  if (!next) {
    return { kind, nextDueDate: null, blockedReason: "Informe o vencimento da obrigação para gerar a próxima ocorrência." };
  }
  if (contract.status === "terminated") {
    return { kind, nextDueDate: next, blockedReason: "O contrato está rescindido: não há próxima ocorrência a gerar." };
  }
  if (contract.endDate && next > contract.endDate) {
    return {
      kind,
      nextDueDate: next,
      blockedReason:
        `A próxima ocorrência (${formatDate(next)}) seria posterior ao término da vigência (${formatDate(contract.endDate)}). ` +
        "Registre a renovação do contrato ou cadastre a obrigação manualmente.",
    };
  }
  return { kind, nextDueDate: next, blockedReason: null };
}

const CONTRACT_AUDIT_FIELDS = [
  "title",
  "counterparty",
  "counterpartyDocument",
  "type",
  "status",
  "startDate",
  "endDate",
  "renewalType",
  "renewalNoticeDays",
  "valueCents",
  "riskLevel",
  "unitId",
  "responsibleId",
  "linkedProcessId",
  "linkedOccurrenceId",
  "description",
  "isConfidential",
] as const;

const OBLIGATION_AUDIT_FIELDS = ["description", "responsibleId", "dueDate", "recurrence", "status"] as const;

const LIFECYCLE_ACTIONS = { "contract.renew": "renewal", "contract.terminate": "termination" } as const;

// ---------------------------------------------------------------------------
// Contracts: reads
// ---------------------------------------------------------------------------

type OpenObligationRow = { id: string; contractId: string; description: string; dueDate: string | null; status: ObligationStatus };

/** Open obligations of the given contracts, earliest first (undated last). */
async function loadOpenObligations(ctx: AuthContext, contractIds: string[], db: DbOrTx): Promise<OpenObligationRow[]> {
  if (contractIds.length === 0) return [];
  return db
    .select({
      id: contractObligations.id,
      contractId: contractObligations.contractId,
      description: contractObligations.description,
      dueDate: contractObligations.dueDate,
      status: contractObligations.status,
    })
    .from(contractObligations)
    .where(
      and(
        eq(contractObligations.organizationId, ctx.organizationId),
        inArray(contractObligations.contractId, contractIds),
        inArray(contractObligations.status, OPEN_STATUSES),
      ),
    )
    .orderBy(sql`${contractObligations.dueDate} asc nulls last`, asc(contractObligations.createdAt), asc(contractObligations.id));
}

function summarizeObligations(rows: OpenObligationRow[], today: string) {
  const byContract = new Map<string, { open: number; overdue: number; next: NextObligationSummary | null }>();
  for (const r of rows) {
    const entry = byContract.get(r.contractId) ?? { open: 0, overdue: 0, next: null };
    const status = effectiveObligationStatus(r.status, r.dueDate, today);
    entry.open += 1;
    if (status === "overdue") entry.overdue += 1;
    entry.next ??= { id: r.id, description: r.description, dueDate: r.dueDate, status };
    byContract.set(r.contractId, entry);
  }
  return byContract;
}

export async function listContracts(ctx: AuthContext, filters: ContractListFilters = {}): Promise<Paginated<ContractListItem>> {
  assertCan(ctx, "contract:read");
  const { overdue, ...rest } = filters;
  const f = parseOrThrow(listContractsSchema, rest);
  const { page, pageSize, offset } = normalizePage(f);
  const db = getDb();
  const today = todayISO();
  const days = await contractExpirationDays(ctx.organizationId, db);

  const conds: (SQL | undefined)[] = [contractWhere(ctx)];
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`;
    conds.push(or(ilike(contracts.title, pattern), ilike(contracts.counterparty, pattern), ilike(contracts.description, pattern)));
  }
  if (f.status) conds.push(eq(contracts.status, f.status));
  if (f.type) conds.push(eq(contracts.type, f.type));
  if (f.responsibleId) conds.push(eq(contracts.responsibleId, f.responsibleId));
  if (f.expiring) conds.push(expiringCondition(today, days));
  if (overdue) conds.push(overdueCondition(today));
  if (f.noticeSoon) conds.push(noticeSoonCondition(today, days));
  if (f.overdueObligations) {
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(contractObligations)
          .where(and(eq(contractObligations.contractId, contracts.id), overdueObligationCondition(today))),
      ),
    );
  }
  const where = and(...conds);

  const responsible = alias(users, "contract_responsible");
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: contracts.id,
        title: contracts.title,
        counterparty: contracts.counterparty,
        counterpartyDocument: contracts.counterpartyDocument,
        type: contracts.type,
        status: contracts.status,
        startDate: contracts.startDate,
        endDate: contracts.endDate,
        renewalType: contracts.renewalType,
        renewalNoticeDays: contracts.renewalNoticeDays,
        valueCents: contracts.valueCents,
        riskLevel: contracts.riskLevel,
        isConfidential: contracts.isConfidential,
        responsibleId: contracts.responsibleId,
        responsibleName: responsible.name,
        unitName: units.name,
      })
      .from(contracts)
      .leftJoin(responsible, eq(responsible.id, contracts.responsibleId))
      .leftJoin(units, eq(units.id, contracts.unitId))
      .where(where)
      .orderBy(
        sql`case when ${contracts.status} in ('active', 'under_review', 'draft') then 0 else 1 end`,
        sql`${contracts.endDate} asc nulls last`,
        asc(contracts.title),
        asc(contracts.id),
      )
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(contracts).where(where),
  ]);

  const obligations = summarizeObligations(await loadOpenObligations(ctx, rows.map((r) => r.id), db), today);

  return {
    items: rows.map(({ counterpartyDocument, ...r }) => {
      const o = obligations.get(r.id);
      return {
        ...r,
        counterpartyDocumentMasked: counterpartyDocument ? maskDocument(counterpartyDocument) : null,
        pendingObligations: o?.open ?? 0,
        overdueObligations: o?.overdue ?? 0,
        nextObligation: o?.next ?? null,
        vigency: contractVigencyState(r, today, days),
        daysToEnd: daysToEnd(r.endDate, today),
        notice: contractNoticeInfo(r, today, days),
      };
    }),
    total: Number(total),
    page,
    pageSize,
  };
}

/** Indicators for the contracts list header (all scoped to what ctx can see). */
export async function getContractKpis(ctx: AuthContext): Promise<ContractKpis> {
  assertCan(ctx, "contract:read");
  const db = getDb();
  const today = todayISO();
  const days = await contractExpirationDays(ctx.organizationId, db);
  const scope = contractWhere(ctx);

  const [[counts], [obligations]] = await Promise.all([
    db
      .select({
        active: sql<number>`count(*) filter (where ${and(
          eq(contracts.status, "active"),
          or(isNull(contracts.startDate), lte(contracts.startDate, today)),
          or(isNull(contracts.endDate), gte(contracts.endDate, today)),
        )})`.mapWith(Number),
        expiring: sql<number>`count(*) filter (where ${expiringCondition(today, days)})`.mapWith(Number),
        expired: sql<number>`count(*) filter (where ${overdueCondition(today)})`.mapWith(Number),
        noticeSoon: sql<number>`count(*) filter (where ${noticeSoonCondition(today, days)})`.mapWith(Number),
      })
      .from(contracts)
      .where(scope),
    db
      .select({
        open: count(),
        overdue: sql<number>`count(*) filter (where ${overdueObligationCondition(today)})`.mapWith(Number),
      })
      .from(contractObligations)
      .innerJoin(contracts, eq(contracts.id, contractObligations.contractId))
      .where(
        and(
          scope,
          eq(contractObligations.organizationId, ctx.organizationId),
          inArray(contractObligations.status, OPEN_STATUSES),
        ),
      ),
  ]);

  return {
    active: counts?.active ?? 0,
    expiring: counts?.expiring ?? 0,
    expired: counts?.expired ?? 0,
    noticeSoon: counts?.noticeSoon ?? 0,
    pendingObligations: Number(obligations?.open ?? 0),
    overdueObligations: obligations?.overdue ?? 0,
    expirationDays: days,
  };
}

export async function getContract(ctx: AuthContext, id: string): Promise<ContractDetail> {
  assertCan(ctx, "contract:read");
  const db = getDb();
  const responsible = alias(users, "contract_responsible");
  const creator = alias(users, "contract_creator");

  const [row] = await db
    .select({
      contract: contracts,
      responsibleName: responsible.name,
      createdByName: creator.name,
      unitName: units.name,
    })
    .from(contracts)
    .leftJoin(responsible, eq(responsible.id, contracts.responsibleId))
    .leftJoin(creator, eq(creator.id, contracts.createdById))
    .leftJoin(units, eq(units.id, contracts.unitId))
    .where(and(eq(contracts.id, parseId(id)), contractWhere(ctx)));
  if (!row) throw new NotFoundError();
  const c = row.contract;

  const today = todayISO();
  const obligationResponsible = alias(users, "obligation_responsible");
  const [days, obligationRows, process, occurrence] = await Promise.all([
    contractExpirationDays(ctx.organizationId, db),
    db
      .select({
        id: contractObligations.id,
        description: contractObligations.description,
        responsibleId: contractObligations.responsibleId,
        responsibleName: obligationResponsible.name,
        dueDate: contractObligations.dueDate,
        recurrence: contractObligations.recurrence,
        status: contractObligations.status,
        origin: contractObligations.origin,
        sourceAnalysisId: contractObligations.sourceAnalysisId,
        createdAt: contractObligations.createdAt,
        updatedAt: contractObligations.updatedAt,
      })
      .from(contractObligations)
      .leftJoin(obligationResponsible, eq(obligationResponsible.id, contractObligations.responsibleId))
      .where(and(eq(contractObligations.contractId, c.id), eq(contractObligations.organizationId, ctx.organizationId)))
      .orderBy(sql`${contractObligations.dueDate} asc nulls last`, asc(contractObligations.createdAt)),
    c.linkedProcessId
      ? db
          .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
          .from(legalProcesses)
          .where(and(eq(legalProcesses.id, c.linkedProcessId), processWhere(ctx)))
      : Promise.resolve([]),
    c.linkedOccurrenceId
      ? db
          .select({ id: occurrences.id, title: occurrences.title })
          .from(occurrences)
          .where(and(eq(occurrences.id, c.linkedOccurrenceId), occurrenceWhere(ctx)))
      : Promise.resolve([]),
  ]);

  const obligations: ContractObligationItem[] = obligationRows.map((o) => {
    const plan = planNextOccurrence(o, c);
    return {
      ...o,
      recurrenceKind: plan.kind,
      effectiveStatus: effectiveObligationStatus(o.status, o.dueDate, today),
      nextDueDate: plan.nextDueDate,
      nextBlockedReason: plan.blockedReason,
    };
  });
  // Already ordered by due date (undated last): the first open one is the next.
  const open = obligations.filter((o) => isOpenObligation(o.status));
  const next = open[0] ?? null;

  const linkedProcess: LinkedRecordSummary | null = c.linkedProcessId
    ? process[0]
      ? { id: process[0].id, label: `${process[0].number} — ${process[0].title}`, visible: true }
      : { id: c.linkedProcessId, label: "Processo vinculado (sem acesso)", visible: false }
    : null;
  const linkedOccurrence: LinkedRecordSummary | null = c.linkedOccurrenceId
    ? occurrence[0]
      ? { id: occurrence[0].id, label: occurrence[0].title, visible: true }
      : { id: c.linkedOccurrenceId, label: "Ocorrência vinculada (sem acesso)", visible: false }
    : null;

  return {
    id: c.id,
    title: c.title,
    counterparty: c.counterparty,
    counterpartyDocument: c.counterpartyDocument,
    type: c.type,
    status: c.status,
    startDate: c.startDate,
    endDate: c.endDate,
    renewalType: c.renewalType,
    renewalNoticeDays: c.renewalNoticeDays,
    valueCents: c.valueCents,
    riskLevel: c.riskLevel,
    isConfidential: c.isConfidential,
    responsibleId: c.responsibleId,
    responsibleName: row.responsibleName,
    unitId: c.unitId,
    unitName: row.unitName,
    description: c.description,
    linkedProcessId: c.linkedProcessId,
    linkedOccurrenceId: c.linkedOccurrenceId,
    linkedProcess,
    linkedOccurrence,
    legalHold: c.legalHold,
    createdById: c.createdById,
    createdByName: row.createdByName,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    pendingObligations: open.length,
    overdueObligations: open.filter((o) => o.effectiveStatus === "overdue").length,
    nextObligation: next ? { id: next.id, description: next.description, dueDate: next.dueDate, status: next.effectiveStatus } : null,
    vigency: contractVigencyState(c, today, days),
    daysToEnd: daysToEnd(c.endDate, today),
    notice: contractNoticeInfo(c, today, days),
    noticeDeadline: noticeDeadline(c.endDate, c.renewalNoticeDays),
    expirationDays: days,
    obligations,
  };
}

/** Options for selects in other modules (documents, deadlines, ...). */
export async function listContractOptions(ctx: AuthContext): Promise<{ id: string; title: string; counterparty: string }[]> {
  assertCan(ctx, "contract:read");
  return getDb()
    .select({ id: contracts.id, title: contracts.title, counterparty: contracts.counterparty })
    .from(contracts)
    .where(contractWhere(ctx))
    .orderBy(asc(contracts.title))
    .limit(1000);
}

/** Documents linked to the contract that ctx can see (aditivo / distrato selects). */
export async function listContractDocumentOptions(ctx: AuthContext, contractId: string): Promise<ContractDocumentOption[]> {
  assertCan(ctx, "contract:read");
  const contract = await loadContract(ctx, contractId);
  if (!can(ctx, "document:read")) return [];
  return getDb()
    .select({ id: documents.id, title: documents.title, category: documents.category })
    .from(documents)
    .where(and(eq(documents.contractId, contract.id), documentWhere(ctx)))
    .orderBy(desc(documents.createdAt))
    .limit(200);
}

/** Renewals and terminations of a visible contract, most recent first (read from the audit trail). */
export async function listContractLifecycle(ctx: AuthContext, contractId: string): Promise<ContractLifecycleEvent[]> {
  assertCan(ctx, "contract:read");
  const contract = await loadContract(ctx, contractId);
  const db = getDb();
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      actorName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, and(eq(users.id, auditLogs.actorId), eq(users.organizationId, ctx.organizationId)))
    .where(
      and(
        eq(auditLogs.organizationId, ctx.organizationId),
        eq(auditLogs.entityType, "contract"),
        eq(auditLogs.entityId, contract.id),
        inArray(auditLogs.action, Object.keys(LIFECYCLE_ACTIONS)),
      ),
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(100);

  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const docIds = [
    ...new Set(
      rows
        .map((r) => str(r.metadata?.amendmentDocumentId) ?? str(r.metadata?.documentId))
        .filter((v): v is string => v !== null && idSchema.safeParse(v).success),
    ),
  ];
  const visibleDocs = new Map<string, string>();
  if (docIds.length > 0 && can(ctx, "document:read")) {
    const docs = await db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(and(inArray(documents.id, docIds), documentWhere(ctx)));
    for (const d of docs) visibleDocs.set(d.id, d.title);
  }

  return rows.map((r) => {
    const m = r.metadata ?? {};
    const docId = str(m.amendmentDocumentId) ?? str(m.documentId);
    const title = docId ? visibleDocs.get(docId) : undefined;
    return {
      id: r.id,
      kind: LIFECYCLE_ACTIONS[r.action as keyof typeof LIFECYCLE_ACTIONS],
      createdAt: r.createdAt,
      actorName: r.actorName,
      previousEndDate: str(m.previousEndDate),
      newEndDate: str(m.newEndDate),
      terminationDate: str(m.terminationDate),
      document: docId ? { id: docId, title: title ?? "Documento (sem acesso)", visible: title !== undefined } : null,
      note: str(m.note),
    };
  });
}

// ---------------------------------------------------------------------------
// Contracts: writes
// ---------------------------------------------------------------------------

export async function createContract(ctx: AuthContext, input: ContractInput): Promise<{ id: string }> {
  assertCan(ctx, "contract:write");
  const data = parseOrThrow(contractInputSchema, input);
  if (data.isConfidential && !seesConfidential(ctx)) {
    throw new ValidationError("Verifique os campos informados.", { isConfidential: [CONFIDENTIAL_ERROR] });
  }

  return getDb().transaction(async (tx) => {
    await validateContractReferences(ctx, data, null, tx);
    const [created] = await tx
      .insert(contracts)
      .values({ ...data, organizationId: ctx.organizationId, createdById: ctx.userId })
      .returning({ id: contracts.id });
    await recordAudit(
      ctx,
      {
        action: "contract.create",
        entityType: "contract",
        entityId: created.id,
        summary: `Contrato "${data.title}" cadastrado.`,
        changes: diffChanges(null, data, CONTRACT_AUDIT_FIELDS),
      },
      tx,
    );
    return { id: created.id };
  });
}

export async function updateContract(ctx: AuthContext, id: string, input: ContractInput): Promise<void> {
  assertCan(ctx, "contract:write");
  const data = parseOrThrow(contractInputSchema, input);

  await getDb().transaction(async (tx) => {
    const before = await loadContract(ctx, id, tx);
    if (data.isConfidential !== before.isConfidential && !seesConfidential(ctx)) {
      throw new ValidationError("Verifique os campos informados.", { isConfidential: [CONFIDENTIAL_ERROR] });
    }
    await validateContractReferences(ctx, data, before, tx);

    const changes = diffChanges(before, data, CONTRACT_AUDIT_FIELDS);
    if (!changes) return;

    await tx
      .update(contracts)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(contracts.id, before.id), eq(contracts.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "contract.update",
        entityType: "contract",
        entityId: before.id,
        summary: `Contrato "${data.title}" atualizado.`,
        changes,
      },
      tx,
    );
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: before.id, reason: "Dados do contrato alterados." },
      tx,
    );
  });
}

/** Soft delete. Blocked while the contract is under legal hold. */
export async function deleteContract(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "contract:delete");
  await getDb().transaction(async (tx) => {
    const before = await loadContract(ctx, id, tx);
    if (before.legalHold) {
      throw new ConflictError("Este contrato está sob retenção legal (legal hold) e não pode ser excluído.");
    }
    await tx
      .update(contracts)
      .set({ deletedAt: new Date() })
      .where(and(eq(contracts.id, before.id), eq(contracts.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "contract.delete",
        entityType: "contract",
        entityId: before.id,
        summary: `Contrato "${before.title}" excluído.`,
      },
      tx,
    );
  });
}

/**
 * "Registrar renovação": moves the end date forward (active or expired
 * contracts with an end date), reactivates an expired contract and optionally
 * links the aditivo document. Audited as `contract.renew` (the renewal history
 * shown on the contract page reads these entries).
 */
export async function renewContract(ctx: AuthContext, id: string, input: RenewContractInput): Promise<void> {
  assertCan(ctx, "contract:write");
  const data = parseOrThrow(renewContractSchema, input);

  await getDb().transaction(async (tx) => {
    const before = await loadContract(ctx, id, tx);
    if (before.status !== "active" && before.status !== "expired") {
      throw new ConflictError("Somente contratos vigentes ou expirados podem ter a renovação registrada.");
    }
    if (!before.endDate) {
      throw new ConflictError(
        "Contrato por prazo indeterminado: não há término a renovar. Edite o contrato para informar a vigência.",
      );
    }
    if (data.newEndDate <= before.endDate) {
      throw new ValidationError("Verifique os campos informados.", {
        newEndDate: [`A nova data de término deve ser posterior ao término atual (${formatDate(before.endDate)}).`],
      });
    }
    const document = data.amendmentDocumentId
      ? await assertContractDocument(ctx, before.id, data.amendmentDocumentId, "amendmentDocumentId", tx)
      : null;

    const after = { endDate: data.newEndDate, status: "active" as const };
    await tx
      .update(contracts)
      .set({ ...after, updatedAt: new Date() })
      .where(and(eq(contracts.id, before.id), eq(contracts.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "contract.renew",
        entityType: "contract",
        entityId: before.id,
        summary: `Renovação registrada: término de ${formatDate(before.endDate)} para ${formatDate(data.newEndDate)}.`,
        changes: diffChanges(before, after, ["endDate", "status"]),
        metadata: {
          previousEndDate: before.endDate,
          newEndDate: data.newEndDate,
          amendmentDocumentId: document?.id ?? null,
          note: data.note,
        },
      },
      tx,
    );
    await resolveAlertsByDedupeKeys(ctx.organizationId, [`contract_expiring:${before.id}`], tx);
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: before.id, reason: "Renovação do contrato registrada." },
      tx,
    );
  });
}

/**
 * "Registrar rescisão": status `terminated` and end date = effective date of
 * the termination (never after the current end date). Optional distrato /
 * notificação document of the contract. Open obligations are kept (they may
 * still be due) and listed by the UI.
 */
export async function terminateContract(ctx: AuthContext, id: string, input: TerminateContractInput): Promise<void> {
  assertCan(ctx, "contract:write");
  const data = parseOrThrow(terminateContractSchema, input);

  await getDb().transaction(async (tx) => {
    const before = await loadContract(ctx, id, tx);
    if (before.status === "terminated") throw new ConflictError("O contrato já está rescindido.");
    if (before.status !== "active") {
      throw new ConflictError("Somente contratos vigentes podem ter a rescisão registrada.");
    }
    if (before.startDate && data.terminationDate < before.startDate) {
      throw new ValidationError("Verifique os campos informados.", {
        terminationDate: [`A rescisão não pode ser anterior ao início da vigência (${formatDate(before.startDate)}).`],
      });
    }
    if (before.endDate && data.terminationDate > before.endDate) {
      throw new ValidationError("Verifique os campos informados.", {
        terminationDate: [`A rescisão não pode ser posterior ao término da vigência (${formatDate(before.endDate)}).`],
      });
    }
    const document = data.documentId ? await assertContractDocument(ctx, before.id, data.documentId, "documentId", tx) : null;
    const openObligations = await tx
      .select({ id: contractObligations.id })
      .from(contractObligations)
      .where(
        and(
          eq(contractObligations.contractId, before.id),
          eq(contractObligations.organizationId, ctx.organizationId),
          inArray(contractObligations.status, OPEN_STATUSES),
        ),
      );

    const after = { status: "terminated" as const, endDate: data.terminationDate };
    await tx
      .update(contracts)
      .set({ ...after, updatedAt: new Date() })
      .where(and(eq(contracts.id, before.id), eq(contracts.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "contract.terminate",
        entityType: "contract",
        entityId: before.id,
        summary: `Rescisão registrada com efeito em ${formatDate(data.terminationDate)}.`,
        changes: diffChanges(before, after, ["status", "endDate"]),
        metadata: {
          previousEndDate: before.endDate,
          terminationDate: data.terminationDate,
          documentId: document?.id ?? null,
          note: data.note,
          openObligations: openObligations.length,
        },
      },
      tx,
    );
    await resolveAlertsByDedupeKeys(
      ctx.organizationId,
      [`contract_expiring:${before.id}`, ...openObligations.map((o) => `obligation_due:${o.id}`)],
      tx,
    );
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: before.id, reason: "Rescisão do contrato registrada." },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------

export async function addObligation(ctx: AuthContext, contractId: string, input: ObligationInput): Promise<{ id: string }> {
  assertCan(ctx, "contract:write");
  const data = parseOrThrow(obligationInputSchema, input);

  return getDb().transaction(async (tx) => {
    const contract = await loadContract(ctx, contractId, tx);
    if (data.responsibleId) await assertUserInOrg(ctx, data.responsibleId, "responsibleId", tx);
    const [created] = await tx
      .insert(contractObligations)
      .values({
        ...data,
        organizationId: ctx.organizationId,
        contractId: contract.id,
        origin: "manual",
        createdById: ctx.userId,
      })
      .returning({ id: contractObligations.id });
    await recordAudit(
      ctx,
      {
        action: "contract_obligation.create",
        entityType: "contract",
        entityId: contract.id,
        summary: `Obrigação adicionada ao contrato "${contract.title}".`,
        changes: diffChanges(null, data, OBLIGATION_AUDIT_FIELDS),
        metadata: { obligationId: created.id },
      },
      tx,
    );
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: contract.id, reason: "Obrigações do contrato alteradas." },
      tx,
    );
    return { id: created.id };
  });
}

export async function updateObligation(ctx: AuthContext, obligationId: string, patch: ObligationPatch): Promise<void> {
  assertCan(ctx, "contract:write");
  const data = parseOrThrow(obligationPatchSchema, patch);

  await getDb().transaction(async (tx) => {
    const { obligation: before, contractTitle } = await loadObligation(ctx, obligationId, tx);
    if (data.responsibleId && data.responsibleId !== before.responsibleId) {
      await assertUserInOrg(ctx, data.responsibleId, "responsibleId", tx);
    }
    const set = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Partial<
      typeof contractObligations.$inferInsert
    >;
    const changes = diffChanges(before, set, OBLIGATION_AUDIT_FIELDS.filter((k) => k in set));
    if (!changes) return;

    await tx
      .update(contractObligations)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(contractObligations.id, before.id), eq(contractObligations.organizationId, ctx.organizationId)));
    const statusOnly = Object.keys(changes).length === 1 && "status" in changes;
    await recordAudit(
      ctx,
      {
        action: statusOnly ? "contract_obligation.status_change" : "contract_obligation.update",
        entityType: "contract",
        entityId: before.contractId,
        summary: statusOnly
          ? `Situação de obrigação do contrato "${contractTitle}" alterada.`
          : `Obrigação do contrato "${contractTitle}" atualizada.`,
        changes,
        metadata: { obligationId: before.id },
      },
      tx,
    );
    if (set.status && !isOpenObligation(set.status)) {
      await resolveAlertsByDedupeKeys(ctx.organizationId, [`obligation_due:${before.id}`], tx);
    }
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: before.contractId, reason: "Obrigações do contrato alteradas." },
      tx,
    );
  });
}

/**
 * Marks an open obligation as fulfilled. With `generateNext`, a recurring
 * obligation (mensal/trimestral/semestral/anual) gets its next occurrence
 * (same description, responsible and recurrence; due date + period, never past
 * the contract end date). Idempotent for the next occurrence: an identical open
 * one is reused.
 */
export async function fulfillObligation(
  ctx: AuthContext,
  obligationId: string,
  opts: { generateNext?: boolean } = {},
): Promise<{ contractId: string; nextObligationId: string | null; nextDueDate: string | null }> {
  assertCan(ctx, "contract:write");

  return getDb().transaction(async (tx) => {
    const { obligation: before, contract } = await loadObligation(ctx, obligationId, tx);
    if (!isOpenObligation(before.status)) {
      throw new ConflictError("Esta obrigação já está encerrada (cumprida ou dispensada).");
    }

    let nextId: string | null = null;
    let nextDue: string | null = null;
    if (opts.generateNext) {
      const plan = planNextOccurrence(before, contract);
      if (plan.kind === "none" || plan.kind === "custom") {
        throw new ValidationError(
          "Esta obrigação não tem recorrência reconhecida (mensal, trimestral, semestral ou anual). Edite a recorrência para gerar a próxima ocorrência.",
        );
      }
      if (!plan.nextDueDate || plan.blockedReason) {
        throw new ConflictError(plan.blockedReason ?? "Não foi possível calcular a próxima ocorrência.");
      }
      nextDue = plan.nextDueDate;

      const [existing] = await tx
        .select({ id: contractObligations.id })
        .from(contractObligations)
        .where(
          and(
            eq(contractObligations.contractId, contract.id),
            eq(contractObligations.organizationId, ctx.organizationId),
            eq(contractObligations.description, before.description),
            eq(contractObligations.dueDate, nextDue),
            inArray(contractObligations.status, OPEN_STATUSES),
            ne(contractObligations.id, before.id),
          ),
        )
        .limit(1);
      if (existing) {
        nextId = existing.id;
      } else {
        let responsibleId = before.responsibleId;
        if (responsibleId) {
          const [u] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, responsibleId), eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)));
          if (!u) responsibleId = null;
        }
        const [created] = await tx
          .insert(contractObligations)
          .values({
            organizationId: ctx.organizationId,
            contractId: contract.id,
            description: before.description,
            responsibleId,
            dueDate: nextDue,
            recurrence: before.recurrence,
            status: "pending",
            origin: "system",
            createdById: ctx.userId,
          })
          .returning({ id: contractObligations.id });
        nextId = created.id;
      }
    }

    await tx
      .update(contractObligations)
      .set({ status: "fulfilled", updatedAt: new Date() })
      .where(and(eq(contractObligations.id, before.id), eq(contractObligations.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "contract_obligation.fulfill",
        entityType: "contract",
        entityId: contract.id,
        summary: nextDue
          ? `Obrigação do contrato "${contract.title}" cumprida; próxima ocorrência para ${formatDate(nextDue)}.`
          : `Obrigação do contrato "${contract.title}" cumprida.`,
        changes: { status: { from: before.status, to: "fulfilled" } },
        metadata: { obligationId: before.id, nextObligationId: nextId, nextDueDate: nextDue },
      },
      tx,
    );
    await resolveAlertsByDedupeKeys(ctx.organizationId, [`obligation_due:${before.id}`], tx);
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: contract.id, reason: "Obrigações do contrato alteradas." },
      tx,
    );
    return { contractId: contract.id, nextObligationId: nextId, nextDueDate: nextDue };
  });
}

export async function removeObligation(ctx: AuthContext, obligationId: string): Promise<{ contractId: string }> {
  assertCan(ctx, "contract:write");
  return getDb().transaction(async (tx) => {
    const { obligation: before, contractTitle } = await loadObligation(ctx, obligationId, tx);
    await tx
      .delete(contractObligations)
      .where(and(eq(contractObligations.id, before.id), eq(contractObligations.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "contract_obligation.delete",
        entityType: "contract",
        entityId: before.contractId,
        summary: `Obrigação removida do contrato "${contractTitle}".`,
        metadata: { obligationId: before.id, origin: before.origin },
      },
      tx,
    );
    await resolveAlertsByDedupeKeys(ctx.organizationId, [`obligation_due:${before.id}`], tx);
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: before.contractId, reason: "Obrigações do contrato alteradas." },
      tx,
    );
    return { contractId: before.contractId };
  });
}

/** Contract id of an obligation visible to ctx (used by actions to revalidate the right page). */
export async function getObligationContractId(ctx: AuthContext, obligationId: string): Promise<string> {
  assertCan(ctx, "contract:read");
  const { obligation } = await loadObligation(ctx, obligationId);
  return obligation.contractId;
}
