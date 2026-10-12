/**
 * Contingências: valorações (append-only), posição e exposição da carteira,
 * fila de conferência (TE-04). Guarantees, risk, settlements and the monthly
 * close live in the sibling `*-service.ts` files of this module.
 *
 * Cross-module contracts (docs/dev/MODULE_CONTRACTS.md, "v2"):
 *   getProcessContingencySummary, getPortfolioExposure, proposeValuation.
 *
 * Valuation lifecycle (RN-08, RN-11, RF-09):
 *   proposed ──approve──▶ official ──(newer official of the same kind+instance)──▶ superseded
 *            ──correct──▶ rejected + NEW official with the corrected amount
 *            ──reject───▶ rejected
 * Amounts are never updated; only status and review fields change (audited).
 * At most one `official` valuation exists per (process, kind, instance): the one
 * with the latest base date. Older official values are `superseded` and remain
 * the history used for "posição em data".
 */
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  addProvisionBasis,
  addToBucket,
  emptyBasisCounts,
  emptyBucket,
  netExposure,
  provisionFor,
  type AmountBasisCounts,
  type ExposureInput,
  type ExposureResult,
  type MoneyBucket,
  type ProvisionResult,
} from "@/domain/contingency";
import {
  VALUATION_KIND_LABELS,
  type CorrectionIndex,
  type LossProbability,
  type ProcessInstance,
  type ProcessPhase,
  type ProcessStatus,
  type TextExtractionStatus,
  type ValuationKind,
  type ValuationSource,
  type ValuationStatus,
} from "@/domain/enums";
import { normalizePage, type Paginated } from "@/domain/entities";
import { formatDate, formatMoneyCents, todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { documentWhere, processWhere, valuationWhere, visibleProcessIds } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  documentVersions,
  documents,
  legalProcesses,
  processGuarantees,
  processRiskAssessments,
  processValuations,
  users,
} from "@/server/db/schema";
import { recordAudit } from "@/server/services/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import {
  assertProcessDocument,
  loadSettings,
  loadVisibleProcess,
  OFFICIAL_VALUATION_ORDER,
  parseId,
  parseOrThrow,
  requireHuman,
  syncProcessMirrors,
  type MirrorChanges,
} from "./internal";
import { positionAt, recordRiskBp, type ProcessPosition } from "./position";
import { findExcerpt, slicePageText, windowAround } from "./rules";
import {
  addValuationSchema,
  bulkApproveSchema,
  extinctionSchema,
  positionAtSchema,
  proposeValuationSchema,
  reviewQueueFiltersSchema,
  reviewValuationSchema,
  type AddValuationInput,
  type ExtinctionInput,
  type ReviewQueueFilters,
  type ReviewValuationInput,
} from "./schemas";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type ProcessContingencySummary = {
  processId: string;
  /** Valor da causa (null = não informado). Never added to the liquidated value (RN-02). */
  claimCents: number | null;
  /** Current official liquidated value (null = não apurado, RN-03). */
  liquidatedCents: number | null;
  liquidatedBaseDate: string | null;
  linkedGuaranteesCents: number;
  classification: LossProbability | null;
  percentageBp: number | null;
  exposure: ExposureResult;
  provision: ProvisionResult;
  /** Proposed valuations waiting for human review. */
  pendingReviewCount: number;
};

export type PortfolioExposureFilters = {
  companyId?: string;
  unitId?: string;
  court?: string;
  instance?: ProcessInstance;
  phase?: ProcessPhase;
  city?: string;
  /** Default false: only active portfolio (status active/suspended). */
  includeClosed?: boolean;
};

export type PortfolioExposureRow = {
  processId: string;
  number: string;
  title: string;
  companyId: string | null;
  unitId: string | null;
  court: string;
  instance: ProcessInstance | null;
  phase: ProcessPhase;
  city: string | null;
  status: ProcessStatus;
  classification: LossProbability | null;
  percentageBp: number | null;
  claimCents: number | null;
  liquidatedCents: number | null;
  guaranteesCents: number;
  exposure: ExposureResult;
  provision: ProvisionResult;
};

export type ProposeValuationInput = {
  processId: string;
  kind: ValuationKind;
  amountCents: number;
  baseDate: string;
  source: ValuationSource;
  instance?: ProcessInstance | null;
  documentId?: string | null;
  documentVersionId?: string | null;
  page?: number | null;
  excerpt?: string | null;
  /** 0–100; values below the org threshold must be reviewed individually (RN-11). */
  confidence?: number | null;
  reason?: string | null;
  briefId?: string | null;
  isEstimate?: boolean;
};

// ---------------------------------------------------------------------------
// Module types
// ---------------------------------------------------------------------------

export type ValuationItem = {
  id: string;
  kind: ValuationKind;
  amountCents: number;
  baseDate: string;
  instance: ProcessInstance | null;
  source: ValuationSource;
  status: ValuationStatus;
  isEstimate: boolean;
  reason: string | null;
  documentId: string | null;
  /** Null when there is no document or the user cannot see it. */
  documentTitle: string | null;
  /** False when the valuation cites a document the user cannot open (excerpt hidden). */
  documentVisible: boolean;
  page: number | null;
  /** Literal excerpt — only when the cited document is visible to the user. */
  excerpt: string | null;
  confidence: number | null;
  supersedesId: string | null;
  createdByName: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
};

export type ValuationTimeline = {
  kind: ValuationKind;
  label: string;
  points: { id: string; baseDate: string; amountCents: number; status: ValuationStatus; instance: ProcessInstance | null }[];
}[];

type ValuationRow = typeof processValuations.$inferSelect;


// ---------------------------------------------------------------------------
// Summary & portfolio exposure
// ---------------------------------------------------------------------------

