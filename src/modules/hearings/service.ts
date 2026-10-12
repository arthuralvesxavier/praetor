/**
 * Audiências e pauta (RF-13).
 *
 * Rules:
 * - Visibility is inherited from the process (`hearingWhere`, rule 11 of access.ts).
 * - Reads require `process:read`; writes require `process:write` on a visible process.
 * - Hearings are entered by people (from the intimação or the published schedule). The
 *   DataJud collection only raises an alert when a tribunal designates a hearing (the
 *   date is not provided); PJe and MNI are not integrated.
 * - Date and time are typed in America/Sao_Paulo and stored as a timestamp.
 * - Status flow: scheduled → held (with outcome) | cancelled | rescheduled (the old
 *   hearing is kept as `rescheduled` and a new `scheduled` one is created; both audited).
 * - Free text (notes, outcome, meeting links) is never written to the audit trail.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { cnjDigits, normalizeCnj } from "@/domain/cnj";
import { normalizePage, type Paginated } from "@/domain/entities";
import {
  HEARING_KIND_LABELS,
  type DataOrigin,
  type HearingKind,
  type HearingMode,
  type HearingStatus,
} from "@/domain/enums";
import { addDaysISO, formatDate, todayISO } from "@/lib/format";
import { canViewScopedRecord, hearingWhere, processWhere, userDirectoryWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { hearings, legalProcesses, users } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { resolveAlertsByDedupeKeys } from "@/modules/alerts/service";
import {
  createHearingSchema,
  hearingFiltersSchema,
  hearingStatusSchema,
  updateHearingSchema,
  type CreateHearingInput,
  type HearingFilters,
  type HearingPeriod,
  type HearingStatusInput,
  type UpdateHearingInput,
} from "./schemas";
import { endOfZonedDayExclusive, formatTime, startOfZonedDay, zonedDateTimeToUtc } from "./time";

export type { CreateHearingInput, HearingFilters, HearingStatusInput, UpdateHearingInput } from "./schemas";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type UpcomingHearing = {
  id: string;
  processId: string;
  processNumber: string;
  processTitle: string;
  kind: HearingKind;
  mode: HearingMode;
  status: HearingStatus;
  scheduledAt: Date;
  location: string | null;
  responsibleName: string | null;
};

export type HearingListItem = {
  id: string;
  processId: string;
  processNumber: string;
  processTitle: string;
  processCourt: string;
  kind: HearingKind;
  mode: HearingMode;
  status: HearingStatus;
  scheduledAt: Date;
  location: string | null;
  meetingUrl: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  notes: string | null;
  /** Result (held), reason (cancelled / rescheduled). */
  outcome: string | null;
  origin: DataOrigin;
  createdAt: Date;
  updatedAt: Date;
  /** Scheduled hearing whose date has passed and whose result was not registered yet. */
  awaitingRecord: boolean;
  /** Current user can edit / change the status (process:write and still scheduled). */
  canManage: boolean;
};

export type HearingCounts = {
  today: number;
  next7Days: number;
  next30Days: number;
  /** Scheduled hearings of the current user from today on. */
  mine: number;
  /** Scheduled hearings in the past without a registered result. */
  awaitingRecord: number;
};

export type HearingUserOption = { id: string; name: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIST_HARD_LIMIT = 200;
const ACTIVE_STATUSES: HearingStatus[] = ["scheduled", "held"];

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(undefined, z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  }
  return result.data;
}

const uuidSchema = z.guid();

function parseIdOrNotFound(id: unknown): string {
  const r = uuidSchema.safeParse(id);
  if (!r.success) throw new NotFoundError("Audiência não encontrada ou sem permissão de acesso.");
  return r.data;
}

/** Dedupe key of the "audiência próxima" alert of a hearing (hearings routine). */
export function hearingAlertKey(hearingId: string): string {
  return `hearing_upcoming:${hearingId}`;
}

/** Timestamp parameter for raw SQL fragments (explicit cast, driver independent). */
function tsParam(d: Date): SQL {
  return sql`${d.toISOString()}::timestamptz`;
}

function describeWhen(at: Date): string {
  return `${formatDate(at)} às ${formatTime(at)}`;
}

