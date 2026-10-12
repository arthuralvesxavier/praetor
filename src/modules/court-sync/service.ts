/**
 * Acompanhamento automático da carteira no DataJud (API pública do CNJ).
 *
 * - `runCourtSync(organizationId, opts)`: processes due for a check (active
 *   portfolio, valid CNJ, `next_check_at` reached), grouped by the tribunal
 *   endpoint of origin, queried in batches (`terms` on `numeroProcesso`) under
 *   the per-tribunal rate limit; one `court_sync_runs` row per tribunal.
 * - `applyCourtRecords(...)`: writes what the tribunal informed, in ONE
 *   transaction per process: instance links (G1/G2/SUP), NEW movements only
 *   (dedupe by `code|dataHora|grau`), empty fields only (never overwrites what a
 *   person typed; divergences become a verification note), forward-only phase
 *   changes and instance moves under `autoApplyPhase`, alerts for relevant
 *   movements and designated hearings. Every automatic change is audited with
 *   the actor "Sistema · DataJud" (no content).
 * - Without DATAJUD_API_KEY every entry point reports "Coleta inativa" and
 *   nothing else changes.
 *
 * Services never import `next/*`. Users trigger syncs through
 * `syncProcessNow` (court_sync:run) and `requestPortfolioSync`
 * (admin:organization); jobs and routines use the system context.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { cnjDigits, isValidCnj, normalizeCnj } from "@/domain/cnj";
import {
  COURT_SYNC_STATUSES,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  type CourtSyncRunStatus,
  type CourtSyncStatus,
  type CourtSyncTrigger,
  type ProcessInstance,
  type ProcessPhase,
} from "@/domain/enums";
import { addDaysISO, formatDate, formatDateTime, pluralize, todayISO } from "@/lib/format";
import { resolveAlertsByDedupeKeys, upsertAlert } from "@/modules/alerts/service";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import { loadOrganization, mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import { ACTIVE_PORTFOLIO_STATUSES, isInActivePortfolio } from "@/modules/processes/service";
import { processWhere } from "@/server/auth/access";
import { systemContext, type AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  courtSyncRuns,
  courtSyncStates,
  jobs,
  legalProcesses,
  organizations,
  processEvents,
  processInstances,
  scheduledRoutines,
  type CourtInstanceFound,
  type OrganizationSettings,
} from "@/server/db/schema";
import {
  COURT_COLLECTION_INACTIVE,
  CourtProviderError,
  UNSUPPORTED_REASON_LABELS,
  aliasLabel,
  courtAliasesForCnj,
  getCourtProvider,
  getCourtRuntimeInfo,
  type CourtDataProvider,
  type CourtMovement,
  type CourtRecord,
} from "@/server/integrations/courts";
import { enqueueJob, safeErrorMessage } from "@/server/jobs/queue";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { diffChanges, recordAudit } from "@/server/services/audit";
import {
  CLOSURE_KINDS,
  DATAJUD_ACTOR,
  DATAJUD_SOURCE_LABEL,
  INSTANCE_RANK,
  RELEVANT_KIND_LABELS,
  courtsDiffer,
  describeComplements,
  eventTypeFor,
  hearingSituation,
  instanceForGrau,
  isForwardPhaseChange,
  isRemessaEmGrauDeRecurso,
  mergeVerificationNote,
  movementDate,
  movementExternalId,
  parseCityState,
  phaseTargetFor,
  relevantKind,
  reopensCase,
  sameDescriptive,
  sameProcessClass,
  sameText,
} from "./mapping";
import { grauText } from "./labels";
import { courtIntegrationSettingsSchema, type CourtIntegrationSettingsInput, type CourtSyncJobPayload } from "./schemas";

export type DataJudSettings = OrganizationSettings["integrations"]["datajud"];

/**
 * Alerts (relevant movement, designated hearing) only for movements dated
 * within this window, so the first sync of an old portfolio does not flood the
 * inbox. Exception: a closure-type movement (baixa, arquivamento, extinção,
 * trânsito) on the LATEST movement day of the process is always reported,
 * however old: that is the stale active process a person must look at.
 */
export const ALERT_LOOKBACK_DAYS = 120;
/** Numbers outside the CNJ pattern / without endpoint are re-evaluated after this many days. */
const UNSUPPORTED_RECHECK_DAYS = 30;
/** Processes handled by one call of `runCourtSync` (the rest stay due for the next run). */
export const MAX_PROCESSES_PER_RUN = 400;
/** A job with processes left re-enqueues itself, at most this many times. */
export const MAX_CONTINUATIONS = 50;
/**
 * A tribunal whose last N runs all failed, the oldest of them at least
 * FAILURE_ALERT_MIN_HOURS before the newest, raises `court_sync_failed` (a
 * short outage or a few quick manual retries do not page anyone).
 */
export const FAILED_RUNS_FOR_ALERT = 3;
export const FAILURE_ALERT_MIN_HOURS = 2;
/** Same limit as the process form (processes/schemas.ts). */
const MAX_VERIFICATION_NOTE = 2000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dataJudSystemContext(organizationId: string, isDemo = false): AuthContext {
  return { ...systemContext(organizationId, isDemo), name: DATAJUD_ACTOR };
}

function chunks<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

function unsupportedMessage(number: string): string | null {
  const a = courtAliasesForCnj(number);
  return a.supported ? null : UNSUPPORTED_REASON_LABELS[a.reason];
}

function sanitizedError(err: unknown): string {
  if (err instanceof CourtProviderError) return err.message;
  return safeErrorMessage(err);
}

function nextCheckAfterSuccess(settings: DataJudSettings, now = Date.now()): Date {
  return new Date(now + Math.max(1, settings.syncIntervalHours) * HOUR_MS);
}

/** Backoff after consecutive failures: 1 h, 2 h, 4 h... capped at the sync interval. */
export function nextCheckAfterError(consecutiveErrors: number, settings: DataJudSettings, now = Date.now()): Date {
  const hours = Math.min(Math.max(1, settings.syncIntervalHours), 2 ** Math.max(0, Math.min(10, consecutiveErrors - 1)));
  return new Date(now + hours * HOUR_MS);
}

/**
 * Tolerance so the routine does not skip, until its next run, a process
 * checked a few minutes later in the previous cycle (the jobs run after the
 * routine). It applies only to processes whose last check worked: a process
 * in error waits for its whole backoff.
 */
function dueSlackMs(settings: DataJudSettings): number {
  return Math.min(HOUR_MS, (Math.max(1, settings.syncIntervalHours) * HOUR_MS) / 4);
}

/** Whether a process is due for a check (same rule for the selection and the health page). */
function isDueForCheck(
  state: { nextCheckAt: Date | null; consecutiveErrors: number | null } | null,
  settings: DataJudSettings,
  now = Date.now(),
): boolean {
  if (!state?.nextCheckAt) return true;
  const limit = (state.consecutiveErrors ?? 0) > 0 ? now : now + dueSlackMs(settings);
  return state.nextCheckAt.getTime() <= limit;
}

const instanceLabel = (i: ProcessInstance) => PROCESS_INSTANCE_LABELS[i] ?? i;
const grauLabel = (grau: string) => {
  const i = instanceForGrau(grau);
  return i ? instanceLabel(i) : grauText(grau);
};
/** "no 1º grau", "no 3º grau", "na Turma recursal" (Portuguese contraction by gender). */
const inGrau = (label: string) => `${/^turma/i.test(label) ? "na" : "no"} ${label}`;

export type MovementWithGrau = { m: CourtMovement; grau: string; externalId: string };

/** Fields of a grau kept in `court_sync_states.instances_found` (what the tribunal informed at the last check). */
type RemoteField = "tribunal" | "courtDivision" | "processClass" | "filedAt";

/**
 * A difference between what is on record and what the tribunal informs for
 * `field` of `grau`. The note is written (and the process flagged) only when
 * the tribunal's value is NEW, i.e. differs from what it informed at the
 * previous check: a person who resolved the verification is not asked again
 * while the tribunal keeps saying the same thing.
 */
type Divergence = { grau: string; field: RemoteField; remote: string; note: string };

function divergence(grau: string, field: RemoteField, remote: string, label: string, local: string): Divergence {
  return { grau, field, remote, note: `[DataJud] ${label}: o tribunal informa "${remote}" (cadastro: "${local}"). Conferir.` };
}

/** Whether the tribunal already informed this value for the field at the previous check. */
function informedBefore(previous: CourtInstanceFound[], dv: Pick<Divergence, "grau" | "field" | "remote">): boolean {
  return previous.some((e) => e.grau.toUpperCase() === dv.grau.toUpperCase() && e[dv.field] === dv.remote);
}

function sortByDate(list: MovementWithGrau[]): MovementWithGrau[] {
  return [...list].sort((a, b) => (a.m.dateTime < b.m.dateTime ? -1 : a.m.dateTime > b.m.dateTime ? 1 : 0));
}