async function linkedGuaranteesTotal(organizationId: string, processId: string, db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${processGuarantees.amountCents}), 0)`.mapWith(Number) })
    .from(processGuarantees)
    .where(
      and(
        eq(processGuarantees.organizationId, organizationId),
        eq(processGuarantees.processId, processId),
        eq(processGuarantees.status, "linked"),
        isNull(processGuarantees.deletedAt),
      ),
    );
  return row?.total ?? 0;
}

/** Requires `contingency:read` and a visible process. */
export async function getProcessContingencySummary(ctx: AuthContext, processId: string): Promise<ProcessContingencySummary> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const settings = await loadSettings(ctx.organizationId, db);
  const [guarantees, [latestLiq], [pending]] = await Promise.all([
    linkedGuaranteesTotal(ctx.organizationId, p.id, db),
    db
      .select({ baseDate: processValuations.baseDate })
      .from(processValuations)
      .where(
        and(
          eq(processValuations.organizationId, ctx.organizationId),
          eq(processValuations.processId, p.id),
          eq(processValuations.kind, "liquidated"),
          eq(processValuations.status, "official"),
        ),
      )
      .orderBy(...OFFICIAL_VALUATION_ORDER)
      .limit(1),
    db
      .select({ n: count() })
      .from(processValuations)
      .where(
        and(
          eq(processValuations.organizationId, ctx.organizationId),
          eq(processValuations.processId, p.id),
          eq(processValuations.status, "proposed"),
        ),
      ),
  ]);
  const percentageBp = recordRiskBp(p, settings.contingency.riskPercentages);
  const input = {
    liquidatedCents: p.liquidatedAmountCents,
    linkedGuaranteesCents: guarantees,
    claimCents: p.claimAmountCents,
    riskPercentageBp: percentageBp,
  };
  return {
    processId: p.id,
    claimCents: p.claimAmountCents,
    liquidatedCents: p.liquidatedAmountCents,
    liquidatedBaseDate: p.liquidatedAmountCents !== null ? (latestLiq?.baseDate ?? null) : null,
    linkedGuaranteesCents: guarantees,
    classification: p.lossProbability,
    percentageBp,
    exposure: netExposure(input),
    provision: provisionFor(input),
    pendingReviewCount: Number(pending?.n ?? 0),
  };
}

function exposureConditions(ctx: AuthContext, filters: PortfolioExposureFilters): SQL[] {
  const conds: SQL[] = [processWhere(ctx)];
  if (!filters.includeClosed) conds.push(inArray(legalProcesses.status, ["active", "suspended"]));
  if (filters.companyId) conds.push(eq(legalProcesses.companyId, filters.companyId));
  if (filters.unitId) conds.push(eq(legalProcesses.unitId, filters.unitId));
  if (filters.court) conds.push(eq(legalProcesses.court, filters.court));
  if (filters.instance) conds.push(eq(legalProcesses.instance, filters.instance));
  if (filters.phase) conds.push(eq(legalProcesses.phase, filters.phase));
  if (filters.city) conds.push(eq(legalProcesses.city, filters.city));
  return conds;
}

/** Current position of every VISIBLE process (row visibility applied). Requires `contingency:read`. */
export async function getPortfolioExposure(
  ctx: AuthContext,
  filters: PortfolioExposureFilters = {},
): Promise<{ rows: PortfolioExposureRow[]; totals: MoneyBucket }> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const settings = await loadSettings(ctx.organizationId, db);
  const g = db
    .select({
      processId: processGuarantees.processId,
      total: sql<number>`sum(${processGuarantees.amountCents})`.mapWith(Number).as("guarantees_total"),
    })
    .from(processGuarantees)
    .where(
      and(
        eq(processGuarantees.organizationId, ctx.organizationId),
        eq(processGuarantees.status, "linked"),
        isNull(processGuarantees.deletedAt),
      ),
    )
    .groupBy(processGuarantees.processId)
    .as("linked_guarantees");

  const rows = await db
    .select({
      processId: legalProcesses.id,
      number: legalProcesses.number,
      title: legalProcesses.title,
      companyId: legalProcesses.companyId,
      unitId: legalProcesses.unitId,
      court: legalProcesses.court,
      instance: legalProcesses.instance,
      phase: legalProcesses.phase,
      city: legalProcesses.city,
      status: legalProcesses.status,
      lossProbability: legalProcesses.lossProbability,
      riskPercentageBp: legalProcesses.riskPercentageBp,
      claimAmountCents: legalProcesses.claimAmountCents,
      liquidatedAmountCents: legalProcesses.liquidatedAmountCents,
      guarantees: sql<number>`coalesce(${g.total}, 0)`.mapWith(Number),
    })
    .from(legalProcesses)
    .leftJoin(g, eq(g.processId, legalProcesses.id))
    .where(and(...exposureConditions(ctx, filters)))
    .orderBy(asc(legalProcesses.number), asc(legalProcesses.id));

  const totals = emptyBucket();
  const out: PortfolioExposureRow[] = rows.map((r) => {
    const percentageBp = recordRiskBp(r, settings.contingency.riskPercentages);
    const input = {
      liquidatedCents: r.liquidatedAmountCents,
      linkedGuaranteesCents: r.guarantees,
      claimCents: r.claimAmountCents,
      riskPercentageBp: percentageBp,
    };
    addToBucket(totals, input);
    return {
      processId: r.processId,
      number: r.number,
      title: r.title,
      companyId: r.companyId,
      unitId: r.unitId,
      court: r.court,
      instance: r.instance,
      phase: r.phase,
      city: r.city,
      status: r.status,
      classification: r.lossProbability,
      percentageBp,
      claimCents: r.claimAmountCents,
      liquidatedCents: r.liquidatedAmountCents,
      guaranteesCents: r.guarantees,
      exposure: netExposure(input),
      provision: provisionFor(input),
    };
  });
  return { rows: out, totals };
}

/**
 * A group of `/contingencias`. `provisionBasis` counts how many processes have a provision
 * on the valor apurado, on the valor da causa (estimate) or none at all, so a group whose
 * sum is zero only because nothing was calculated never reads "R$ 0,00" (RN-03).
 */
export type ContingencyGroup<K extends string = string> = { key: K; bucket: MoneyBucket; provisionBasis: AmountBasisCounts };

export type ContingencyOverview = {
  totals: MoneyBucket;
  totalsProvisionBasis: AmountBasisCounts;
  byCourt: ContingencyGroup[];
  byInstance: ContingencyGroup[];
  byPhase: ContingencyGroup[];
  byCompany: ContingencyGroup[];
  byClassification: ContingencyGroup<LossProbability | "unclassified">[];
  unclassifiedCount: number;
  pendingReviewCount: number;
};

function exposureInput(r: PortfolioExposureRow): ExposureInput {
  return {
    liquidatedCents: r.liquidatedCents,
    linkedGuaranteesCents: r.guaranteesCents,
    claimCents: r.claimCents,
    riskPercentageBp: r.percentageBp,
  };
}

function group(rows: PortfolioExposureRow[], keyOf: (r: PortfolioExposureRow) => string): ContingencyGroup[] {
  const map = new Map<string, ContingencyGroup>();
  for (const r of rows) {
    const key = keyOf(r);
    const g = map.get(key) ?? { key, bucket: emptyBucket(), provisionBasis: emptyBasisCounts() };
    addToBucket(g.bucket, exposureInput(r));
    addProvisionBasis(g.provisionBasis, exposureInput(r));
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.bucket.count - a.bucket.count || a.key.localeCompare(b.key, "pt-BR"));
}

/** Data of `/contingencias`: totals and breakdowns of the visible active portfolio. */
export async function getContingencyOverview(ctx: AuthContext, filters: PortfolioExposureFilters = {}): Promise<ContingencyOverview> {
  const { rows, totals } = await getPortfolioExposure(ctx, filters);
  const byClassification = (["probable", "possible", "remote", "unclassified"] as const).map((key) => {
    const g: ContingencyGroup<typeof key> = { key, bucket: emptyBucket(), provisionBasis: emptyBasisCounts() };
    for (const r of rows) {
      if ((r.classification ?? "unclassified") !== key) continue;
      addToBucket(g.bucket, exposureInput(r));
      addProvisionBasis(g.provisionBasis, exposureInput(r));
    }
    return g;
  });
  return {
    totals,
    totalsProvisionBasis: rows.reduce((acc, r) => addProvisionBasis(acc, exposureInput(r)), emptyBasisCounts()),
    byCourt: group(rows, (r) => r.court),
    byInstance: group(rows, (r) => r.instance ?? "none"),
    byPhase: group(rows, (r) => r.phase),
    byCompany: group(rows, (r) => r.companyId ?? "none"),
    byClassification,
    unclassifiedCount: rows.filter((r) => r.percentageBp === null).length,
    pendingReviewCount: await countPendingValuations(ctx),
  };
}

export type ContingencyParams = {
  riskPercentages: { remote: number; possible: number; probable: number };
  confidenceThreshold: number;
  rulesVersion: number;
  idleGuaranteeDays: number;
  installmentDueDays: number;
};

/** Organization contingency parameters (with defaults) for forms and explanations. */
export async function getContingencyParams(ctx: AuthContext): Promise<ContingencyParams> {
  assertCan(ctx, "contingency:read");
  const s = await loadSettings(ctx.organizationId);
  return {
    riskPercentages: { ...s.contingency.riskPercentages },
    confidenceThreshold: s.contingency.confidenceThreshold,
    rulesVersion: s.contingency.rulesVersion,
    idleGuaranteeDays: s.contingency.idleGuaranteeDays,
    installmentDueDays: s.alerts.installmentDueDays,
  };
}

/** Distinct courts of the visible portfolio (filter options). */
export async function listCourtOptions(ctx: AuthContext): Promise<string[]> {
  assertCan(ctx, "contingency:read");
  const rows = await getDb()
    .selectDistinct({ court: legalProcesses.court })
    .from(legalProcesses)
    .where(processWhere(ctx))
    .orderBy(asc(legalProcesses.court))
    .limit(500);
  return rows.map((r) => r.court);
}

// ---------------------------------------------------------------------------
// Valuations: writes
// ---------------------------------------------------------------------------

function assertNotFuture(date: string, field: string, message: string) {
  if (date > todayISO()) throw new ValidationError("Verifique os campos informados.", { [field]: [message] });
}

function instanceCondition(instance: ProcessInstance | null): SQL {
  return instance === null ? isNull(processValuations.instance) : eq(processValuations.instance, instance);
}

/**
 * Makes a (proposed) valuation official with an identified reviewer. When an
 * official value of the same kind+instance with a LATER base date already
 * exists, the approved value enters the history directly as `superseded`.
 * Otherwise every other official value of the same kind+instance becomes
 * `superseded` and the new one points to the value it replaced.
 */
async function promoteToOfficial(
  tx: DbOrTx,
  organizationId: string,
  v: Pick<ValuationRow, "id" | "processId" | "kind" | "instance" | "baseDate" | "supersedesId">,
  reviewerId: string,
  reviewNote: string | null,
): Promise<"official" | "superseded"> {
  const others = await tx
    .select({ id: processValuations.id, baseDate: processValuations.baseDate, createdAt: processValuations.createdAt })
    .from(processValuations)
    .where(
      and(
        eq(processValuations.organizationId, organizationId),
        eq(processValuations.processId, v.processId),
        eq(processValuations.kind, v.kind),
        instanceCondition(v.instance),
        eq(processValuations.status, "official"),
        ne(processValuations.id, v.id),
      ),
    );
  const reviewed = { reviewedById: reviewerId, reviewedAt: new Date(), reviewNote };
  if (others.some((o) => o.baseDate > v.baseDate)) {
    await tx
      .update(processValuations)
      .set({ status: "superseded", ...reviewed })
      .where(and(eq(processValuations.id, v.id), eq(processValuations.organizationId, organizationId)));
    return "superseded";
  }
  let replaced: (typeof others)[number] | null = null;
  for (const o of others) {
    if (!replaced || o.baseDate > replaced.baseDate || (o.baseDate === replaced.baseDate && o.createdAt > replaced.createdAt)) {
      replaced = o;
    }
  }
  if (others.length > 0) {
    await tx
      .update(processValuations)
      .set({ status: "superseded" })
      .where(
        and(
          eq(processValuations.organizationId, organizationId),
          inArray(
            processValuations.id,
            others.map((o) => o.id),
          ),
        ),
      );
  }
  await tx
    .update(processValuations)
    .set({ status: "official", ...reviewed, supersedesId: replaced?.id ?? v.supersedesId })
    .where(and(eq(processValuations.id, v.id), eq(processValuations.organizationId, organizationId)));
  return "official";
}

/** A quitação (RN-06): liquidated value 0 whose reason starts with "Quitação" (see `registerExtinction`). */
function isExtinction(v: Pick<ValuationRow, "kind" | "amountCents" | "reason">): boolean {
  return v.kind === "liquidated" && v.amountCents === 0 && (v.reason ?? "").startsWith("Quitação");
}

/**
 * Refuses a quitação dated before an official liquidated value of ANY instance:
 * the payment would not change the value in force (the mirror takes the latest
 * base date), so recording it as "zerado" would be false.
 */
async function assertNoLaterOfficialLiquidated(
  tx: DbOrTx,
  organizationId: string,
  processId: string,
  baseDate: string,
  excludeId?: string,
): Promise<void> {
  const [later] = await tx
    .select({ baseDate: processValuations.baseDate })
    .from(processValuations)
    .where(
      and(
        eq(processValuations.organizationId, organizationId),
        eq(processValuations.processId, processId),
        eq(processValuations.kind, "liquidated"),
        eq(processValuations.status, "official"),
        gt(processValuations.baseDate, baseDate),
        excludeId ? ne(processValuations.id, excludeId) : undefined,
      ),
    )
    .orderBy(desc(processValuations.baseDate))
    .limit(1);
  if (later) {
    throw new ValidationError(
      `Já existe valor liquidado oficial com data-base ${formatDate(later.baseDate)}, posterior à quitação ` +
        `(${formatDate(baseDate)}): a quitação não mudaria o valor em vigor. Confira a data do pagamento ou ` +
        "revise o valor liquidado oficial antes de registrar a quitação.",
      { baseDate: ["A data da quitação é anterior ao valor liquidado oficial em vigor."] },
    );
  }
}

/**
 * Makes a quitação official (RN-06). Unlike other values, it ends EVERY
 * official liquidated value of the process whatever the instance (imported
 * values carry one): rows with base date on/before the payment become
 * `superseded` — append-only, amounts never change. Refused when an official
 * liquidated value has a later base date (`assertNoLaterOfficialLiquidated`).
 */
async function promoteExtinction(
  tx: DbOrTx,
  organizationId: string,
  v: Pick<ValuationRow, "id" | "processId" | "baseDate" | "supersedesId">,
  reviewerId: string,
  reviewNote: string | null,
): Promise<"official"> {
  await assertNoLaterOfficialLiquidated(tx, organizationId, v.processId, v.baseDate, v.id);
  const [replaced] = await tx
    .select({ id: processValuations.id })
    .from(processValuations)
    .where(
      and(
        eq(processValuations.organizationId, organizationId),
        eq(processValuations.processId, v.processId),
        eq(processValuations.kind, "liquidated"),
        eq(processValuations.status, "official"),
        ne(processValuations.id, v.id),
      ),
    )
    .orderBy(...OFFICIAL_VALUATION_ORDER)
    .limit(1);
  await tx
    .update(processValuations)
    .set({ status: "superseded" })
    .where(
      and(
        eq(processValuations.organizationId, organizationId),
        eq(processValuations.processId, v.processId),
        eq(processValuations.kind, "liquidated"),
        eq(processValuations.status, "official"),
        lte(processValuations.baseDate, v.baseDate),
        ne(processValuations.id, v.id),
      ),
    );
  await tx
    .update(processValuations)
    .set({ status: "official", reviewedById: reviewerId, reviewedAt: new Date(), reviewNote, supersedesId: replaced?.id ?? v.supersedesId })
    .where(and(eq(processValuations.id, v.id), eq(processValuations.organizationId, organizationId)));
  return "official";
}

function valuationSummary(kind: ValuationKind, amountCents: number, baseDate: string): string {
  return `${VALUATION_KIND_LABELS[kind]} de ${formatMoneyCents(amountCents)} (data-base ${formatDate(baseDate)})`;
}

/**
 * Records a PROPOSED valuation (never official) for human review in the
 * review queue (RF-08). Requires `contingency:write` (system context allowed).
 */
export async function proposeValuation(ctx: AuthContext, input: ProposeValuationInput): Promise<{ id: string }> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(proposeValuationSchema, input);
  assertNotFuture(data.baseDate, "baseDate", "A data-base não pode ser futura.");
  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, data.processId, tx);
    let versionId: string | null = data.documentVersionId;
    if (data.documentId) {
      ({ versionId } = await assertProcessDocument(
        ctx,
        p.id,
        { documentId: data.documentId, documentVersionId: data.documentVersionId, page: data.page },
        tx,
      ));
    } else if (data.documentVersionId || data.page !== null || data.excerpt) {
      throw new ValidationError("Verifique os campos informados.", { documentId: ["Versão, página e trecho exigem um documento."] });
    }
    const [created] = await tx
      .insert(processValuations)
      .values({
        organizationId: ctx.organizationId,
        processId: p.id,
        kind: data.kind,
        amountCents: data.amountCents,
        baseDate: data.baseDate,
        instance: data.instance,
        source: data.source,
        status: "proposed",
        isEstimate: data.kind === "estimate" || data.isEstimate === true,
        reason: data.reason,
        documentId: data.documentId,
        documentVersionId: data.documentId ? versionId : null,
        page: data.page,
        excerpt: data.excerpt,
        confidence: data.confidence,
        briefId: data.briefId,
        createdById: ctx.userId,
      })
      .returning({ id: processValuations.id });
    await recordAudit(
      ctx,
      {
        action: "valuation.propose",
        entityType: "legal_process",
        entityId: p.id,
        summary: `${valuationSummary(data.kind, data.amountCents, data.baseDate)} proposto para conferência no processo ${p.number}.`,
        metadata: { valuationId: created.id, source: data.source, confidence: data.confidence },
      },
      tx,
    );
    return { id: created.id };
  });
}

/**
 * Manual entry from the process tab (RF-07). Users with `contingency:approve`
 * register it directly as OFFICIAL (they are the identified reviewer); others
 * (lawyers, external counsel) register it as PROPOSED for review.
 */
export async function addValuation(
  ctx: AuthContext,
  input: AddValuationInput,
): Promise<{ id: string; status: ValuationStatus }> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(addValuationSchema, input);
  assertNotFuture(data.baseDate, "baseDate", "A data-base não pode ser futura.");
  const official = can(ctx, "contingency:approve") && ctx.userId !== null;

  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, data.processId, tx);
    let versionId: string | null = null;
    if (data.documentId) {
      ({ versionId } = await assertProcessDocument(ctx, p.id, { documentId: data.documentId, page: data.page }, tx));
    }
    const [created] = await tx
      .insert(processValuations)
      .values({
        organizationId: ctx.organizationId,
        processId: p.id,
        kind: data.kind,
        amountCents: data.amountCents,
        baseDate: data.baseDate,
        instance: data.instance,
        source: data.source,
        status: "proposed",
        isEstimate: data.kind === "estimate",
        reason: data.reason,
        documentId: data.documentId,
        documentVersionId: versionId,
        page: data.documentId ? data.page : null,
        excerpt: data.documentId ? data.excerpt : null,
        createdById: ctx.userId,
      })
      .returning();

    let status: ValuationStatus = "proposed";
    let mirrors: MirrorChanges = null;
    if (official) {
      status = await promoteToOfficial(tx, ctx.organizationId, created, ctx.userId!, null);
      mirrors = await syncProcessMirrors(ctx.organizationId, p.id, tx);
    }
    await recordAudit(
      ctx,
      {
        action: official ? "valuation.create" : "valuation.propose",
        entityType: "legal_process",
        entityId: p.id,
        summary: official
          ? `${valuationSummary(data.kind, data.amountCents, data.baseDate)} registrado como oficial no processo ${p.number}.`
          : `${valuationSummary(data.kind, data.amountCents, data.baseDate)} proposto para conferência no processo ${p.number}.`,
        changes: mirrors,
        metadata: { valuationId: created.id, source: data.source, status },
      },
      tx,
    );
    return { id: created.id, status };
  });
}

async function loadValuation(ctx: AuthContext, id: string, db: DbOrTx): Promise<ValuationRow & { processNumber: string }> {
  const [row] = await db
    .select({ v: processValuations, processNumber: legalProcesses.number })
    .from(processValuations)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processValuations.processId))
    .where(and(eq(processValuations.id, parseId(id)), valuationWhere(ctx)));
  if (!row) throw new NotFoundError("Valor não encontrado ou sem permissão de acesso.");
  return { ...row.v, processNumber: row.processNumber };
}

export type ReviewResult = {
  /** Status of the reviewed proposal after the decision. */
  status: ValuationStatus;
  /** The official valuation created by a correction. */
  correctedValuationId?: string;
  /** Status of the corrected valuation (official, or superseded when a later official value exists). */
  correctedStatus?: ValuationStatus;
};

/**
 * What the reviewer saw (P1.7). `expectedCorrectionIndex`: the correction index
 * shown on the review screen (null = "sem índice informado"); when given, an
 * approval or correction is refused if the index changed since (it becomes final
 * with the official value). Undefined = not checked.
 */
export type ReviewGuard = { expectedCorrectionIndex?: string | null };

/** Refusal when the index of a proposal changed after the review screen was loaded (P1.7). */
export const CORRECTION_INDEX_CHANGED_MESSAGE =
  "O índice de atualização deste valor mudou depois que a página foi carregada. Recarregue a página e confira o valor de novo antes de decidir.";

function correctionIndexChanged(current: CorrectionIndex | null, expected: string | null | undefined): boolean {
  return expected !== undefined && (current ?? null) !== expected;
}

/**
 * Human review of a PROPOSED valuation (RN-11). Requires `contingency:approve`
 * and an identified user, who is recorded as `reviewedById`.
 *   approve → official (or superseded history when a later official value exists)
 *   correct → original rejected + new official valuation with the corrected amount
 *   reject  → rejected (note required)
 * `guard.expectedCorrectionIndex` pins the index shown to the reviewer (see `ReviewGuard`).
 */
export async function reviewValuation(
  ctx: AuthContext,
  id: string,
  input: ReviewValuationInput,
  guard: ReviewGuard = {},
): Promise<ReviewResult> {
  assertCan(ctx, "contingency:approve");
  const reviewerId = requireHuman(ctx);
  const data = parseOrThrow(reviewValuationSchema, input);

  return getDb().transaction(async (tx) => {
    const v = await loadValuation(ctx, id, tx);
    // Lock the proposal: while it is in review its correction index may be changed concurrently (P1.7).
    const [locked] = await tx
      .select({ status: processValuations.status, correctionIndex: processValuations.correctionIndex })
      .from(processValuations)
      .where(and(eq(processValuations.id, v.id), eq(processValuations.organizationId, ctx.organizationId)))
      .for("update");
    if (!locked || locked.status !== "proposed") throw new ConflictError("Este valor já foi conferido.");
    v.correctionIndex = locked.correctionIndex;
    if (data.decision !== "reject" && correctionIndexChanged(v.correctionIndex, guard.expectedCorrectionIndex)) {
      throw new ConflictError(CORRECTION_INDEX_CHANGED_MESSAGE);
    }
    const label = valuationSummary(v.kind, v.amountCents, v.baseDate);

    if (data.decision === "reject") {
      await tx
        .update(processValuations)
        .set({ status: "rejected", reviewedById: reviewerId, reviewedAt: new Date(), reviewNote: data.note })
        .where(and(eq(processValuations.id, v.id), eq(processValuations.organizationId, ctx.organizationId)));
      await recordAudit(
        ctx,
        {
          action: "valuation.reject",
          entityType: "legal_process",
          entityId: v.processId,
          summary: `${label} rejeitado na conferência (processo ${v.processNumber}).`,
          metadata: { valuationId: v.id },
        },
        tx,
      );
      return { status: "rejected" };
    }

    if (data.decision === "approve") {
      const extinction = isExtinction(v);
      const status = extinction
        ? await promoteExtinction(tx, ctx.organizationId, v, reviewerId, data.note)
        : await promoteToOfficial(tx, ctx.organizationId, v, reviewerId, data.note);
      const mirrors = await syncProcessMirrors(ctx.organizationId, v.processId, tx);
      const zeroed = extinction && mirrors?.liquidatedAmountCents?.to === 0;
      await recordAudit(
        ctx,
        {
          action: "valuation.approve",
          entityType: "legal_process",
          entityId: v.processId,
          summary: `${label} conferido e oficializado (processo ${v.processNumber})${zeroed ? ": quitação, valor liquidado oficial zerado" : ""}.`,
          changes: mirrors,
          metadata: { valuationId: v.id, status },
        },
        tx,
      );
      return { status };
    }

    // correct
    const corrected = data.correctedAmountCents!;
    if (corrected === v.amountCents) {
      throw new ValidationError("Verifique os campos informados.", {
        correctedAmountCents: ["O valor corrigido é igual ao proposto. Use “Aprovar”."],
      });
    }
    const originalNote = `Corrigido na conferência para ${formatMoneyCents(corrected)}.${data.note ? ` ${data.note}` : ""}`;
    await tx
      .update(processValuations)
      .set({ status: "rejected", reviewedById: reviewerId, reviewedAt: new Date(), reviewNote: originalNote.slice(0, 1000) })
      .where(and(eq(processValuations.id, v.id), eq(processValuations.organizationId, ctx.organizationId)));
    const reason = `Correção do valor proposto de ${formatMoneyCents(v.amountCents)}${v.reason ? ` (${v.reason})` : ""}`;
    const [created] = await tx
      .insert(processValuations)
      .values({
        organizationId: ctx.organizationId,
        processId: v.processId,
        kind: v.kind,
        amountCents: corrected,
        baseDate: v.baseDate,
        instance: v.instance,
        source: v.source,
        status: "proposed",
        isEstimate: v.isEstimate,
        reason: reason.slice(0, 1000),
        documentId: v.documentId,
        documentVersionId: v.documentVersionId,
        page: v.page,
        excerpt: v.excerpt,
        importBatchId: v.importBatchId,
        briefId: v.briefId,
        // P1.7: keep the index informed during review (null lets the trigger apply the org default).
        correctionIndex: v.correctionIndex,
        createdById: reviewerId,
      })
      .returning();
    const correctedStatus = await promoteToOfficial(tx, ctx.organizationId, created, reviewerId, data.note);
    const mirrors = await syncProcessMirrors(ctx.organizationId, v.processId, tx);
    await recordAudit(
      ctx,
      {
        action: "valuation.correct",
        entityType: "legal_process",
        entityId: v.processId,
        summary: `${label} corrigido na conferência para ${formatMoneyCents(corrected)} (processo ${v.processNumber}).`,
        changes: mirrors,
        metadata: { valuationId: v.id, correctedValuationId: created.id, status: correctedStatus },
      },
      tx,
    );
    return { status: "rejected", correctedValuationId: created.id, correctedStatus };
  });
}

export type BulkApproveResult = { approved: number; refused: { id: string; reason: string }[] };

/** Refusal reason of bulk approval for simulated extractions (their confidence is not a real measure). */
export const SIMULATED_BULK_REFUSAL = "Extração simulada: confira individualmente no documento antes de aprovar.";

/**
 * Bulk eligibility (RN-11): confidence at or above the threshold AND not a
 * simulated extraction — simulated proposals carry a fixed, demonstrative
 * confidence and must be checked one by one; quitações too.
 */
export function isBulkEligible(
  v: Pick<ValuationRow, "confidence" | "source" | "kind" | "amountCents" | "reason">,
  threshold: number,
): boolean {
  return v.source !== "simulation" && !isExtinction(v) && v.confidence !== null && v.confidence >= threshold;
}

/**
 * Approves several proposed valuations at once. Allowed only for items whose
 * extraction confidence is at least `settings.contingency.confidenceThreshold`
 * (RN-11) and that are not simulated extractions; the others are refused with
 * a pt-BR explanation and must be reviewed individually. Requires
 * `contingency:approve` and an identified user. `expectedCorrectionIndexes`
 * (P1.7): the correction index shown for each id (null = "sem índice
 * informado"); an item whose index changed since is refused.
 */
export async function bulkApproveValuations(
  ctx: AuthContext,
  ids: string[],
  expectedCorrectionIndexes: Record<string, string | null> = {},
): Promise<BulkApproveResult> {
  assertCan(ctx, "contingency:approve");
  const reviewerId = requireHuman(ctx);
  const data = parseOrThrow(bulkApproveSchema, { ids: [...new Set(ids)] });

  return getDb().transaction(async (tx) => {
    const settings = await loadSettings(ctx.organizationId, tx);
    const threshold = settings.contingency.confidenceThreshold;
    const rows = await tx
      .select({ v: processValuations, processNumber: legalProcesses.number })
      .from(processValuations)
      .innerJoin(legalProcesses, eq(legalProcesses.id, processValuations.processId))
      .where(and(inArray(processValuations.id, data.ids), valuationWhere(ctx)))
      .for("update", { of: processValuations });
    const byId = new Map(rows.map((r) => [r.v.id, r]));
    const refused: BulkApproveResult["refused"] = [];
    const eligible: typeof rows = [];
    for (const id of data.ids) {
      const r = byId.get(id);
      if (!r || r.v.status !== "proposed") {
        refused.push({ id, reason: "Valor não encontrado, sem acesso ou já conferido." });
      } else if (r.v.source === "simulation") {
        refused.push({ id, reason: SIMULATED_BULK_REFUSAL });
      } else if (isExtinction(r.v)) {
        refused.push({ id, reason: "Quitação: confira individualmente." });
      } else if (r.v.confidence === null || r.v.confidence < threshold) {
        refused.push({
          id,
          reason:
            `Confiança ${r.v.confidence === null ? "não informada" : `de ${r.v.confidence}%`} abaixo do mínimo de ` +
            `${threshold}% para conferência em lote: confira este valor individualmente.`,
        });
      } else if (
        correctionIndexChanged(
          r.v.correctionIndex,
          Object.hasOwn(expectedCorrectionIndexes, id) ? expectedCorrectionIndexes[id] : undefined,
        )
      ) {
        refused.push({ id, reason: CORRECTION_INDEX_CHANGED_MESSAGE });
      } else {
        eligible.push(r);
      }
    }
    // Oldest base date first, so the most recent value of each kind ends up official.
    eligible.sort((a, b) => a.v.baseDate.localeCompare(b.v.baseDate) || a.v.createdAt.getTime() - b.v.createdAt.getTime());
    const processes = new Set<string>();
    for (const { v, processNumber } of eligible) {
      const status = await promoteToOfficial(tx, ctx.organizationId, v, reviewerId, "Conferência em lote (alta confiança).");
      processes.add(v.processId);
      await recordAudit(
        ctx,
        {
          action: "valuation.approve",
          entityType: "legal_process",
          entityId: v.processId,
          summary: `${valuationSummary(v.kind, v.amountCents, v.baseDate)} oficializado em conferência em lote (processo ${processNumber}).`,
          metadata: { valuationId: v.id, status, bulk: true, confidence: v.confidence, threshold },
        },
        tx,
      );
    }
    for (const processId of processes) await syncProcessMirrors(ctx.organizationId, processId, tx, settings);
    return { approved: eligible.length, refused };
  });
}

/**
 * What a quitação actually did (messages and audit are built from it, never assumed):
 *   zeroed       → official, and the official liquidated value in force went to R$ 0,00
 *   already_zero → official; the value in force was already R$ 0,00
 *   history_only → official in the history, value in force unchanged (defensive: not expected)
 *   proposed     → waiting for review; nothing changed yet
 */
export type ExtinctionOutcome = "zeroed" | "already_zero" | "history_only" | "proposed";

/**
 * Extinção pela satisfação (RN-06): a new `liquidated` valuation of amount 0
 * whose reason starts with "Quitação". The history stays. Official when the
 * user has `contingency:approve`; proposed for review otherwise. Once official
 * it supersedes the official liquidated values of EVERY instance with base
 * date on/before the payment (`promoteExtinction`); a quitação dated before an
 * official liquidated value is refused (it would not change the value in force).
 */
export async function registerExtinction(
  ctx: AuthContext,
  processId: string,
  input: ExtinctionInput,
): Promise<{ id: string; status: ValuationStatus; outcome: ExtinctionOutcome }> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(extinctionSchema, input);
  assertNotFuture(data.baseDate, "baseDate", "A data da quitação não pode ser futura.");
  const official = can(ctx, "contingency:approve") && ctx.userId !== null;

  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, processId, tx);
    await assertNoLaterOfficialLiquidated(tx, ctx.organizationId, p.id, data.baseDate);
    let versionId: string | null = null;
    if (data.documentId) ({ versionId } = await assertProcessDocument(ctx, p.id, { documentId: data.documentId }, tx));
    const [created] = await tx
      .insert(processValuations)
      .values({
        organizationId: ctx.organizationId,
        processId: p.id,
        kind: "liquidated",
        amountCents: 0,
        baseDate: data.baseDate,
        instance: null,
        source: data.documentId ? "document" : "manual",
        status: "proposed",
        reason: data.note ? `Quitação: ${data.note}` : "Quitação",
        documentId: data.documentId,
        documentVersionId: versionId,
        createdById: ctx.userId,
      })
      .returning();
    let status: ValuationStatus = "proposed";
    let mirrors: MirrorChanges = null;
    let outcome: ExtinctionOutcome = "proposed";
    if (official) {
      status = await promoteExtinction(tx, ctx.organizationId, created, ctx.userId!, null);
      mirrors = await syncProcessMirrors(ctx.organizationId, p.id, tx);
      const inForce = mirrors?.liquidatedAmountCents ? mirrors.liquidatedAmountCents.to : p.liquidatedAmountCents;
      outcome =
        status === "official" && mirrors?.liquidatedAmountCents?.to === 0
          ? "zeroed"
          : status === "official" && inForce === 0
            ? "already_zero"
            : "history_only";
    }
    const date = formatDate(data.baseDate);
    const summary = {
      zeroed: `Quitação registrada no processo ${p.number}: valor liquidado oficial zerado em ${date}.`,
      already_zero: `Quitação registrada no processo ${p.number} (data ${date}); o valor liquidado oficial já era R$ 0,00.`,
      history_only: `Quitação de ${date} registrada no histórico do processo ${p.number}, sem alterar o valor liquidado em vigor.`,
      proposed: `Quitação proposta para conferência no processo ${p.number} (data ${date}).`,
    }[outcome];
    await recordAudit(
      ctx,
      {
        action: "valuation.extinction",
        entityType: "legal_process",
        entityId: p.id,
        summary,
        changes: mirrors,
        metadata: { valuationId: created.id, status, outcome },
      },
      tx,
    );
    return { id: created.id, status, outcome };
  });
}

// ---------------------------------------------------------------------------
// Valuations: reads
// ---------------------------------------------------------------------------

/** Ids and titles of the given documents that ctx can see. */
async function visibleDocumentTitles(ctx: AuthContext, ids: string[], db: DbOrTx): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(inArray(documents.id, ids), documentWhere(ctx)));
  return new Map(rows.map((r) => [r.id, r.title]));
}

/** Every valuation of a visible process (all statuses), newest base date first. */
export async function listValuations(ctx: AuthContext, processId: string): Promise<ValuationItem[]> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const creator = alias(users, "valuation_creator");
  const reviewer = alias(users, "valuation_reviewer");
  const rows = await db
    .select({ v: processValuations, createdByName: creator.name, reviewedByName: reviewer.name })
    .from(processValuations)
    .leftJoin(creator, eq(creator.id, processValuations.createdById))
    .leftJoin(reviewer, eq(reviewer.id, processValuations.reviewedById))
    .where(and(eq(processValuations.organizationId, ctx.organizationId), eq(processValuations.processId, p.id)))
    .orderBy(desc(processValuations.baseDate), desc(processValuations.createdAt));
  const titles = await visibleDocumentTitles(
    ctx,
    [...new Set(rows.map((r) => r.v.documentId).filter((x): x is string => !!x))],
    db,
  );
  return rows.map(({ v, createdByName, reviewedByName }) => {
    const documentVisible = v.documentId ? titles.has(v.documentId) : true;
    return {
      id: v.id,
      kind: v.kind,
      amountCents: v.amountCents,
      baseDate: v.baseDate,
      instance: v.instance,
      source: v.source,
      status: v.status,
      isEstimate: v.isEstimate,
      reason: v.reason,
      documentId: v.documentId,
      documentTitle: v.documentId ? (titles.get(v.documentId) ?? null) : null,
      documentVisible,
      page: v.page,
      excerpt: documentVisible ? v.excerpt : null,
      confidence: v.confidence,
      supersedesId: v.supersedesId,
      createdByName,
      reviewedByName,
      reviewedAt: v.reviewedAt,
      reviewNote: v.reviewNote,
      createdAt: v.createdAt,
    };
  });
}

/** RF-09: value history (official + superseded) grouped by kind, oldest first. Kinds are never summed (RN-02). */
export async function getValuationTimeline(ctx: AuthContext, processId: string): Promise<ValuationTimeline> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const rows = await db
    .select({
      id: processValuations.id,
      kind: processValuations.kind,
      amountCents: processValuations.amountCents,
      baseDate: processValuations.baseDate,
      status: processValuations.status,
      instance: processValuations.instance,
    })
    .from(processValuations)
    .where(
      and(
        eq(processValuations.organizationId, ctx.organizationId),
        eq(processValuations.processId, p.id),
        inArray(processValuations.status, ["official", "superseded"]),
      ),
    )
    .orderBy(asc(processValuations.baseDate), asc(processValuations.createdAt));
  const series = new Map<ValuationKind, ValuationTimeline[number]>();
  for (const r of rows) {
    const s = series.get(r.kind) ?? { kind: r.kind, label: VALUATION_KIND_LABELS[r.kind], points: [] };
    s.points.push({ id: r.id, baseDate: r.baseDate, amountCents: r.amountCents, status: r.status, instance: r.instance });
    series.set(r.kind, s);
  }
  const order: ValuationKind[] = ["claim", "liquidated", "settlement", "deposit", "paid", "fees", "estimate"];
  return order.map((k) => series.get(k)).filter((s): s is ValuationTimeline[number] => !!s);
}

/** "Quanto era o passivo em data passada": position of a process on `date` (history, RN-04/RN-05). */
export async function getPositionAt(ctx: AuthContext, processId: string, date: string): Promise<ProcessPosition> {
  assertCan(ctx, "contingency:read");
  const { date: d } = parseOrThrow(positionAtSchema, { date });
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const settings = await loadSettings(ctx.organizationId, db);
  const [valuations, risks, guarantees] = await Promise.all([
    db
      .select({
        id: processValuations.id,
        kind: processValuations.kind,
        amountCents: processValuations.amountCents,
        baseDate: processValuations.baseDate,
        status: processValuations.status,
        createdAt: processValuations.createdAt,
        reviewedAt: processValuations.reviewedAt,
      })
      .from(processValuations)
      .where(and(eq(processValuations.organizationId, ctx.organizationId), eq(processValuations.processId, p.id))),
    db
      .select({
        id: processRiskAssessments.id,
        classification: processRiskAssessments.classification,
        percentageBp: processRiskAssessments.percentageBp,
        effectiveFrom: processRiskAssessments.effectiveFrom,
        status: processRiskAssessments.status,
        createdAt: processRiskAssessments.createdAt,
        reviewedAt: processRiskAssessments.reviewedAt,
      })
      .from(processRiskAssessments)
      .where(and(eq(processRiskAssessments.organizationId, ctx.organizationId), eq(processRiskAssessments.processId, p.id))),
    db
      .select({
        amountCents: processGuarantees.amountCents,
        status: processGuarantees.status,
        depositedAt: processGuarantees.depositedAt,
        statusChangedAt: processGuarantees.statusChangedAt,
        createdAt: processGuarantees.createdAt,
        deletedAt: processGuarantees.deletedAt,
      })
      .from(processGuarantees)
      .where(and(eq(processGuarantees.organizationId, ctx.organizationId), eq(processGuarantees.processId, p.id))),
  ]);
  return positionAt({
    date: d,
    process: p,
    valuations,
    risks,
    guarantees,
    params: settings.contingency.riskPercentages,
  });
}

/** Process id of a visible valuation (actions use it to revalidate the right page). */
export async function getValuationProcessId(ctx: AuthContext, id: string): Promise<string> {
  assertCan(ctx, "contingency:read");
  return (await loadValuation(ctx, id, getDb())).processId;
}

/** Documents of a process visible to ctx (selects of the valuation/guarantee forms). */
export async function listProcessDocumentOptions(ctx: AuthContext, processId: string): Promise<{ id: string; title: string }[]> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  return db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.processId, p.id), documentWhere(ctx)))
    .orderBy(desc(documents.createdAt))
    .limit(200);
}

const PROCESS_DOCUMENT_OPTIONS_LIMIT = 200;

/**
 * Batched `listProcessDocumentOptions` for several processes (e.g. the
 * "Registrar quitação" dialogs of `/acordos`): only visible processes and
 * visible documents; ids that are invalid or not visible are ignored.
 * Returns process id → documents (newest first, at most 200 per process).
 */
export async function listDocumentOptionsForProcesses(
  ctx: AuthContext,
  processIds: string[],
): Promise<Record<string, { id: string; title: string }[]>> {
  assertCan(ctx, "contingency:read");
  const ids = [...new Set(processIds)].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (ids.length === 0) return {};
  const rows = await getDb()
    .select({ id: documents.id, title: documents.title, processId: documents.processId })
    .from(documents)
    .where(and(inArray(documents.processId, ids), inArray(documents.processId, visibleProcessIds(ctx)), documentWhere(ctx)))
    .orderBy(desc(documents.createdAt), asc(documents.id));
  const out: Record<string, { id: string; title: string }[]> = {};
  for (const r of rows) {
    if (!r.processId) continue;
    const list = (out[r.processId] ??= []);
    if (list.length < PROCESS_DOCUMENT_OPTIONS_LIMIT) list.push({ id: r.id, title: r.title });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Review queue (TE-04)
// ---------------------------------------------------------------------------

export type ReviewQueueItem = {
  id: string;
  processId: string;
  processNumber: string;
  processTitle: string;
  kind: ValuationKind;
  amountCents: number;
  baseDate: string;
  instance: ProcessInstance | null;
  source: ValuationSource;
  confidence: number | null;
  /** Confidence at or above the organization threshold: eligible for bulk approval (RN-11). */
  bulkEligible: boolean;
  isEstimate: boolean;
  reason: string | null;
  documentTitle: string | null;
  page: number | null;
  createdByName: string | null;
  createdAt: Date;
  /** Current official value of the same kind (for comparison), null = none. */
  currentOfficialCents: number | null;
  /** P1.7: index of the proposal (null = "sem índice informado"); final once approved, so it is shown in the review. */
  correctionIndex: CorrectionIndex | null;
};

export async function countPendingValuations(ctx: AuthContext): Promise<number> {
  assertCan(ctx, "contingency:read");
  const [row] = await getDb()
    .select({ n: count() })
    .from(processValuations)
    .where(and(valuationWhere(ctx), eq(processValuations.status, "proposed")));
  return Number(row?.n ?? 0);
}

export async function listReviewQueue(
  ctx: AuthContext,
  filters: ReviewQueueFilters = {},
): Promise<Paginated<ReviewQueueItem> & { threshold: number }> {
  assertCan(ctx, "contingency:read");
  const f = parseOrThrow(reviewQueueFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const db = getDb();
  const settings = await loadSettings(ctx.organizationId, db);
  const threshold = settings.contingency.confidenceThreshold;

  const conds: SQL[] = [valuationWhere(ctx), eq(processValuations.status, "proposed")];
  if (f.source) conds.push(eq(processValuations.source, f.source));
  if (f.confidence === "alta") conds.push(gte(processValuations.confidence, threshold));
  if (f.confidence === "baixa") {
    conds.push(or(isNull(processValuations.confidence), lt(processValuations.confidence, threshold)) as SQL);
  }
  const where = and(...conds);
  const creator = alias(users, "queue_creator");
  const currentOfficial = sql<number | null>`(
    select cv.amount_cents from process_valuations cv
    where cv.process_id = ${processValuations.processId}
      and cv.kind = ${processValuations.kind}
      and cv.status = 'official'
    order by cv.base_date desc, coalesce(cv.reviewed_at, cv.created_at) desc, cv.created_at desc, cv.id desc
    limit 1
  )`.mapWith((v) => (v === null ? null : Number(v)));

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        v: processValuations,
        processNumber: legalProcesses.number,
        processTitle: legalProcesses.title,
        createdByName: creator.name,
        currentOfficialCents: currentOfficial,
      })
      .from(processValuations)
      .innerJoin(legalProcesses, eq(legalProcesses.id, processValuations.processId))
      .leftJoin(creator, eq(creator.id, processValuations.createdById))
      .where(where)
      .orderBy(asc(processValuations.createdAt), asc(processValuations.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(processValuations).where(where),
  ]);
  const titles = await visibleDocumentTitles(
    ctx,
    [...new Set(rows.map((r) => r.v.documentId).filter((x): x is string => !!x))],
    db,
  );
  return {
    threshold,
    total: Number(total),
    page,
    pageSize,
    items: rows.map(({ v, processNumber, processTitle, createdByName, currentOfficialCents }) => ({
      id: v.id,
      processId: v.processId,
      processNumber,
      processTitle,
      kind: v.kind,
      amountCents: v.amountCents,
      baseDate: v.baseDate,
      instance: v.instance,
      source: v.source,
      confidence: v.confidence,
      bulkEligible: isBulkEligible(v, threshold),
      isEstimate: v.isEstimate,
      reason: v.reason,
      documentTitle: v.documentId ? (titles.get(v.documentId) ?? null) : null,
      page: v.page,
      createdByName,
      createdAt: v.createdAt,
      currentOfficialCents,
      correctionIndex: v.correctionIndex,
    })),
  };
}

export type ReviewItemDocument = {
  documentId: string;
  /** False when the user cannot open the document: no text and no excerpt are returned. */
  visible: boolean;
  title: string | null;
  versionNumber: number | null;
  extractionStatus: TextExtractionStatus | null;
  pageCount: number | null;
  /** Page shown (requested page, or the page where the excerpt was found). */
  page: number | null;
  pageText: string | null;
  highlight: { start: number; end: number } | null;
  truncatedStart: boolean;
  truncatedEnd: boolean;
};

export type ReviewItem = {
  valuation: ReviewQueueItem & { excerpt: string | null; status: ValuationStatus; reviewNote: string | null };
  document: ReviewItemDocument | null;
  currentOfficial: { amountCents: number; baseDate: string } | null;
  threshold: number;
};

/** Selected item of the review queue: valuation + the cited document page with the excerpt highlighted. */
export async function getReviewItem(ctx: AuthContext, id: string): Promise<ReviewItem> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const settings = await loadSettings(ctx.organizationId, db);
  const creator = alias(users, "review_creator");
  const [row] = await db
    .select({
      v: processValuations,
      processNumber: legalProcesses.number,
      processTitle: legalProcesses.title,
      createdByName: creator.name,
    })
    .from(processValuations)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processValuations.processId))
    .leftJoin(creator, eq(creator.id, processValuations.createdById))
    .where(and(eq(processValuations.id, parseId(id)), valuationWhere(ctx)));
  if (!row) throw new NotFoundError("Valor não encontrado ou sem permissão de acesso.");
  const v = row.v;

  const [official] = await db
    .select({ amountCents: processValuations.amountCents, baseDate: processValuations.baseDate })
    .from(processValuations)
    .where(
      and(
        eq(processValuations.organizationId, ctx.organizationId),
        eq(processValuations.processId, v.processId),
        eq(processValuations.kind, v.kind),
        eq(processValuations.status, "official"),
      ),
    )
    .orderBy(...OFFICIAL_VALUATION_ORDER)
    .limit(1);

  let document: ReviewItemDocument | null = null;
  if (v.documentId) {
    const [doc] = await db
      .select({ id: documents.id, title: documents.title, currentVersionId: documents.currentVersionId })
      .from(documents)
      .where(and(eq(documents.id, v.documentId), documentWhere(ctx)));
    if (!doc) {
      document = {
        documentId: v.documentId,
        visible: false,
        title: null,
        versionNumber: null,
        extractionStatus: null,
        pageCount: null,
        page: v.page,
        pageText: null,
        highlight: null,
        truncatedStart: false,
        truncatedEnd: false,
      };
    } else {
      const versionId = v.documentVersionId ?? doc.currentVersionId;
      const [version] = versionId
        ? await db
            .select({
              versionNumber: documentVersions.versionNumber,
              extractionStatus: documentVersions.extractionStatus,
              extractedText: documentVersions.extractedText,
              pageOffsets: documentVersions.pageOffsets,
              pageCount: documentVersions.pageCount,
            })
            .from(documentVersions)
            .where(
              and(
                eq(documentVersions.id, versionId),
                eq(documentVersions.documentId, doc.id),
                eq(documentVersions.organizationId, ctx.organizationId),
              ),
            )
        : [];
      let page = v.page;
      let pageText: string | null = null;
      let highlight: { start: number; end: number } | null = null;
      const text = version?.extractedText ?? null;
      if (text) {
        const offsets = version?.pageOffsets ?? null;
        if (page === null && v.excerpt) {
          const found = findExcerpt(text, v.excerpt);
          if (found && offsets && offsets.length > 0) {
            let p = 1;
            for (let i = 0; i < offsets.length; i++) if (offsets[i] <= found.start) p = i + 1;
            page = p;
          } else if (found) {
            page = 1;
          }
        }
        pageText = slicePageText(text, offsets, page ?? 1);
        if (pageText !== null) highlight = findExcerpt(pageText, v.excerpt);
      }
      const windowed = pageText !== null ? windowAround(pageText, highlight) : null;
      document = {
        documentId: doc.id,
        visible: true,
        title: doc.title,
        versionNumber: version?.versionNumber ?? null,
        extractionStatus: version?.extractionStatus ?? null,
        pageCount: version?.pageCount ?? (version?.pageOffsets ? version.pageOffsets.length : null),
        page,
        pageText: windowed?.text ?? null,
        highlight: windowed?.highlight ?? null,
        truncatedStart: windowed?.truncatedStart ?? false,
        truncatedEnd: windowed?.truncatedEnd ?? false,
      };
    }
  }

  const threshold = settings.contingency.confidenceThreshold;
  return {
    threshold,
    currentOfficial: official ?? null,
    document,
    valuation: {
      id: v.id,
      processId: v.processId,
      processNumber: row.processNumber,
      processTitle: row.processTitle,
      kind: v.kind,
      amountCents: v.amountCents,
      baseDate: v.baseDate,
      instance: v.instance,
      source: v.source,
      confidence: v.confidence,
      bulkEligible: isBulkEligible(v, threshold),
      isEstimate: v.isEstimate,
      reason: v.reason,
      documentTitle: document?.visible ? document.title : null,
      page: v.page,
      createdByName: row.createdByName,
      createdAt: v.createdAt,
      currentOfficialCents: official?.amountCents ?? null,
      correctionIndex: v.correctionIndex,
      excerpt: document && !document.visible ? null : v.excerpt,
      status: v.status,
      reviewNote: v.reviewNote,
    },
  };
}