const responsibleUser = alias(users, "hearing_responsible");

function selectHearingRows(ctx: AuthContext, where: SQL | undefined) {
  return getDb()
    .select({
      h: hearings,
      processNumber: legalProcesses.number,
      processTitle: legalProcesses.title,
      processCourt: legalProcesses.court,
      responsibleName: responsibleUser.name,
    })
    .from(hearings)
    .innerJoin(legalProcesses, eq(legalProcesses.id, hearings.processId))
    .leftJoin(
      responsibleUser,
      and(eq(responsibleUser.id, hearings.responsibleId), eq(responsibleUser.organizationId, ctx.organizationId)),
    )
    .where(where);
}

type HearingRow = Awaited<ReturnType<typeof selectHearingRows>>[number];

function mapRows(ctx: AuthContext, rows: HearingRow[], now: Date): HearingListItem[] {
  const canWrite = can(ctx, "process:write");
  return rows.map((r) => ({
    id: r.h.id,
    processId: r.h.processId,
    processNumber: r.processNumber,
    processTitle: r.processTitle,
    processCourt: r.processCourt,
    kind: r.h.kind,
    mode: r.h.mode,
    status: r.h.status,
    scheduledAt: r.h.scheduledAt,
    location: r.h.location,
    meetingUrl: r.h.meetingUrl,
    responsibleId: r.h.responsibleId,
    responsibleName: r.responsibleName,
    notes: r.h.notes,
    outcome: r.h.outcome,
    origin: r.h.origin,
    createdAt: r.h.createdAt,
    updatedAt: r.h.updatedAt,
    awaitingRecord: r.h.status === "scheduled" && r.h.scheduledAt.getTime() < now.getTime(),
    canManage: canWrite && r.h.status === "scheduled",
  }));
}

function periodCondition(period: HearingPeriod, now: Date): SQL {
  const today = todayISO(now);
  const startToday = startOfZonedDay(today);
  switch (period) {
    case "upcoming":
      return gte(hearings.scheduledAt, startToday);
    case "past":
      return lt(hearings.scheduledAt, now);
    case "7d":
    case "30d":
    case "90d": {
      const days = Number(period.slice(0, -1));
      return and(gte(hearings.scheduledAt, startToday), lt(hearings.scheduledAt, endOfZonedDayExclusive(addDaysISO(today, days))))!;
    }
  }
}

async function loadProcessForWrite(ctx: AuthContext, db: DbOrTx, processId: string) {
  const [p] = await db
    .select()
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), processWhere(ctx)))
    .limit(1);
  if (!p) {
    throw new ValidationError("Processo não encontrado ou sem permissão de acesso.", {
      processId: ["Processo não encontrado ou sem permissão de acesso."],
    });
  }
  return p;
}

type ProcessRow = Awaited<ReturnType<typeof loadProcessForWrite>>;

/**
 * The responsible person must be an active user of the organization who can see
 * the process (otherwise they could not open the hearing they are responsible for).
 */
async function assertResponsible(ctx: AuthContext, db: DbOrTx, userId: string, process: ProcessRow): Promise<void> {
  const [u] = await db
    .select({ id: users.id, role: users.role, unitId: users.unitId, lawFirmId: users.lawFirmId, name: users.name })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)))
    .limit(1);
  if (!u) {
    throw new ValidationError("Responsável inválido.", { responsibleId: ["Selecione um usuário ativo da organização."] });
  }
  const userCtx: AuthContext = {
    kind: "user",
    userId: u.id,
    organizationId: ctx.organizationId,
    role: u.role,
    unitId: u.unitId,
    lawFirmId: u.lawFirmId,
    name: u.name,
    email: null,
    isDemoOrganization: false,
  };
  if (!can(userCtx, "process:read") || !canViewScopedRecord(userCtx, process)) {
    throw new ValidationError("Responsável sem acesso ao processo.", {
      responsibleId: ["Este usuário não tem acesso ao processo. Escolha outra pessoa ou ajuste o processo antes."],
    });
  }
}

