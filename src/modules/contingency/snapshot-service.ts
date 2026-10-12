/**
 * Fechamento mensal (RN-05, RN-10, RF-16, TE-06).
 *
 * - `generateSnapshot` creates or refreshes the PREVIEW of a competência: one
 *   item per process active on the reference date (last day of the month),
 *   with the official values whose base date is on/before it, the risk
 *   classification in force on it and the guarantees linked on it. Metrics are
 *   aggregated with `addToBucket`; params record the risk percentages and the
 *   rules version used (RNF-14).
 * - `closeSnapshot` makes the competência IMMUTABLE: it can no longer be
 *   regenerated or closed again, and reports read it from the stored items.
 * - Close gate (P1.9, ./close-gate.ts): evaluated on the STORED items of the
 *   preview (the population the close freezes). The close is refused while an
 *   item has no OFFICIAL risk classification in force on the reference date
 *   (`process_risk_assessments`; claims-derived classifications are recorded
 *   there too, with `effective_from` = the day they are derived), unless a
 *   justification is given; then the override (who, when, why, which
 *   processes, always a subset of the closed items) is stored in
 *   `snapshot_close_overrides` in the same transaction. A STALE preview
 *   (classifications recorded/reviewed after it, or the live population of
 *   the reference date no longer matching its items) must be recalculated
 *   first, even with a justification. The routine never closes:
 *   `refreshCloseGateAlerts` only raises one alert per unclassified (live)
 *   process while a competência whose reference date passed is still open.
 * - Snapshots are organization-level artifacts: they are computed over every
 *   process of the organization. When READ, items are filtered by row
 *   visibility of the process WITHOUT the soft-delete condition: a process
 *   deleted (or rolled back) after the calculation keeps its row, flagged
 *   `processDeleted` — the competência never changes (RN-10).
 * - Org-wide totals that include confidential processes (with the count of
 *   those not listed) are shown only to who sees everything or books the
 *   provision (`snapshot:close`, e.g. accountant). Other org-wide roles
 *   (executive, auditor) get totals of the listed items, like the reports
 *   ("exceto sigilosos") — docs/SECURITY.md.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  addToBucket,
  emptyBucket,
  periodReferenceDate,
  previousPeriod,
  provisionFor,
  type MoneyBucket,
  type ProvisionResult,
  type SnapshotMetrics,
  type SnapshotParams,
} from "@/domain/contingency";
import {
  isProcessPhase,
  type LossProbability,
  type ProcessInstance,
  type SnapshotStatus,
  type StoredProcessPhase,
} from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, todayISO } from "@/lib/format";
import { resolveStaleAlerts, upsertAlert } from "@/modules/alerts/service";
import type { AuthContext } from "@/server/auth/context";
import { canViewScopedRecord, hasOrganizationWideScope, seesConfidential } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  companies,
  legalProcesses,
  organizations,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processGuarantees,
  processRiskAssessments,
  processValuations,
  snapshotCloseOverrides,
  units,
  users,
  type OrganizationSettings,
} from "@/server/db/schema";
import type { RoutineContext } from "@/server/jobs/routines";
import { recordAudit } from "@/server/services/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import {
  CLOSE_BLOCKED_ALERT_TYPE,
  closeBlockedAlertKey,
  closeBlockedMessage,
  closeJustificationSchema,
  isPreviewStale,
  stalePreviewMessage,
  type PreviewStaleness,
} from "./close-gate";
import { buildSnapshotCsv, type CsvSnapshotRow } from "./csv";
import { isUniqueViolation, loadSettings, parseOrThrow, requireHuman } from "./internal";
import { NONE_KEY } from "./labels";
import {
  positionAt,
  riskAt,
  type PositionGuarantee,
  type PositionHistory,
  type PositionRisk,
  type PositionValuation,
} from "./position";
import { formatPeriod, periodOf } from "./rules";
import { periodSchema } from "./schemas";

export type SnapshotScope = "all" | "org_wide" | "visible";

export type SnapshotListItem = {
  id: string;
  period: string;
  referenceDate: string;
  status: SnapshotStatus;
  generatedAt: Date;
  generatedByName: string | null;
  closedAt: Date | null;
  closedByName: string | null;
  /** Org-wide totals — only for roles with organization-wide scope (null otherwise). */
  totals: (MoneyBucket & { confidentialCount: number }) | null;
};

export type SnapshotItemView = CsvSnapshotRow & {
  processId: string;
  isConfidential: boolean;
  provision: ProvisionResult;
  /** The process was deleted after the calculation: listed (RN-10) but without a link to its page. */
  processDeleted: boolean;
};

type MovementEntry = {
  processId: string;
  number: string;
  provisionCents: number | null;
  provisionIsEstimate: boolean;
  processDeleted: boolean;
};

/**
 * Provision of a process that changed between two competências. The difference exists only
 * when both sides have a provision on the SAME basis (RN-03/RN-07): a provision that appeared
 * or disappeared, or moved between the estimate (valor da causa) and the valor apurado, has
 * `deltaCents: null` and is read as a change of basis, never as a plain difference.
 */
export type ProvisionChange = {
  processId: string;
  number: string;
  fromCents: number | null;
  toCents: number | null;
  /** The previous provision was an estimate on the valor da causa (false when there was none). */
  fromIsEstimate: boolean;
  /** The current provision is an estimate on the valor da causa (false when there is none). */
  toIsEstimate: boolean;
  /** `toCents − fromCents` when both exist on the same basis; null otherwise. */
  deltaCents: number | null;
  processDeleted: boolean;
};

