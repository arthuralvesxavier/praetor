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
 * - Snapshots are organization-level artifacts: they are computed over every
 *   process of the organization. When READ, items are filtered by row
 *   visibility; org-wide totals are only shown to roles with organization-wide
 *   scope (with the count of confidential processes not listed).
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
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
import type { LossProbability, ProcessInstance, ProcessPhase, SnapshotStatus } from "@/domain/enums";
import { formatDateTime, formatMoneyCents, todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { hasOrganizationWideScope, seesConfidential, visibleProcessIds } from "@/server/auth/access";
import { assertCan } from "@/server/auth/permissions";
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
  units,
  users,
  type OrganizationSettings,
} from "@/server/db/schema";
import { recordAudit } from "@/server/services/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { buildSnapshotCsv, type CsvSnapshotRow } from "./csv";
import { loadSettings, parseOrThrow, requireHuman } from "./internal";
import { NONE_KEY } from "./labels";
import { positionAt, type PositionGuarantee, type PositionRisk, type PositionValuation } from "./position";
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
};

export type SnapshotMovement = {
  added: { processId: string; number: string; provisionCents: number | null; provisionIsEstimate: boolean }[];
  removed: { processId: string; number: string; provisionCents: number | null; provisionIsEstimate: boolean }[];
  provisionChanges: {
    processId: string;
    number: string;
    fromCents: number | null;
    toCents: number | null;
    deltaCents: number;
    toIsEstimate: boolean;
  }[];
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
  /** Totals for the viewer: org-wide (scope all/org_wide) or visible items only. */
  totals: MoneyBucket;
  /** Processes included in org-wide totals but not listed for the viewer. */
  hiddenCount: number;
  byClassification: { key: LossProbability | "unclassified"; bucket: MoneyBucket }[];
  /** Visible items with an estimated exposure or provision (RN-07). */
  estimateCount: number;
  items: SnapshotItemView[];
  itemsTotal: number;
  page: number;
  pageSize: number;
  previous: { period: string; status: SnapshotStatus; totals: MoneyBucket } | null;
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

export function snapshotScope(ctx: AuthContext): SnapshotScope {
  if (seesConfidential(ctx)) return "all";
  if (hasOrganizationWideScope(ctx)) return "org_wide";
  return "visible";
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

  const [vals, risks, guarantees] = await Promise.all([
    tx
      .select({
        processId: processValuations.processId,
        kind: processValuations.kind,
        amountCents: processValuations.amountCents,
        baseDate: processValuations.baseDate,
        status: processValuations.status,
        createdAt: processValuations.createdAt,
      })
      .from(processValuations)
      .where(
        and(
          eq(processValuations.organizationId, organizationId),
          inArray(processValuations.kind, ["claim", "liquidated"]),
          inArray(processValuations.status, ["official", "superseded"]),
        ),
      ),
    tx
      .select({
        processId: processRiskAssessments.processId,
        classification: processRiskAssessments.classification,
        percentageBp: processRiskAssessments.percentageBp,
        effectiveFrom: processRiskAssessments.effectiveFrom,
        status: processRiskAssessments.status,
        createdAt: processRiskAssessments.createdAt,
      })
      .from(processRiskAssessments)
      .where(and(eq(processRiskAssessments.organizationId, organizationId), eq(processRiskAssessments.status, "official"))),
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

  return procs.map((p) => {
    const pos = positionAt({
      date: referenceDate,
      process: p,
      valuations: (valsBy.get(p.id) ?? []) as PositionValuation[],
      risks: (risksBy.get(p.id) ?? []) as PositionRisk[],
      guarantees: (guaranteesBy.get(p.id) ?? []) as PositionGuarantee[],
      params: settings.contingency.riskPercentages,
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

  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: portfolioSnapshots.id, status: portfolioSnapshots.status })
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.organizationId, ctx.organizationId), eq(portfolioSnapshots.period, p)))
      .for("update");
    if (existing?.status === "closed") {
      throw new ConflictError(`A competência ${formatPeriod(p)} está fechada e é imutável (RN-10).`);
    }
    const settings = await loadSettings(ctx.organizationId, tx);
    const items = await computeItems(ctx.organizationId, referenceDate, settings, tx);
    const metrics = buildMetrics(items);
    const params: SnapshotParams = {
      riskPercentages: { ...settings.contingency.riskPercentages },
      rulesVersion: settings.contingency.rulesVersion,
      confidenceThreshold: settings.contingency.confidenceThreshold,
    };
    const now = new Date();
    let id: string;
    if (existing) {
      id = existing.id;
      const updated = await tx
        .update(portfolioSnapshots)
        .set({ metrics, params, referenceDate, generatedAt: now, generatedById: ctx.userId, updatedAt: now })
        .where(and(eq(portfolioSnapshots.id, id), eq(portfolioSnapshots.status, "preview")))
        .returning({ id: portfolioSnapshots.id });
      // Never touch the items of a competência closed in the meantime (RN-10).
      if (updated.length === 0) throw new ConflictError(`A competência ${formatPeriod(p)} está fechada e é imutável (RN-10).`);
      await tx.delete(portfolioSnapshotItems).where(eq(portfolioSnapshotItems.snapshotId, id));
    } else {
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
        .returning({ id: portfolioSnapshots.id });
      id = created.id;
    }
    for (let i = 0; i < items.length; i += 500) {
      await tx.insert(portfolioSnapshotItems).values(items.slice(i, i + 500).map((it) => ({ ...it, snapshotId: id })));
    }
    await recordAudit(
      ctx,
      {
        action: "snapshot.generate",
        entityType: "snapshot",
        entityId: id,
        summary:
          `Prévia da competência ${formatPeriod(p)} ${existing ? "recalculada" : "gerada"}: ${items.length} processo(s), ` +
          `provisão ${formatMoneyCents(metrics.totals.provisionCents)} + estimativa ${formatMoneyCents(metrics.totals.provisionEstimateCents)}.`,
        metadata: { period: p, referenceDate, itemCount: items.length, rulesVersion: params.rulesVersion },
      },
      tx,
    );
    return { id, status: "preview" as const, itemCount: items.length, metrics };
  });
}

