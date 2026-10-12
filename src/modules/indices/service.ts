/**
 * Índices de correção (P1.7): coleta automática das séries mensais do Banco
 * Central (SGS), situação da coleta, índice por valoração e VALOR ATUALIZADO
 * calculado na leitura (nunca gravado).
 *
 * Rules:
 * - Rates come only from the SGS API (routine `index_series_refresh` or the
 *   admin "Atualizar agora"). There is no manual entry of rates.
 * - A month already stored is never rewritten; the current month is never
 *   stored, and a month that may still be incomplete at the source (Selic
 *   accumulated in the month) waits for the series' confirmation day in the
 *   next month (`lastStorableMonth`). Gaps inside a stored series are fetched
 *   again on the next runs and shown on the admin card.
 * - The updated value is `updatedValue(...)` from `./math`, computed for each
 *   read; `cents: null` when a month is missing (never estimated).
 * - Which index applies to a case is the lawyer's choice. The organization
 *   default (`settings.contingency.defaultCorrectionIndex`) is written into new
 *   valuations by the database trigger `process_valuations_default_correction_index`.
 *   The index of an official value is changed by a NEW official record (same
 *   amount and base date) that supersedes it (`setValuationCorrectionIndex`).
 *
 * The series tables are global (public data, no organization column); reading
 * the collection status requires `admin:organization`.
 */
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CORRECTION_INDEX_LABELS,
  CORRECTION_INDEXES,
  INDEX_SERIES_CODES,
  ROUTINE_TYPE_LABELS,
  VALUATION_KIND_LABELS,
  type CorrectionIndex,
  type IndexSeriesCode,
  type ValuationKind,
  type ValuationStatus,
} from "@/domain/enums";
import { formatDate, formatMoneyCents, pluralize, todayISO } from "@/lib/format";
import { loadOrganization, mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import type { AuthContext } from "@/server/auth/context";
import { valuationWhere } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  indexSeries,
  indexSeriesValues,
  organizations,
  processValuations,
  scheduledRoutines,
} from "@/server/db/schema";
import { getSgsClient, SgsError, type SgsClient } from "@/server/integrations/bcb";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "@/server/services/audit";
import {
  INDEX_SERIES_CATALOG,
  lastStorableMonth,
  monthsToCollect,
  sgsSourceTag,
  type IndexSeriesDefinition,
} from "./catalog";
import { CORRECTION_INDEX_NOTE_MAX, correctionIndexEditability, type CorrectionIndexChangeMode } from "./policy";
import { indexSwapInForceChange, sameBaseDateOtherInstance } from "./swap-guard";
import type { ValuationUpdate, ValuationUpdates } from "./types";
import {
  addMonths,
  formatMonth,
  formatMonthRanges,
  groupMonthRanges,
  isIsoDate,
  microToRateText,
  monthOfDate,
  parseRateMicro,
  seriesGaps,
  updatedValue,
  type MonthlyRates,
  type SeriesByIndex,
  type UpdatedValue,
} from "./math";

const uuid = z.guid();

/** A series consulted successfully less than this long ago is not consulted again by the routine. */
export const REFRESH_SUCCESS_THROTTLE_MS = 6 * 60 * 60_000;
/** After a failure, the routine waits at least this long before trying the same series again. */
export const REFRESH_FAILURE_THROTTLE_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Catalog and rates
// ---------------------------------------------------------------------------

/** Keeps the catalog rows in line with `INDEX_SERIES_CATALOG` (idempotent). */
export async function ensureIndexCatalog(db: DbOrTx = getDb()): Promise<void> {
  await db
    .insert(indexSeries)
    .values(INDEX_SERIES_CATALOG.map((s) => ({ code: s.code, name: s.name, sgsCode: s.sgsCode })))
    .onConflictDoUpdate({
      target: indexSeries.code,
      set: { name: sql`excluded.name`, sgsCode: sql`excluded.sgs_code` },
    });
}

/**
 * Monthly rates (micro-percent) of the given indexes between two months
 * (inclusive). Server-side helper reused by other modules (reports).
 */