export type SnapshotMovement = {
  added: MovementEntry[];
  removed: MovementEntry[];
  /**
   * Largest changes first: by the difference when there is one, else by the larger of the two
   * amounts (a change of basis or a provision that appeared or disappeared).
   */
  provisionChanges: ProvisionChange[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
};

export type SnapshotVariation = {
  count: number;
  claimCents: number;
  liquidatedCents: number;
  guaranteesCents: number;
  exposureCents: number;
  exposureEstimateCents: number;
  provisionCents: number;
  provisionEstimateCents: number;
};

export type SnapshotView = {
  id: string;
  period: string;
  referenceDate: string;
  status: SnapshotStatus;
  generatedAt: Date;
  generatedByName: string | null;
  closedAt: Date | null;
  closedByName: string | null;
  params: SnapshotParams;
  scope: SnapshotScope;
  /** pt-BR note on what the totals cover when scope is "visible" (null otherwise). */
  scopeNote: string | null;
  /** Totals for the viewer: org-wide (scope all/org_wide) or visible items only. */
  totals: MoneyBucket;
  /** Processes included in org-wide totals but not listed for the viewer. */
  hiddenCount: number;
  byClassification: { key: LossProbability | "unclassified"; bucket: MoneyBucket }[];
  /** Visible items with an estimated exposure or provision (RN-07). */
  estimateCount: number;
  /** Listed items whose process was deleted after the calculation (kept, RN-10). */
  deletedCount: number;
  items: SnapshotItemView[];
  itemsTotal: number;
  page: number;
  pageSize: number;
  /**
   * Previous competência with the same scope as `totals`. `byClassification` gives its provision
   * basis, so a variation is shown only when both sides were calculated (RN-03).
   */
  previous: {
    period: string;
    status: SnapshotStatus;
    totals: MoneyBucket;
    byClassification: { key: LossProbability | "unclassified"; bucket: MoneyBucket }[];
  } | null;
  variation: SnapshotVariation | null;
  movement: SnapshotMovement | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePeriod(period: string): string {
  return parseOrThrow(periodSchema, period);
}

function currentPeriod(): string {
  return periodOf(todayISO());
}

function assertNotFuturePeriod(period: string) {
  if (period > currentPeriod()) {
    throw new ValidationError("Competência futura: só é possível gerar ou fechar competências até o mês atual.", {
      period: ["Escolha o mês atual ou um mês anterior."],
    });
  }
}

/**
 * Who gets which totals (docs/SECURITY.md, "Fechamento mensal"):
 *   all      → admin / legal manager: every item, stored org-wide totals;
 *   org_wide → org-wide roles that book the provision (`snapshot:close`, e.g.
 *              accountant): stored org-wide totals (confidential included) +
 *              the count of processes not listed;
 *   visible  → everyone else (executive, auditor, unit-scoped roles, external
 *              counsel): totals, classification and comparison computed from
 *              the listed items only — nothing about confidential processes.
 */
export function snapshotScope(ctx: AuthContext): SnapshotScope {
  if (seesConfidential(ctx)) return "all";
  if (hasOrganizationWideScope(ctx) && can(ctx, "snapshot:close")) return "org_wide";
  return "visible";
}

function visibleScopeNote(ctx: AuthContext): string {
  return hasOrganizationWideScope(ctx)
    ? "Totais da organização, exceto processos sigilosos (não visíveis para o seu perfil)."
    : "Totais calculados somente sobre os processos que você pode ver.";
}

/** Message of a concurrent first generation of the same competência. */
export const SNAPSHOT_IN_PROGRESS_MESSAGE = "A prévia desta competência está sendo gerada agora. Tente novamente em instantes.";

/** Maps a unique violation of a snapshot write (concurrent generation) to a pt-BR ConflictError; other errors pass through. */
export function snapshotWriteError(err: unknown): unknown {
  return isUniqueViolation(err) ? new ConflictError(SNAPSHOT_IN_PROGRESS_MESSAGE) : err;
}

/** Processes active on the reference date (status/closure aware; `filedAt` null = unknown, included). */
function activeAtCondition(organizationId: string, ref: string): SQL {
  return and(
    eq(legalProcesses.organizationId, organizationId),
    isNull(legalProcesses.deletedAt),
    or(isNull(legalProcesses.filedAt), lte(legalProcesses.filedAt, ref)),
    or(
      and(
        inArray(legalProcesses.status, ["active", "suspended"]),
        or(isNull(legalProcesses.closedAt), gt(legalProcesses.closedAt, ref)),
      ),
      and(
        inArray(legalProcesses.status, ["archived", "closed"]),
        isNotNull(legalProcesses.closedAt),
        gt(legalProcesses.closedAt, ref),
      ),
    ),
  ) as SQL;
}

function bucketInput(i: {
  liquidatedAmountCents: number | null;
  guaranteesCents: number;
  claimAmountCents: number | null;
  percentageBp: number | null;
}) {
  return {
    liquidatedCents: i.liquidatedAmountCents,
    linkedGuaranteesCents: i.guaranteesCents,
    claimCents: i.claimAmountCents,
    riskPercentageBp: i.percentageBp,
  };
}

type ComputedItem = Omit<typeof portfolioSnapshotItems.$inferInsert, "snapshotId">;

async function computeItems(
  organizationId: string,
  referenceDate: string,
  settings: OrganizationSettings,
  tx: DbOrTx,
): Promise<ComputedItem[]> {
  const procs = await tx
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      companyId: legalProcesses.companyId,
      unitId: legalProcesses.unitId,
      court: legalProcesses.court,
      instance: legalProcesses.instance,
      phase: legalProcesses.phase,
      city: legalProcesses.city,
      isConfidential: legalProcesses.isConfidential,
      claimAmountCents: legalProcesses.claimAmountCents,
      liquidatedAmountCents: legalProcesses.liquidatedAmountCents,
      riskPercentageBp: legalProcesses.riskPercentageBp,
      lossProbability: legalProcesses.lossProbability,
    })
    .from(legalProcesses)
    .where(activeAtCondition(organizationId, referenceDate))
    .orderBy(asc(legalProcesses.number));
  if (procs.length === 0) return [];

  // Only processes of the competência, and only rows dated on/before the reference date: the
  // history flags below are computed over the whole history (cheap aggregates), so a process
  // whose values all start after the reference date does not fall back to today's record values.
  const inScope = (col: typeof processValuations.processId | typeof processRiskAssessments.processId) =>
    inArray(col, tx.select({ id: legalProcesses.id }).from(legalProcesses).where(activeAtCondition(organizationId, referenceDate)));
  const valuationBase = and(
    eq(processValuations.organizationId, organizationId),
    inArray(processValuations.kind, ["claim", "liquidated"]),
    inArray(processValuations.status, ["official", "superseded"]),
    inScope(processValuations.processId),
  );
  const riskBase = and(
    eq(processRiskAssessments.organizationId, organizationId),
    eq(processRiskAssessments.status, "official"),
    inScope(processRiskAssessments.processId),
  );
  const [vals, valuationHistory, risks, riskHistory, guarantees] = await Promise.all([
    tx
      .select({
        id: processValuations.id,
        processId: processValuations.processId,
        kind: processValuations.kind,
        amountCents: processValuations.amountCents,
        baseDate: processValuations.baseDate,
        status: processValuations.status,
        createdAt: processValuations.createdAt,
        reviewedAt: processValuations.reviewedAt,
      })
      .from(processValuations)
      .where(and(valuationBase, lte(processValuations.baseDate, referenceDate))),
    tx
      .select({
        processId: processValuations.processId,
        kind: processValuations.kind,
        hasOfficial: sql<boolean>`bool_or(${processValuations.status} = 'official')`.mapWith(
          (v: unknown) => v === true || v === "t" || v === "true",
        ),
      })
      .from(processValuations)
      .where(valuationBase)
      .groupBy(processValuations.processId, processValuations.kind),
    tx
      .select({
        id: processRiskAssessments.id,
        processId: processRiskAssessments.processId,
        classification: processRiskAssessments.classification,
        percentageBp: processRiskAssessments.percentageBp,
        effectiveFrom: processRiskAssessments.effectiveFrom,
        status: processRiskAssessments.status,
        createdAt: processRiskAssessments.createdAt,
        reviewedAt: processRiskAssessments.reviewedAt,
      })
      .from(processRiskAssessments)
      .where(and(riskBase, lte(processRiskAssessments.effectiveFrom, referenceDate))),
    tx.selectDistinct({ processId: processRiskAssessments.processId }).from(processRiskAssessments).where(riskBase),
    tx
      .select({
        processId: processGuarantees.processId,
        amountCents: processGuarantees.amountCents,
        status: processGuarantees.status,
        depositedAt: processGuarantees.depositedAt,
        statusChangedAt: processGuarantees.statusChangedAt,
        createdAt: processGuarantees.createdAt,
        deletedAt: processGuarantees.deletedAt,
      })
      .from(processGuarantees)
      .where(and(eq(processGuarantees.organizationId, organizationId), isNull(processGuarantees.deletedAt))),
  ]);

  const byProcess = <T extends { processId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.processId) ?? [];
      list.push(r);
      m.set(r.processId, list);
    }
    return m;
  };
  const valsBy = byProcess(vals);
  const risksBy = byProcess(risks);
  const guaranteesBy = byProcess(guarantees);
  const historyBy = new Map<string, PositionHistory>();
  const historyOfProcess = (id: string): PositionHistory => {
    let h = historyBy.get(id);
    if (!h) {
      h = { claim: false, claimOfficial: false, liquidated: false, risk: false };
      historyBy.set(id, h);
    }
    return h;
  };
  for (const r of valuationHistory) {
    const h = historyOfProcess(r.processId);
    if (r.kind === "claim") {
      h.claim = true;
      h.claimOfficial = r.hasOfficial;
    } else {
      h.liquidated = true;
    }
  }
  for (const r of riskHistory) historyOfProcess(r.processId).risk = true;

  return procs.map((p) => {
    const pos = positionAt({
      date: referenceDate,
      process: p,
      valuations: (valsBy.get(p.id) ?? []) as PositionValuation[],
      risks: (risksBy.get(p.id) ?? []) as PositionRisk[],
      guarantees: (guaranteesBy.get(p.id) ?? []) as PositionGuarantee[],
      params: settings.contingency.riskPercentages,
      history: historyOfProcess(p.id),
    });
    return {
      organizationId,
      processId: p.id,
      number: p.number,
      companyId: p.companyId,
      unitId: p.unitId,
      court: p.court,
      instance: p.instance,
      phase: p.phase,
      city: p.city,
      isConfidential: p.isConfidential,
      classification: pos.classification,
      percentageBp: pos.percentageBp,
      claimAmountCents: pos.claimCents,
      liquidatedAmountCents: pos.liquidatedCents,
      guaranteesCents: pos.linkedGuaranteesCents,
      exposureCents: pos.exposure.exposureCents,
      exposureIsEstimate: pos.exposure.isEstimate,
      provisionCents: pos.provision.provisionCents,
      provisionIsEstimate: pos.provision.isEstimate,
    };
  });
}

