/**
 * Executive portfolio panel (TE-01): current position of the active portfolio
 * of legal liabilities and the follow-up cards (intake, alerts, preliminary
 * analyses awaiting review). Hearings appear only in the decision band
 * (`./decision-service.ts`, `DECISION_WINDOW_DAYS`).
 *
 * Scope: every figure is bounded by the row-visibility rules of
 * `@/server/auth/access` — executives, accountants and auditors aggregate the
 * whole NON-confidential portfolio; lawyers/analysts their visible portfolio;
 * external counsel their firm's processes. Rows returned by the contingency
 * module are additionally intersected with `processWhere(ctx)` here (defense
 * in depth), so a widened upstream result can never leak into the panel.
 * Net exposure (P1.8): valor apurado vigente − linked guarantees per process (never
 * negative), with the deductions by guarantee kind (SQL aggregate) and the processes with
 * the largest deductions; the estimate stays apart.
 * Previous closing (RN-10): the stored items of the latest CLOSED competência are summed
 * in SQL; a process deleted after the close still counts (same visibility policy as the
 * reports and the provision memo: the scope rules without the soft-delete condition).
 * Follow-up cards: alert counts only for the modules the role can read
 * (`visibleAlertsWhere`), and briefs awaiting review only in their latest version.
 *
 * Money rules: see `./portfolio.ts` (RN-02, RN-03, RN-04, RN-05, RN-07, RN-09, RN-10).
 * Coverage: `coverage` says in how many active processes the official liquidated
 * value is assessed (null = não apurado, never zero); the UI shows every
 * apurado-based amount together with it.
 * Registration gaps: a process without tribunal/instância/fase/cidade/empresa/unidade
 * stays out of that chart and is counted in `registrationGaps`, which links to
 * `/processos?pendencia=<campo>` (same rule as the processes list filter).
 * Services never import next/*; the page handles the UI states.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notExists, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { emptyBucket, netExposure, type AmountBasisCounts, type MoneyBucket } from "@/domain/contingency";
import {
  ALERT_TYPE_LABELS,
  LOSS_PROBABILITIES,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  type AlertType,
  type CaseBriefStatus,
  type GuaranteeKind,
  type LossProbability,
  type ProcessInstance,
  type ProcessPhase,
} from "@/domain/enums";
import { todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { caseBriefWhere, processWhere, scopedRecordWhere } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  alerts,
  caseBriefs,
  companies,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processGuarantees,
  units,
} from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { visibleAlertsWhere } from "@/modules/alerts/service";
import { getPortfolioExposure, type PortfolioExposureRow } from "@/modules/contingency/service";
import { getIntakeStatusCounts } from "@/modules/intake/service";
import { processesHref, type BiFilters } from "./bi-filters";
import {
  DIMENSIONS,
  bucketOf,
  dimensionGroups,
  groupRows,
  liquidatedCoverage,
  netExposureSummary,
  provisionBasisOf,
  uniqueProcessCount,
  type DimensionKey,
  type LiquidatedCoverage,
  type NetExposureSummary,
  type PortfolioRowLike,
} from "./portfolio";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a panel section that depends on a permission and on another module. */
export type Section<T> = { status: "ok"; data: T } | { status: "forbidden" } | { status: "error" };

export { DIMENSIONS, type DimensionKey } from "./portfolio";

/**
 * One chart category: always an informed value (processes without it are a registration gap).
 * `provisionBasis`: processes of the group with a provision on the valor apurado, on the valor da
 * causa or none (a group mixes classified and unclassified processes, so its bucket cannot tell).
 */
export type DimensionRow = { key: string; label: string; bucket: MoneyBucket; href: string; provisionBasis: AmountBasisCounts };
export type Dimension = {
  key: DimensionKey;
  rows: DimensionRow[];
  others: { groups: number; bucket: MoneyBucket; provisionBasis: AmountBasisCounts } | null;
  /** Processes without this field: kept out of the chart; `href` opens them in the portfolio. */
  missing: { bucket: MoneyBucket; href: string } | null;
};