/**
 * External id of the most recent baixa/arquivamento/extinção (any grau) when
 * no later movement shows the case going on (see `reopensCase`); else null.
 */
export function standingClosureId(movements: MovementWithGrau[]): string | null {
  const chronological = sortByDate(movements);
  for (let i = chronological.length - 1; i >= 0; i--) {
    const kind = relevantKind(chronological[i].m);
    if (kind === null || !CLOSURE_KINDS.has(kind)) continue;
    return chronological.slice(i + 1).some((x) => reopensCase(x.m)) ? null : chronological[i].externalId;
  }
  return null;
}

/** Record that describes the process of origin (G1 when informed, else the lowest grau). */
export function originRecord(records: CourtRecord[]): CourtRecord {
  const ranked = [...records].sort((a, b) => {
    const ra = instanceForGrau(a.grau);
    const rb = instanceForGrau(b.grau);
    return (ra ? INSTANCE_RANK[ra] : 9) - (rb ? INSTANCE_RANK[rb] : 9);
  });
  return ranked[0];
}

/**
 * What to remember in `court_sync_states.instances_found` after a check: the
 * graus returned now, plus the previous entries of graus this check did not
 * return (a secondary tribunal that failed or timed out, e.g. the TST), kept
 * with their values and marked `notReturnedSince`. Missing data never erases
 * what the tribunal said before, so a divergence a person already resolved is
 * not reported again when that tribunal answers on a later check.
 */
export function mergeInstancesFound(previous: CourtInstanceFound[], records: CourtRecord[], now: Date): CourtInstanceFound[] {
  const returned: CourtInstanceFound[] = records.map((r) => ({
    grau: r.grau,
    tribunal: r.tribunal,
    alias: r.alias,
    remoteUpdatedAt: r.remoteUpdatedAt,
    courtDivision: r.courtDivision?.name ?? null,
    processClass: r.processClass?.name ?? null,
    filedAt: r.filedAt,
  }));
  const returnedGraus = new Set(returned.map((e) => e.grau.toUpperCase()));
  const kept = previous
    .filter((e) => !returnedGraus.has(e.grau.toUpperCase()))
    .map((e) => ({ ...e, notReturnedSince: e.notReturnedSince ?? now.toISOString() }));
  const rank = (grau: string) => {
    const inst = instanceForGrau(grau);
    return inst ? INSTANCE_RANK[inst] : 9;
  };
  return [...returned, ...kept].sort((a, b) => rank(a.grau) - rank(b.grau));
}

/** "3 h" / "2 dias" for the failure alert. */
function formatSpan(ms: number): string {
  const hours = Math.max(1, Math.round(ms / HOUR_MS));
  return hours < 48 ? `${hours} h` : pluralize(Math.round(hours / 24), "dia", "dias");
}

function maxIso(values: (string | null | undefined)[]): string | null {
  let out: string | null = null;
  for (const v of values) if (v && (!out || v > out)) out = v;
  return out;
}

// ---------------------------------------------------------------------------
// Fetching (provider calls)
// ---------------------------------------------------------------------------

export type CourtFetchResult =
  | { status: "inactive"; message: string }
  | { status: "unsupported"; message: string }
  | {
      status: "ok";
      primary: string;
      secondary: string[];
      records: CourtRecord[];
      /** Aliases that failed (sanitized messages). */
      errors: { alias: string; message: string }[];
    };

/**
 * Queries every endpoint of one CNJ number (origin tribunal + TST for labor
 * cases). Never writes anything. `attempts: 1` for interactive use.
 */
export async function fetchCourtRecordsForCnj(
  number: string,
  opts: { attempts?: number; timeoutMs?: number; maxRequestsPerMinute?: number } = {},
): Promise<CourtFetchResult> {
  const provider = getCourtProvider();
  if (!provider) return { status: "inactive", message: COURT_COLLECTION_INACTIVE };
  const aliases = courtAliasesForCnj(number);
  if (!aliases.supported) return { status: "unsupported", message: UNSUPPORTED_REASON_LABELS[aliases.reason] };
  const records: CourtRecord[] = [];
  const errors: { alias: string; message: string }[] = [];
  for (const alias of [aliases.primary, ...aliases.secondary]) {
    try {
      records.push(...(await provider.searchByNumbers(alias, [aliases.digits], opts)));
    } catch (err) {
      errors.push({ alias, message: sanitizedError(err) });
    }
  }
  return { status: "ok", primary: aliases.primary, secondary: aliases.secondary, records, errors };
}

// ---------------------------------------------------------------------------
// Applying the official data to one process
// ---------------------------------------------------------------------------

export type ApplyCourtRecordsResult = {
  status: "found" | "not_found" | "skipped";
  newMovements: number;
  phaseChanged: boolean;
  instanceChanged: boolean;
  instancesAdded: ProcessInstance[];
  filledFields: string[];
  verificationFlagged: boolean;
  alerts: number;
};

const EMPTY_RESULT: ApplyCourtRecordsResult = {
  status: "skipped",
  newMovements: 0,
  phaseChanged: false,
  instanceChanged: false,
  instancesAdded: [],
  filledFields: [],
  verificationFlagged: false,
  alerts: 0,
};

const PROCESS_AUDIT_FIELDS = [
  "phase",
  "instance",
  "courtDivision",
  "processClass",
  "city",
  "state",
  "filedAt",
  "lastMovementAt",
  "needsVerification",
  "verificationNote",
] as const;

const FIELD_NAMES: Record<string, string> = {
  courtDivision: "vara/órgão",
  processClass: "classe",
  city: "cidade",
  state: "UF",
  filedAt: "data de ajuizamento",
  subjects: "assuntos",
};

type ApplyMeta = {
  trigger: CourtSyncTrigger;
  settings: DataJudSettings;
  requestedById?: string | null;
  /** "YYYY-MM-DD" (tests). */
  today?: string;
};

async function upsertState(
  db: DbOrTx,
  organizationId: string,
  processId: string,
  values: Partial<typeof courtSyncStates.$inferInsert> & { status: CourtSyncStatus },
): Promise<void> {
  await db
    .insert(courtSyncStates)
    .values({ organizationId, processId, source: "datajud", ...values })
    .onConflictDoUpdate({ target: courtSyncStates.processId, set: { ...values, updatedAt: new Date() } });
}

/**
 * Applies the records informed by the tribunal to one process (system write,
 * one transaction). `records` may contain other numbers: only the process's
 * own number is used. Returns what changed.
 */