function emptyMetrics(): SnapshotMetrics {
  return {
    totals: { ...emptyBucket(), confidentialCount: 0 },
    byCourt: {},
    byInstance: {},
    byPhase: {},
    byCity: {},
    byClassification: {},
    byCompany: {},
    byUnit: {},
  };
}

function addTo(map: Record<string, MoneyBucket>, key: string | null | undefined, input: ReturnType<typeof bucketInput>) {
  const k = key && key.trim() ? key : NONE_KEY;
  map[k] = addToBucket(map[k] ?? emptyBucket(), input);
}

export function buildMetrics(items: ComputedItem[]): SnapshotMetrics {
  const m = emptyMetrics();
  for (const it of items) {
    const input = bucketInput({
      liquidatedAmountCents: it.liquidatedAmountCents ?? null,
      guaranteesCents: it.guaranteesCents ?? 0,
      claimAmountCents: it.claimAmountCents ?? null,
      percentageBp: it.percentageBp ?? null,
    });
    addToBucket(m.totals, input);
    if (it.isConfidential) m.totals.confidentialCount += 1;
    addTo(m.byCourt, it.court, input);
    addTo(m.byInstance, it.instance, input);
    addTo(m.byPhase, it.phase, input);
    addTo(m.byCity, it.city, input);
    addTo(m.byClassification, it.classification ?? "unclassified", input);
    addTo(m.byCompany, it.companyId, input);
    addTo(m.byUnit, it.unitId, input);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Creates or refreshes the PREVIEW of a competência (RN-05). Refused for a
 * closed competência (RN-10) and for future months. Requires
 * `contingency:approve` (accounting/management); the routine uses the system context.
 */
export async function generateSnapshot(
  ctx: AuthContext,
  period: string,
): Promise<{ id: string; status: "preview"; itemCount: number; metrics: SnapshotMetrics }> {
  assertCan(ctx, "contingency:approve");
  const p = parsePeriod(period);
  assertNotFuturePeriod(p);
  const referenceDate = periodReferenceDate(p);
  const closedMessage = `A competência ${formatPeriod(p)} está fechada e é imutável.`;

  try {
    return await getDb().transaction(async (tx) => {
      const lockRow = async () =>
        (
          await tx
            .select({ id: portfolioSnapshots.id, status: portfolioSnapshots.status })
            .from(portfolioSnapshots)
            .where(and(eq(portfolioSnapshots.organizationId, ctx.organizationId), eq(portfolioSnapshots.period, p)))
            .for("update")
        )[0];
      let existing = await lockRow();
      if (existing?.status === "closed") throw new ConflictError(closedMessage);
      const settings = await loadSettings(ctx.organizationId, tx);
      const items = await computeItems(ctx.organizationId, referenceDate, settings, tx);
      const metrics = buildMetrics(items);
      const params: SnapshotParams = {
        riskPercentages: { ...settings.contingency.riskPercentages },
        rulesVersion: settings.contingency.rulesVersion,
        confidenceThreshold: settings.contingency.confidenceThreshold,
      };
      const now = new Date();
      let id: string | null = null;
      if (!existing) {
        // First generation. `select … for update` locks nothing when the row does not exist, so a
        // concurrent first generation (user + daily routine) may insert first: then this insert does
        // nothing, waits for the other transaction and the committed row is refreshed below.
        const [created] = await tx
          .insert(portfolioSnapshots)
          .values({
            organizationId: ctx.organizationId,
            period: p,
            referenceDate,
            status: "preview",
            metrics,
            params,
            generatedAt: now,
            generatedById: ctx.userId,
          })
          .onConflictDoNothing({ target: [portfolioSnapshots.organizationId, portfolioSnapshots.period] })
          .returning({ id: portfolioSnapshots.id });
        if (created) {
          id = created.id;
        } else {
          existing = await lockRow();
          if (!existing) throw new ConflictError(SNAPSHOT_IN_PROGRESS_MESSAGE);
          if (existing.status === "closed") throw new ConflictError(closedMessage);
        }
      }
      if (existing) {
        id = existing.id;
        const updated = await tx
          .update(portfolioSnapshots)
          .set({ metrics, params, referenceDate, generatedAt: now, generatedById: ctx.userId, updatedAt: now })
          .where(and(eq(portfolioSnapshots.id, id), eq(portfolioSnapshots.status, "preview")))
          .returning({ id: portfolioSnapshots.id });
        // Never touch the items of a competência closed in the meantime (RN-10).
        if (updated.length === 0) throw new ConflictError(closedMessage);
        await tx.delete(portfolioSnapshotItems).where(eq(portfolioSnapshotItems.snapshotId, id));
      }
      if (!id) throw new ConflictError(SNAPSHOT_IN_PROGRESS_MESSAGE);
      const snapshotId = id;
      for (let i = 0; i < items.length; i += 500) {
        await tx.insert(portfolioSnapshotItems).values(items.slice(i, i + 500).map((it) => ({ ...it, snapshotId })));
      }
      await recordAudit(
        ctx,
        {
          action: "snapshot.generate",
          entityType: "snapshot",
          entityId: snapshotId,
          summary:
            `Prévia da competência ${formatPeriod(p)} ${existing ? "recalculada" : "gerada"}: ${items.length} processo(s), ` +
            `provisão ${formatMoneyCents(metrics.totals.provisionCents)} + estimativa ${formatMoneyCents(metrics.totals.provisionEstimateCents)}.`,
          metadata: { period: p, referenceDate, itemCount: items.length, rulesVersion: params.rulesVersion },
        },
        tx,
      );
      return { id: snapshotId, status: "preview" as const, itemCount: items.length, metrics };
    });
  } catch (err) {
    // Safety net: a unique violation here means another generation of the same competência won the race.
    throw snapshotWriteError(err);
  }
}

// ---------------------------------------------------------------------------
// Close gate (P1.9): processes without an official risk classification
// ---------------------------------------------------------------------------

type UnclassifiedRow = {
  id: string;
  number: string;
  title: string;
  organizationId: string;
  unitId: string | null;
  responsibleId: string | null;
  createdById: string | null;
  isConfidential: boolean;
  lawFirmId: string | null;
  lossProbability: LossProbability | null;
  responsibleName: string | null;
};

/**
 * LIVE processes active on the reference date (same rule as the preview)
 * WITHOUT an official risk assessment in force on it: no row with status
 * `official` and `effective_from <= reference date`. Proposals (rule
 * suggestions) and the classification typed on the process record do not
 * count: an official classification needs an opinion and an identified person.
 * Organization-wide; callers filter by visibility before naming them.
 *
 * Used only by the routine alerts (what still needs a classification, as the
 * next recalculation will see it). The close and the provision page evaluate
 * the gate on the stored items (`evaluatePreviewGate`).
 */
async function loadUnclassifiedLive(organizationId: string, referenceDate: string, db: DbOrTx): Promise<UnclassifiedRow[]> {
  const officialInForce = db
    .select({ one: sql`1` })
    .from(processRiskAssessments)
    .where(
      and(
        eq(processRiskAssessments.organizationId, organizationId),
        eq(processRiskAssessments.processId, legalProcesses.id),
        eq(processRiskAssessments.status, "official"),
        lte(processRiskAssessments.effectiveFrom, referenceDate),
      ),
    );
  return db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      title: legalProcesses.title,
      organizationId: legalProcesses.organizationId,
      unitId: legalProcesses.unitId,
      responsibleId: legalProcesses.responsibleId,
      createdById: legalProcesses.createdById,
      isConfidential: legalProcesses.isConfidential,
      lawFirmId: legalProcesses.lawFirmId,
      lossProbability: legalProcesses.lossProbability,
      responsibleName: users.name,
    })
    .from(legalProcesses)
    .leftJoin(users, and(eq(users.id, legalProcesses.responsibleId), eq(users.organizationId, organizationId)))
    .where(and(activeAtCondition(organizationId, referenceDate), notExists(officialInForce)))
    .orderBy(asc(legalProcesses.number), asc(legalProcesses.id));
}

