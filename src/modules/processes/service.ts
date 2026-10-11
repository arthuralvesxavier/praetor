/**
 * Litigation management (contencioso): legal processes, their parties and the
 * manual/imported timeline of movements.
 *
 * Conventions (docs/dev/MODULE_CONTRACTS.md): ctx first, assertCan, row
 * visibility through `processWhere(ctx)` on every query, zod validation of
 * every input, foreign ids checked against the organization, mutations in a
 * transaction with `recordAudit`. No tribunal integration exists: numbers are
 * stored as informed (only the CNJ *shape* is checked, for display) and
 * movements are typed by users or imported from an informed source.
 */
import { and, asc, count, desc, eq, exists, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import {
  PARTY_ROLE_LABELS,
  PROCESS_EVENT_TYPE_LABELS,
  type DataOrigin,
  type LegalArea,
  type LossProbability,
  type PartyRole,
  type ProcessEventType,
  type ProcessPhase,
  type ProcessStatus,
  type RiskLevel,
} from "@/domain/enums";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import { linkOccurrenceToProcess } from "@/modules/occurrences/service";
import { deadlineWhere, occurrenceWhere, processWhere, seesConfidential } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  deadlines,
  legalProcesses,
  occurrences,
  processEvents,
  processParties,
  units,
  users,
} from "@/server/db/schema";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { diffChanges, recordAudit } from "@/server/services/audit";
import {
  areaFromOccurrenceCategory,
  createProcessSchema,
  isCnjNumberFormat,
  partyInputSchema,
  PROCESS_FIELD_LABELS,
  processEventInputSchema,
  processFiltersSchema,
  updateProcessSchema,
  type CreateProcessInput,
  type PartyInput,
  type ProcessEventInput,
  type ProcessFilters,
  type UpdateProcessInput,
} from "./schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProcessRow = typeof legalProcesses.$inferSelect;

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
  status: ProcessStatus;
  riskLevel: RiskLevel;
  claimAmountCents: number | null;
  responsibleId: string | null;
  responsibleName: string | null;
  unitId: string | null;
  unitName: string | null;
  dataOrigin: DataOrigin;
  isConfidential: boolean;
  /** Open deadlines that count as real (manual or validated; pending AI suggestions excluded). */
  openDeadlineCount: number;
  nextDeadlineDate: string | null;
  updatedAt: Date;
};

export type ProcessPartyItem = {
  id: string;
  name: string;
  role: PartyRole;
  /** Digits only (CPF/CNPJ). Personal data: mask it in lists (`maskDocument`). */
  documentNumber: string | null;
  isClient: boolean;
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
  createdByName: string | null;
  createdAt: Date;
  /** Only manually registered movements can be removed; imported ones are read-only. */
  removable: boolean;
};

export type ProcessDetail = ProcessRow & {
  isCnjFormat: boolean;
  responsibleName: string | null;
  unitName: string | null;
  createdByName: string | null;
  parties: ProcessPartyItem[];
  events: ProcessEventItem[];
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
  "provisionAmountCents",
  "riskLevel",
  "lossProbability",
  "riskRationale",
  "description",
  "isConfidential",
] as const;

/** Changes to these fields make previous AI analyses of the process outdated. */
const STALE_FIELDS = new Set<string>(AUDIT_FIELDS.filter((f) => f !== "isConfidential"));

const PARTY_AUDIT_FIELDS = ["name", "role", "documentNumber", "isClient", "counselName"] as const;

const isUuid = (v: unknown): v is string => typeof v === "string" && z.uuid().safeParse(v).success;

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

function fieldList(keys: readonly string[]): string {
  return keys.map((k) => PROCESS_FIELD_LABELS[k] ?? k).join(", ");
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
  const where = and(
    processWhere(ctx),
    f.q ? searchCondition(f.q) : undefined,
    f.status ? eq(p.status, f.status) : undefined,
    f.area ? eq(p.area, f.area) : undefined,
    f.phase ? eq(p.phase, f.phase) : undefined,
    f.riskLevel ? eq(p.riskLevel, f.riskLevel) : undefined,
    f.unitId ? eq(p.unitId, f.unitId) : undefined,
    f.responsibleId ? eq(p.responsibleId, f.responsibleId) : undefined,
  );

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
      status: p.status,
      riskLevel: p.riskLevel,
      claimAmountCents: p.claimAmountCents,
      responsibleId: p.responsibleId,
      responsibleName: users.name,
      unitId: p.unitId,
      unitName: units.name,
      dataOrigin: p.dataOrigin,
      isConfidential: p.isConfidential,
      updatedAt: p.updatedAt,
    })
    .from(p)
    .leftJoin(users, and(eq(users.id, p.responsibleId), eq(users.organizationId, ctx.organizationId)))
    .leftJoin(units, and(eq(units.id, p.unitId), eq(units.organizationId, ctx.organizationId)))
    .where(where)
    .orderBy(desc(p.updatedAt), desc(p.id))
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
      isCnjFormat: isCnjNumberFormat(r.number),
      openDeadlineCount: stats.get(r.id)?.open ?? 0,
      nextDeadlineDate: stats.get(r.id)?.next ?? null,
    })),
    total: Number(total),
    page,
    pageSize,
  };
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

