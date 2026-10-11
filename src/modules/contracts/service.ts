import { and, asc, count, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type {
  ContractStatus,
  ContractType,
  DataOrigin,
  ObligationStatus,
  RenewalType,
  RiskLevel,
} from "@/domain/enums";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import { addDaysISO, maskDocument, todayISO } from "@/lib/format";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import type { AuthContext } from "@/server/auth/context";
import { contractWhere, occurrenceWhere, processWhere, seesConfidential } from "@/server/auth/access";
import { assertCan } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  contractObligations,
  contracts,
  DEFAULT_ORGANIZATION_SETTINGS,
  legalProcesses,
  occurrences,
  organizations,
  units,
  users,
} from "@/server/db/schema";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import {
  contractInputSchema,
  idSchema,
  listContractsSchema,
  obligationInputSchema,
  obligationPatchSchema,
  type ContractData,
  type ContractInput,
  type ListContractsFilters,
  type ObligationInput,
  type ObligationPatch,
} from "./schemas";
import { contractVigencyState, daysToEnd, noticeDeadline, type VigencyState } from "./vigencia";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  pendingObligations: number;
  vigency: VigencyState;
  daysToEnd: number | null;
};

export type ContractObligationItem = {
  id: string;
  description: string;
  responsibleId: string | null;
  responsibleName: string | null;
  dueDate: string | null;
  recurrence: string | null;
  status: ObligationStatus;
  origin: DataOrigin;
  sourceAnalysisId: string | null;
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
  /** Organization setting used to compute the "vencendo" state. */
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
  /** Pending or overdue obligations of visible contracts. */
  pendingObligations: number;
  expirationDays: number;
};

export type ContractListFilters = ListContractsFilters & {
  /** Status "expired" or active with end date in the past (module-specific URL param `vencidos=1`). */
  overdue?: boolean;
} & Page;

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

const OPEN_OBLIGATION_STATUSES: ObligationStatus[] = ["pending", "overdue"];

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
    .select({ obligation: contractObligations, contractTitle: contracts.title })
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
  return row;
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

// ---------------------------------------------------------------------------
// Contracts: reads
// ---------------------------------------------------------------------------

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
  const where = and(...conds);

  const responsible = alias(users, "contract_responsible");
  const pendingObligations = sql<number>`(
    select count(*) from ${contractObligations}
    where ${contractObligations.contractId} = ${contracts.id}
      and ${contractObligations.status} in ('pending', 'overdue')
  )`.mapWith(Number);

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
        pendingObligations,
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

  return {
    items: rows.map(({ counterpartyDocument, ...r }) => ({
      ...r,
      counterpartyDocumentMasked: counterpartyDocument ? maskDocument(counterpartyDocument) : null,
      vigency: contractVigencyState(r, today, days),
      daysToEnd: daysToEnd(r.endDate, today),
    })),
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
      })
      .from(contracts)
      .where(scope),
    db
      .select({ n: count() })
      .from(contractObligations)
      .innerJoin(contracts, eq(contracts.id, contractObligations.contractId))
      .where(
        and(
          scope,
          eq(contractObligations.organizationId, ctx.organizationId),
          inArray(contractObligations.status, OPEN_OBLIGATION_STATUSES),
        ),
      ),
  ]);

  return {
    active: counts?.active ?? 0,
    expiring: counts?.expiring ?? 0,
    expired: counts?.expired ?? 0,
    pendingObligations: Number(obligations?.n ?? 0),
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
  const [days, obligations, process, occurrence] = await Promise.all([
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
    pendingObligations: obligations.filter((o) => OPEN_OBLIGATION_STATUSES.includes(o.status)).length,
    vigency: contractVigencyState(c, today, days),
    daysToEnd: daysToEnd(c.endDate, today),
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
    await markAnalysesStaleForEntity(
      { organizationId: ctx.organizationId, entityId: before.contractId, reason: "Obrigações do contrato alteradas." },
      tx,
    );
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