export async function loadMonthlyRates(
  codes: readonly IndexSeriesCode[],
  fromMonth: string,
  toMonth: string,
  db: DbOrTx = getDb(),
): Promise<SeriesByIndex> {
  const unique = [...new Set(codes)].filter((c) => (INDEX_SERIES_CODES as readonly string[]).includes(c));
  if (unique.length === 0 || fromMonth > toMonth) return {};
  const rows = await db
    .select({ code: indexSeriesValues.indexCode, month: indexSeriesValues.month, rate: indexSeriesValues.ratePercent })
    .from(indexSeriesValues)
    .where(
      and(
        inArray(indexSeriesValues.indexCode, unique),
        gte(indexSeriesValues.month, fromMonth),
        lte(indexSeriesValues.month, toMonth),
      ),
    );
  const out: Partial<Record<IndexSeriesCode, Map<string, number>>> = {};
  for (const code of unique) out[code] = new Map();
  for (const r of rows) {
    const micro = parseRateMicro(r.rate);
    // A stored rate is always valid (checked before insert); never guess otherwise.
    if (micro !== null) out[r.code]?.set(r.month, micro);
  }
  return out as SeriesByIndex;
}

/** Rates needed to update the given rows as of `asOf`. */
export async function loadRatesFor(
  rows: readonly { baseDate: string; correctionIndex: CorrectionIndex | null }[],
  asOf: string,
  db: DbOrTx = getDb(),
): Promise<SeriesByIndex> {
  const codes = new Set<IndexSeriesCode>();
  let from: string | null = null;
  for (const r of rows) {
    if (!r.correctionIndex || r.correctionIndex === "none" || !isIsoDate(r.baseDate)) continue;
    codes.add(r.correctionIndex);
    const start = addMonths(monthOfDate(r.baseDate), 1);
    if (from === null || start < from) from = start;
  }
  if (codes.size === 0 || from === null || !isIsoDate(asOf)) return {};
  return loadMonthlyRates([...codes], from, addMonths(monthOfDate(asOf), -1), db);
}

// ---------------------------------------------------------------------------
// Updated values (computed on read)
// ---------------------------------------------------------------------------

/**
 * Original and updated value of every valuation of a process visible to ctx
 * (`contingency:read` + row visibility). `asOf` defaults to today.
 */
export async function getValuationUpdates(
  ctx: AuthContext,
  processId: string,
  opts: { asOf?: string } = {},
): Promise<ValuationUpdates> {
  assertCan(ctx, "contingency:read");
  const parsed = uuid.safeParse(processId);
  if (!parsed.success) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  const asOf = opts.asOf ?? todayISO();
  if (!isIsoDate(asOf)) throw new ValidationError("Data de referência inválida.", { asOf: ["Informe uma data válida."] });
  const db = getDb();
  const rows = await db
    .select({
      id: processValuations.id,
      kind: processValuations.kind,
      status: processValuations.status,
      amountCents: processValuations.amountCents,
      baseDate: processValuations.baseDate,
      correctionIndex: processValuations.correctionIndex,
    })
    .from(processValuations)
    .where(and(eq(processValuations.processId, parsed.data), valuationWhere(ctx)));
  return buildUpdates(rows, asOf, db);
}

/** Valuation fields needed to compute the updated value. */
export type ValuationUpdateSource = {
  id: string;
  kind: ValuationKind;
  status: ValuationStatus;
  amountCents: number;
  baseDate: string;
  correctionIndex: CorrectionIndex | null;
};

/**
 * Original and updated value of valuations the caller ALREADY loaded with its
 * own access checks (e.g. the review queue, `contingency:read` + `valuationWhere`).
 * Only the public index series are read here. `asOf` defaults to today.
 */
export async function computeValuationUpdates(
  ctx: AuthContext,
  rows: readonly ValuationUpdateSource[],
  opts: { asOf?: string } = {},
): Promise<ValuationUpdates> {
  assertCan(ctx, "contingency:read");
  const asOf = opts.asOf ?? todayISO();
  if (!isIsoDate(asOf)) throw new ValidationError("Data de referência inválida.", { asOf: ["Informe uma data válida."] });
  return buildUpdates(rows, asOf, getDb());
}