export async function getProcess(ctx: AuthContext, id: string): Promise<ProcessDetail> {
  assertCan(ctx, "process:read");
  const row = await loadProcess(ctx, id);
  const db = getDb();

  const [parties, events, unit] = await Promise.all([
    db
      .select()
      .from(processParties)
      .where(and(eq(processParties.processId, row.id), eq(processParties.organizationId, ctx.organizationId)))
      .orderBy(asc(processParties.role), asc(processParties.name)),
    db
      .select()
      .from(processEvents)
      .where(and(eq(processEvents.processId, row.id), eq(processEvents.organizationId, ctx.organizationId)))
      .orderBy(desc(processEvents.occurredAt), desc(processEvents.createdAt)),
    row.unitId
      ? db
          .select({ name: units.name })
          .from(units)
          .where(and(eq(units.id, row.unitId), eq(units.organizationId, ctx.organizationId)))
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  const names = await userNameMap(ctx.organizationId, [
    row.responsibleId,
    row.createdById,
    ...events.map((e) => e.createdById),
  ]);
  const canEdit = can(ctx, "process:write");

  return {
    ...row,
    isCnjFormat: isCnjNumberFormat(row.number),
    responsibleName: row.responsibleId ? (names.get(row.responsibleId) ?? null) : null,
    unitName: unit?.name ?? null,
    createdByName: row.createdById ? (names.get(row.createdById) ?? null) : null,
    parties: parties.map((pt) => ({
      id: pt.id,
      name: pt.name,
      role: pt.role,
      documentNumber: pt.documentNumber,
      isClient: pt.isClient,
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
      createdByName: e.createdById ? (names.get(e.createdById) ?? null) : null,
      createdAt: e.createdAt,
      removable: canEdit && e.origin === "manual",
    })),
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
// Process mutations
// ---------------------------------------------------------------------------

export async function createProcess(
  ctx: AuthContext,
  input: CreateProcessInput,
): Promise<{ id: string; occurrenceLinkError: string | null }> {
  assertCan(ctx, "process:write");
  const v = parse(createProcessSchema, input);

  await assertNumberAvailable(ctx, v.number);
  if (v.unitId) await assertUnitOfOrganization(ctx, v.unitId);
  if (v.responsibleId) await assertActiveUserOfOrganization(ctx, v.responsibleId);
  const origin = v.fromOccurrenceId ? await loadVisibleOccurrence(ctx, v.fromOccurrenceId) : null;

  // A process created from a confidential occurrence carries the same facts:
  // it stays confidential unless an admin / legal manager decides otherwise.
  const isConfidential = canEditProcessConfidentiality(ctx)
    ? (v.isConfidential ?? origin?.isConfidential ?? false)
    : (origin?.isConfidential ?? false);

  const values = {
    organizationId: ctx.organizationId,
    number: v.number,
    title: v.title,
    court: v.court,
    courtDivision: v.courtDivision ?? null,
    jurisdiction: v.jurisdiction ?? null,
    area: v.area,
    phase: v.phase,
    status: v.status ?? "active",
    filedAt: v.filedAt ?? null,
    closedAt: v.closedAt ?? null,
    unitId: v.unitId ?? null,
    responsibleId: v.responsibleId ?? null,
    claimAmountCents: v.claimAmountCents ?? null,
    provisionAmountCents: v.provisionAmountCents ?? null,
    riskLevel: v.riskLevel ?? "medium",
    lossProbability: (v.lossProbability ?? null) as LossProbability | null,
    riskRationale: v.riskRationale ?? null,
    description: v.description ?? null,
    isConfidential,
    dataOrigin: "manual" as const,
    createdById: ctx.userId,
  } satisfies typeof legalProcesses.$inferInsert;

  let created: ProcessRow;
  try {
    created = await getDb().transaction(async (tx) => {
      const [row] = await tx.insert(legalProcesses).values(values).returning();
      await recordAudit(
        ctx,
        {
          action: "legal_process.create",
          entityType: "legal_process",
          entityId: row.id,
          summary: `Processo ${row.number} cadastrado.`,
          changes: diffChanges(null, row, AUDIT_FIELDS),
          metadata: v.fromOccurrenceId ? { fromOccurrenceId: v.fromOccurrenceId } : undefined,
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

/**
 * Partial update. Imported processes stay `dataOrigin: "imported"`; the audit
 * entry records that the change was made manually.
 */
export async function updateProcess(ctx: AuthContext, id: string, input: UpdateProcessInput): Promise<void> {
  assertCan(ctx, "process:write");
  const v = parse(updateProcessSchema, input);
  const before = await loadProcess(ctx, id);

  const patch: Partial<typeof legalProcesses.$inferInsert> = {};
  const assignable = AUDIT_FIELDS.filter((k) => k !== "isConfidential");
  for (const key of assignable) {
    const value = v[key];
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  if (v.isConfidential !== undefined && canEditProcessConfidentiality(ctx)) {
    patch.isConfidential = v.isConfidential;
  }

  const filedAt = patch.filedAt !== undefined ? patch.filedAt : before.filedAt;
  const closedAt = patch.closedAt !== undefined ? patch.closedAt : before.closedAt;
  if (filedAt && closedAt && closedAt < filedAt) {
    throw fieldError("closedAt", "A data de encerramento não pode ser anterior à distribuição.");
  }
  if (patch.number !== undefined && patch.number !== before.number) {
    await assertNumberAvailable(ctx, patch.number, before.id);
  }
  if (patch.unitId && patch.unitId !== before.unitId) await assertUnitOfOrganization(ctx, patch.unitId);
  if (patch.responsibleId && patch.responsibleId !== before.responsibleId) {
    await assertActiveUserOfOrganization(ctx, patch.responsibleId);
  }

  const after = { ...before, ...patch } as Record<string, unknown>;
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
          metadata: { dataOrigin: before.dataOrigin, manualChange: true },
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
        changes: diffChanges(null, row, ["occurredAt", "type", "title"]),
        metadata: { eventId: row.id },
      },
      tx,
    );
    // Touch the process so it surfaces as recently updated in the list.
    await tx
      .update(legalProcesses)
      .set({ updatedAt: new Date() })
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