export async function applyCourtRecords(
  organizationId: string,
  processId: string,
  records: CourtRecord[],
  meta: ApplyMeta,
): Promise<ApplyCourtRecordsResult> {
  const today = meta.today ?? todayISO();
  const alertCutoff = addDaysISO(today, -ALERT_LOOKBACK_DAYS);
  const ctx = dataJudSystemContext(organizationId);
  const now = new Date();

  return getDb().transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId), isNull(legalProcesses.deletedAt)))
      .for("update");
    if (!p) return EMPTY_RESULT;
    const digits = cnjDigits(p.number);
    const recs = records.filter((r) => r.number === digits);

    if (recs.length === 0) {
      await upsertState(tx, organizationId, processId, {
        status: "not_found",
        lastCheckedAt: now,
        lastError: null,
        consecutiveErrors: 0,
        nextCheckAt: nextCheckAfterSuccess(meta.settings, now.getTime()),
      });
      return { ...EMPTY_RESULT, status: "not_found" };
    }

    const [prevState] = await tx
      .select({ instancesFound: courtSyncStates.instancesFound })
      .from(courtSyncStates)
      .where(eq(courtSyncStates.processId, p.id));
    const origin = originRecord(recs);
    const originInstance = instanceForGrau(origin.grau);
    /** Differences between the record and the tribunal (never overwritten; reported once per remote value). */
    const divergences: Divergence[] = [];

    // --- Instance links (G1 / G2 / SUP) ------------------------------------
    const existing = await tx
      .select()
      .from(processInstances)
      .where(and(eq(processInstances.processId, p.id), eq(processInstances.organizationId, organizationId)));
    const byInstance = new Map(existing.map((r) => [r.instance, r]));
    const instancesAdded: ProcessInstance[] = [];
    let instancesFilled = 0;
    const latestPerInstance = new Map<ProcessInstance, CourtRecord>();
    for (const rec of recs) {
      const inst = instanceForGrau(rec.grau);
      if (!inst) continue;
      const prev = latestPerInstance.get(inst);
      if (!prev || (rec.remoteUpdatedAt ?? "") > (prev.remoteUpdatedAt ?? "")) latestPerInstance.set(inst, rec);
    }
    for (const [inst, rec] of latestPerInstance) {
      const place = parseCityState(rec.courtDivision?.name);
      const row = byInstance.get(inst);
      if (!row) {
        await tx.insert(processInstances).values({
          organizationId,
          processId: p.id,
          instance: inst,
          court: rec.tribunal,
          courtDivision: rec.courtDivision?.name ?? null,
          city: place?.city ?? null,
          state: place?.state ?? null,
          processClass: rec.processClass?.name ?? null,
          isCurrent: p.instance === inst,
          origin: "imported",
        });
        instancesAdded.push(inst);
        continue;
      }
      const patch: Partial<typeof processInstances.$inferInsert> = {};
      if (!row.court?.trim()) patch.court = rec.tribunal;
      if (!row.courtDivision && rec.courtDivision?.name) patch.courtDivision = rec.courtDivision.name;
      if (!row.processClass && rec.processClass?.name) patch.processClass = rec.processClass.name;
      if (place && !row.city && !row.state) {
        patch.city = place.city;
        patch.state = place.state;
      }
      // Divergences of this instance. The instance of origin usually repeats the
      // process fields: when it holds the same value, the process note covers it.
      const coveredByProcess = (local: string | null, processValue: string | null) => inst === originInstance && sameText(local, processValue);
      const where = instanceLabel(inst);
      if (row.court?.trim() && courtsDiffer(row.court, rec.tribunal) && !coveredByProcess(row.court, p.court)) {
        divergences.push(divergence(rec.grau, "tribunal", rec.tribunal, `Tribunal ${inGrau(where)}`, row.court));
      }
      if (row.courtDivision && rec.courtDivision?.name && !sameDescriptive(row.courtDivision, rec.courtDivision.name) && !coveredByProcess(row.courtDivision, p.courtDivision)) {
        divergences.push(divergence(rec.grau, "courtDivision", rec.courtDivision.name, `Órgão julgador ${inGrau(where)}`, row.courtDivision));
      }
      if (row.processClass && rec.processClass?.name && !sameProcessClass(row.processClass, rec.processClass.name) && !coveredByProcess(row.processClass, p.processClass)) {
        divergences.push(divergence(rec.grau, "processClass", rec.processClass.name, `Classe ${inGrau(where)}`, row.processClass));
      }
      if (Object.keys(patch).length > 0) {
        await tx.update(processInstances).set(patch).where(eq(processInstances.id, row.id));
        instancesFilled++;
      }
    }

    // --- Movements: insert only the new ones -------------------------------
    const all: MovementWithGrau[] = [];
    const seen = new Set<string>();
    for (const rec of recs) {
      for (const m of rec.movements) {
        const externalId = movementExternalId(m, rec.grau);
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        all.push({ m, grau: rec.grau, externalId });
      }
    }
    const divisionOf = new Map(recs.map((r) => [r.grau, r.courtDivision?.name ?? null]));
    const eventRows = all.map(({ m, grau, externalId }) => {
      const details = describeComplements(m.complements);
      const otherDivision = m.courtDivision && m.courtDivision !== divisionOf.get(grau) ? `Órgão: ${m.courtDivision}` : null;
      return {
        organizationId,
        processId: p.id,
        occurredAt: movementDate(m),
        type: eventTypeFor(m),
        title: m.name.slice(0, 200),
        description: [details, otherDivision].filter(Boolean).join(". ") || null,
        origin: "imported" as const,
        externalSource: DATAJUD_SOURCE_LABEL,
        externalId,
        cnjMovementCode: m.code,
        instance: instanceForGrau(grau),
        createdById: null,
      };
    });
    const insertedIds = new Set<string>();
    for (const part of chunks(eventRows, 300)) {
      const inserted = await tx
        .insert(processEvents)
        .values(part)
        .onConflictDoNothing({
          target: [processEvents.processId, processEvents.externalSource, processEvents.externalId],
          where: sql`${processEvents.externalId} is not null`,
        })
        .returning({ externalId: processEvents.externalId });
      for (const r of inserted) if (r.externalId) insertedIds.add(r.externalId);
    }
    const fresh = sortByDate(all.filter((x) => insertedIds.has(x.externalId)));

    // --- Process fields: fill empty ones, record divergences ---------------
    const patch: Partial<typeof legalProcesses.$inferInsert> = {};
    const filled: string[] = [];
    const notes: string[] = [];
    if (courtsDiffer(p.court, origin.tribunal)) {
      divergences.push(divergence(origin.grau, "tribunal", origin.tribunal, "Tribunal", p.court));
    }
    if (!p.courtDivision && origin.courtDivision?.name) {
      patch.courtDivision = origin.courtDivision.name;
      filled.push("courtDivision");
    } else if (p.courtDivision && origin.courtDivision?.name && !sameDescriptive(p.courtDivision, origin.courtDivision.name)) {
      divergences.push(divergence(origin.grau, "courtDivision", origin.courtDivision.name, "Órgão julgador", p.courtDivision));
    }
    if (!p.processClass && origin.processClass?.name) {
      patch.processClass = origin.processClass.name.slice(0, 120);
      filled.push("processClass");
    } else if (p.processClass && origin.processClass?.name && !sameProcessClass(p.processClass, origin.processClass.name)) {
      divergences.push(divergence(origin.grau, "processClass", origin.processClass.name, "Classe", p.processClass));
    }
    const place = parseCityState(origin.courtDivision?.name);
    if (place) {
      if (!p.city && !p.state) {
        patch.city = place.city;
        patch.state = place.state;
        filled.push("city", "state");
      } else if (!p.city && p.state === place.state) {
        patch.city = place.city;
        filled.push("city");
      } else if (p.city && !p.state && sameText(p.city, place.city)) {
        patch.state = place.state;
        filled.push("state");
      }
      if (p.city && !sameText(p.city, place.city)) {
        divergences.push({
          grau: origin.grau,
          field: "courtDivision", // city/UF come from the órgão name
          remote: origin.courtDivision?.name ?? "",
          note: `[DataJud] Cidade informada pelo tribunal: ${place.city}/${place.state} (cadastro: ${p.city}${p.state ? `/${p.state}` : ""}). Conferir.`,
        });
      } else if (p.state && p.state !== place.state) {
        divergences.push({
          grau: origin.grau,
          field: "courtDivision",
          remote: origin.courtDivision?.name ?? "",
          note: `[DataJud] UF informada pelo tribunal: ${place.state} (cadastro: ${p.state}). Conferir.`,
        });
      }
    }
    if (origin.filedAt) {
      if (!p.filedAt) {
        patch.filedAt = origin.filedAt;
        filled.push("filedAt");
      } else if (p.filedAt !== origin.filedAt) {
        divergences.push({
          grau: origin.grau,
          field: "filedAt",
          remote: origin.filedAt,
          note: `[DataJud] Data de ajuizamento informada pelo tribunal: ${formatDate(origin.filedAt)} (cadastro: ${formatDate(p.filedAt)}). Conferir.`,
        });
      }
    }
    // Only a divergence on a value the tribunal informs for the first time (or
    // changed since the previous check) is noted: once a person resolves the
    // verification, the same difference does not flag the process again.
    const previouslyInformed = prevState?.instancesFound ?? [];
    const newDivergences = divergences.filter((dv) => !informedBefore(previouslyInformed, dv));
    for (const dv of newDivergences) notes.push(dv.note);
    const subjects = [...new Map(recs.flatMap((r) => r.subjects).map((s) => [s.code, s])).values()].sort((a, b) => a.code - b.code);
    if (subjects.length > 0 && JSON.stringify(subjects) !== JSON.stringify(p.subjects ?? null)) {
      patch.subjects = subjects;
      if (!p.subjects) filled.push("subjects");
    }
    const lastMovement = maxIso(all.map((x) => movementDate(x.m)));
    if (lastMovement && (!p.lastMovementAt || lastMovement > p.lastMovementAt)) patch.lastMovementAt = lastMovement;

    // --- Phase (forward only) and instance (remessa em grau de recurso) ----
    const auto = meta.settings.autoApplyPhase;
    const pendingNotes: string[] = [];
    let phaseChanged = false;
    let instanceChanged = false;
    const phaseHit = [...fresh].reverse().find((x) => phaseTargetFor(x.m) !== null);
    if (phaseHit) {
      const target = phaseTargetFor(phaseHit.m) as ProcessPhase;
      // A process out of the active portfolio (closed/archived) never changes phase automatically.
      if (isInActivePortfolio(p.status) && isForwardPhaseChange(p.phase, target)) {
        if (auto) {
          patch.phase = target;
          phaseChanged = true;
        } else {
          pendingNotes.push(
            `"${phaseHit.m.name}" em ${formatDate(movementDate(phaseHit.m))} indica a fase ${PROCESS_PHASE_LABELS[target]}: aplique manualmente se confirmado.`,
          );
        }
      }
    }
    const remessa = [...fresh].reverse().find((x) => isRemessaEmGrauDeRecurso(x.m) && instanceForGrau(x.grau) !== null);
    if (remessa) {
      const from = instanceForGrau(remessa.grau) as ProcessInstance;
      const target: ProcessInstance | null = from === "first" ? "second" : from === "second" ? "superior" : null;
      const sourceRecord = recs.find((r) => r.grau === remessa.grau);
      const latestOfGrau = sourceRecord?.movements[sourceRecord.movements.length - 1];
      const stillThere = latestOfGrau ? movementExternalId(latestOfGrau, remessa.grau) === remessa.externalId : false;
      if (target && stillThere && (!p.instance || INSTANCE_RANK[target] > INSTANCE_RANK[p.instance])) {
        if (auto) {
          patch.instance = target;
          instanceChanged = true;
        } else {
          pendingNotes.push(
            `Remessa em grau de recurso em ${formatDate(movementDate(remessa.m))}: o processo deve estar ${inGrau(instanceLabel(target))} (atualize a instância se confirmado).`,
          );
        }
      }
    }

    // --- Relevant movements (never close automatically) --------------------
    // Within the alert window; on the latest movement day whatever its age (an
    // "active" process whose last word in court is a baixa/arquivamento); or the
    // most recent baixa/arquivamento/extinção that nothing after it shows the
    // case going on (a routine petição after a baixa does not hide it).
    const latestDay = maxIso(all.map((x) => movementDate(x.m)));
    const standingClosure = standingClosureId(all);
    const relevant = fresh.filter(
      (x) =>
        relevantKind(x.m) !== null &&
        (movementDate(x.m) >= alertCutoff || movementDate(x.m) === latestDay || x.externalId === standingClosure),
    );
    for (const x of relevant.slice(-3)) {
      const kind = relevantKind(x.m)!;
      notes.push(
        `[DataJud] ${RELEVANT_KIND_LABELS[kind]}: "${x.m.name}" em ${formatDate(movementDate(x.m))} ${inGrau(grauLabel(x.grau))}. Conferir se o processo continua na carteira ativa.`,
      );
    }
    let verificationFlagged = false;
    if (notes.length > 0) {
      const current = p.verificationNote ?? "";
      const additions = notes.filter((n) => !current.includes(n));
      if (additions.length > 0 || !p.needsVerification) {
        patch.needsVerification = true;
        patch.verificationNote = mergeVerificationNote(p.verificationNote, additions, MAX_VERIFICATION_NOTE);
        verificationFlagged = true;
      }
    }

    if (Object.keys(patch).length > 0) {
      await tx
        .update(legalProcesses)
        .set({ ...patch, updatedAt: now })
        .where(and(eq(legalProcesses.id, p.id), eq(legalProcesses.organizationId, organizationId)));
    }
    if (instanceChanged && patch.instance) {
      await tx
        .update(processInstances)
        .set({ isCurrent: sql`${processInstances.instance} = ${patch.instance}` })
        .where(and(eq(processInstances.processId, p.id), eq(processInstances.organizationId, organizationId)));
    }

    // --- State ---------------------------------------------------------------
    const instancesFound = mergeInstancesFound(previouslyInformed, recs, now);
    const remoteUpdated = maxIso(recs.map((r) => r.remoteUpdatedAt));
    await upsertState(tx, organizationId, p.id, {
      status: "found",
      lastCheckedAt: now,
      lastFoundAt: now,
      remoteUpdatedAt: remoteUpdated ? new Date(remoteUpdated) : null,
      instancesFound,
      lastError: null,
      consecutiveErrors: 0,
      nextCheckAt: nextCheckAfterSuccess(meta.settings, now.getTime()),
    });

    // --- Alerts --------------------------------------------------------------
    let alertCount = 0;
    if (relevant.length > 0 || pendingNotes.length > 0) {
      const lines = relevant
        .slice(-3)
        .map((x) => `${x.m.name} em ${formatDate(movementDate(x.m))} ${inGrau(grauLabel(x.grau))}`);
      const message = [
        lines.length ? `O DataJud informou: ${lines.join("; ")}.` : null,
        lines.length ? "O processo ficou pendente de conferência; nada foi encerrado automaticamente." : null,
        ...pendingNotes,
      ]
        .filter(Boolean)
        .join(" ");
      await upsertAlert(
        {
          organizationId,
          type: "court_movement_relevant",
          severity: "warning",
          title: `Movimentação relevante no tribunal: ${p.number}`,
          message,
          entityType: "legal_process",
          entityId: p.id,
          dedupeKey: `court_movement_relevant:${p.id}`,
        },
        tx,
      );
      alertCount++;
    }
    // Hearings: the latest situation of each hearing movement (grau + code) decides.
    const groups = new Map<string, MovementWithGrau[]>();
    for (const x of sortByDate(all)) {
      if (hearingSituation(x.m) === null) continue;
      const key = `${x.grau}|${x.m.code ?? x.m.name}`;
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    const toResolve: string[] = [];
    for (const list of groups.values()) {
      const latest = list[list.length - 1];
      const designated = hearingSituation(latest.m) === "designada";
      for (const x of list) {
        if (hearingSituation(x.m) === "designada" && !(designated && x === latest)) {
          toResolve.push(`court_hearing_designated:${p.id}:${x.externalId}`);
        }
      }
      if (designated && insertedIds.has(latest.externalId) && movementDate(latest.m) >= alertCutoff) {
        await upsertAlert(
          {
            organizationId,
            type: "court_hearing_designated",
            severity: "warning",
            title: `Audiência designada no tribunal: ${p.number}`,
            message:
              `O DataJud informa audiência "${latest.m.name}" designada ${inGrau(grauLabel(latest.grau))} ` +
              `(movimentação de ${formatDate(movementDate(latest.m))}). Data não informada pelo tribunal: cadastre a partir da intimação.`,
            entityType: "legal_process",
            entityId: p.id,
            dedupeKey: `court_hearing_designated:${p.id}:${latest.externalId}`,
          },
          tx,
        );
        alertCount++;
      }
    }
    if (toResolve.length > 0) await resolveAlertsByDedupeKeys(organizationId, toResolve, tx);

    // --- Audit ---------------------------------------------------------------
    const changed =
      fresh.length > 0 || Object.keys(patch).length > 0 || instancesAdded.length > 0 || instancesFilled > 0;
    if (changed) {
      const before = Object.fromEntries(PROCESS_AUDIT_FIELDS.map((k) => [k, p[k]]));
      const after = { ...before, ...Object.fromEntries(PROCESS_AUDIT_FIELDS.filter((k) => k in patch).map((k) => [k, patch[k]])) };
      const parts = [
        fresh.length ? pluralize(fresh.length, "movimentação nova importada", "movimentações novas importadas") : null,
        phaseChanged && patch.phase ? `fase: ${PROCESS_PHASE_LABELS[p.phase] ?? p.phase} para ${PROCESS_PHASE_LABELS[patch.phase]}` : null,
        instanceChanged && patch.instance ? `instância atual: ${instanceLabel(patch.instance)}` : null,
        instancesAdded.length ? `vínculo com ${instancesAdded.map(instanceLabel).join(" e ")} criado` : null,
        filled.length ? `campos vazios preenchidos: ${filled.map((f) => FIELD_NAMES[f] ?? f).join(", ")}` : null,
        verificationFlagged ? "pendente de conferência" : null,
      ].filter(Boolean);
      await recordAudit(
        ctx,
        {
          action: "legal_process.court_sync",
          entityType: "legal_process",
          entityId: p.id,
          summary: `${DATAJUD_ACTOR}: ${parts.length ? parts.join("; ") : "dados conferidos"} (processo ${p.number}).`,
          changes: diffChanges(before, after),
          metadata: {
            source: "datajud",
            actor: DATAJUD_ACTOR,
            // Name shown as the author in the history when there is no user (actorId null).
            actorLabel: DATAJUD_ACTOR,
            trigger: meta.trigger,
            newMovements: fresh.length,
            instancesAdded,
            instancesFilled,
            filledFields: filled,
            subjectsUpdated: "subjects" in patch,
            divergencesReported: newDivergences.map((dv) => `${dv.grau}.${dv.field}`),
            requestedById: meta.requestedById ?? null,
          },
        },
        tx,
      );
      await markAnalysesStaleForEntity({ organizationId, entityId: p.id, reason: "Dados atualizados pelo DataJud" }, tx);
    }

    return {
      status: "found",
      newMovements: fresh.length,
      phaseChanged,
      instanceChanged,
      instancesAdded,
      filledFields: filled,
      verificationFlagged,
      alerts: alertCount,
    };
  });
}