function canSeeProcess(ctx: AuthContext, r: UnclassifiedRow): boolean {
  return canViewScopedRecord(ctx, { ...r, deletedAt: null });
}

const toBool = (v: unknown) => v === true || v === "t" || v === "true";

type PreviewGate = {
  /**
   * Items of the preview, still active on the reference date, WITHOUT an
   * official classification in force on it (org-wide, in item order). When the
   * preview is not stale this is exactly what the close freezes unclassified.
   */
  unclassified: UnclassifiedRow[];
  staleness: PreviewStaleness;
};

/**
 * Close gate evaluated on the STORED items of a preview (the population the
 * close freezes), with the official assessments in force on the reference date:
 *
 * - an item without any official assessment with `effective_from <= data-base`
 *   is unclassified (the record classification or a proposal does not count);
 * - the preview is STALE when, for any item, such an assessment was recorded
 *   or reviewed after `generatedAt`, or the one in force differs from the
 *   stored classification/percentage (covers a concurrent recording during the
 *   calculation); or when the live population of the reference date differs
 *   from the items (processes added, deleted, closed before it or filed after it);
 *   or when an item's phase/instance differs from the process record, or is a
 *   phase of the model before P0.5 (preview calculated before the migration).
 *
 * The close is refused while the preview is stale, so the override list is
 * always a subset of the closed items.
 */
async function evaluatePreviewGate(
  organizationId: string,
  s: { id: string; referenceDate: string; generatedAt: Date },
  db: DbOrTx,
): Promise<PreviewGate> {
  const ref = s.referenceDate;
  const itemsOfSnapshot = and(eq(portfolioSnapshotItems.snapshotId, s.id), eq(portfolioSnapshotItems.organizationId, organizationId));
  const [items, risks, [addedRow]] = await Promise.all([
    db
      .select({
        processId: portfolioSnapshotItems.processId,
        number: portfolioSnapshotItems.number,
        classification: portfolioSnapshotItems.classification,
        percentageBp: portfolioSnapshotItems.percentageBp,
        itemPhase: portfolioSnapshotItems.phase,
        itemInstance: portfolioSnapshotItems.instance,
        processPhase: legalProcesses.phase,
        processInstance: legalProcesses.instance,
        title: legalProcesses.title,
        organizationId: legalProcesses.organizationId,
        unitId: legalProcesses.unitId,
        responsibleId: legalProcesses.responsibleId,
        createdById: legalProcesses.createdById,
        isConfidential: legalProcesses.isConfidential,
        lawFirmId: legalProcesses.lawFirmId,
        lossProbability: legalProcesses.lossProbability,
        responsibleName: users.name,
        stillActive: sql<boolean>`coalesce((${activeAtCondition(organizationId, ref)}), false)`.mapWith(toBool),
      })
      .from(portfolioSnapshotItems)
      .leftJoin(
        legalProcesses,
        and(eq(legalProcesses.id, portfolioSnapshotItems.processId), eq(legalProcesses.organizationId, organizationId)),
      )
      .leftJoin(users, and(eq(users.id, legalProcesses.responsibleId), eq(users.organizationId, organizationId)))
      .where(itemsOfSnapshot)
      .orderBy(asc(portfolioSnapshotItems.number), asc(portfolioSnapshotItems.processId)),
    db
      .select({
        id: processRiskAssessments.id,
        processId: processRiskAssessments.processId,
        classification: processRiskAssessments.classification,
        percentageBp: processRiskAssessments.percentageBp,
        effectiveFrom: processRiskAssessments.effectiveFrom,
        status: processRiskAssessments.status,
        createdAt: processRiskAssessments.createdAt,
        reviewedAt: processRiskAssessments.reviewedAt,
      })
      .from(processRiskAssessments)
      .where(
        and(
          eq(processRiskAssessments.organizationId, organizationId),
          eq(processRiskAssessments.status, "official"),
          lte(processRiskAssessments.effectiveFrom, ref),
          inArray(
            processRiskAssessments.processId,
            db.select({ id: portfolioSnapshotItems.processId }).from(portfolioSnapshotItems).where(itemsOfSnapshot),
          ),
        ),
      ),
    // Live processes of the reference date missing from the preview.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(legalProcesses)
      .where(
        and(
          activeAtCondition(organizationId, ref),
          notExists(
            db
              .select({ one: sql`1` })
              .from(portfolioSnapshotItems)
              .where(and(eq(portfolioSnapshotItems.snapshotId, s.id), eq(portfolioSnapshotItems.processId, legalProcesses.id))),
          ),
        ),
      ),
  ]);

  const risksBy = new Map<string, PositionRisk[]>();
  for (const r of risks) {
    const list = risksBy.get(r.processId) ?? [];
    list.push(r);
    risksBy.set(r.processId, list);
  }
  const generatedAt = s.generatedAt.getTime();
  const unclassified: UnclassifiedRow[] = [];
  let classified = 0;
  let removed = 0;
  let changed = 0;
  for (const it of items) {
    if (!it.stillActive || it.organizationId === null) {
      removed += 1;
      continue;
    }
    // The close freezes the stored phase/instance: they must be the record's current ones (P0.5).
    if (!isProcessPhase(it.itemPhase) || it.itemPhase !== it.processPhase || (it.itemInstance ?? null) !== (it.processInstance ?? null)) {
      changed += 1;
    }
    const rows = risksBy.get(it.processId) ?? [];
    const inForce = riskAt(rows, ref);
    if (!inForce) {
      unclassified.push({
        id: it.processId,
        number: it.number,
        title: it.title ?? "",
        organizationId: it.organizationId,
        unitId: it.unitId,
        responsibleId: it.responsibleId,
        createdById: it.createdById,
        isConfidential: it.isConfidential ?? true,
        lawFirmId: it.lawFirmId,
        lossProbability: it.lossProbability,
        responsibleName: it.responsibleName,
      });
      continue;
    }
    const recordedAfter = rows.some((r) => Math.max(r.createdAt.getTime(), r.reviewedAt?.getTime() ?? 0) > generatedAt);
    if (recordedAfter || inForce.classification !== it.classification || inForce.percentageBp !== it.percentageBp) classified += 1;
  }
  return { unclassified, staleness: { classified, added: Number(addedRow?.n ?? 0), removed, changed } };
}