async function loadHearingForWrite(ctx: AuthContext, db: DbOrTx, id: string) {
  const hearingId = parseIdOrNotFound(id);
  const [row] = await db
    .select()
    .from(hearings)
    .where(and(eq(hearings.id, hearingId), hearingWhere(ctx)))
    .limit(1);
  if (!row) throw new NotFoundError("Audiência não encontrada ou sem permissão de acesso.");
  return row;
}

/** Status changes are described in the summary and metadata (the process history labels `status` as a process status). */
const HEARING_AUDIT_FIELDS = ["kind", "mode", "scheduledAt", "location", "responsibleId", "origin"] as const;

function emptyToNull(v: string | null | undefined): string | null {
  return v ? v : null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Agenda. Default period: every hearing from today on. Without a status filter
 * only scheduled and held hearings are listed (rescheduled / cancelled ones
 * appear when filtered by status). Past hearings are listed newest first.
 */
export async function listHearings(ctx: AuthContext, filters: HearingFilters = {}): Promise<Paginated<HearingListItem>> {
  assertCan(ctx, "process:read");
  const f = parseOrThrow(hearingFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const now = new Date();
  const period = f.period ?? "upcoming";

  const where = and(
    hearingWhere(ctx),
    periodCondition(period, now),
    f.status ? eq(hearings.status, f.status) : inArray(hearings.status, ACTIVE_STATUSES),
    f.responsibleId ? eq(hearings.responsibleId, f.responsibleId) : undefined,
    f.processId ? eq(hearings.processId, f.processId) : undefined,
  );

  const [{ total }] = await getDb().select({ total: count() }).from(hearings).where(where);
  const rows = await selectHearingRows(ctx, where)
    .orderBy(period === "past" ? desc(hearings.scheduledAt) : asc(hearings.scheduledAt), asc(hearings.id))
    .limit(pageSize)
    .offset(offset);
  return { items: mapRows(ctx, rows, now), total, page, pageSize };
}

export async function getHearing(ctx: AuthContext, id: string): Promise<HearingListItem> {
  assertCan(ctx, "process:read");
  const hearingId = parseIdOrNotFound(id);
  const rows = await selectHearingRows(ctx, and(eq(hearings.id, hearingId), hearingWhere(ctx))).limit(1);
  if (rows.length === 0) throw new NotFoundError("Audiência não encontrada ou sem permissão de acesso.");
  return mapRows(ctx, rows, new Date())[0];
}

/** Every hearing of a visible process (all statuses), upcoming first, then past ones newest first. */
export async function listProcessHearings(ctx: AuthContext, processId: string): Promise<HearingListItem[]> {
  assertCan(ctx, "process:read");
  const pid = z.guid().safeParse(processId);
  if (!pid.success) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  const [p] = await getDb()
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, pid.data), processWhere(ctx)))
    .limit(1);
  if (!p) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  const now = new Date();
  const start = tsParam(startOfZonedDay(todayISO(now)));
  const rows = await selectHearingRows(ctx, and(hearingWhere(ctx), eq(hearings.processId, p.id)))
    .orderBy(
      sql`case when ${hearings.scheduledAt} >= ${start} then 0 else 1 end`,
      sql`case when ${hearings.scheduledAt} >= ${start} then ${hearings.scheduledAt} end asc`,
      desc(hearings.scheduledAt),
      asc(hearings.id),
    )
    .limit(LIST_HARD_LIMIT);
  return mapRows(ctx, rows, now);
}

function upcomingDays(days: number | undefined): number {
  return Math.min(366, Math.max(0, Math.floor(Number.isFinite(days) ? (days as number) : 30)));
}

/** Scheduled hearings of visible processes within [now, end of today + days). */
function upcomingHearingsWhere(ctx: AuthContext, days: number, now: Date): SQL {
  const until = endOfZonedDayExclusive(addDaysISO(todayISO(now), days));
  return and(
    hearingWhere(ctx),
    eq(hearings.status, "scheduled"),
    gte(hearings.scheduledAt, now),
    lt(hearings.scheduledAt, until),
  )!;
}