async function buildUpdates(rows: readonly ValuationUpdateSource[], asOf: string, db: DbOrTx): Promise<ValuationUpdates> {
  const rates = await loadRatesFor(rows, asOf, db);
  const items = rows.map((r) => ({
    valuationId: r.id,
    kind: r.kind,
    status: r.status,
    amountCents: r.amountCents,
    baseDate: r.baseDate,
    correctionIndex: r.correctionIndex,
    updated: updatedValue(r.amountCents, r.baseDate, r.correctionIndex, asOf, rates),
  }));
  return { asOf, items, byId: Object.fromEntries(items.map((i) => [i.valuationId, i])) };
}

// ---------------------------------------------------------------------------
// Index of a valuation
// ---------------------------------------------------------------------------

const correctionIndexSchema = z.enum(CORRECTION_INDEXES, { error: "Selecione um índice da lista." });

export type CorrectionIndexChange = {
  processId: string;
  changed: boolean;
  /** How the index was changed; null when nothing changed (the value already used this index). */
  mode: CorrectionIndexChangeMode | null;
  /** Valuation that carries the chosen index now: the same row, or the new record that superseded it. */
  valuationId: string;
};

/**
 * Informs or changes the index of a valuation, following `correctionIndexEditability`
 * (`./policy`). Identified person only; amount and base date never change; audited.
 *
 * - PROPOSED (in review): the row itself, with `contingency:write`.
 * - Official or superseded WITHOUT an index ("sem índice informado"): the row
 *   itself, once, with `contingency:approve`.
 * - OFFICIAL WITH an index (including `"none"` stamped by the organization
 *   default, e.g. a value registered directly as official by an approver, an
 *   imported official value or the valor da causa of the process form): with
 *   `contingency:approve`, a NEW official valuation with the same amount, base
 *   date, instance and provenance and the chosen index supersedes it; the old
 *   row keeps its index (append-only history). Audit `valuation.correction_index_replace`.
 *   The swap never changes which value is in force nor any amount: refused
 *   (ConflictError) when another official or superseded value of the same kind
 *   and base date exists in a different instance (the new record would win the
 *   tie of that base date), and rolled back when the value in force of the kind
 *   (positions at every base date and the process record) differs before and
 *   after (`indexSwapInForceChange`, ./swap-guard).
 * - Superseded with an index (history) and rejected values: refused.
 */