/** Close refused because of unclassified processes. Lists only what the person may see. */
export class CloseBlockedError extends ValidationError {
  constructor(
    message: string,
    /** Organization-wide count of unclassified processes. */
    readonly unclassifiedCount: number,
    /** The unclassified processes the person may see. */
    readonly unclassified: { processId: string; number: string }[],
    /** Counted but not listed (confidential for this person). */
    readonly hiddenCount: number,
  ) {
    super(message);
  }
}

export type CloseSnapshotOptions = {
  /** Required to close while processes are unclassified (min. 20 characters). Ignored when nothing is pending. */
  justification?: string | null;
};

export type CloseSnapshotResult = {
  id: string;
  /** Present when the competência was closed with a justification. */
  override: { id: string; unclassifiedCount: number } | null;
};

/**
 * Closes a competência (RN-10): from now on it is immutable. Requires
 * `snapshot:close` and an identified person. Refused (ConflictError) while the
 * preview is stale (see `evaluatePreviewGate`), and (CloseBlockedError) while
 * items of the preview have no official risk classification in force on the
 * reference date, unless `justification` is given: then the override row
 * (ids = those items, a subset of the closed items) and the audit entry are
 * written in the same transaction.
 */
export async function closeSnapshot(ctx: AuthContext, period: string, opts: CloseSnapshotOptions = {}): Promise<CloseSnapshotResult> {
  assertCan(ctx, "snapshot:close");
  const userId = requireHuman(ctx);
  const p = parsePeriod(period);
  assertNotFuturePeriod(p);
  const justification =
    opts.justification === undefined || opts.justification === null
      ? null
      : parseOrThrow(closeJustificationSchema, { justification: opts.justification }).justification;
  const result = await getDb().transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.organizationId, ctx.organizationId), eq(portfolioSnapshots.period, p)))
      .for("update");
    if (!s) throw new ConflictError(`Gere a prévia da competência ${formatPeriod(p)} antes de fechá-la.`);
    if (s.status === "closed") throw new ConflictError(`A competência ${formatPeriod(p)} já está fechada.`);

    // Evaluated on the stored items (what is frozen below). A stale preview is refused even with a
    // justification: the override must list exactly the unclassified items of the closed competência.
    const gate = await evaluatePreviewGate(ctx.organizationId, s, tx);
    if (isPreviewStale(gate.staleness)) throw new ConflictError(stalePreviewMessage(formatPeriod(p), gate.staleness));
    const unclassified = gate.unclassified;
    if (unclassified.length > 0 && justification === null) {
      const visible = unclassified.filter((u) => canSeeProcess(ctx, u));
      const hiddenCount = unclassified.length - visible.length;
      throw new CloseBlockedError(
        closeBlockedMessage({
          periodLabel: formatPeriod(p),
          referenceDateLabel: formatDate(s.referenceDate),
          total: unclassified.length,
          numbers: visible.map((u) => u.number),
          hiddenCount,
        }),
        unclassified.length,
        visible.map((u) => ({ processId: u.id, number: u.number })),
        hiddenCount,
      );
    }

    const now = new Date();
    const updated = await tx
      .update(portfolioSnapshots)
      .set({ status: "closed", closedAt: now, closedById: userId, updatedAt: now })
      .where(and(eq(portfolioSnapshots.id, s.id), eq(portfolioSnapshots.status, "preview")))
      .returning({ id: portfolioSnapshots.id });
    if (updated.length === 0) throw new ConflictError(`A competência ${formatPeriod(p)} já está fechada.`);

    let override: CloseSnapshotResult["override"] = null;
    if (unclassified.length > 0 && justification !== null) {
      const [o] = await tx
        .insert(snapshotCloseOverrides)
        .values({
          organizationId: ctx.organizationId,
          snapshotId: s.id,
          reason: justification,
          unclassifiedProcessIds: unclassified.map((u) => u.id),
          unclassifiedCount: unclassified.length,
          closedById: userId,
          createdAt: now,
        })
        .returning({ id: snapshotCloseOverrides.id });
      override = { id: o.id, unclassifiedCount: unclassified.length };
    }
    await recordAudit(
      ctx,
      {
        action: "snapshot.close",
        entityType: "snapshot",
        entityId: s.id,
        summary:
          `Competência ${formatPeriod(p)} fechada (imutável): provisão ${formatMoneyCents(s.metrics.totals.provisionCents)} + ` +
          `estimativa ${formatMoneyCents(s.metrics.totals.provisionEstimateCents)}, prévia calculada em ${formatDateTime(s.generatedAt)}.` +
          (override
            ? ` Fechada com justificativa: ${override.unclassifiedCount} processo(s) sem classificação de risco oficial em vigor em ${formatDate(s.referenceDate)}.`
            : ""),
        metadata: {
          period: p,
          itemCount: s.metrics.totals.count,
          rulesVersion: s.params.rulesVersion,
          ...(override
            ? { closeOverrideId: override.id, unclassifiedCount: override.unclassifiedCount, justification }
            : {}),
        },
      },
      tx,
    );
    return { id: s.id, override };
  });
  // Best effort, after the commit: the alerts of the processes of this competência are resolved now
  // instead of on the next daily run. A failure here never undoes the close.
  try {
    await refreshCloseGateAlerts(ctx.organizationId);
  } catch (err) {
    logger.warn("close_gate_alerts_refresh_failed", { organizationId: ctx.organizationId, ...errorSummary(err) });
  }
  return result;
}

function errorSummary(err: unknown): { errorName: string; errorCode: string | null } {
  if (!(err instanceof Error)) return { errorName: "unknown", errorCode: null };
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  return { errorName: err.name, errorCode: typeof code === "string" ? code : null };
}

/**
 * System: one open `snapshot_close_blocked` alert per process without an
 * official classification in force on the reference date of a competência
 * whose reference date already passed and that is still OPEN (preview). Never
 * closes anything. Alerts of processes no longer blocking are resolved.
 */