async function markProcessError(
  organizationId: string,
  processId: string,
  previousErrors: number,
  message: string,
  settings: DataJudSettings,
): Promise<void> {
  const consecutive = previousErrors + 1;
  await upsertState(getDb(), organizationId, processId, {
    status: "error",
    lastCheckedAt: new Date(),
    lastError: message.slice(0, 500),
    consecutiveErrors: consecutive,
    nextCheckAt: nextCheckAfterError(consecutive, settings),
  });
}

// ---------------------------------------------------------------------------
// Runs (routine, jobs, manual)
// ---------------------------------------------------------------------------

type Candidate = { id: string; number: string; consecutiveErrors: number };

export type CourtSyncRunResult = {
  alias: string;
  runId: string;
  status: CourtSyncRunStatus;
  checked: number;
  found: number;
  notFound: number;
  newMovements: number;
  phaseChanges: number;
  errors: number;
  errorMessage: string | null;
};

export type CourtSyncSummary =
  | { status: "inactive" | "disabled"; message: string; runs: []; unsupported: 0; remaining: 0 }
  | { status: "completed"; message: string; runs: CourtSyncRunResult[]; unsupported: number; remaining: number };

export type RunCourtSyncOptions = {
  trigger: CourtSyncTrigger;
  /** Only processes whose tribunal of origin is this endpoint alias. */
  alias?: string;
  /** Explicit processes (ignores `next_check_at` and the portfolio status). */
  processIds?: string[];
  /** All active processes, even those not due yet. */
  force?: boolean;
  /** With `force`: skip processes already checked since this moment (continuation of a long run). */
  notCheckedSince?: Date;
  limit?: number;
  /** Provider attempts per query (default 3; interactive calls use 1). */
  attempts?: number;
  requestedById?: string | null;
  /** Tests: provider override. */
  provider?: CourtDataProvider;
};