export async function setValuationCorrectionIndex(
  ctx: AuthContext,
  valuationId: string,
  index: CorrectionIndex,
  opts: { note?: string | null } = {},
): Promise<CorrectionIndexChange> {
  assertCan(ctx, "contingency:write");
  const userId = ctx.userId;
  if (!userId) throw new ValidationError("Somente uma pessoa identificada pode informar o índice de um valor.");
  const id = uuid.safeParse(valuationId);
  if (!id.success) throw new NotFoundError();
  const parsed = correctionIndexSchema.safeParse(index);
  if (!parsed.success) throw new ValidationError("Verifique os campos informados.", { correctionIndex: ["Selecione um índice da lista."] });
  const next = parsed.data;
  const note = (opts.note ?? "").trim() || null;
  if (note && note.length > CORRECTION_INDEX_NOTE_MAX) {
    throw new ValidationError("Verifique os campos informados.", {
      note: [`A observação deve ter no máximo ${CORRECTION_INDEX_NOTE_MAX} caracteres.`],
    });
  }

  return getDb().transaction(async (tx) => {
    const [v] = await tx
      .select()
      .from(processValuations)
      .where(and(eq(processValuations.id, id.data), valuationWhere(ctx)))
      .for("update");
    if (!v) throw new NotFoundError();
    if (v.correctionIndex === next) return { processId: v.processId, changed: false, mode: null, valuationId: v.id };
    const rule = correctionIndexEditability(v);
    if (!rule.editable) {
      if (rule.reason === "rejected") throw new ConflictError("Valor rejeitado: o índice não é alterado.");
      throw new ConflictError(
        "Este valor já foi substituído por um registro mais recente e faz parte do histórico: o índice dele não muda. Troque o índice do valor oficial em vigor.",
      );
    }
    // An official (or superseded) value only gets an index from someone who could have approved it.
    if (rule.permission === "contingency:approve" && !can(ctx, "contingency:approve")) {
      throw new ForbiddenError(
        rule.mode === "new_record"
          ? "Este valor já é oficial: somente quem confere valores troca o índice dele (um novo registro com o mesmo valor e a mesma data-base substitui o atual, e o histórico é preservado). Peça a quem confere valores."
          : "Este valor já passou pela conferência: somente quem confere valores pode informar o índice dele. Peça a quem confere valores.",
      );
    }
    const label = `${VALUATION_KIND_LABELS[v.kind]} de ${formatMoneyCents(v.amountCents)} (data-base ${formatDate(v.baseDate)})`;

    if (rule.mode === "new_record") {
      // Append-only: the official row keeps its index and becomes history; a new official
      // record with the same amount, base date, instance and provenance carries the new index.
      // The new record is the most recently reviewed one: it must never change which value is in
      // force (or any amount) at any date, so the history of the kind is compared before and after.
      const historyOfKind = () =>
        tx
          .select({
            id: processValuations.id,
            kind: processValuations.kind,
            amountCents: processValuations.amountCents,
            baseDate: processValuations.baseDate,
            status: processValuations.status,
            instance: processValuations.instance,
            createdAt: processValuations.createdAt,
            reviewedAt: processValuations.reviewedAt,
          })
          .from(processValuations)
          .where(
            and(
              eq(processValuations.organizationId, ctx.organizationId),
              eq(processValuations.processId, v.processId),
              eq(processValuations.kind, v.kind),
              inArray(processValuations.status, ["official", "superseded"]),
            ),
          );
      const before = await historyOfKind();
      const tie = sameBaseDateOtherInstance(before, v);
      if (tie) {
        throw new ConflictError(
          `Há outro registro de ${VALUATION_KIND_LABELS[v.kind]} com a mesma data-base (${formatDate(v.baseDate)}) em outra instância. ` +
            "Um novo registro nessa data-base mudaria qual valor está em vigor no processo, por isso a troca do índice foi recusada. " +
            "Confira os valores dessa data-base na aba Valores e risco.",
        );
      }
      const superseded = await tx
        .update(processValuations)
        .set({ status: "superseded" })
        .where(
          and(
            eq(processValuations.id, v.id),
            eq(processValuations.organizationId, ctx.organizationId),
            eq(processValuations.status, "official"),
          ),
        )
        .returning({ id: processValuations.id });
      if (superseded.length === 0) throw new ConflictError("O valor mudou enquanto você editava. Recarregue a página.");
      const fromLabel = v.correctionIndex ? CORRECTION_INDEX_LABELS[v.correctionIndex] : "sem índice informado";
      const toLabel = CORRECTION_INDEX_LABELS[next];
      const reviewNote = `Troca do índice de atualização: de ${fromLabel} para ${toLabel}, com o mesmo valor e a mesma data-base do registro anterior.${note ? ` ${note}` : ""}`;
      const [created] = await tx
        .insert(processValuations)
        .values({
          organizationId: ctx.organizationId,
          processId: v.processId,
          kind: v.kind,
          amountCents: v.amountCents,
          baseDate: v.baseDate,
          instance: v.instance,
          source: v.source,
          status: "official",
          isEstimate: v.isEstimate,
          // Same reason (a quitação keeps its "Quitação" prefix) and provenance; not part of an import batch.
          reason: v.reason,
          documentId: v.documentId,
          documentVersionId: v.documentVersionId,
          page: v.page,
          excerpt: v.excerpt,
          confidence: v.confidence,
          briefId: v.briefId,
          supersedesId: v.id,
          correctionIndex: next,
          createdById: userId,
          reviewedById: userId,
          reviewedAt: new Date(),
          reviewNote: reviewNote.slice(0, 1000),
        })
        .returning({ id: processValuations.id });
      const change = indexSwapInForceChange({
        kind: v.kind,
        before,
        after: await historyOfKind(),
        replacedId: v.id,
        newId: created.id,
      });
      if (change) {
        // Throwing rolls the whole swap back (nothing superseded, nothing inserted).
        throw new ConflictError(
          "A troca do índice mudaria o valor em vigor do processo, e o valor e a data-base precisam continuar os mesmos. " +
            "A troca foi recusada. Confira os valores com a mesma data-base na aba Valores e risco.",
        );
      }
      await recordAudit(
        ctx,
        {
          action: "valuation.correction_index_replace",
          entityType: "legal_process",
          entityId: v.processId,
          summary: `Índice de atualização do valor ${label} trocado de ${fromLabel} para ${toLabel}: um novo registro oficial com o mesmo valor e a mesma data-base substituiu o anterior.`,
          changes: { correctionIndex: { from: v.correctionIndex, to: next } },
          metadata: { valuationId: v.id, newValuationId: created.id },
        },
        tx,
      );
      return { processId: v.processId, changed: true, mode: "new_record", valuationId: created.id };
    }

    const updated = await tx
      .update(processValuations)
      .set({ correctionIndex: next })
      .where(
        and(
          eq(processValuations.id, v.id),
          eq(processValuations.organizationId, ctx.organizationId),
          eq(processValuations.status, v.status),
          or(isNull(processValuations.correctionIndex), eq(processValuations.status, "proposed")),
        ),
      )
      .returning({ id: processValuations.id });
    if (updated.length === 0) throw new ConflictError("O valor mudou enquanto você editava. Recarregue a página.");
    await recordAudit(
      ctx,
      {
        action: "valuation.correction_index_set",
        entityType: "legal_process",
        entityId: v.processId,
        summary: `Índice de atualização do valor ${label} definido como ${CORRECTION_INDEX_LABELS[next]}.`,
        changes: { correctionIndex: { from: v.correctionIndex, to: next } },
        metadata: { valuationId: v.id, valuationStatus: v.status },
      },
      tx,
    );
    return { processId: v.processId, changed: true, mode: "in_place", valuationId: v.id };
  });
}