export async function refreshCloseGateAlerts(
  organizationId: string,
  today: string = todayISO(),
  db: DbOrTx = getDb(),
): Promise<{ periods: string[]; processCount: number; resolved: number }> {
  const open = await db
    .select({ period: portfolioSnapshots.period, referenceDate: portfolioSnapshots.referenceDate })
    .from(portfolioSnapshots)
    .where(
      and(
        eq(portfolioSnapshots.organizationId, organizationId),
        eq(portfolioSnapshots.status, "preview"),
        lt(portfolioSnapshots.referenceDate, today),
      ),
    )
    .orderBy(asc(portfolioSnapshots.period));
  const byProcess = new Map<string, { number: string; periods: string[] }>();
  const periods: string[] = [];
  for (const s of open) {
    const rows = await loadUnclassifiedLive(organizationId, s.referenceDate, db);
    if (rows.length > 0) periods.push(s.period);
    for (const r of rows) {
      const entry = byProcess.get(r.id) ?? { number: r.number, periods: [] };
      entry.periods.push(s.period);
      byProcess.set(r.id, entry);
    }
  }
  const keep: string[] = [];
  for (const [processId, e] of byProcess) {
    const key = closeBlockedAlertKey(processId);
    keep.push(key);
    const labels = e.periods.map(formatPeriod).join(", ");
    const many = e.periods.length > 1;
    const title = `Sem classificação de risco para o fechamento: ${e.number}`;
    await upsertAlert(
      {
        organizationId,
        type: CLOSE_BLOCKED_ALERT_TYPE,
        severity: "warning",
        title: title.length > 140 ? `${title.slice(0, 139)}…` : title,
        message:
          `O processo ${e.number} não tem classificação de risco oficial em vigor na data-base ` +
          `${many ? "das competências" : "da competência"} ${labels}, que ${many ? "continuam abertas" : "continua aberta"}. ` +
          "Registre a classificação com parecer, vigente até a data-base, ou a contabilidade pode fechar com justificativa.",
        entityType: "legal_process",
        entityId: processId,
        dedupeKey: key,
      },
      db,
    );
  }
  const resolved = await resolveStaleAlerts(organizationId, [CLOSE_BLOCKED_ALERT_TYPE], keep, db);
  return { periods, processCount: byProcess.size, resolved };
}

/**
 * Close-gate part of the `monthly_snapshot` routine (wired in src/server/jobs/routines.ts after
 * `runMonthlySnapshotRoutine`, which only refreshes the preview of the current month).
 */