/** Scheduled hearings of visible processes from now on (default 30 days, 10 items). Requires `process:read`. */
export async function listUpcomingHearings(
  ctx: AuthContext,
  opts: { days?: number; limit?: number } = {},
): Promise<UpcomingHearing[]> {
  assertCan(ctx, "process:read");
  const days = upcomingDays(opts.days);
  const limit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 10)));
  const rows = await selectHearingRows(ctx, upcomingHearingsWhere(ctx, days, new Date()))
    .orderBy(asc(hearings.scheduledAt), asc(hearings.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.h.id,
    processId: r.h.processId,
    processNumber: r.processNumber,
    processTitle: r.processTitle,
    kind: r.h.kind,
    mode: r.h.mode,
    status: r.h.status,
    scheduledAt: r.h.scheduledAt,
    location: r.h.location,
    responsibleName: r.responsibleName,
  }));
}

/**
 * How many hearings `listUpcomingHearings` would list for the same window
 * (default 30 days), without its 50-item cap. Requires `process:read`.
 */
export async function countUpcomingHearings(ctx: AuthContext, days?: number): Promise<number> {
  assertCan(ctx, "process:read");
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(hearings)
    .where(upcomingHearingsWhere(ctx, upcomingDays(days), new Date()));
  return row?.total ?? 0;
}

/** Indicators of the agenda page (same scope as the list). */
export async function getHearingCounts(ctx: AuthContext): Promise<HearingCounts> {
  assertCan(ctx, "process:read");
  const now = new Date();
  const today = todayISO(now);
  const start = tsParam(startOfZonedDay(today));
  const endToday = tsParam(endOfZonedDayExclusive(today));
  const end7 = tsParam(endOfZonedDayExclusive(addDaysISO(today, 7)));
  const end30 = tsParam(endOfZonedDayExclusive(addDaysISO(today, 30)));
  const nowParam = tsParam(now);
  const scheduled = sql`${hearings.status} = 'scheduled'`;
  const active = sql`${hearings.status} in ('scheduled', 'held')`;
  const [row] = await getDb()
    .select({
      today: sql<number>`count(*) filter (where ${active} and ${hearings.scheduledAt} >= ${start} and ${hearings.scheduledAt} < ${endToday})::int`,
      next7Days: sql<number>`count(*) filter (where ${active} and ${hearings.scheduledAt} >= ${start} and ${hearings.scheduledAt} < ${end7})::int`,
      next30Days: sql<number>`count(*) filter (where ${active} and ${hearings.scheduledAt} >= ${start} and ${hearings.scheduledAt} < ${end30})::int`,
      mine: ctx.userId
        ? sql<number>`count(*) filter (where ${active} and ${hearings.scheduledAt} >= ${start} and ${hearings.responsibleId} = ${ctx.userId})::int`
        : sql<number>`0`,
      awaitingRecord: sql<number>`count(*) filter (where ${scheduled} and ${hearings.scheduledAt} < ${nowParam})::int`,
    })
    .from(hearings)
    .where(hearingWhere(ctx));
  return {
    today: row?.today ?? 0,
    next7Days: row?.next7Days ?? 0,
    next30Days: row?.next30Days ?? 0,
    mine: Number(row?.mine ?? 0),
    awaitingRecord: row?.awaitingRecord ?? 0,
  };
}

/**
 * Active users of the organization who can read processes (responsible select
 * and filter). External counsel only receives the users of their own firm, the
 * responsible people of the processes they see (`userDirectoryWhere`) and the
 * responsible people of the hearings they see — never the whole internal staff.
 */
export async function listHearingUserOptions(ctx: AuthContext): Promise<HearingUserOption[]> {
  assertCan(ctx, "process:read");
  const directory = userDirectoryWhere(ctx);
  const rows = await getDb()
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.organizationId, ctx.organizationId),
        eq(users.isActive, true),
        directory
          ? or(
              directory,
              inArray(
                users.id,
                getDb()
                  .select({ id: hearings.responsibleId })
                  .from(hearings)
                  .where(and(hearingWhere(ctx), isNotNull(hearings.responsibleId))),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(users.name))
    .limit(1000);
  return rows
    .filter((u) => can({ kind: "user", role: u.role }, "process:read"))
    .map((u) => ({ id: u.id, name: u.name }));
}