/** "Pendência de cadastro": active processes without a field used by the charts. */
export type RegistrationGap = {
  field: DimensionKey;
  /** Unique processes without the field. */
  count: number;
  /** `/processos?pendencia=<campo>` with the dashboard filters. */
  href: string;
};

export type TopExposureItem = {
  processId: string;
  number: string;
  title: string;
  court: string;
  instance: ProcessInstance | null;
  phase: ProcessPhase;
  classification: LossProbability | null;
  claimCents: number | null;
  liquidatedCents: number | null;
  exposureCents: number | null;
  exposureIsEstimate: boolean;
};

export type PreviousClosing = {
  period: string;
  referenceDate: string;
  closedAt: Date | null;
  /** Stored figures of the closed period, restricted to the same scope and filters. */
  totals: MoneyBucket;
  /**
   * Stored items with an exposure on the valor apurado, on the valor da causa (estimate) or none,
   * counted from the stored items as they are (RN-10). A side without any is "not calculated",
   * never R$ 0, and is not compared (RN-03).
   */
  exposureBasis: AmountBasisCounts;
  /** Same for the provision (a valor apurado without risk classification has none). */
  provisionBasis: AmountBasisCounts;
};

export type PortfolioData = {
  /** Unique CNJ numbers in the active portfolio (RN-09). */
  activeProcesses: number;
  totals: MoneyBucket;
  /** "Exposição líquida" with what was deducted (P1.8); the estimate is kept apart. */
  netExposure: NetExposureSummary;
  /** "Valor apurado em X de Y processos": official liquidated value assessed (null never counts, zero does). */
  coverage: LiquidatedCoverage;
  /** Fields missing in active processes (only fields with at least one process), in `DIMENSIONS` order. */
  registrationGaps: RegistrationGap[];
  /**
   * `provisionBasis`: processes with a provision on the valor apurado, on the valor da causa
   * or none, so "Estimada" reads "Sem estimativa" instead of a R$ 0 that was never calculated.
   */
  byClassification: { key: LossProbability | "unclassified"; bucket: MoneyBucket; provisionBasis?: AmountBasisCounts }[];
  dimensions: Record<DimensionKey, Dimension>;
  top: TopExposureItem[];
  /** Latest CLOSED monthly snapshot before the current month; null = "sem fechamento anterior". */
  previous: PreviousClosing | null;
};

export type AlertGroupKey = "deadlines" | "hearings" | "portfolio" | "intake" | "contracts" | "analyses" | "others";

export type AlertGroupSummary = {
  key: AlertGroupKey;
  label: string;
  total: number;
  critical: number;
  types: { type: AlertType; label: string; count: number; critical: number }[];
};

export type BriefAwaiting = {
  id: string;
  processId: string;
  processNumber: string;
  status: CaseBriefStatus;
  mode: "live" | "demo";
  generatedAt: Date | null;
};

/**
 * Preliminary analyses awaiting review: latest version of each process only (a newer
 * generated version supersedes the older ones). `readyForReview` and `inReview` are
 * exactly what `/analises-preliminares?status=ready_for_review|in_review` lists.
 */
export type BriefsAwaiting = { total: number; readyForReview: number; inReview: number; items: BriefAwaiting[] };

/**
 * Intakes by step, from the effective statuses of `/entrada` (`getIntakeStatusCounts`):
 * each figure except `inProgress` is exactly what `/entrada?status=<status>` lists.
 */
export type IntakeFollowUp = {
  received: number;
  /** assigned + analyzing + brief_ready (no single list reproduces it). */
  inProgress: number;
  notified: number;
  inReview: number;
  approved: number;
  failed: number;
};

export type FollowUpData = {
  intake: Section<IntakeFollowUp>;
  alerts: { total: number; critical: number; groups: AlertGroupSummary[] };
  briefs: Section<BriefsAwaiting>;
};

const ACTIVE_STATUSES = ["active", "suspended"] as const;
const REVIEW_BRIEF_STATUSES = ["ready_for_review", "in_review"] as const satisfies readonly CaseBriefStatus[];
const CITY_TOP = 10;
const TOP_EXPOSURES = 8;