export async function runCloseGateAlertsRoutine(rc: RoutineContext): Promise<string> {
  const r = await refreshCloseGateAlerts(rc.organizationId, rc.today);
  const resolved = r.resolved > 0 ? ` ${r.resolved} alerta(s) de classificação pendente encerrado(s).` : "";
  if (r.periods.length === 0) {
    return `Nenhuma competência vencida está aberta por falta de classificação de risco.${resolved}`;
  }
  return (
    `Competência(s) vencida(s) ainda aberta(s) por falta de classificação de risco: ${r.periods.map(formatPeriod).join(", ")}; ` +
    `${r.processCount} processo(s) com alerta. Nada foi fechado automaticamente.${resolved}`
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSnapshots(ctx: AuthContext): Promise<SnapshotListItem[]> {
  assertCan(ctx, "contingency:read");
  const generator = alias(users, "snapshot_generator");
  const closer = alias(users, "snapshot_closer");
  const rows = await getDb()
    .select({ s: portfolioSnapshots, generatedByName: generator.name, closedByName: closer.name })
    .from(portfolioSnapshots)
    .leftJoin(generator, eq(generator.id, portfolioSnapshots.generatedById))
    .leftJoin(closer, eq(closer.id, portfolioSnapshots.closedById))
    .where(eq(portfolioSnapshots.organizationId, ctx.organizationId))
    .orderBy(asc(portfolioSnapshots.period));
  const orgWide = snapshotScope(ctx) !== "visible";
  return rows
    .map(({ s, generatedByName, closedByName }) => ({
      id: s.id,
      period: s.period,
      referenceDate: s.referenceDate,
      status: s.status,
      generatedAt: s.generatedAt,
      generatedByName,
      closedAt: s.closedAt,
      closedByName,
      totals: orgWide ? s.metrics.totals : null,
    }))
    .reverse();
}

type ItemRow = typeof portfolioSnapshotItems.$inferSelect & {
  companyName: string | null;
  unitName: string | null;
  processDeleted: boolean;
};

/**
 * Items of a snapshot the viewer may see. Visibility is the CURRENT row rule of
 * the process (unit, responsible, confidentiality, law firm) but WITHOUT the
 * soft-delete condition: a process deleted or rolled back after the
 * calculation stays in the competência (RN-10), flagged `processDeleted`, and
 * is never counted as "sigiloso não listado".
 */
async function loadVisibleItems(ctx: AuthContext, snapshotId: string, db: DbOrTx): Promise<ItemRow[]> {
  const rows = await db
    .select({
      i: portfolioSnapshotItems,
      companyName: companies.name,
      unitName: units.name,
      pOrganizationId: legalProcesses.organizationId,
      pUnitId: legalProcesses.unitId,
      pResponsibleId: legalProcesses.responsibleId,
      pCreatedById: legalProcesses.createdById,
      pIsConfidential: legalProcesses.isConfidential,
      pLawFirmId: legalProcesses.lawFirmId,
      pDeletedAt: legalProcesses.deletedAt,
    })
    .from(portfolioSnapshotItems)
    .leftJoin(companies, eq(companies.id, portfolioSnapshotItems.companyId))
    .leftJoin(units, eq(units.id, portfolioSnapshotItems.unitId))
    .leftJoin(
      legalProcesses,
      and(eq(legalProcesses.id, portfolioSnapshotItems.processId), eq(legalProcesses.organizationId, ctx.organizationId)),
    )
    .where(and(eq(portfolioSnapshotItems.snapshotId, snapshotId), eq(portfolioSnapshotItems.organizationId, ctx.organizationId)))
    .orderBy(asc(portfolioSnapshotItems.number), asc(portfolioSnapshotItems.id));
  const all = seesConfidential(ctx);
  return rows
    .filter(
      (r) =>
        all ||
        (r.pOrganizationId !== null &&
          canViewScopedRecord(ctx, {
            organizationId: r.pOrganizationId,
            unitId: r.pUnitId,
            responsibleId: r.pResponsibleId,
            createdById: r.pCreatedById,
            isConfidential: r.pIsConfidential ?? true,
            lawFirmId: r.pLawFirmId,
            deletedAt: null,
          })),
    )
    .map((r) => ({ ...r.i, companyName: r.companyName, unitName: r.unitName, processDeleted: r.pDeletedAt !== null }));
}

function itemsBucket(items: ItemRow[]): MoneyBucket {
  const b = emptyBucket();
  for (const i of items) addToBucket(b, bucketInput(i));
  return b;
}

function toView(i: ItemRow): SnapshotItemView {
  return {
    processId: i.processId,
    number: i.number,
    companyName: i.companyName,
    unitName: i.unitName,
    court: i.court,
    instance: i.instance as ProcessInstance | null,
    phase: i.phase as StoredProcessPhase | null,
    city: i.city,
    isConfidential: i.isConfidential,
    classification: i.classification,
    percentageBp: i.percentageBp,
    claimAmountCents: i.claimAmountCents,
    liquidatedAmountCents: i.liquidatedAmountCents,
    guaranteesCents: i.guaranteesCents,
    exposureCents: i.exposureCents,
    exposureIsEstimate: i.exposureIsEstimate,
    provisionCents: i.provisionCents,
    provisionIsEstimate: i.provisionIsEstimate,
    provision: provisionFor(bucketInput(i)),
    processDeleted: i.processDeleted,
  };
}

function variation(cur: MoneyBucket, prev: MoneyBucket): SnapshotVariation {
  return {
    count: cur.count - prev.count,
    claimCents: cur.claimCents - prev.claimCents,
    liquidatedCents: cur.liquidatedCents - prev.liquidatedCents,
    guaranteesCents: cur.guaranteesCents - prev.guaranteesCents,
    exposureCents: cur.exposureCents - prev.exposureCents,
    exposureEstimateCents: cur.exposureEstimateCents - prev.exposureEstimateCents,
    provisionCents: cur.provisionCents - prev.provisionCents,
    provisionEstimateCents: cur.provisionEstimateCents - prev.provisionEstimateCents,
  };
}

/** One provision change; the flags of a side without provision are false (there is no basis). */
function provisionChange(
  p: Pick<ItemRow, "provisionCents" | "provisionIsEstimate">,
  c: Pick<ItemRow, "processId" | "number" | "provisionCents" | "provisionIsEstimate" | "processDeleted">,
): ProvisionChange {
  const fromIsEstimate = p.provisionCents !== null && p.provisionIsEstimate;
  const toIsEstimate = c.provisionCents !== null && c.provisionIsEstimate;
  const deltaCents =
    p.provisionCents !== null && c.provisionCents !== null && fromIsEstimate === toIsEstimate ? c.provisionCents - p.provisionCents : null;
  return {
    processId: c.processId,
    number: c.number,
    fromCents: p.provisionCents,
    toCents: c.provisionCents,
    fromIsEstimate,
    toIsEstimate,
    deltaCents,
    processDeleted: c.processDeleted,
  };
}

function movement(cur: ItemRow[], prev: ItemRow[], limit = 50): SnapshotMovement {
  const prevBy = new Map(prev.map((i) => [i.processId, i]));
  const curBy = new Map(cur.map((i) => [i.processId, i]));
  const pick = (i: ItemRow): MovementEntry => ({
    processId: i.processId,
    number: i.number,
    provisionCents: i.provisionCents,
    provisionIsEstimate: i.provisionIsEstimate,
    processDeleted: i.processDeleted,
  });
  const added = cur.filter((i) => !prevBy.has(i.processId)).map(pick);
  const removed = prev.filter((i) => !curBy.has(i.processId)).map(pick);
  const changes: SnapshotMovement["provisionChanges"] = [];
  for (const c of cur) {
    const p = prevBy.get(c.processId);
    if (!p) continue;
    if (p.provisionCents === c.provisionCents && p.provisionIsEstimate === c.provisionIsEstimate) continue;
    changes.push(provisionChange(p, c));
  }
  const weight = (x: ProvisionChange) => (x.deltaCents !== null ? Math.abs(x.deltaCents) : Math.max(x.fromCents ?? 0, x.toCents ?? 0));
  changes.sort((a, b) => weight(b) - weight(a) || a.number.localeCompare(b.number));
  return {
    added: added.slice(0, limit),
    removed: removed.slice(0, limit),
    provisionChanges: changes.slice(0, limit),
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changes.length,
  };
}

const CLASSIFICATION_KEYS = ["probable", "possible", "remote", "unclassified"] as const;

/**
 * A competência for the viewer: totals (org-wide or visible), memória de
 * cálculo per visible process (paginated), comparison with the previous
 * competência and the movement of the period. Returns null when it was never generated.
 */
export async function getSnapshot(
  ctx: AuthContext,
  period: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<SnapshotView | null> {
  assertCan(ctx, "contingency:read");
  const p = parsePeriod(period);
  const db = getDb();
  const generator = alias(users, "snapshot_generator");
  const closer = alias(users, "snapshot_closer");
  const load = (per: string) =>
    db
      .select({ s: portfolioSnapshots, generatedByName: generator.name, closedByName: closer.name })
      .from(portfolioSnapshots)
      .leftJoin(generator, eq(generator.id, portfolioSnapshots.generatedById))
      .leftJoin(closer, eq(closer.id, portfolioSnapshots.closedById))
      .where(and(eq(portfolioSnapshots.organizationId, ctx.organizationId), eq(portfolioSnapshots.period, per)));
  const [[row], [prevRow]] = await Promise.all([load(p), load(previousPeriod(p))]);
  if (!row) return null;
  const s = row.s;
  const scope = snapshotScope(ctx);

  const [items, prevItems] = await Promise.all([
    loadVisibleItems(ctx, s.id, db),
    prevRow ? loadVisibleItems(ctx, prevRow.s.id, db) : Promise.resolve([] as ItemRow[]),
  ]);

  const visibleTotals = itemsBucket(items);
  const totals = scope === "visible" ? visibleTotals : s.metrics.totals;
  const hiddenCount = scope === "org_wide" ? Math.max(0, s.metrics.totals.count - items.length) : 0;
  const classBuckets = (metrics: SnapshotMetrics, rows: ItemRow[]) =>
    CLASSIFICATION_KEYS.map((key) => {
      if (scope !== "visible") return { key, bucket: metrics.byClassification[key] ?? emptyBucket() };
      const b = emptyBucket();
      for (const i of rows) if ((i.classification ?? "unclassified") === key) addToBucket(b, bucketInput(i));
      return { key, bucket: b };
    });
  const byClassification = classBuckets(s.metrics, items);

  const prevTotals = prevRow ? (scope === "visible" ? itemsBucket(prevItems) : prevRow.s.metrics.totals) : null;
  const pageSize = Math.min(200, Math.max(10, opts.pageSize ?? 50));
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pageCount);

  return {
    id: s.id,
    period: s.period,
    referenceDate: s.referenceDate,
    status: s.status,
    generatedAt: s.generatedAt,
    generatedByName: row.generatedByName,
    closedAt: s.closedAt,
    closedByName: row.closedByName,
    params: s.params,
    scope,
    scopeNote: scope === "visible" ? visibleScopeNote(ctx) : null,
    totals,
    hiddenCount,
    byClassification,
    estimateCount: items.filter((i) => i.provisionIsEstimate || i.exposureIsEstimate).length,
    deletedCount: items.filter((i) => i.processDeleted).length,
    items: items.slice((page - 1) * pageSize, page * pageSize).map(toView),
    itemsTotal: items.length,
    page,
    pageSize,
    previous:
      prevRow && prevTotals
        ? {
            period: prevRow.s.period,
            status: prevRow.s.status,
            totals: prevTotals,
            byClassification: classBuckets(prevRow.s.metrics, prevItems),
          }
        : null,
    variation: prevTotals ? variation(totals, prevTotals) : null,
    movement: prevRow ? movement(items, prevItems) : null,
  };
}

export type UnclassifiedProcessView = {
  processId: string;
  number: string;
  title: string;
  responsibleName: string | null;
  isConfidential: boolean;
  /** An official classification exists, but only in force from this date (after the reference date). */
  classifiedFrom: string | null;
  /** A classification is on the process record, without any official assessment (opinion + identified person). */
  recordOnly: boolean;
  /** A rule suggestion (RF-12) is waiting for review. */
  pendingProposal: boolean;
};

export type CloseOverrideView = {
  /**
   * The justification. Null for a "visible"-scope viewer for whom none of the
   * unclassified processes is listed: the org-level text is not shown and the
   * page shows a neutral line instead.
   */
  reason: string | null;
  createdAt: Date;
  closedByName: string | null;
  /** Unclassified processes at the close: stored org-wide count (scope all/org_wide) or the listed ones (visible). */
  count: number;
  /** Org-wide scope only: counted but not listed for the viewer (confidential). */
  hiddenCount: number;
  /** The ones the viewer may see, from the closed items (a process deleted afterwards stays, flagged). */
  items: { processId: string; number: string; processDeleted: boolean }[];
};

export type CloseGateView = {
  period: string;
  referenceDate: string;
  /** Null when the competência was never generated. */
  status: SnapshotStatus | null;
  scope: SnapshotScope;
  /** Preview: unclassified processes (org-wide count for scope all/org_wide, listed ones for "visible"). */
  count: number;
  /** Preview, org-wide scope: unclassified but not listed for the viewer (confidential). */
  hiddenCount: number;
  /** Preview: the unclassified processes the viewer may see (first `limit`). */
  items: UnclassifiedProcessView[];
  itemsTotal: number;
  /** Preview: it must be recalculated before closing (classifications or population changed afterwards). */
  isStale: boolean;
  /** Preview, stale, org-wide scopes only: why (org-wide counts). Null otherwise. */
  staleness: PreviewStaleness | null;
  /** `snapshot:close` holders only: the normal close is allowed now. Null for everyone else. */
  canCloseWithoutJustification: boolean | null;
  /** Closed with a justification (P1.9). */
  override: CloseOverrideView | null;
};

/**
 * Close gate of a competência for the provision page: before the close, the
 * items of the preview without an official classification in force on the
 * reference date and whether the preview is stale (the same evaluation
 * `closeSnapshot` runs); after the close, the stored override, if any
 * (immutable). Names only processes the viewer may see.
 */
export async function getCloseGate(ctx: AuthContext, period: string, opts: { limit?: number } = {}): Promise<CloseGateView> {
  assertCan(ctx, "contingency:read");
  const p = parsePeriod(period);
  const db = getDb();
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const scope = snapshotScope(ctx);
  const [s] = await db
    .select({
      id: portfolioSnapshots.id,
      status: portfolioSnapshots.status,
      referenceDate: portfolioSnapshots.referenceDate,
      generatedAt: portfolioSnapshots.generatedAt,
    })
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.organizationId, ctx.organizationId), eq(portfolioSnapshots.period, p)));
  const base: CloseGateView = {
    period: p,
    referenceDate: s?.referenceDate ?? periodReferenceDate(p),
    status: s?.status ?? null,
    scope,
    count: 0,
    hiddenCount: 0,
    items: [],
    itemsTotal: 0,
    isStale: false,
    staleness: null,
    canCloseWithoutJustification: null,
    override: null,
  };
  if (!s) return base;

  if (s.status === "closed") {
    const closer = alias(users, "override_closer");
    const [o] = await db
      .select({ o: snapshotCloseOverrides, closedByName: closer.name })
      .from(snapshotCloseOverrides)
      .leftJoin(closer, and(eq(closer.id, snapshotCloseOverrides.closedById), eq(closer.organizationId, ctx.organizationId)))
      .where(and(eq(snapshotCloseOverrides.snapshotId, s.id), eq(snapshotCloseOverrides.organizationId, ctx.organizationId)));
    if (!o) return base;
    // The ids are a subset of the closed items (the close refuses a stale preview), so the listed
    // ones are the closed items the viewer may see.
    const ids = new Set(o.o.unclassifiedProcessIds);
    const listed = (await loadVisibleItems(ctx, s.id, db)).filter((i) => ids.has(i.processId));
    return {
      ...base,
      override: {
        reason: scope === "visible" && listed.length === 0 ? null : o.o.reason,
        createdAt: o.o.createdAt,
        closedByName: o.closedByName,
        count: scope === "visible" ? listed.length : o.o.unclassifiedCount,
        hiddenCount: scope === "org_wide" ? Math.max(0, o.o.unclassifiedCount - listed.length) : 0,
        items: listed.slice(0, limit).map((i) => ({ processId: i.processId, number: i.number, processDeleted: i.processDeleted })),
      },
    };
  }

  const [gate, later, proposed] = await Promise.all([
    evaluatePreviewGate(ctx.organizationId, s, db),
    db
      .select({
        processId: processRiskAssessments.processId,
        from: sql<string>`min(${processRiskAssessments.effectiveFrom})::text`,
      })
      .from(processRiskAssessments)
      .where(
        and(
          eq(processRiskAssessments.organizationId, ctx.organizationId),
          eq(processRiskAssessments.status, "official"),
          gt(processRiskAssessments.effectiveFrom, s.referenceDate),
        ),
      )
      .groupBy(processRiskAssessments.processId),
    db
      .selectDistinct({ processId: processRiskAssessments.processId })
      .from(processRiskAssessments)
      .where(and(eq(processRiskAssessments.organizationId, ctx.organizationId), eq(processRiskAssessments.status, "proposed"))),
  ]);
  const rows = gate.unclassified;
  const stale = isPreviewStale(gate.staleness);
  const laterBy = new Map(later.map((r) => [r.processId, r.from]));
  const proposedSet = new Set(proposed.map((r) => r.processId));
  const visible = rows.filter((r) => canSeeProcess(ctx, r));
  return {
    ...base,
    count: scope === "visible" ? visible.length : rows.length,
    hiddenCount: scope === "org_wide" ? rows.length - visible.length : 0,
    items: visible.slice(0, limit).map((r) => ({
      processId: r.id,
      number: r.number,
      title: r.title,
      responsibleName: r.responsibleName,
      isConfidential: r.isConfidential,
      classifiedFrom: laterBy.get(r.id) ?? null,
      recordOnly: r.lossProbability !== null && !laterBy.has(r.id),
      pendingProposal: proposedSet.has(r.id),
    })),
    itemsTotal: visible.length,
    isStale: stale,
    // Org-wide counts (they include confidential processes): only for who sees org-wide totals.
    staleness: stale && scope !== "visible" ? gate.staleness : null,
    canCloseWithoutJustification: can(ctx, "snapshot:close") ? rows.length === 0 && !stale : null,
  };
}