/**
 * Finds a visible process by its number as typed (with or without the CNJ mask).
 * Throws a ValidationError on the `processNumber` field when nothing matches.
 */
export async function findVisibleProcessByNumber(
  ctx: AuthContext,
  rawNumber: string,
): Promise<{ id: string; number: string; title: string }> {
  assertCan(ctx, "process:read");
  const raw = (rawNumber ?? "").trim();
  const notFound = () =>
    new ValidationError("Processo não encontrado.", {
      processNumber: ["Processo não encontrado ou sem permissão de acesso. Confira o número."],
    });
  if (raw.length < 3 || raw.length > 60) throw notFound();
  const normalized = normalizeCnj(raw);
  const digits = cnjDigits(raw);
  const [p] = await getDb()
    .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
    .from(legalProcesses)
    .where(
      and(
        processWhere(ctx),
        or(
          eq(legalProcesses.number, raw),
          normalized ? eq(legalProcesses.number, normalized) : undefined,
          digits.length >= 10 ? sql`regexp_replace(${legalProcesses.number}, '[^0-9]', '', 'g') = ${digits}` : undefined,
        ),
      ),
    )
    .orderBy(asc(legalProcesses.number))
    .limit(1);
  if (!p) throw notFound();
  return p;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createHearing(ctx: AuthContext, input: CreateHearingInput): Promise<{ id: string }> {
  assertCan(ctx, "process:write");
  const v = parseOrThrow(createHearingSchema, input);
  return getDb().transaction(async (tx) => {
    const process = await loadProcessForWrite(ctx, tx, v.processId);
    if (v.responsibleId) await assertResponsible(ctx, tx, v.responsibleId, process);
    const values = {
      organizationId: ctx.organizationId,
      processId: process.id,
      kind: v.kind,
      mode: v.mode,
      status: "scheduled" as const,
      scheduledAt: zonedDateTimeToUtc(v.date, v.time),
      location: emptyToNull(v.location),
      meetingUrl: emptyToNull(v.meetingUrl),
      responsibleId: v.responsibleId ?? null,
      notes: emptyToNull(v.notes),
      origin: v.origin ?? ("manual" as const),
      createdById: ctx.userId,
    };
    const [row] = await tx.insert(hearings).values(values).returning({ id: hearings.id });
    await recordAudit(
      ctx,
      {
        action: "hearing.create",
        entityType: "legal_process",
        entityId: process.id,
        summary: `Audiência (${HEARING_KIND_LABELS[v.kind].toLowerCase()}) cadastrada para ${describeWhen(values.scheduledAt)}`,
        changes: diffChanges(null, values, HEARING_AUDIT_FIELDS),
        metadata: { hearingId: row.id },
      },
      tx,
    );
    return { id: row.id };
  });
}

/** Corrects the data of a scheduled hearing. To move it to a new date with history, use `setHearingStatus(rescheduled)`. */
export async function updateHearing(ctx: AuthContext, id: string, input: UpdateHearingInput): Promise<void> {
  assertCan(ctx, "process:write");
  const v = parseOrThrow(updateHearingSchema, input);
  await getDb().transaction(async (tx) => {
    const before = await loadHearingForWrite(ctx, tx, id);
    if (before.status !== "scheduled") {
      throw new ConflictError("Somente audiências designadas podem ser editadas.");
    }
    const process = await loadProcessForWrite(ctx, tx, before.processId);
    if (v.responsibleId && v.responsibleId !== before.responsibleId) {
      await assertResponsible(ctx, tx, v.responsibleId, process);
    }
    const next = {
      kind: v.kind,
      mode: v.mode,
      scheduledAt: zonedDateTimeToUtc(v.date, v.time),
      location: emptyToNull(v.location),
      meetingUrl: emptyToNull(v.meetingUrl),
      responsibleId: v.responsibleId ?? null,
      notes: emptyToNull(v.notes),
    };
    const changes = diffChanges(before, { ...before, ...next }, HEARING_AUDIT_FIELDS);
    const otherChanged = before.meetingUrl !== next.meetingUrl || before.notes !== next.notes;
    if (!changes && !otherChanged) return;
    await tx
      .update(hearings)
      .set({ ...next, updatedAt: new Date() })
      .where(and(eq(hearings.id, before.id), eq(hearings.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "hearing.update",
        entityType: "legal_process",
        entityId: before.processId,
        summary: `Audiência de ${describeWhen(before.scheduledAt)} alterada`,
        changes,
        metadata: {
          hearingId: before.id,
          // Free text is never audited: only THAT it changed.
          ...(before.meetingUrl !== next.meetingUrl ? { meetingUrlChanged: true } : {}),
          ...(before.notes !== next.notes ? { notesChanged: true } : {}),
        },
      },
      tx,
    );
  });
}

/**
 * held (outcome required, only once the date has arrived) · cancelled (optional
 * reason) · rescheduled (new date/time in the future; the current hearing is kept
 * as `rescheduled` and a NEW scheduled hearing is created). Only scheduled
 * hearings change status. Resolves the open "audiência próxima" alert.
 */
export async function setHearingStatus(
  ctx: AuthContext,
  id: string,
  input: HearingStatusInput,
): Promise<{ newHearingId: string | null }> {
  assertCan(ctx, "process:write");
  const v = parseOrThrow(hearingStatusSchema, input);
  return getDb().transaction(async (tx) => {
    const before = await loadHearingForWrite(ctx, tx, id);
    if (before.status !== "scheduled") {
      throw new ConflictError("Esta audiência não está mais designada: a situação já foi registrada.");
    }
    await loadProcessForWrite(ctx, tx, before.processId);
    const now = new Date();
    let newHearingId: string | null = null;

    if (v.status === "held") {
      if (todayISO(before.scheduledAt) > todayISO(now)) {
        throw new ConflictError("A audiência ainda não aconteceu: registre o resultado a partir da data designada.");
      }
      await tx
        .update(hearings)
        .set({ status: "held", outcome: v.outcome, updatedAt: now })
        .where(and(eq(hearings.id, before.id), eq(hearings.status, "scheduled")));
      await recordAudit(
        ctx,
        {
          action: "hearing.status_change",
          entityType: "legal_process",
          entityId: before.processId,
          summary: `Audiência de ${describeWhen(before.scheduledAt)} registrada como realizada`,
          metadata: { fromStatus: "scheduled", toStatus: "held", hearingId: before.id },
        },
        tx,
      );
    } else if (v.status === "cancelled") {
      await tx
        .update(hearings)
        .set({ status: "cancelled", outcome: emptyToNull(v.reason), updatedAt: now })
        .where(and(eq(hearings.id, before.id), eq(hearings.status, "scheduled")));
      await recordAudit(
        ctx,
        {
          action: "hearing.status_change",
          entityType: "legal_process",
          entityId: before.processId,
          summary: `Audiência de ${describeWhen(before.scheduledAt)} cancelada`,
          metadata: { fromStatus: "scheduled", toStatus: "cancelled", hearingId: before.id },
        },
        tx,
      );
    } else {
      const newAt = zonedDateTimeToUtc(v.date, v.time);
      if (newAt.getTime() <= now.getTime()) {
        throw new ValidationError("A nova data deve estar no futuro.", {
          date: ["Informe uma nova data e horário futuros."],
        });
      }
      if (newAt.getTime() === before.scheduledAt.getTime()) {
        throw new ValidationError("A nova data é igual à atual.", { date: ["Informe uma data ou horário diferente do atual."] });
      }
      const values = {
        organizationId: ctx.organizationId,
        processId: before.processId,
        kind: before.kind,
        mode: v.mode,
        status: "scheduled" as const,
        scheduledAt: newAt,
        location: emptyToNull(v.location),
        meetingUrl: emptyToNull(v.meetingUrl),
        responsibleId: before.responsibleId,
        notes: before.notes,
        origin: "manual" as const,
        createdById: ctx.userId,
      };
      const [created] = await tx.insert(hearings).values(values).returning({ id: hearings.id });
      newHearingId = created.id;
      await tx
        .update(hearings)
        .set({ status: "rescheduled", outcome: emptyToNull(v.reason), updatedAt: now })
        .where(and(eq(hearings.id, before.id), eq(hearings.status, "scheduled")));
      await recordAudit(
        ctx,
        {
          action: "hearing.status_change",
          entityType: "legal_process",
          entityId: before.processId,
          summary: `Audiência de ${describeWhen(before.scheduledAt)} redesignada para ${describeWhen(newAt)}`,
          metadata: { fromStatus: "scheduled", toStatus: "rescheduled", hearingId: before.id, newHearingId: created.id },
        },
        tx,
      );
      await recordAudit(
        ctx,
        {
          action: "hearing.create",
          entityType: "legal_process",
          entityId: before.processId,
          summary: `Nova audiência designada para ${describeWhen(newAt)} (redesignação)`,
          changes: diffChanges(null, values, HEARING_AUDIT_FIELDS),
          metadata: { hearingId: created.id, rescheduledFromId: before.id },
        },
        tx,
      );
    }

    await resolveAlertsByDedupeKeys(ctx.organizationId, [hearingAlertKey(before.id)], tx);
    return { newHearingId };
  });
}

/** Scheduled hearings of a visible process from today on (e.g. the count on the process tab). 0 when not visible. */
export async function countUpcomingProcessHearings(ctx: AuthContext, processId: string): Promise<number> {
  if (!can(ctx, "process:read")) return 0;
  const pid = z.guid().safeParse(processId);
  if (!pid.success) return 0;
  const [row] = await getDb()
    .select({ n: count() })
    .from(hearings)
    .where(
      and(
        hearingWhere(ctx),
        eq(hearings.processId, pid.data),
        eq(hearings.status, "scheduled"),
        gte(hearings.scheduledAt, startOfZonedDay(todayISO())),
      ),
    );
  return row?.n ?? 0;
}

/** Process id of a visible hearing (used by actions to revalidate the process page). */
export async function getHearingProcessId(ctx: AuthContext, id: string): Promise<string> {
  assertCan(ctx, "process:read");
  const hearingId = parseIdOrNotFound(id);
  const [row] = await getDb()
    .select({ processId: hearings.processId })
    .from(hearings)
    .where(and(eq(hearings.id, hearingId), hearingWhere(ctx)))
    .limit(1);
  if (!row) throw new NotFoundError("Audiência não encontrada ou sem permissão de acesso.");
  return row.processId;
}

/**
 * Processes whose hearings are alerted and reminded: the active portfolio
 * (same statuses as `ACTIVE_PORTFOLIO_STATUSES` in processes/service, not
 * imported here to keep this module free of a load-order cycle).
 */
const ALERTED_PROCESS_STATUSES = ["active", "suspended"] as const;

/**
 * Internal (routine): scheduled hearings of the organization within [from, until)
 * whose process is in the active portfolio (archived or closed processes are
 * neither alerted nor reminded; their open alerts are resolved by the routine).
 * No user scope.
 */
export async function listScheduledHearingsForAlerts(
  organizationId: string,
  from: Date,
  until: Date,
  db: DbOrTx = getDb(),
) {
  return db
    .select({
      id: hearings.id,
      processId: hearings.processId,
      kind: hearings.kind,
      mode: hearings.mode,
      scheduledAt: hearings.scheduledAt,
      location: hearings.location,
      responsibleId: hearings.responsibleId,
      responsibleName: users.name,
      responsibleActive: users.isActive,
      processNumber: legalProcesses.number,
      processTitle: legalProcesses.title,
    })
    .from(hearings)
    .innerJoin(
      legalProcesses,
      and(
        eq(legalProcesses.id, hearings.processId),
        eq(legalProcesses.organizationId, organizationId),
        isNull(legalProcesses.deletedAt),
        inArray(legalProcesses.status, [...ALERTED_PROCESS_STATUSES]),
      ),
    )
    .leftJoin(users, and(eq(users.id, hearings.responsibleId), eq(users.organizationId, organizationId)))
    .where(
      and(
        eq(hearings.organizationId, organizationId),
        isNull(hearings.deletedAt),
        eq(hearings.status, "scheduled"),
        gte(hearings.scheduledAt, from),
        lt(hearings.scheduledAt, until),
      ),
    )
    .orderBy(asc(hearings.scheduledAt))
    .limit(5000);
}