export const ALERT_GROUPS: { key: AlertGroupKey; label: string; types: AlertType[] }[] = [
  { key: "deadlines", label: "Prazos", types: ["deadline_overdue", "deadline_upcoming", "deadline_pending_validation"] },
  { key: "hearings", label: "Audiências", types: ["hearing_upcoming"] },
  {
    key: "portfolio",
    label: "Carteira e contingências",
    types: [
      "valuation_pending_review",
      "enforcement_without_value",
      "guarantee_idle",
      "process_needs_verification",
      "settlement_installment_due",
    ],
  },
  {
    key: "intake",
    label: "Entrada e análises preliminares",
    types: ["new_process_received", "intake_unassigned", "brief_pending_review"],
  },
  { key: "contracts", label: "Contratos", types: ["contract_expiring", "obligation_due"] },
  { key: "analyses", label: "Análises de IA e sinais de risco", types: ["risk_signal", "analysis_stale", "analysis_failed"] },
];

function logSectionError(section: string, error: unknown) {
  logger.error("dashboard_section_failed", { section, error });
}

/** Processes of the panel: visible, in the active portfolio and inside the BI filters (period excluded). */
function panelProcessWhere(ctx: AuthContext, filters: BiFilters): SQL {
  const p = legalProcesses;
  return and(
    processWhere(ctx),
    inArray(p.status, [...ACTIVE_STATUSES]),
    filters.companyId ? eq(p.companyId, filters.companyId) : undefined,
    filters.unitId ? eq(p.unitId, filters.unitId) : undefined,
    filters.area ? eq(p.area, filters.area) : undefined,
    filters.responsibleId ? eq(p.responsibleId, filters.responsibleId) : undefined,
  )!;
}

/**
 * Visibility of a process listed in a CLOSED competência (RN-10): every rule of
 * `processWhere` (organization, confidentiality, unit, responsible, law firm) except the
 * soft-delete condition, so a process deleted after the close keeps counting in the closed
 * figures. Same policy as the reports and the provision memo
 * (`canViewScopedRecord(ctx, { ...row, deletedAt: null })`).
 */
export function closedCompetenceProcessWhere(ctx: AuthContext): SQL {
  const p = legalProcesses;
  return scopedRecordWhere(ctx, {
    organizationId: p.organizationId,
    unitId: p.unitId,
    responsibleId: p.responsibleId,
    createdById: p.createdById,
    isConfidential: p.isConfidential,
    lawFirmId: p.lawFirmId,
    // `scopedRecordWhere` adds `<deletedAt> is null`: a constant null keeps every other rule and drops that one.
    deletedAt: sql`null` as unknown as AnyPgColumn,
  });
}

const sumText = (expr: SQL) => sql<string>`coalesce(${expr}, 0)::text`;
const countInt = (where?: SQL) =>
  where ? sql<number>`(count(*) filter (where ${where}))::int` : sql<number>`count(*)::int`;

/**
 * Stored figures of a closed competência, summed in SQL (RN-10: never recomputed). Same
 * result as `bucketFromSnapshotItems` over the same items (null values counted as unknown,
 * official and estimated amounts apart, negative guarantees ignored), plus how many items
 * carry an exposure and a provision on each basis.
 */