// ---------------------------------------------------------------------------
// Organization default
// ---------------------------------------------------------------------------

/** Index written into new valuations of the organization. */
export async function getDefaultCorrectionIndex(ctx: AuthContext): Promise<CorrectionIndex> {
  if (!can(ctx, "admin:organization") && !can(ctx, "contingency:read")) throw new ForbiddenError();
  return (await loadOrganization(ctx.organizationId)).settings.contingency.defaultCorrectionIndex;
}

/**
 * Chooses the index written into NEW valuations (`admin:organization`,
 * audited). Existing valuations keep their index; older ones stay "sem índice
 * informado" until someone informs it.
 */
export async function updateDefaultCorrectionIndex(
  ctx: AuthContext,
  index: CorrectionIndex,
): Promise<{ changed: boolean }> {
  assertCan(ctx, "admin:organization");
  const parsed = correctionIndexSchema.safeParse(index);
  if (!parsed.success) {
    throw new ValidationError("Verifique os campos informados.", { defaultCorrectionIndex: ["Selecione um índice da lista."] });
  }
  const next = parsed.data;
  return getDb().transaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId))
      .for("update");
    if (!org) throw new NotFoundError("Organização não encontrada.");
    const current = mergeOrganizationSettings(org.settings);
    const before = current.contingency.defaultCorrectionIndex;
    if (before === next) return { changed: false };
    await tx
      .update(organizations)
      .set({ settings: { ...current, contingency: { ...current.contingency, defaultCorrectionIndex: next } } })
      .where(eq(organizations.id, ctx.organizationId));
    await recordAudit(
      ctx,
      {
        action: "organization.correction_index_default_update",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: `Índice de atualização dos novos valores alterado para ${CORRECTION_INDEX_LABELS[next]}.`,
        changes: { defaultCorrectionIndex: { from: before, to: next } },
      },
      tx,
    );
    return { changed: true };
  });
}

// ---------------------------------------------------------------------------
// Automatic collection (routine `index_series_refresh`)
// ---------------------------------------------------------------------------

export type SeriesRefreshStatus = "updated" | "no_new_month" | "up_to_date" | "throttled" | "failed" | "not_attempted";

export type SeriesRefreshOutcome = {
  code: IndexSeriesCode;
  status: SeriesRefreshStatus;
  /** Months inserted in this run. */
  added: number;
  lastMonth: string | null;
  /** Months still missing between the first and the last stored month after this run. */
  gapMonths: string[];
  error: string | null;
};

export type IndexRefreshSummary = { outcomes: SeriesRefreshOutcome[]; added: number; failed: number };

/** More separate missing ranges than this in one series are fetched as a single span (stored months are kept). */
const MAX_RANGES_PER_SERIES = 6;

function safeSgsMessage(err: unknown): string {
  if (err instanceof SgsError) return err.message;
  if (err instanceof ValidationError) return err.message;
  return "Falha interna ao gravar a série.";
}

function isCommunicationFailure(err: unknown): boolean {
  return err instanceof SgsError && (err.code === "network" || err.code === "timeout");
}