async function loadCandidates(organizationId: string, settings: DataJudSettings, opts: RunCourtSyncOptions): Promise<Candidate[]> {
  const db = getDb();
  const now = Date.now();
  const dueLimit = new Date(now + dueSlackMs(settings));
  const explicit = opts.processIds && opts.processIds.length > 0;
  // Due: never checked; last check worked and the interval passed (with the
  // slack); last check failed and the whole backoff passed (no slack).
  const due = or(
    isNull(courtSyncStates.nextCheckAt),
    and(eq(courtSyncStates.consecutiveErrors, 0), lte(courtSyncStates.nextCheckAt, dueLimit)),
    and(gt(courtSyncStates.consecutiveErrors, 0), lte(courtSyncStates.nextCheckAt, new Date(now))),
  );
  const rows = await db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      consecutiveErrors: courtSyncStates.consecutiveErrors,
      status: courtSyncStates.status,
      nextCheckAt: courtSyncStates.nextCheckAt,
    })
    .from(legalProcesses)
    .leftJoin(courtSyncStates, eq(courtSyncStates.processId, legalProcesses.id))
    .where(
      and(
        eq(legalProcesses.organizationId, organizationId),
        isNull(legalProcesses.deletedAt),
        explicit ? inArray(legalProcesses.id, opts.processIds!) : inArray(legalProcesses.status, [...ACTIVE_PORTFOLIO_STATUSES]),
        // Numbers without a query (invalid, unsupported) come back early when someone corrected them.
        explicit || opts.force ? undefined : or(due, eq(courtSyncStates.status, "unsupported")),
        !explicit && opts.force && opts.notCheckedSince
          ? or(isNull(courtSyncStates.lastCheckedAt), lt(courtSyncStates.lastCheckedAt, opts.notCheckedSince))
          : undefined,
      ),
    )
    .orderBy(asc(sql`coalesce(${courtSyncStates.nextCheckAt}, '1970-01-01'::timestamptz)`), asc(legalProcesses.number));
  return rows
    .filter(
      (r) =>
        explicit ||
        opts.force ||
        r.status !== "unsupported" ||
        isDueForCheck({ nextCheckAt: r.nextCheckAt, consecutiveErrors: r.consecutiveErrors }, settings, now) ||
        courtAliasesForCnj(r.number).supported,
    )
    .map((r) => ({ id: r.id, number: r.number, consecutiveErrors: r.consecutiveErrors ?? 0 }));
}

/** Due processes grouped by the endpoint of origin (primary alias). */
function groupByAlias(candidates: Candidate[]): { groups: Map<string, { secondary: string[]; items: Candidate[] }>; unsupported: Candidate[] } {
  const groups = new Map<string, { secondary: string[]; items: Candidate[] }>();
  const unsupported: Candidate[] = [];
  for (const c of candidates) {
    const a = courtAliasesForCnj(c.number);
    if (!a.supported) {
      unsupported.push(c);
      continue;
    }
    const g = groups.get(a.primary) ?? { secondary: [], items: [] };
    for (const s of a.secondary) if (!g.secondary.includes(s)) g.secondary.push(s);
    g.items.push(c);
    groups.set(a.primary, g);
  }
  return { groups, unsupported };
}

async function markUnsupported(organizationId: string, items: Candidate[]): Promise<void> {
  if (items.length === 0) return;
  const now = new Date();
  const next = new Date(now.getTime() + UNSUPPORTED_RECHECK_DAYS * DAY_MS);
  for (const part of chunks(items, 200)) {
    await getDb()
      .insert(courtSyncStates)
      .values(
        part.map((c) => ({
          organizationId,
          processId: c.id,
          source: "datajud",
          status: "unsupported" as const,
          lastCheckedAt: now,
          nextCheckAt: next,
          lastError: unsupportedMessage(c.number),
        })),
      )
      .onConflictDoUpdate({
        target: courtSyncStates.processId,
        set: {
          status: sql`excluded.status`,
          lastCheckedAt: sql`excluded.last_checked_at`,
          nextCheckAt: sql`excluded.next_check_at`,
          lastError: sql`excluded.last_error`,
          updatedAt: now,
        },
      });
  }
}

async function raiseFailureAlertIfRepeated(organizationId: string, alias: string, sampleProcessId: string | null, lastError: string | null) {
  const db = getDb();
  const recent = await db
    .select({ status: courtSyncRuns.status, startedAt: courtSyncRuns.startedAt })
    .from(courtSyncRuns)
    .where(and(eq(courtSyncRuns.organizationId, organizationId), eq(courtSyncRuns.tribunalAlias, alias), sql`${courtSyncRuns.status} <> 'running'`))
    .orderBy(desc(courtSyncRuns.startedAt))
    .limit(FAILED_RUNS_FOR_ALERT);
  const key = `court_sync_failed:${alias}`;
  const span = recent.length > 0 ? recent[0].startedAt.getTime() - recent[recent.length - 1].startedAt.getTime() : 0;
  if (
    recent.length >= FAILED_RUNS_FOR_ALERT &&
    recent.every((r) => r.status === "failed") &&
    span >= FAILURE_ALERT_MIN_HOURS * HOUR_MS
  ) {
    if (!sampleProcessId) return;
    await upsertAlert({
      organizationId,
      type: "court_sync_failed",
      severity: "critical",
      title: `Coleta no DataJud falhando: ${aliasLabel(alias)}`,
      message:
        `As últimas ${FAILED_RUNS_FOR_ALERT} consultas ao DataJud para ${aliasLabel(alias)} falharam, ao longo de ${formatSpan(span)}` +
        `${lastError ? ` (último erro: ${lastError})` : ""}. Os processos continuam com os dados atuais; ` +
        "a coleta tenta de novo automaticamente. Veja Administração, Integrações, DataJud.",
      entityType: "legal_process",
      entityId: sampleProcessId,
      dedupeKey: key,
    });
  } else if (recent[0] && recent[0].status !== "failed") {
    await resolveAlertsByDedupeKeys(organizationId, [key]);
  }
}

/**
 * Checks the due processes of an organization (or the given ones) against the
 * DataJud. Provider failures never throw: they are recorded per process (with
 * backoff) and per tribunal run. Only unexpected database errors propagate.
 */
export async function runCourtSync(organizationId: string, opts: RunCourtSyncOptions): Promise<CourtSyncSummary> {
  const provider = opts.provider ?? getCourtProvider();
  if (!provider) return { status: "inactive", message: COURT_COLLECTION_INACTIVE, runs: [], unsupported: 0, remaining: 0 };
  const org = await loadOrganization(organizationId);
  const settings = org.settings.integrations.datajud;
  if (!settings.enabled && opts.trigger === "routine") {
    return {
      status: "disabled",
      message: "Acompanhamento automático no DataJud desativado nas configurações.",
      runs: [],
      unsupported: 0,
      remaining: 0,
    };
  }

  const candidates = await loadCandidates(organizationId, settings, opts);
  const { groups, unsupported } = groupByAlias(candidates);
  await markUnsupported(organizationId, unsupported);

  const limit = Math.max(1, opts.limit ?? MAX_PROCESSES_PER_RUN);
  let budget = limit;
  let remaining = 0;
  const runs: CourtSyncRunResult[] = [];
  const aliases = [...groups.keys()].filter((a) => !opts.alias || a === opts.alias).sort();
  for (const alias of aliases) {
    const group = groups.get(alias)!;
    const items = group.items.slice(0, Math.max(0, budget));
    remaining += group.items.length - items.length;
    if (items.length === 0) continue;
    budget -= items.length;
    runs.push(await runAlias(organizationId, provider, alias, group.secondary, items, settings, opts));
  }
  const totals = runs.reduce(
    (acc, r) => ({ checked: acc.checked + r.checked, found: acc.found + r.found, moves: acc.moves + r.newMovements, errors: acc.errors + r.errors }),
    { checked: 0, found: 0, moves: 0, errors: 0 },
  );
  const message =
    `${pluralize(totals.checked, "processo consultado", "processos consultados")} em ${pluralize(runs.length, "tribunal", "tribunais")}: ` +
    `${totals.found} encontrado(s), ${pluralize(totals.moves, "movimentação nova", "movimentações novas")}` +
    `${totals.errors ? `, ${totals.errors} com falha` : ""}` +
    `${unsupported.length ? `; ${unsupported.length} sem consulta disponível (dígito verificador inválido, número fora do padrão ou tribunal sem endpoint)` : ""}` +
    `${remaining ? `; ${remaining} ficam para a próxima execução` : ""}.`;
  return { status: "completed", message, runs, unsupported: unsupported.length, remaining };
}