async function closedSnapshotBucket(
  ctx: AuthContext,
  snapshotId: string,
  filters: BiFilters,
): Promise<Pick<PreviousClosing, "totals" | "exposureBasis" | "provisionBasis">> {
  const it = portfolioSnapshotItems;
  const p = legalProcesses;
  const [row] = await getDb()
    .select({
      count: countInt(),
      claimCents: sumText(sql`sum(${it.claimAmountCents})`),
      claimUnknown: countInt(sql`${it.claimAmountCents} is null`),
      liquidatedCents: sumText(sql`sum(${it.liquidatedAmountCents})`),
      liquidatedUnknown: countInt(sql`${it.liquidatedAmountCents} is null`),
      guaranteesCents: sumText(sql`sum(greatest(${it.guaranteesCents}, 0))`),
      exposureCents: sumText(sql`sum(${it.exposureCents}) filter (where not ${it.exposureIsEstimate})`),
      exposureEstimateCents: sumText(sql`sum(${it.exposureCents}) filter (where ${it.exposureIsEstimate})`),
      exposureUnknown: countInt(sql`${it.exposureCents} is null`),
      provisionCents: sumText(sql`sum(${it.provisionCents}) filter (where not ${it.provisionIsEstimate})`),
      provisionEstimateCents: sumText(sql`sum(${it.provisionCents}) filter (where ${it.provisionIsEstimate})`),
      exposureOfficial: countInt(sql`${it.exposureCents} is not null and not ${it.exposureIsEstimate}`),
      exposureEstimate: countInt(sql`${it.exposureCents} is not null and ${it.exposureIsEstimate}`),
      provisionOfficial: countInt(sql`${it.provisionCents} is not null and not ${it.provisionIsEstimate}`),
      provisionEstimate: countInt(sql`${it.provisionCents} is not null and ${it.provisionIsEstimate}`),
      provisionNone: countInt(sql`${it.provisionCents} is null`),
    })
    .from(it)
    .innerJoin(p, and(eq(p.id, it.processId), eq(p.organizationId, ctx.organizationId)))
    .where(
      and(
        eq(it.organizationId, ctx.organizationId),
        eq(it.snapshotId, snapshotId),
        closedCompetenceProcessWhere(ctx),
        // Company and unit as stored at the close; area and responsible are not stored: current process.
        filters.companyId ? eq(it.companyId, filters.companyId) : undefined,
        filters.unitId ? eq(it.unitId, filters.unitId) : undefined,
        filters.area ? eq(p.area, filters.area) : undefined,
        filters.responsibleId ? eq(p.responsibleId, filters.responsibleId) : undefined,
      ),
    );
  const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
  return {
    totals: {
      count: n(row?.count),
      claimCents: n(row?.claimCents),
      claimUnknown: n(row?.claimUnknown),
      liquidatedCents: n(row?.liquidatedCents),
      liquidatedUnknown: n(row?.liquidatedUnknown),
      guaranteesCents: n(row?.guaranteesCents),
      exposureCents: n(row?.exposureCents),
      exposureEstimateCents: n(row?.exposureEstimateCents),
      exposureUnknown: n(row?.exposureUnknown),
      provisionCents: n(row?.provisionCents),
      provisionEstimateCents: n(row?.provisionEstimateCents),
    },
    exposureBasis: {
      official: n(row?.exposureOfficial),
      estimate: n(row?.exposureEstimate),
      none: n(row?.exposureUnknown),
    },
    provisionBasis: {
      official: n(row?.provisionOfficial),
      estimate: n(row?.provisionEstimate),
      none: n(row?.provisionNone),
    },
  };
}

// ---------------------------------------------------------------------------
// Portfolio position
// ---------------------------------------------------------------------------

export type PortfolioOptions = { today?: string };

/**
 * Current position of the active portfolio (stock: the period filter does not
 * apply), narrowed by company, unit, legal area and responsible person.
 * Requires `dashboard:read`; the section needs `contingency:read`.
 */