/** Stored months of every series, sorted ("YYYY-MM"). */
async function loadStoredMonths(db: DbOrTx, code?: IndexSeriesCode): Promise<Map<IndexSeriesCode, string[]>> {
  const rows = await db
    .select({ code: indexSeriesValues.indexCode, month: indexSeriesValues.month })
    .from(indexSeriesValues)
    .where(code ? eq(indexSeriesValues.indexCode, code) : undefined)
    .orderBy(asc(indexSeriesValues.indexCode), asc(indexSeriesValues.month));
  const out = new Map<IndexSeriesCode, string[]>();
  for (const r of rows) {
    const list = out.get(r.code) ?? [];
    list.push(r.month);
    out.set(r.code, list);
  }
  return out;
}

/**
 * Fetches the months missing in every series and stores them without rewriting
 * any stored month (idempotent: running twice adds nothing). Missing months are
 * the gaps inside the stored series plus the months after the last stored one
 * (or July 1994), up to `lastStorableMonth` of each series: never the current
 * month, and a month whose value may still be incomplete at the source (Selic
 * accumulated in the month) only after the series' confirmation day. Failures
 * are recorded on the series (`last_error`). A network or timeout failure stops
 * the run (the other series are tried next time).
 *
 * `admin:organization` for people; the routine runs with the system context.
 * `force` ignores the throttle (manual "Atualizar agora").
 */
export async function refreshIndexSeries(
  ctx: AuthContext,
  opts: { now?: Date; force?: boolean; client?: SgsClient } = {},
): Promise<IndexRefreshSummary> {
  assertCan(ctx, "admin:organization");
  const now = opts.now ?? new Date();
  const client = opts.client ?? getSgsClient();
  const db = getDb();
  await ensureIndexCatalog(db);
  const today = todayISO(now);
  const [stateRows, stored] = await Promise.all([db.select().from(indexSeries), loadStoredMonths(db)]);
  const states = new Map(stateRows.map((r) => [r.code, r]));

  const outcomes: SeriesRefreshOutcome[] = [];
  let stop = false;
  for (const def of INDEX_SERIES_CATALOG) {
    const state = states.get(def.code);
    const months = stored.get(def.code) ?? [];
    const lastMonth = months.length > 0 ? months[months.length - 1] : null;
    const gapMonths = seriesGaps(months);
    const base = { code: def.code, added: 0, lastMonth, gapMonths };
    if (stop) {
      outcomes.push({ ...base, status: "not_attempted", error: null });
      continue;
    }
    const wanted = monthsToCollect(months, lastStorableMonth(def, today));
    if (wanted.length === 0) {
      outcomes.push({ ...base, status: "up_to_date", error: null });
      continue;
    }
    if (!opts.force && state?.lastAttemptAt) {
      const failedLast = !!state.lastError;
      const wait = failedLast ? REFRESH_FAILURE_THROTTLE_MS : REFRESH_SUCCESS_THROTTLE_MS;
      if (now.getTime() - state.lastAttemptAt.getTime() < wait) {
        outcomes.push({ ...base, status: "throttled", error: state.lastError });
        continue;
      }
    }
    let ranges = groupMonthRanges(wanted);
    if (ranges.length > MAX_RANGES_PER_SERIES) ranges = [[ranges[0][0], ranges[ranges.length - 1][1]]];
    try {
      outcomes.push(await fetchAndStore(def, ranges, client, now));
    } catch (err) {
      const message = safeSgsMessage(err);
      logger.warn("index_series_refresh_failed", {
        code: def.code,
        sgsCode: def.sgsCode,
        errorName: err instanceof Error ? err.name : "unknown",
        errorCode: err instanceof SgsError ? err.code : undefined,
      });
      await db
        .update(indexSeries)
        .set({ lastAttemptAt: now, lastError: message.slice(0, 500), lastErrorAt: now })
        .where(eq(indexSeries.code, def.code));
      outcomes.push({ ...base, status: "failed", error: message });
      if (isCommunicationFailure(err)) stop = true;
    }
  }
  return {
    outcomes,
    added: outcomes.reduce((s, o) => s + o.added, 0),
    failed: outcomes.filter((o) => o.status === "failed").length,
  };
}