async function runAlias(
  organizationId: string,
  provider: CourtDataProvider,
  alias: string,
  secondary: string[],
  items: Candidate[],
  settings: DataJudSettings,
  opts: RunCourtSyncOptions,
): Promise<CourtSyncRunResult> {
  const db = getDb();
  const started = Date.now();
  const [run] = await db
    .insert(courtSyncRuns)
    .values({ organizationId, tribunalAlias: alias, trigger: opts.trigger, status: "running", source: "datajud" })
    .returning({ id: courtSyncRuns.id });
  const r: CourtSyncRunResult = {
    alias,
    runId: run.id,
    status: "running",
    checked: 0,
    found: 0,
    notFound: 0,
    newMovements: 0,
    phaseChanges: 0,
    errors: 0,
    errorMessage: null,
  };
  let secondaryFailure: string | null = null;
  const searchOpts = { maxRequestsPerMinute: settings.maxRequestsPerMinute, attempts: opts.attempts };

  for (const batch of chunks(items, settings.batchSize)) {
    const numbers = batch.map((c) => cnjDigits(c.number));
    let records: CourtRecord[] = [];
    let primaryError: string | null = null;
    try {
      records = await provider.searchByNumbers(alias, numbers, searchOpts);
    } catch (err) {
      primaryError = sanitizedError(err);
    }
    if (!primaryError) {
      for (const sec of secondary) {
        try {
          records.push(...(await provider.searchByNumbers(sec, numbers, searchOpts)));
        } catch (err) {
          secondaryFailure ??= `${aliasLabel(sec)}: ${sanitizedError(err)}`;
        }
      }
    }
    for (const c of batch) {
      r.checked++;
      if (primaryError) {
        r.errors++;
        r.errorMessage ??= primaryError;
        await markProcessError(organizationId, c.id, c.consecutiveErrors, primaryError, settings);
        continue;
      }
      try {
        const res = await applyCourtRecords(organizationId, c.id, records, {
          trigger: opts.trigger,
          settings,
          requestedById: opts.requestedById,
        });
        if (res.status === "found") r.found++;
        else if (res.status === "not_found") r.notFound++;
        r.newMovements += res.newMovements;
        if (res.phaseChanged) r.phaseChanges++;
      } catch (err) {
        const message = safeErrorMessage(err);
        r.errors++;
        r.errorMessage ??= message;
        logger.error("court_sync_apply_failed", { processId: c.id, alias, error: message });
        await markProcessError(organizationId, c.id, c.consecutiveErrors, message, settings);
      }
    }
  }

  r.status = r.checked > 0 && r.errors === r.checked ? "failed" : r.errors > 0 || secondaryFailure ? "partial" : "succeeded";
  if (!r.errorMessage && secondaryFailure) r.errorMessage = secondaryFailure;
  await db
    .update(courtSyncRuns)
    .set({
      finishedAt: new Date(),
      status: r.status,
      checked: r.checked,
      found: r.found,
      notFound: r.notFound,
      newMovements: r.newMovements,
      phaseChanges: r.phaseChanges,
      errors: r.errors,
      errorMessage: r.errorMessage?.slice(0, 500) ?? null,
      durationMs: Date.now() - started,
    })
    .where(eq(courtSyncRuns.id, run.id));
  logger.info("court_sync_run", {
    organizationId,
    alias,
    trigger: opts.trigger,
    status: r.status,
    checked: r.checked,
    found: r.found,
    newMovements: r.newMovements,
    errors: r.errors,
  });
  await raiseFailureAlertIfRepeated(organizationId, alias, items[0]?.id ?? null, r.errorMessage);
  return r;
}

/**
 * Job body of "court_sync.run". Each job handles at most MAX_PROCESSES_PER_RUN
 * processes (bounded duration); when processes are left, it enqueues its own
 * continuation (same tribunal) instead of waiting for the next routine run.
 * A run that failed entirely (tribunal unavailable) does not continue: the
 * rest stays due and the routine retries later, so an outage is not hammered.
 */
/**
 * Next continuation step of a tribunal job, or null when the chain stops:
 * nothing left, explicit processes, the cap reached, or a run that failed
 * entirely (the tribunal is down: the rest waits for the routine).
 */
export function continuationStep(summary: CourtSyncSummary, payload: CourtSyncJobPayload): number | null {
  const step = (payload.continuation ?? 0) + 1;
  if (summary.status !== "completed" || summary.remaining <= 0) return null;
  if (!payload.alias || payload.processIds || step > MAX_CONTINUATIONS) return null;
  if (summary.runs.some((r) => r.status === "failed")) return null;
  return step;
}

export async function runCourtSyncJob(organizationId: string, payload: CourtSyncJobPayload): Promise<CourtSyncSummary> {
  const since = payload.since ? new Date(payload.since) : new Date();
  const summary = await runCourtSync(organizationId, {
    trigger: payload.trigger,
    alias: payload.alias,
    processIds: payload.processIds,
    force: payload.force,
    notCheckedSince: payload.force ? since : undefined,
    requestedById: payload.requestedById ?? null,
  });
  const step = continuationStep(summary, payload);
  if (step !== null && payload.alias) {
    await enqueueJob({
      type: "court_sync.run",
      organizationId,
      payload: { ...payload, continuation: step, since: since.toISOString() },
      dedupeKey: `${courtSyncJobKey(organizationId, payload.alias)}:${payload.trigger}:cont:${step}`,
      runAt: new Date(Date.now() + 30_000),
      maxAttempts: 2,
    });
  }
  return summary;
}

/** Due processes per endpoint of origin (routine and portfolio button). */
export async function listDueAliases(
  organizationId: string,
  settings: DataJudSettings,
  opts: { force?: boolean } = {},
): Promise<{ alias: string; processes: number }[]> {
  const candidates = await loadCandidates(organizationId, settings, { trigger: "routine", force: opts.force });
  const { groups } = groupByAlias(candidates);
  return [...groups.entries()].map(([alias, g]) => ({ alias, processes: g.items.length })).sort((a, b) => a.alias.localeCompare(b.alias));
}

export function courtSyncJobKey(organizationId: string, alias: string): string {
  return `court_sync:${organizationId}:${alias}`;
}

/**
 * Tribunals that already have a "court_sync.run" job queued or running
 * (routine, manual request or continuation): the routine leaves them alone,
 * so the same processes are not queried twice at the same time.
 */
export async function aliasesWithPendingSync(organizationId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.organizationId, organizationId), eq(jobs.type, "court_sync.run"), inArray(jobs.status, ["queued", "running"])));
  const out = new Set<string>();
  for (const r of rows) {
    const alias = (r.payload as { alias?: unknown } | null)?.alias;
    if (typeof alias === "string") out.add(alias);
  }
  return out;
}

// ---------------------------------------------------------------------------
// User-facing entry points
// ---------------------------------------------------------------------------

export type SyncProcessResult = {
  status: "inactive" | "unsupported" | "found" | "not_found" | "error";
  message: string;
  newMovements: number;
};

/** "Sincronizar agora" on a process (court_sync:run + visibility). Runs inline, one attempt per endpoint. */
export async function syncProcessNow(ctx: AuthContext, processId: string): Promise<SyncProcessResult> {
  assertCan(ctx, "court_sync:run");
  if (!z.guid().safeParse(processId).success) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  const [p] = await getDb()
    .select({ id: legalProcesses.id, number: legalProcesses.number })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), processWhere(ctx)));
  if (!p) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  if (!getCourtProvider()) return { status: "inactive", message: COURT_COLLECTION_INACTIVE, newMovements: 0 };
  const aliases = courtAliasesForCnj(p.number);
  if (!aliases.supported) {
    await markUnsupported(ctx.organizationId, [{ id: p.id, number: p.number, consecutiveErrors: 0 }]);
    return { status: "unsupported", message: UNSUPPORTED_REASON_LABELS[aliases.reason], newMovements: 0 };
  }
  const summary = await runCourtSync(ctx.organizationId, {
    trigger: "manual",
    processIds: [p.id],
    attempts: 1,
    requestedById: ctx.userId,
  });
  const run = summary.runs[0];
  if (!run) return { status: "inactive", message: summary.message, newMovements: 0 };
  if (run.errors > 0) {
    return { status: "error", message: `Não foi possível consultar o DataJud agora: ${run.errorMessage ?? "falha na consulta"}`, newMovements: 0 };
  }
  if (run.found === 0) {
    return {
      status: "not_found",
      message: "O número não foi encontrado no DataJud (o tribunal pode ainda não ter enviado os dados ao CNJ).",
      newMovements: 0,
    };
  }
  return {
    status: "found",
    message:
      run.newMovements > 0
        ? `Dados atualizados pelo DataJud: ${pluralize(run.newMovements, "movimentação nova", "movimentações novas")}.`
        : "Dados conferidos no DataJud: nenhuma movimentação nova.",
    newMovements: run.newMovements,
  };
}