export async function getPortfolioPanel(
  ctx: AuthContext,
  filters: BiFilters,
  opts: PortfolioOptions = {},
): Promise<Section<PortfolioData>> {
  assertCan(ctx, "dashboard:read");
  if (!can(ctx, "contingency:read")) return { status: "forbidden" };
  const today = opts.today && /^\d{4}-\d{2}-\d{2}$/.test(opts.today) ? opts.today : todayISO();
  const db = getDb();
  const p = legalProcesses;

  let exposureRows: PortfolioExposureRow[];
  try {
    const result = await getPortfolioExposure(ctx, {
      ...(filters.companyId ? { companyId: filters.companyId } : {}),
      ...(filters.unitId ? { unitId: filters.unitId } : {}),
    });
    exposureRows = result.rows;
  } catch (error) {
    logSectionError("portfolio_exposure", error);
    return { status: "error" };
  }

  // Visible ACTIVE processes inside every filter (area and responsible are not in the exposure rows).
  const visible = await db.select({ id: p.id }).from(p).where(panelProcessWhere(ctx, filters));
  const visibleIds = new Set(visible.map((v) => v.id));
  const inFilters = (r: { companyId: string | null; unitId: string | null }) =>
    (!filters.companyId || r.companyId === filters.companyId) && (!filters.unitId || r.unitId === filters.unitId);

  const rows = exposureRows.filter(
    (r) => visibleIds.has(r.processId) && (ACTIVE_STATUSES as readonly string[]).includes(r.status) && inFilters(r),
  );

  // --- groups ---------------------------------------------------------------
  const companyIds = [...new Set(rows.map((r) => r.companyId).filter((v): v is string => Boolean(v)))];
  const unitIds = [...new Set(rows.map((r) => r.unitId).filter((v): v is string => Boolean(v)))];
  const [companyNames, unitNames] = await Promise.all([
    companyIds.length
      ? db
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(eq(companies.organizationId, ctx.organizationId), inArray(companies.id, companyIds)))
      : [],
    unitIds.length
      ? db
          .select({ id: units.id, name: units.name })
          .from(units)
          .where(and(eq(units.organizationId, ctx.organizationId), inArray(units.id, unitIds)))
      : [],
  ]);
  const companyName = new Map(companyNames.map((c) => [c.id, c.name]));
  const unitName = new Map(unitNames.map((u) => [u.id, u.name]));

  // A null key never becomes a "Não informado" category: it is a registration gap.
  const dimension = (
    key: DimensionKey,
    keyOf: (r: PortfolioRowLike) => string | null,
    label: (k: string) => string,
    href: (k: string) => string,
    limit?: number,
  ): Dimension => {
    const groups = dimensionGroups(rows, keyOf, limit);
    return {
      key,
      rows: groups.top.map((g) => ({
        key: g.key,
        label: label(g.key),
        bucket: g.bucket,
        href: href(g.key),
        provisionBasis: g.provisionBasis,
      })),
      others: groups.others,
      missing: groups.missing ? { bucket: groups.missing, href: processesHref(filters, { pendencia: key }) } : null,
    };
  };
  // Blank text counts as missing (same rule as `/processos?pendencia=`).
  const informed = (v: string | null) => (v !== null && v.trim() !== "" ? v : null);

  const dimensions: Record<DimensionKey, Dimension> = {
    court: dimension(
      "court",
      (r) => informed(r.court),
      (k) => k,
      (k) => processesHref(filters, { tribunal: k }),
    ),
    instance: dimension(
      "instance",
      (r) => r.instance,
      (k) => PROCESS_INSTANCE_LABELS[k as ProcessInstance] ?? k,
      (k) => processesHref(filters, { instancia: k as ProcessInstance }),
    ),
    phase: dimension(
      "phase",
      (r) => r.phase,
      (k) => PROCESS_PHASE_LABELS[k as ProcessPhase] ?? k,
      (k) => processesHref(filters, { phase: k as ProcessPhase }),
    ),
    city: dimension(
      "city",
      (r) => informed(r.city)?.trim() ?? null,
      (k) => k,
      (k) => processesHref(filters, { cidade: k }),
      CITY_TOP,
    ),
    company: dimension(
      "company",
      (r) => r.companyId,
      (k) => companyName.get(k) ?? "Empresa desativada ou removida",
      (k) => processesHref(filters, { empresa: k }),
    ),
    unit: dimension(
      "unit",
      (r) => r.unitId,
      (k) => unitName.get(k) ?? "Unidade desativada ou removida",
      (k) => processesHref(filters, { unidade: k }),
    ),
  };

  const registrationGaps: RegistrationGap[] = DIMENSIONS.flatMap((k) => {
    const missing = dimensions[k].missing;
    return missing ? [{ field: k, count: missing.bucket.count, href: missing.href }] : [];
  });

  const byClassificationMap = groupRows(rows, (r) => r.classification);
  const byClassification = [...LOSS_PROBABILITIES, "unclassified" as const].map((key) => ({
    key,
    bucket: byClassificationMap.get(key === "unclassified" ? null : key) ?? emptyBucket(),
    provisionBasis: provisionBasisOf(rows.filter((r) => (r.classification ?? "unclassified") === key)),
  }));

  const top: TopExposureItem[] = rows
    .map((r) => {
      const e = netExposure({
        liquidatedCents: r.liquidatedCents,
        linkedGuaranteesCents: r.guaranteesCents,
        claimCents: r.claimCents,
        riskPercentageBp: r.percentageBp,
      });
      return {
        processId: r.processId,
        number: r.number,
        title: r.title,
        court: r.court,
        instance: r.instance,
        phase: r.phase,
        classification: r.classification,
        claimCents: r.claimCents,
        liquidatedCents: r.liquidatedCents,
        exposureCents: e.exposureCents,
        exposureIsEstimate: e.isEstimate,
      };
    })
    .filter((t) => t.exposureCents !== null && t.exposureCents > 0)
    .sort((a, b) => (b.exposureCents ?? 0) - (a.exposureCents ?? 0) || a.number.localeCompare(b.number))
    .slice(0, TOP_EXPOSURES);

  // --- net exposure (P1.8): deductions by guarantee kind, aggregated in SQL -------
  const g = processGuarantees;
  const kindRows = await db
    .select({
      kind: g.kind,
      count: sql<number>`count(*)::int`,
      cents: sql<string>`coalesce(sum(${g.amountCents}), 0)::text`,
    })
    .from(g)
    .innerJoin(p, eq(p.id, g.processId))
    .where(
      and(
        // Same guarantees as the exposure rows (linked, not deleted) of the same processes with a valor apurado.
        eq(g.organizationId, ctx.organizationId),
        eq(g.status, "linked"),
        isNull(g.deletedAt),
        panelProcessWhere(ctx, filters),
        isNotNull(p.liquidatedAmountCents),
      ),
    )
    .groupBy(g.kind);
  const netExposureData = netExposureSummary(
    rows,
    kindRows.map((k) => ({ kind: k.kind as GuaranteeKind, count: Number(k.count), amountCents: Number(k.cents) })),
  );

  // --- previous closed month (read-only, stored figures) ------------------------
  let previous: PreviousClosing | null = null;
  const [snapshot] = await db
    .select({
      id: portfolioSnapshots.id,
      period: portfolioSnapshots.period,
      referenceDate: portfolioSnapshots.referenceDate,
      closedAt: portfolioSnapshots.closedAt,
    })
    .from(portfolioSnapshots)
    .where(
      and(
        eq(portfolioSnapshots.organizationId, ctx.organizationId),
        eq(portfolioSnapshots.status, "closed"),
        lt(portfolioSnapshots.period, today.slice(0, 7)),
      ),
    )
    .orderBy(desc(portfolioSnapshots.period))
    .limit(1);
  if (snapshot) {
    previous = {
      period: snapshot.period,
      referenceDate: snapshot.referenceDate,
      closedAt: snapshot.closedAt,
      ...(await closedSnapshotBucket(ctx, snapshot.id, filters)),
    };
  }

  const totals = bucketOf(rows);
  return {
    status: "ok",
    data: {
      activeProcesses: uniqueProcessCount(rows),
      totals,
      netExposure: netExposureData,
      coverage: liquidatedCoverage(totals),
      registrationGaps,
      byClassification,
      dimensions,
      top,
      previous,
    },
  };
}

