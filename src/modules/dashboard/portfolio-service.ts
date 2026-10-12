/**
 * Executive portfolio panel (TE-01): current position of the active portfolio
 * of legal liabilities and the follow-up cards (hearings, intake, alerts,
 * preliminary analyses awaiting review).
 *
 * Scope: every figure is bounded by the row-visibility rules of
 * `@/server/auth/access` — executives, accountants and auditors aggregate the
 * whole NON-confidential portfolio; lawyers/analysts their visible portfolio;
 * external counsel their firm's processes. Rows returned by the contingency
 * module are additionally intersected with `processWhere(ctx)` here (defense
 * in depth), so a widened upstream result can never leak into the panel.
 *
 * Money rules: see `./portfolio.ts` (RN-02, RN-03, RN-04, RN-05, RN-07, RN-09, RN-10).
 * Services never import next/*; the page handles the UI states.
 */
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { emptyBucket, netExposure, type MoneyBucket } from "@/domain/contingency";
import {
  ALERT_TYPE_LABELS,
  LOSS_PROBABILITIES,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  type AlertType,
  type CaseBriefStatus,
  type LossProbability,
  type ProcessInstance,
  type ProcessPhase,
} from "@/domain/enums";
import { todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { caseBriefWhere, entityReferenceWhere, processWhere } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  alerts,
  caseBriefs,
  companies,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  units,
} from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { getPortfolioExposure, type PortfolioExposureRow } from "@/modules/contingency/service";
import { listUpcomingHearings, type UpcomingHearing } from "@/modules/hearings/service";
import { getIntakeCounts, type IntakeCounts } from "@/modules/intake/service";
import { processesHref, type BiFilters } from "./bi-filters";
import {
  bucketFromSnapshotItems,
  bucketOf,
  groupRows,
  rankGroups,
  uniqueProcessCount,
  type PortfolioRowLike,
} from "./portfolio";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a panel section that depends on a permission and on another module. */
export type Section<T> = { status: "ok"; data: T } | { status: "forbidden" } | { status: "error" };

export const DIMENSIONS = ["court", "instance", "phase", "city", "company", "unit"] as const;
export type DimensionKey = (typeof DIMENSIONS)[number];

export type DimensionRow = { key: string | null; label: string; bucket: MoneyBucket; href: string | null };
export type Dimension = { key: DimensionKey; rows: DimensionRow[]; others: { groups: number; bucket: MoneyBucket } | null };

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
};