/** "Sincronizar a carteira agora" (admin): enqueues one job per tribunal for every active process. */
export async function requestPortfolioSync(ctx: AuthContext): Promise<{ jobs: number; processes: number }> {
  assertCan(ctx, "admin:organization");
  if (!getCourtProvider()) throw new ValidationError(COURT_COLLECTION_INACTIVE);
  const org = await loadOrganization(ctx.organizationId);
  const due = await listDueAliases(ctx.organizationId, org.settings.integrations.datajud, { force: true });
  // Own key: a routine job already queued for the tribunal does not swallow
  // the request. `since` = now: what any other run checks after this moment
  // is not queried again by this one.
  const since = new Date().toISOString();
  let queued = 0;
  for (const g of due) {
    const r = await enqueueJob({
      type: "court_sync.run",
      organizationId: ctx.organizationId,
      payload: { alias: g.alias, trigger: "manual", force: true, requestedById: ctx.userId, since },
      dedupeKey: `${courtSyncJobKey(ctx.organizationId, g.alias)}:manual`,
      maxAttempts: 2,
    });
    if (!r.deduplicated) queued++;
  }
  const processes = due.reduce((s, g) => s + g.processes, 0);
  await recordAudit(ctx, {
    action: "organization.court_sync_request",
    entityType: "organization",
    entityId: ctx.organizationId,
    summary: `Sincronização da carteira com o DataJud solicitada: ${pluralize(processes, "processo", "processos")} em ${pluralize(due.length, "tribunal", "tribunais")}.`,
    metadata: { aliases: due.map((g) => g.alias), processes, jobs: queued },
  });
  return { jobs: queued, processes };
}

// ---------------------------------------------------------------------------
// Read models (panel, lookup tool, health page)
// ---------------------------------------------------------------------------

export type ProcessCourtSyncPanel = {
  number: string;
  active: boolean;
  enabled: boolean;
  supported: boolean;
  unsupportedReason: string | null;
  aliases: string[];
  state: {
    status: CourtSyncStatus;
    lastCheckedAt: Date | null;
    lastFoundAt: Date | null;
    remoteUpdatedAt: Date | null;
    instancesFound: CourtInstanceFound[];
    lastError: string | null;
    consecutiveErrors: number;
    nextCheckAt: Date | null;
  } | null;
  importedMovements: number;
  subjects: { code: number; name: string }[];
  canRun: boolean;
};

export async function getProcessCourtSyncPanel(ctx: AuthContext, processId: string): Promise<ProcessCourtSyncPanel> {
  assertCan(ctx, "process:read");
  if (!z.guid().safeParse(processId).success) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  const db = getDb();
  const [p] = await db
    .select({ id: legalProcesses.id, number: legalProcesses.number, subjects: legalProcesses.subjects })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), processWhere(ctx)));
  if (!p) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  const [state] = await db
    .select()
    .from(courtSyncStates)
    .where(and(eq(courtSyncStates.processId, p.id), eq(courtSyncStates.organizationId, ctx.organizationId)));
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(processEvents)
    .where(
      and(
        eq(processEvents.processId, p.id),
        eq(processEvents.organizationId, ctx.organizationId),
        eq(processEvents.externalSource, DATAJUD_SOURCE_LABEL),
      ),
    );
  const org = await loadOrganization(ctx.organizationId);
  const aliases = courtAliasesForCnj(p.number);
  return {
    number: p.number,
    active: getCourtProvider() !== null,
    enabled: org.settings.integrations.datajud.enabled,
    supported: aliases.supported,
    unsupportedReason: aliases.supported ? null : UNSUPPORTED_REASON_LABELS[aliases.reason],
    aliases: aliases.supported ? [aliases.primary, ...aliases.secondary] : [],
    state: state
      ? {
          status: state.status,
          lastCheckedAt: state.lastCheckedAt,
          lastFoundAt: state.lastFoundAt,
          remoteUpdatedAt: state.remoteUpdatedAt,
          instancesFound: state.instancesFound,
          lastError: state.lastError,
          consecutiveErrors: state.consecutiveErrors,
          nextCheckAt: state.nextCheckAt,
        }
      : null,
    importedMovements: Number(n),
    subjects: p.subjects ?? [],
    canRun: can(ctx, "court_sync:run"),
  };
}

export type CourtLookupResult =
  | { status: "inactive"; message: string; number: string | null }
  | { status: "unsupported"; message: string; number: string | null }
  | { status: "invalid"; message: string; number: string | null }
  | {
      status: "found" | "not_found" | "error";
      message: string | null;
      number: string;
      aliases: string[];
      records: CourtRecord[];
      errors: { alias: string; message: string }[];
      existingProcess: { id: string; number: string; title: string } | null;
    };

/** Consulta avulsa (tool page): reads the official data WITHOUT saving anything. */
export async function lookupCourtRecord(ctx: AuthContext, rawNumber: string): Promise<CourtLookupResult> {
  assertCan(ctx, "court_sync:run");
  const number = normalizeCnj(rawNumber);
  if (!number) {
    return { status: "invalid", message: "Informe o número no padrão CNJ (20 dígitos: NNNNNNN-DD.AAAA.J.TR.OOOO).", number: null };
  }
  if (!isValidCnj(number)) return { status: "invalid", message: UNSUPPORTED_REASON_LABELS.invalid_check_digit, number };
  const fetched = await fetchCourtRecordsForCnj(number, { attempts: 1 });
  if (fetched.status === "inactive") return { status: "inactive", message: fetched.message, number };
  if (fetched.status === "unsupported") return { status: "unsupported", message: fetched.message, number };
  const [existing] = await getDb()
    .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.organizationId, ctx.organizationId), eq(legalProcesses.number, number), processWhere(ctx)))
    .limit(1);
  const records = [...fetched.records].sort((a, b) => {
    const ra = instanceForGrau(a.grau);
    const rb = instanceForGrau(b.grau);
    return (ra ? INSTANCE_RANK[ra] : 9) - (rb ? INSTANCE_RANK[rb] : 9);
  });
  logger.info("court_lookup", { userId: ctx.userId, found: records.length, errors: fetched.errors.length });
  const status = records.length > 0 ? "found" : fetched.errors.length > 0 ? "error" : "not_found";
  return {
    status,
    message:
      status === "error"
        ? `Não foi possível consultar o DataJud agora: ${fetched.errors.map((e) => `${aliasLabel(e.alias)}: ${e.message}`).join("; ")}`
        : status === "not_found"
          ? "O número não foi encontrado no DataJud (o tribunal pode ainda não ter enviado os dados ao CNJ)."
          : fetched.errors.length > 0
            ? `Consulta parcial: ${fetched.errors.map((e) => `${aliasLabel(e.alias)}: ${e.message}`).join("; ")}`
            : null,
    number,
    aliases: [fetched.primary, ...fetched.secondary],
    records,
    errors: fetched.errors,
    existingProcess: existing ?? null,
  };
}

export type CourtSyncHealth = {
  generatedAt: Date;
  runtime: ReturnType<typeof getCourtRuntimeInfo>;
  settings: OrganizationSettings["integrations"];
  totals: { activeProcesses: number; tracked: number; due: number; byStatus: Record<CourtSyncStatus, number> };
  tribunals: {
    alias: string;
    label: string;
    processes: number;
    due: number;
    lastRun: {
      status: CourtSyncRunStatus;
      trigger: CourtSyncTrigger;
      startedAt: Date;
      finishedAt: Date | null;
      checked: number;
      found: number;
      notFound: number;
      newMovements: number;
      errors: number;
      durationMs: number | null;
    } | null;
    lastSuccessAt: Date | null;
  }[];
  unsupported: number;
  recentErrors: { alias: string; label: string; at: Date; trigger: CourtSyncTrigger; message: string }[];
  processErrors: { processId: string; number: string; lastError: string | null; consecutiveErrors: number; lastCheckedAt: Date | null }[];
  /** Interval of the simulated_feed routine (null when absent or paused). */
  simulatedFeedRoutineMinutes: number | null;
  routine: {
    enabled: boolean;
    intervalMinutes: number;
    lastRunAt: Date | null;
    lastStatus: string | null;
    lastError: string | null;
    nextRunAt: Date;
  } | null;
};