// ---------------------------------------------------------------------------
// Follow-up cards (not affected by the BI filters)
// ---------------------------------------------------------------------------

export async function getFollowUpPanel(ctx: AuthContext): Promise<FollowUpData> {
  assertCan(ctx, "dashboard:read");
  const db = getDb();

  const intakeP: Promise<Section<IntakeFollowUp>> = can(ctx, "process:read")
    ? getIntakeStatusCounts(ctx).then(
        (s) => ({
          status: "ok" as const,
          data: {
            received: s.received,
            inProgress: s.assigned + s.analyzing + s.brief_ready,
            notified: s.notified,
            inReview: s.in_review,
            approved: s.approved,
            failed: s.failed,
          },
        }),
        (error: unknown) => {
          logSectionError("intake_counts", error);
          return { status: "error" as const };
        },
      )
    : Promise.resolve({ status: "forbidden" as const });

  // Same scope as the alerts center, the header bell and the digest: module read permission + row visibility.
  const alertsP = db
    .select({
      type: alerts.type,
      total: sql<number>`count(*)::int`,
      critical: sql<number>`(count(*) filter (where ${alerts.severity} = 'critical'))::int`,
    })
    .from(alerts)
    .where(and(isNull(alerts.resolvedAt), visibleAlertsWhere(ctx)))
    .groupBy(alerts.type);

  const briefsP: Promise<Section<BriefsAwaiting>> = can(ctx, "brief:read")
    ? (async () => {
        // Only the latest generated version of a process is reviewable (same rule as the briefs queue).
        const newer = alias(caseBriefs, "newer_brief");
        const latest = notExists(
          db
            .select({ one: sql`1` })
            .from(newer)
            .where(
              and(
                eq(newer.organizationId, caseBriefs.organizationId),
                eq(newer.processId, caseBriefs.processId),
                gt(newer.version, caseBriefs.version),
                isNotNull(newer.content),
              ),
            ),
        );
        const awaiting = and(caseBriefWhere(ctx), inArray(caseBriefs.status, [...REVIEW_BRIEF_STATUSES]), latest);
        const [byStatus, items] = await Promise.all([
          // Same join as listCaseBriefs, so each figure equals the list of its status.
          db
            .select({ status: caseBriefs.status, n: sql<number>`count(*)::int` })
            .from(caseBriefs)
            .innerJoin(
              legalProcesses,
              and(eq(legalProcesses.id, caseBriefs.processId), eq(legalProcesses.organizationId, ctx.organizationId)),
            )
            .where(awaiting)
            .groupBy(caseBriefs.status),
          db
            .select({
              id: caseBriefs.id,
              processId: caseBriefs.processId,
              processNumber: legalProcesses.number,
              status: caseBriefs.status,
              mode: caseBriefs.mode,
              generatedAt: caseBriefs.generatedAt,
            })
            .from(caseBriefs)
            .innerJoin(legalProcesses, and(eq(legalProcesses.id, caseBriefs.processId), processWhere(ctx)))
            .where(awaiting)
            .orderBy(asc(sql`coalesce(${caseBriefs.generatedAt}, ${caseBriefs.createdAt})`), asc(caseBriefs.id))
            .limit(5),
        ]);
        const of = (status: CaseBriefStatus) => Number(byStatus.find((r) => r.status === status)?.n ?? 0);
        const readyForReview = of("ready_for_review");
        const inReview = of("in_review");
        return { status: "ok" as const, data: { total: readyForReview + inReview, readyForReview, inReview, items } };
      })().catch((error: unknown) => {
        logSectionError("briefs_awaiting", error);
        return { status: "error" as const };
      })
    : Promise.resolve({ status: "forbidden" as const });

  const [intake, alertRows, briefs] = await Promise.all([intakeP, alertsP, briefsP]);

  const counts = new Map(alertRows.map((r) => [r.type, { total: Number(r.total), critical: Number(r.critical) }]));
  const known = new Set(ALERT_GROUPS.flatMap((g) => g.types));
  const groups: AlertGroupSummary[] = ALERT_GROUPS.map((g) => {
    const types = g.types
      .map((type) => ({ type, label: ALERT_TYPE_LABELS[type], count: counts.get(type)?.total ?? 0, critical: counts.get(type)?.critical ?? 0 }))
      .filter((t) => t.count > 0);
    return {
      key: g.key,
      label: g.label,
      total: types.reduce((a, t) => a + t.count, 0),
      critical: types.reduce((a, t) => a + t.critical, 0),
      types,
    };
  });
  // Types added later without a group still count in the totals (nothing is hidden).
  const ungrouped = alertRows.filter((r) => !known.has(r.type));
  if (ungrouped.length > 0) {
    const types = ungrouped.map((r) => ({
      type: r.type,
      label: ALERT_TYPE_LABELS[r.type] ?? r.type,
      count: Number(r.total),
      critical: Number(r.critical),
    }));
    groups.push({
      key: "others",
      label: "Outros alertas",
      total: types.reduce((a, t) => a + t.count, 0),
      critical: types.reduce((a, t) => a + t.critical, 0),
      types,
    });
  }

  return {
    intake,
    alerts: {
      total: groups.reduce((a, g) => a + g.total, 0),
      critical: groups.reduce((a, g) => a + g.critical, 0),
      groups,
    },
    briefs,
  };
}