async function fetchAndStore(
  def: IndexSeriesDefinition,
  ranges: readonly [string, string][],
  client: SgsClient,
  now: Date,
): Promise<SeriesRefreshOutcome> {
  const rows: (typeof indexSeriesValues.$inferInsert)[] = [];
  const seen = new Set<string>();
  for (const [from, to] of ranges) {
    const points = await client.fetchMonthly(def.sgsCode, from, to);
    for (const p of points) {
      // Only the months asked: never the current month (partial Selic), never a month
      // still inside the confirmation window, never a month already stored.
      if (p.month < from || p.month > to || seen.has(p.month)) continue;
      const micro = parseRateMicro(p.rate);
      if (micro === null) {
        throw new SgsError("invalid_response", `Resposta do Banco Central com taxa ilegível em ${formatMonth(p.month)}.`, false);
      }
      seen.add(p.month);
      rows.push({
        indexCode: def.code,
        month: p.month,
        ratePercent: microToRateText(micro),
        source: sgsSourceTag(def.sgsCode),
        fetchedAt: now,
      });
    }
  }
  return getDb().transaction(async (tx) => {
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const inserted = await tx
        .insert(indexSeriesValues)
        .values(rows.slice(i, i + 500))
        // A stored month is never rewritten.
        .onConflictDoNothing({ target: [indexSeriesValues.indexCode, indexSeriesValues.month] })
        .returning({ month: indexSeriesValues.month });
      added += inserted.length;
    }
    const months = (await loadStoredMonths(tx, def.code)).get(def.code) ?? [];
    const lastMonth = months.length > 0 ? months[months.length - 1] : null;
    await tx
      .update(indexSeries)
      .set({ lastMonth, lastFetchedAt: now, lastAttemptAt: now, lastError: null, lastErrorAt: null })
      .where(eq(indexSeries.code, def.code));
    return {
      code: def.code,
      status: added > 0 ? "updated" : "no_new_month",
      added,
      lastMonth,
      gapMonths: seriesGaps(months),
      error: null,
    };
  });
}

/** pt-BR summary stored in the routine's `last_status`. */
export function describeIndexRefresh(summary: IndexRefreshSummary): string {
  const label = (code: IndexSeriesCode) => CORRECTION_INDEX_LABELS[code];
  const parts: string[] = [];
  const updated = summary.outcomes.filter((o) => o.status === "updated");
  if (updated.length > 0) {
    parts.push(
      `Meses novos: ${updated.map((o) => `${label(o.code)} (${pluralize(o.added, "mês", "meses")}, até ${formatMonth(o.lastMonth)})`).join(", ")}.`,
    );
  }
  const current = summary.outcomes.filter((o) => o.status === "up_to_date" || o.status === "no_new_month");
  if (current.length > 0) {
    parts.push(`Sem mês novo publicado: ${current.map((o) => label(o.code)).join(", ")}.`);
  }
  const throttled = summary.outcomes.filter((o) => o.status === "throttled");
  if (throttled.length > 0) {
    parts.push(`Consultadas há pouco, ficam para a próxima execução: ${throttled.map((o) => label(o.code)).join(", ")}.`);
  }
  const failed = summary.outcomes.filter((o) => o.status === "failed");
  for (const o of failed) parts.push(`Falha em ${label(o.code)}: ${o.error}`);
  const skipped = summary.outcomes.filter((o) => o.status === "not_attempted");
  if (skipped.length > 0) {
    parts.push(`Não consultadas nesta execução (falha de comunicação): ${skipped.map((o) => label(o.code)).join(", ")}.`);
  }
  const withGaps = summary.outcomes.filter((o) => o.gapMonths.length > 0);
  if (withGaps.length > 0) {
    parts.push(
      `Meses sem taxa no meio da série (consultados de novo na próxima execução): ${withGaps
        .map((o) => `${label(o.code)} (${formatMonthRanges(o.gapMonths)})`)
        .join(", ")}.`,
    );
  }
  return parts.join(" ") || "Nenhuma série configurada.";
}