export type PortfolioData = {
  /** Unique CNJ numbers in the active portfolio (RN-09). */
  activeProcesses: number;
  totals: MoneyBucket;
  byClassification: { key: LossProbability | "unclassified"; bucket: MoneyBucket }[];
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

export type FollowUpData = {
  upcomingHearingDays: number;
  hearings: Section<UpcomingHearing[]>;
  intake: Section<IntakeCounts>;
  alerts: { total: number; critical: number; groups: AlertGroupSummary[] };
  briefs: Section<{ total: number; items: BriefAwaiting[] }>;
};

const ACTIVE_STATUSES = ["active", "suspended"] as const;
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

  // Visible processes narrowed by the filters that exposure rows do not carry (area, responsible).
  const visible = await db
    .select({ id: p.id, status: p.status })
    .from(p)
    .where(
      and(
        processWhere(ctx),
        filters.area ? eq(p.area, filters.area) : undefined,
        filters.responsibleId ? eq(p.responsibleId, filters.responsibleId) : undefined,
      ),
    );
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

  const NOT_INFORMED = "Não informado";
  const dimension = (
    key: DimensionKey,
    keyOf: (r: PortfolioRowLike) => string | null,
    label: (k: string) => string,
    href: (k: string) => string | null,
    limit?: number,
  ): Dimension => {
    const ranked = rankGroups(groupRows(rows, keyOf), limit);
    return {
      key,
      rows: ranked.top.map((g) => ({
        key: g.key,
        label: g.key === null ? NOT_INFORMED : label(g.key),
        bucket: g.bucket,
        href: g.key === null ? null : href(g.key),
      })),
      others: ranked.others,
    };
  };

  const dimensions: Record<DimensionKey, Dimension> = {
    court: dimension(
      "court",
      (r) => r.court || null,
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
      (r) => (r.city && r.city.trim() ? r.city.trim() : null),
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

  const byClassificationMap = groupRows(rows, (r) => r.classification);
  const byClassification = [...LOSS_PROBABILITIES, "unclassified" as const].map((key) => ({
    key,
    bucket: byClassificationMap.get(key === "unclassified" ? null : key) ?? emptyBucket(),
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
    const items = await db
      .select({
        processId: portfolioSnapshotItems.processId,
        companyId: portfolioSnapshotItems.companyId,
        unitId: portfolioSnapshotItems.unitId,
        claimAmountCents: portfolioSnapshotItems.claimAmountCents,
        liquidatedAmountCents: portfolioSnapshotItems.liquidatedAmountCents,
        guaranteesCents: portfolioSnapshotItems.guaranteesCents,
        exposureCents: portfolioSnapshotItems.exposureCents,
        exposureIsEstimate: portfolioSnapshotItems.exposureIsEstimate,
        provisionCents: portfolioSnapshotItems.provisionCents,
        provisionIsEstimate: portfolioSnapshotItems.provisionIsEstimate,
      })
      .from(portfolioSnapshotItems)
      .where(
        and(
          eq(portfolioSnapshotItems.organizationId, ctx.organizationId),
          eq(portfolioSnapshotItems.snapshotId, snapshot.id),
        ),
      );
    previous = {
      period: snapshot.period,
      referenceDate: snapshot.referenceDate,
      closedAt: snapshot.closedAt,
      totals: bucketFromSnapshotItems(items.filter((it) => visibleIds.has(it.processId) && inFilters(it))),
    };
  }

  return {
    status: "ok",
    data: {
      activeProcesses: uniqueProcessCount(rows),
      totals: bucketOf(rows),
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
  const org = await loadOrganization(ctx.organizationId);
  const upcomingHearingDays = Math.max(1, Math.min(365, Math.floor(org.settings.alerts.upcomingHearingDays)));

  const hearingsP: Promise<Section<UpcomingHearing[]>> = can(ctx, "process:read")
    ? listUpcomingHearings(ctx, { days: upcomingHearingDays, limit: 6 }).then(
        (data) => ({ status: "ok" as const, data }),
        (error: unknown) => {
          logSectionError("upcoming_hearings", error);
          return { status: "error" as const };
        },
      )
    : Promise.resolve({ status: "forbidden" as const });

  const intakeP: Promise<Section<IntakeCounts>> = can(ctx, "process:read")
    ? getIntakeCounts(ctx).then(
        (data) => ({ status: "ok" as const, data }),
        (error: unknown) => {
          logSectionError("intake_counts", error);
          return { status: "error" as const };
        },
      )
    : Promise.resolve({ status: "forbidden" as const });

  const alertsP = db
    .select({
      type: alerts.type,
      total: sql<number>`count(*)::int`,
      critical: sql<number>`(count(*) filter (where ${alerts.severity} = 'critical'))::int`,
    })
    .from(alerts)
    .where(
      and(
        eq(alerts.organizationId, ctx.organizationId),
        isNull(alerts.resolvedAt),
        entityReferenceWhere(ctx, alerts.entityType, alerts.entityId),
      ),
    )
    .groupBy(alerts.type);

  const briefsP: Promise<Section<{ total: number; items: BriefAwaiting[] }>> = can(ctx, "brief:read")
    ? (async () => {
        const awaiting = and(caseBriefWhere(ctx), inArray(caseBriefs.status, ["ready_for_review", "in_review"]));
        const [[{ total }], items] = await Promise.all([
          db.select({ total: sql<number>`count(*)::int` }).from(caseBriefs).where(awaiting),
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
            .orderBy(asc(sql`coalesce(${caseBriefs.generatedAt}, ${caseBriefs.createdAt})`))
            .limit(5),
        ]);
        return { status: "ok" as const, data: { total: Number(total), items } };
      })().catch((error: unknown) => {
        logSectionError("briefs_awaiting", error);
        return { status: "error" as const };
      })
    : Promise.resolve({ status: "forbidden" as const });

  const [hearings, intake, alertRows, briefs] = await Promise.all([hearingsP, intakeP, alertsP, briefsP]);

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
    upcomingHearingDays,
    hearings,
    intake,
    alerts: {
      total: groups.reduce((a, g) => a + g.total, 0),
      critical: groups.reduce((a, g) => a + g.critical, 0),
      groups,
    },
    briefs,
  };
}