/** Closes a competência (RN-10): from now on it is immutable. Requires `snapshot:close` and an identified person. */
export async function closeSnapshot(ctx: AuthContext, period: string): Promise<{ id: string }> {
  assertCan(ctx, "snapshot:close");
  const userId = requireHuman(ctx);
  const p = parsePeriod(period);
  assertNotFuturePeriod(p);
  return getDb().transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.organizationId, ctx.organizationId), eq(portfolioSnapshots.period, p)))
      .for("update");
    if (!s) throw new ConflictError(`Gere a prévia da competência ${formatPeriod(p)} antes de fechá-la.`);
    if (s.status === "closed") throw new ConflictError(`A competência ${formatPeriod(p)} já está fechada.`);
    const now = new Date();
    const updated = await tx
      .update(portfolioSnapshots)
      .set({ status: "closed", closedAt: now, closedById: userId, updatedAt: now })
      .where(and(eq(portfolioSnapshots.id, s.id), eq(portfolioSnapshots.status, "preview")))
      .returning({ id: portfolioSnapshots.id });
    if (updated.length === 0) throw new ConflictError(`A competência ${formatPeriod(p)} já está fechada.`);
    await recordAudit(
      ctx,
      {
        action: "snapshot.close",
        entityType: "snapshot",
        entityId: s.id,
        summary:
          `Competência ${formatPeriod(p)} fechada (imutável): provisão ${formatMoneyCents(s.metrics.totals.provisionCents)} + ` +
          `estimativa ${formatMoneyCents(s.metrics.totals.provisionEstimateCents)}, prévia calculada em ${formatDateTime(s.generatedAt)}.`,
        metadata: { period: p, itemCount: s.metrics.totals.count, rulesVersion: s.params.rulesVersion },
      },
      tx,
    );
    return { id: s.id };
  });
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

type ItemRow = typeof portfolioSnapshotItems.$inferSelect & { companyName: string | null; unitName: string | null };

async function loadVisibleItems(ctx: AuthContext, snapshotId: string, db: DbOrTx): Promise<ItemRow[]> {
  const conds: SQL[] = [eq(portfolioSnapshotItems.snapshotId, snapshotId), eq(portfolioSnapshotItems.organizationId, ctx.organizationId)];
  if (!seesConfidential(ctx)) conds.push(inArray(portfolioSnapshotItems.processId, visibleProcessIds(ctx)));
  const rows = await db
    .select({ i: portfolioSnapshotItems, companyName: companies.name, unitName: units.name })
    .from(portfolioSnapshotItems)
    .leftJoin(companies, eq(companies.id, portfolioSnapshotItems.companyId))
    .leftJoin(units, eq(units.id, portfolioSnapshotItems.unitId))
    .where(and(...conds))
    .orderBy(asc(portfolioSnapshotItems.number), asc(portfolioSnapshotItems.id));
  return rows.map((r) => ({ ...r.i, companyName: r.companyName, unitName: r.unitName }));
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
    phase: i.phase as ProcessPhase | null,
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

function movement(cur: ItemRow[], prev: ItemRow[], limit = 50): SnapshotMovement {
  const prevBy = new Map(prev.map((i) => [i.processId, i]));
  const curBy = new Map(cur.map((i) => [i.processId, i]));
  const pick = (i: ItemRow) => ({
    processId: i.processId,
    number: i.number,
    provisionCents: i.provisionCents,
    provisionIsEstimate: i.provisionIsEstimate,
  });
  const added = cur.filter((i) => !prevBy.has(i.processId)).map(pick);
  const removed = prev.filter((i) => !curBy.has(i.processId)).map(pick);
  const changes: SnapshotMovement["provisionChanges"] = [];
  for (const c of cur) {
    const p = prevBy.get(c.processId);
    if (!p) continue;
    if (p.provisionCents === c.provisionCents && p.provisionIsEstimate === c.provisionIsEstimate) continue;
    changes.push({
      processId: c.processId,
      number: c.number,
      fromCents: p.provisionCents,
      toCents: c.provisionCents,
      deltaCents: (c.provisionCents ?? 0) - (p.provisionCents ?? 0),
      toIsEstimate: c.provisionIsEstimate,
    });
  }
  changes.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents) || a.number.localeCompare(b.number));
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
  const byClassification = CLASSIFICATION_KEYS.map((key) => {
    if (scope !== "visible") return { key, bucket: s.metrics.byClassification[key] ?? emptyBucket() };
    const b = emptyBucket();
    for (const i of items) if ((i.classification ?? "unclassified") === key) addToBucket(b, bucketInput(i));
    return { key, bucket: b };
  });

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
    totals,
    hiddenCount,
    byClassification,
    estimateCount: items.filter((i) => i.provisionIsEstimate || i.exposureIsEstimate).length,
    items: items.slice((page - 1) * pageSize, page * pageSize).map(toView),
    itemsTotal: items.length,
    page,
    pageSize,
    previous: prevRow && prevTotals ? { period: prevRow.s.period, status: prevRow.s.status, totals: prevTotals } : null,
    variation: prevTotals ? variation(totals, prevTotals) : null,
    movement: prevRow ? movement(items, prevItems) : null,
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