/** Manual "Atualizar agora" (`admin:organization`, audited). Ignores the throttle. */
export async function requestIndexSeriesRefresh(ctx: AuthContext): Promise<IndexRefreshSummary> {
  assertCan(ctx, "admin:organization");
  if (!ctx.userId) throw new ValidationError("Somente uma pessoa identificada pode solicitar a coleta.");
  const summary = await refreshIndexSeries(ctx, { force: true });
  await recordAudit(ctx, {
    action: "organization.index_series_refresh_request",
    entityType: "organization",
    entityId: ctx.organizationId,
    summary: `Coleta das séries de índices solicitada: ${pluralize(summary.added, "mês novo", "meses novos")}, ${pluralize(summary.failed, "falha", "falhas")}.`,
    metadata: { added: summary.added, failed: summary.failed },
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Collection status (admin card)
// ---------------------------------------------------------------------------

export type IndexSeriesHealth = "ok" | "awaiting_publication" | "behind" | "gaps" | "failed" | "empty";

export type IndexSeriesStatusRow = IndexSeriesDefinition & {
  firstMonth: string | null;
  lastMonth: string | null;
  /** Most recent month this series may store today (`lastStorableMonth`). */
  lastStorableMonth: string;
  monthsStored: number;
  /** Months missing between the first and the last stored month. */
  gapMonths: string[];
  lastFetchedAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  health: IndexSeriesHealth;
};

export type IndexSeriesOverview = {
  /** Month before the current one: the most recent month any series can store. */
  lastCompleteMonth: string;
  series: IndexSeriesStatusRow[];
  routine: {
    label: string;
    enabled: boolean;
    lastRunAt: Date | null;
    nextRunAt: Date | null;
    lastStatus: string | null;
    lastError: string | null;
  } | null;
};

export function seriesHealth(
  row: {
    lastMonth: string | null;
    lastError: string | null;
    lastErrorAt: Date | null;
    lastFetchedAt: Date | null;
    gapMonths?: readonly string[];
  },
  lastStorable: string,
): IndexSeriesHealth {
  if (row.lastError && (!row.lastFetchedAt || (row.lastErrorAt && row.lastErrorAt >= row.lastFetchedAt))) return "failed";
  if (!row.lastMonth) return "empty";
  if (row.gapMonths && row.gapMonths.length > 0) return "gaps";
  if (row.lastMonth >= lastStorable) return "ok";
  if (row.lastMonth === addMonths(lastStorable, -1)) return "awaiting_publication";
  return "behind";
}

/** Collection status of every series plus this organization's routine (`admin:organization`). */
export async function getIndexSeriesOverview(ctx: AuthContext, now: Date = new Date()): Promise<IndexSeriesOverview> {
  assertCan(ctx, "admin:organization");
  const db = getDb();
  const today = todayISO(now);
  const lastCompleteMonth = addMonths(monthOfDate(today), -1);
  const [states, stored, routines] = await Promise.all([
    db.select().from(indexSeries),
    loadStoredMonths(db),
    db
      .select()
      .from(scheduledRoutines)
      .where(and(eq(scheduledRoutines.organizationId, ctx.organizationId), eq(scheduledRoutines.type, "index_series_refresh"))),
  ]);
  const stateBy = new Map(states.map((s) => [s.code, s]));
  const series = INDEX_SERIES_CATALOG.map((def) => {
    const s = stateBy.get(def.code);
    const months = stored.get(def.code) ?? [];
    const lastStorable = lastStorableMonth(def, today);
    const row = {
      ...def,
      firstMonth: months[0] ?? null,
      lastMonth: months[months.length - 1] ?? null,
      lastStorableMonth: lastStorable,
      monthsStored: months.length,
      gapMonths: seriesGaps(months),
      lastFetchedAt: s?.lastFetchedAt ?? null,
      lastAttemptAt: s?.lastAttemptAt ?? null,
      lastError: s?.lastError ?? null,
      lastErrorAt: s?.lastErrorAt ?? null,
    };
    return { ...row, health: seriesHealth(row, lastStorable) };
  });
  const r = routines[0];
  return {
    lastCompleteMonth,
    series,
    routine: r
      ? {
          label: ROUTINE_TYPE_LABELS.index_series_refresh,
          enabled: r.enabled,
          lastRunAt: r.lastRunAt,
          nextRunAt: r.nextRunAt,
          lastStatus: r.lastStatus,
          lastError: r.lastError,
        }
      : null,
  };
}

export type { MonthlyRates, SeriesByIndex, UpdatedValue, ValuationUpdate, ValuationUpdates };