/** RF-24 / TE-07: per-tribunal health of the collection. admin:organization. */
export async function getCourtSyncHealth(ctx: AuthContext): Promise<CourtSyncHealth> {
  assertCan(ctx, "admin:organization");
  const db = getDb();
  const org = await loadOrganization(ctx.organizationId);
  const settings = org.settings.integrations.datajud;
  const now = Date.now();

  const active = await db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      nextCheckAt: courtSyncStates.nextCheckAt,
      consecutiveErrors: courtSyncStates.consecutiveErrors,
      status: courtSyncStates.status,
    })
    .from(legalProcesses)
    .leftJoin(courtSyncStates, eq(courtSyncStates.processId, legalProcesses.id))
    .where(
      and(
        eq(legalProcesses.organizationId, ctx.organizationId),
        isNull(legalProcesses.deletedAt),
        inArray(legalProcesses.status, [...ACTIVE_PORTFOLIO_STATUSES]),
      ),
    );
  const byStatus = Object.fromEntries(COURT_SYNC_STATUSES.map((s) => [s, 0])) as Record<CourtSyncStatus, number>;
  const perAlias = new Map<string, { processes: number; due: number }>();
  let tracked = 0;
  let due = 0;
  let unsupported = 0;
  for (const row of active) {
    if (row.status) {
      byStatus[row.status]++;
      tracked++;
    } else byStatus.pending++;
    const a = courtAliasesForCnj(row.number);
    if (!a.supported) {
      unsupported++;
      continue;
    }
    const isDue = isDueForCheck(row, settings, now);
    if (isDue) due++;
    const g = perAlias.get(a.primary) ?? { processes: 0, due: 0 };
    g.processes++;
    if (isDue) g.due++;
    perAlias.set(a.primary, g);
  }

  const runs = await db
    .select()
    .from(courtSyncRuns)
    .where(and(eq(courtSyncRuns.organizationId, ctx.organizationId), gte(courtSyncRuns.startedAt, new Date(now - 90 * DAY_MS))))
    .orderBy(desc(courtSyncRuns.startedAt))
    .limit(2000);
  const aliases = new Set([...perAlias.keys(), ...runs.map((r) => r.tribunalAlias)]);
  const tribunals = [...aliases]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }))
    .map((alias) => {
      const last = runs.find((r) => r.tribunalAlias === alias) ?? null;
      const lastSuccess = runs.find((r) => r.tribunalAlias === alias && (r.status === "succeeded" || r.status === "partial"));
      const g = perAlias.get(alias) ?? { processes: 0, due: 0 };
      return {
        alias,
        label: aliasLabel(alias),
        processes: g.processes,
        due: g.due,
        lastRun: last
          ? {
              status: last.status,
              trigger: last.trigger,
              startedAt: last.startedAt,
              finishedAt: last.finishedAt,
              checked: last.checked,
              found: last.found,
              notFound: last.notFound,
              newMovements: last.newMovements,
              errors: last.errors,
              durationMs: last.durationMs,
            }
          : null,
        lastSuccessAt: lastSuccess ? (lastSuccess.finishedAt ?? lastSuccess.startedAt) : null,
      };
    });
  const recentErrors = runs
    .filter((r) => r.errorMessage)
    .slice(0, 10)
    .map((r) => ({ alias: r.tribunalAlias, label: aliasLabel(r.tribunalAlias), at: r.startedAt, trigger: r.trigger, message: r.errorMessage! }));
  const processErrors = await db
    .select({
      processId: courtSyncStates.processId,
      number: legalProcesses.number,
      lastError: courtSyncStates.lastError,
      consecutiveErrors: courtSyncStates.consecutiveErrors,
      lastCheckedAt: courtSyncStates.lastCheckedAt,
    })
    .from(courtSyncStates)
    .innerJoin(legalProcesses, eq(legalProcesses.id, courtSyncStates.processId))
    .where(and(eq(courtSyncStates.organizationId, ctx.organizationId), eq(courtSyncStates.status, "error"), processWhere(ctx)))
    .orderBy(desc(courtSyncStates.consecutiveErrors), desc(courtSyncStates.lastCheckedAt))
    .limit(10);
  const routines = await db
    .select()
    .from(scheduledRoutines)
    .where(and(eq(scheduledRoutines.organizationId, ctx.organizationId), inArray(scheduledRoutines.type, ["court_sync", "simulated_feed"])));
  const routine = routines.find((r) => r.type === "court_sync");
  const feedRoutine = routines.find((r) => r.type === "simulated_feed");

  return {
    generatedAt: new Date(now),
    runtime: getCourtRuntimeInfo(),
    settings: org.settings.integrations,
    totals: { activeProcesses: active.length, tracked, due, byStatus },
    tribunals,
    unsupported,
    recentErrors,
    processErrors,
    simulatedFeedRoutineMinutes: feedRoutine?.enabled ? feedRoutine.intervalMinutes : null,
    routine: routine
      ? {
          enabled: routine.enabled,
          intervalMinutes: routine.intervalMinutes,
          lastRunAt: routine.lastRunAt,
          lastStatus: routine.lastStatus,
          lastError: routine.lastError,
          nextRunAt: routine.nextRunAt,
        }
      : null,
  };
}

/** Status line of the DataJud integration for /admin/integracoes (honest, never exaggerated). */
export async function describeDataJudIntegration(ctx: AuthContext): Promise<{ statusText: string; detail: string; operational: boolean }> {
  assertCan(ctx, "admin:organization");
  const runtime = getCourtRuntimeInfo();
  if (!runtime.active) {
    return {
      statusText: "Coleta inativa",
      detail: `${COURT_COLLECTION_INACTIVE} Sem a chave pública do CNJ nada é consultado; andamentos seguem por cadastro manual e planilha.`,
      operational: false,
    };
  }
  const org = await loadOrganization(ctx.organizationId);
  const s = org.settings.integrations.datajud;
  const [last] = await getDb()
    .select({ at: courtSyncRuns.startedAt, status: courtSyncRuns.status })
    .from(courtSyncRuns)
    .where(eq(courtSyncRuns.organizationId, ctx.organizationId))
    .orderBy(desc(courtSyncRuns.startedAt))
    .limit(1);
  return {
    statusText: s.enabled ? "Operacional (API pública do CNJ)" : "Configurado, acompanhamento automático desativado",
    detail:
      "Consulta oficial e somente leitura: classe, órgão julgador, assuntos e movimentações por grau. O DataJud não informa partes, valores, " +
      "documentos nem a data das audiências. Movimentações novas entram na linha do tempo como importadas; mudanças de fase só quando inequívocas." +
      (last ? ` Última execução: ${formatDateTime(last.at)}.` : " Nenhuma execução ainda."),
    operational: s.enabled,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function updateCourtIntegrationSettings(ctx: AuthContext, input: CourtIntegrationSettingsInput): Promise<void> {
  assertCan(ctx, "admin:organization");
  const parsed = courtIntegrationSettingsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(undefined, z.flattenError(parsed.error).fieldErrors as Record<string, string[]>);
  const v = parsed.data;
  await getDb().transaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId))
      .for("update");
    if (!org) throw new NotFoundError("Organização não encontrada.");
    const current = mergeOrganizationSettings(org.settings).integrations;
    const next: OrganizationSettings["integrations"] = {
      datajud: {
        enabled: v.enabled,
        syncIntervalHours: v.syncIntervalHours,
        maxRequestsPerMinute: v.maxRequestsPerMinute,
        batchSize: v.batchSize,
        autoApplyPhase: v.autoApplyPhase,
        enrichOnIntake: v.enrichOnIntake,
      },
      simulatedFeed: { enabled: v.simulatedFeedEnabled, intervalMinutes: v.simulatedFeedIntervalMinutes },
    };
    const flat = (s: OrganizationSettings["integrations"]) => ({
      datajudEnabled: s.datajud.enabled,
      syncIntervalHours: s.datajud.syncIntervalHours,
      maxRequestsPerMinute: s.datajud.maxRequestsPerMinute,
      batchSize: s.datajud.batchSize,
      autoApplyPhase: s.datajud.autoApplyPhase,
      enrichOnIntake: s.datajud.enrichOnIntake,
      simulatedFeedEnabled: s.simulatedFeed.enabled,
      simulatedFeedIntervalMinutes: s.simulatedFeed.intervalMinutes,
    });
    const changes = diffChanges(flat(current), flat(next));
    if (!changes) return;
    // Only the `integrations` key is written: the other settings stay as stored.
    await tx
      .update(organizations)
      .set({ settings: sql`jsonb_set(coalesce(${organizations.settings}, '{}'::jsonb), '{integrations}', ${JSON.stringify(next)}::jsonb, true)` })
      .where(eq(organizations.id, ctx.organizationId));
    await recordAudit(
      ctx,
      {
        action: "organization.integration_settings_update",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: "Parâmetros da coleta no DataJud e da chegada simulada alterados.",
        changes,
      },
      tx,
    );
  });
}