/** CSV export of a competência (route handler). Same visibility as `getSnapshot`; the export is audited. */
export async function exportSnapshotCsv(ctx: AuthContext, period: string): Promise<{ fileName: string; content: string }> {
  assertCan(ctx, "contingency:read");
  const p = parsePeriod(period);
  const db = getDb();
  const [s] = await db
    .select()
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.organizationId, ctx.organizationId), eq(portfolioSnapshots.period, p)));
  if (!s) throw new NotFoundError(`A competência ${formatPeriod(p)} ainda não foi gerada.`);
  const scope = snapshotScope(ctx);
  const items = await loadVisibleItems(ctx, s.id, db);
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.organizationId));
  const content = buildSnapshotCsv({
    organizationName: org?.name ?? null,
    period: s.period,
    referenceDate: s.referenceDate,
    status: s.status,
    params: s.params,
    rows: items.map(toView),
    totals: scope === "visible" ? itemsBucket(items) : s.metrics.totals,
    hiddenCount: scope === "org_wide" ? Math.max(0, s.metrics.totals.count - items.length) : 0,
    totalsAreOrganizationWide: scope !== "visible",
  });
  await recordAudit(ctx, {
    action: "snapshot.export",
    entityType: "snapshot",
    entityId: s.id,
    summary: `Competência ${formatPeriod(p)} exportada em CSV (${items.length} processo(s) listados).`,
    metadata: { period: p, status: s.status, rows: items.length },
  });
  return { fileName: `fechamento-${p}${s.status === "preview" ? "-previa" : ""}.csv`, content };
}

/** Used by the monthly routine: status of the competência, if any. */
export async function getSnapshotStatus(organizationId: string, period: string, db: DbOrTx = getDb()): Promise<SnapshotStatus | null> {
  const [s] = await db
    .select({ status: portfolioSnapshots.status })
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.organizationId, organizationId), eq(portfolioSnapshots.period, period)));
  return s?.status ?? null;
}
