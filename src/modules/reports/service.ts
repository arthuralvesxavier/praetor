/**
 * Relatórios da carteira (RF-16..RF-18): carteira por empresa/unidade,
 * exposição com comparação mensal, provisão por competência fechada, carta de
 * auditoria, movimentação do período e carteira por responsável.
 *
 * Rules:
 *  - `report:read` on every entry point; row visibility always applies
 *    (`processWhere`, `valuationWhere`, visible process ids for snapshot items
 *    and audit entries). Organization-wide totals only exist for roles with
 *    organization-wide scope — everyone else sees "totais dos processos visíveis".
 *  - Current positions come from `getPortfolioExposure` (contingency module);
 *    money math from `@/domain/contingency`. Closed competências are read from
 *    `portfolio_snapshot_items` and never recomputed (RN-10).
 *  - RN-02 / RN-03 / RN-07: see ./types.ts.
 *  - Exports are audited (`report.export`) with type, format, filters and row
 *    count only — never report content.
 */
import { and, asc, count, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { emptyBucket, percentToBp, periodReferenceDate, previousPeriod, type BucketItem } from "@/domain/contingency";
import {
  CLOSURE_REASON_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  VALUATION_KIND_LABELS,
  VALUATION_SOURCE_LABELS,
  type ClosureReason,
  type LossProbability,
  type ProcessInstance,
  type ProcessPhase,
  type ProcessStatus,
  type SnapshotStatus,
} from "@/domain/enums";
import { addDaysISO, formatDate, formatMonthYear, toISODate, todayISO } from "@/lib/format";
import { hasOrganizationWideScope, processWhere, seesConfidential, valuationWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  auditLogs,
  companies,
  lawFirms,
  legalProcesses,
  organizations,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processValuations,
  units,
  users,
} from "@/server/db/schema";
import { ValidationError } from "@/server/lib/errors";
import { recordAudit } from "@/server/services/audit";
import { getPortfolioExposure, type PortfolioExposureRow } from "@/modules/contingency/service";
import { sheetToCsv, type ReportExport } from "./csv";
import { buildReportExport } from "./export-builders";
import {
  addSnapshotPosition,
  BucketGroups,
  bucketHasEstimates,
  cityGroup,
  cnjKey,
  courtGroup,
  NONE_KEY,
  totalRow,
  type SnapshotPosition,
} from "./grouping";
import { reportFiltersSchema } from "./schemas";
import {
  CLASSIFICATION_KEYS,
  CLASSIFICATION_LABELS,
  EXPOSURE_DIMENSION_LABELS,
  EXPOSURE_DIMENSIONS,
  REPORT_TYPE_LABELS,
  type AuditLetterReport,
  type AuditLetterRow,
  type BucketRow,
  type ClassificationKey,
  type ExportFormat,
  type ExposureDimension,
  type ExposureReport,
  type ExposureRow,
  type MovementEvent,
  type MovementReport,
  type PortfolioReport,
  type PreviousPosition,
  type ProvisionAmounts,
  type ProvisionClassRow,
  type ProvisionItem,
  type ProvisionMovementKind,
  type ProvisionReport,
  type ReportContext,
  type ReportData,
  type ReportFilterOptions,
  type ReportFilters,
  type ReportScope,
  type ReportType,
  type ResponsibleRow,
  type ResponsiblesReport,
  type SnapshotRef,
} from "./types";

/** Safety limit of movement events per query (the screen paginates; exports carry everything up to it). */
export const MAX_MOVEMENT_EVENTS = 10_000;

/** Fixed offset of America/Sao_Paulo (no daylight saving time since 2019). */
const SAO_PAULO_OFFSET = "-03:00";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFilters(filters: ReportFilters): ReportFilters {
  const parsed = reportFiltersSchema.safeParse(filters ?? {});
  if (!parsed.success) {
    throw new ValidationError(
      "Verifique os filtros do relatório.",
      z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
    );
  }
  return parsed.data;
}

/** Who the numbers represent. */
export function reportScope(ctx: AuthContext): ReportScope {
  if (seesConfidential(ctx)) {
    return {
      orgWide: true,
      includesConfidential: true,
      label: "Carteira completa da organização, incluindo processos sigilosos.",
      totalLabel: "Total da organização",
    };
  }
  if (hasOrganizationWideScope(ctx)) {
    return {
      orgWide: true,
      includesConfidential: false,
      label: "Carteira da organização, exceto processos sigilosos (não visíveis para o seu perfil).",
      totalLabel: "Total da organização (exceto sigilosos)",
    };
  }
  return {
    orgWide: false,
    includesConfidential: false,
    label:
      "Somente os processos visíveis para o seu perfil (da sua unidade, sem unidade ou sob sua responsabilidade). Os totais não representam a organização inteira.",
    totalLabel: "Total dos processos visíveis para você",
  };
}

async function organizationName(ctx: AuthContext): Promise<string> {
  const [org] = await getDb()
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId));
  return org?.name ?? "Organização";
}

async function companyNames(ctx: AuthContext): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.organizationId, ctx.organizationId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function unitNames(ctx: AuthContext): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({ id: units.id, name: units.name })
    .from(units)
    .where(eq(units.organizationId, ctx.organizationId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Common header of every report. Tenant check of the filter ids: a company or
 * unit of another organization is rejected (never silently ignored).
 */
async function reportContext(
  ctx: AuthContext,
  f: ReportFilters,
  extra: string[] = [],
): Promise<ReportContext & { companies: Map<string, string>; units: Map<string, string> }> {
  const [orgName, companyMap, unitMap] = await Promise.all([organizationName(ctx), companyNames(ctx), unitNames(ctx)]);
  const parts: string[] = [];
  if (f.companyId) {
    const name = companyMap.get(f.companyId);
    if (!name) throw new ValidationError("Empresa inválida.", { companyId: ["Selecione uma empresa válida."] });
    parts.push(`Empresa: ${name}`);
  }
  if (f.unitId) {
    const name = unitMap.get(f.unitId);
    if (!name) throw new ValidationError("Unidade inválida.", { unitId: ["Selecione uma unidade válida."] });
    parts.push(`Unidade: ${name}`);
  }
  parts.push(...extra);
  return {
    scope: reportScope(ctx),
    generatedAt: new Date(),
    organizationName: orgName,
    filterSummary: parts.length > 0 ? parts.join(" · ") : "Sem filtros (todas as empresas e unidades)",
    companies: companyMap,
    units: unitMap,
  };
}

function stripMaps<T extends { companies: unknown; units: unknown }>(c: T): Omit<T, "companies" | "units"> {
  const { companies: _c, units: _u, ...rest } = c;
  void _c;
  void _u;
  return rest;
}

function bucketItem(r: PortfolioExposureRow): BucketItem {
  return {
    liquidatedCents: r.liquidatedCents,
    linkedGuaranteesCents: r.guaranteesCents,
    claimCents: r.claimCents,
    riskPercentageBp: r.percentageBp,
  };
}

function classificationOrder(a: BucketRow, b: BucketRow): number {
  return CLASSIFICATION_KEYS.indexOf(a.key as ClassificationKey) - CLASSIFICATION_KEYS.indexOf(b.key as ClassificationKey);
}

/** Groups without a key ("Sem empresa", "Sem unidade"...) go last. */
function noneLast(a: BucketRow, b: BucketRow): number {
  if (a.key === NONE_KEY && b.key !== NONE_KEY) return 1;
  if (b.key === NONE_KEY && a.key !== NONE_KEY) return -1;
  return b.processCount - a.processCount || a.label.localeCompare(b.label, "pt-BR");
}

function currentPeriod(): string {
  return todayISO().slice(0, 7);
}

function periodLabel(period: string): string {
  return formatMonthYear(`${period}-01`);
}

type SnapshotRow = {
  id: string;
  period: string;
  referenceDate: string;
  status: SnapshotStatus;
  closedAt: Date | null;
};

async function listSnapshots(ctx: AuthContext, status?: SnapshotStatus): Promise<SnapshotRow[]> {
  return getDb()
    .select({
      id: portfolioSnapshots.id,
      period: portfolioSnapshots.period,
      referenceDate: portfolioSnapshots.referenceDate,
      status: portfolioSnapshots.status,
      closedAt: portfolioSnapshots.closedAt,
    })
    .from(portfolioSnapshots)
    .where(
      and(
        eq(portfolioSnapshots.organizationId, ctx.organizationId),
        status ? eq(portfolioSnapshots.status, status) : undefined,
      ),
    )
    .orderBy(desc(portfolioSnapshots.period));
}

function snapshotRef(s: SnapshotRow): SnapshotRef {
  return { id: s.id, period: s.period, referenceDate: s.referenceDate, status: s.status };
}

type SnapshotItem = SnapshotPosition & {
  processId: string;
  number: string;
  title: string;
  courtDivision: string | null;
  companyId: string | null;
  unitId: string | null;
  court: string | null;
  instance: ProcessInstance | null;
  phase: ProcessPhase | null;
  city: string | null;
  classification: LossProbability | null;
  percentageBp: number | null;
};

/** Items of a snapshot whose process is visible to ctx (current visibility), with the company/unit filters. */
async function loadSnapshotItems(ctx: AuthContext, snapshotId: string, f: ReportFilters): Promise<SnapshotItem[]> {
  const i = portfolioSnapshotItems;
  return getDb()
    .select({
      processId: i.processId,
      number: i.number,
      title: legalProcesses.title,
      courtDivision: legalProcesses.courtDivision,
      companyId: i.companyId,
      unitId: i.unitId,
      court: i.court,
      instance: i.instance,
      phase: i.phase,
      city: i.city,
      classification: i.classification,
      percentageBp: i.percentageBp,
      claimAmountCents: i.claimAmountCents,
      liquidatedAmountCents: i.liquidatedAmountCents,
      guaranteesCents: i.guaranteesCents,
      exposureCents: i.exposureCents,
      exposureIsEstimate: i.exposureIsEstimate,
      provisionCents: i.provisionCents,
      provisionIsEstimate: i.provisionIsEstimate,
    })
    .from(i)
    .innerJoin(legalProcesses, and(eq(legalProcesses.id, i.processId), processWhere(ctx)))
    .where(
      and(
        eq(i.snapshotId, snapshotId),
        eq(i.organizationId, ctx.organizationId),
        f.companyId ? eq(i.companyId, f.companyId) : undefined,
        f.unitId ? eq(i.unitId, f.unitId) : undefined,
      ),
    )
    .orderBy(asc(i.number));
}

function exposureFilters(f: ReportFilters) {
  return { companyId: f.companyId, unitId: f.unitId };
}

// ---------------------------------------------------------------------------
// Carteira por empresa e unidade
// ---------------------------------------------------------------------------

export async function getPortfolioReport(ctx: AuthContext, filters: ReportFilters = {}): Promise<PortfolioReport> {
  assertCan(ctx, "report:read");
  const f = parseFilters(filters);
  const base = await reportContext(ctx, f, ["Carteira ativa"]);
  const { rows } = await getPortfolioExposure(ctx, exposureFilters(f));

  const byCompany = new BucketGroups();
  const byUnit = new BucketGroups();
  const byClass = new BucketGroups();
  for (const r of rows) {
    const item = bucketItem(r);
    byCompany.add(
      r.companyId ?? NONE_KEY,
      r.companyId ? (base.companies.get(r.companyId) ?? "Empresa não identificada") : "Sem empresa informada",
      r.number,
      item,
    );
    byUnit.add(
      r.unitId ?? NONE_KEY,
      r.unitId ? (base.units.get(r.unitId) ?? "Unidade não identificada") : "Sem unidade",
      r.number,
      item,
    );
    const cls: ClassificationKey = r.classification ?? "unclassified";
    byClass.add(cls, CLASSIFICATION_LABELS[cls], r.number, item);
  }
  const totals = totalRow(
    "total",
    base.scope.totalLabel,
    rows.map((r) => ({ number: r.number, item: bucketItem(r) })),
  );

  return {
    ...stripMaps(base),
    type: "carteira",
    byCompany: byCompany.rows(noneLast),
    byUnit: byUnit.rows(noneLast),
    byClassification: byClass.rows(classificationOrder),
    totals,
    hasEstimates: bucketHasEstimates(totals.bucket),
  };
}

// ---------------------------------------------------------------------------
// Exposição por tribunal, cidade, fase e instância (com comparação mensal)
// ---------------------------------------------------------------------------

type Grouping = { key: string; label: string };

function dimensionGroup(
  dim: ExposureDimension,
  v: { court: string | null; city: string | null; phase: ProcessPhase | null; instance: ProcessInstance | null },
): Grouping {
  switch (dim) {
    case "court":
      return courtGroup(v.court);
    case "city":
      return cityGroup(v.city);
    case "phase":
      return v.phase ? { key: v.phase, label: PROCESS_PHASE_LABELS[v.phase] } : { key: NONE_KEY, label: "Fase não informada" };
    case "instance":
      return v.instance
        ? { key: v.instance, label: PROCESS_INSTANCE_LABELS[v.instance] }
        : { key: NONE_KEY, label: "Instância não informada" };
  }
}

function previousFromItems(items: SnapshotItem[]): PreviousPosition {
  const b = emptyBucket();
  const numbers = new Set<string>();
  for (const it of items) {
    addSnapshotPosition(b, it);
    numbers.add(cnjKey(it.number));
  }
  return {
    processCount: numbers.size,
    exposureCents: b.exposureCents,
    exposureEstimateCents: b.exposureEstimateCents,
    exposureUnknown: b.exposureUnknown,
  };
}

export async function getExposureReport(ctx: AuthContext, filters: ReportFilters = {}): Promise<ExposureReport> {
  assertCan(ctx, "report:read");
  const f = parseFilters(filters);
  const comparisonPeriod = f.period ?? previousPeriod(currentPeriod());
  const base = await reportContext(ctx, f, ["Carteira ativa", `Comparação: ${periodLabel(comparisonPeriod)}`]);

  const [{ rows }, snapshots] = await Promise.all([getPortfolioExposure(ctx, exposureFilters(f)), listSnapshots(ctx)]);
  const snap = snapshots.find((s) => s.period === comparisonPeriod) ?? null;
  const prevItems = snap ? await loadSnapshotItems(ctx, snap.id, f) : [];

  let comparisonNote: string | null = null;
  if (!snap) {
    comparisonNote = `Não há fechamento mensal registrado para ${periodLabel(comparisonPeriod)}: a comparação não está disponível. Os valores abaixo são a posição atual.`;
  } else if (snap.status === "preview") {
    comparisonNote = `A comparação usa a PRÉVIA de ${periodLabel(comparisonPeriod)} (competência ainda não fechada: os valores podem mudar até o fechamento).`;
  }

  const dimensions = EXPOSURE_DIMENSIONS.map((dim) => {
    const groups = new BucketGroups();
    for (const r of rows) {
      const g = dimensionGroup(dim, r);
      groups.add(g.key, g.label, r.number, bucketItem(r));
    }
    const prevByKey = new Map<string, { label: string; items: SnapshotItem[] }>();
    for (const it of prevItems) {
      const g = dimensionGroup(dim, it);
      const entry = prevByKey.get(g.key) ?? { label: g.label, items: [] };
      entry.items.push(it);
      prevByKey.set(g.key, entry);
    }
    const out: ExposureRow[] = groups.rows(noneLast).map((row) => ({
      ...row,
      previous: snap ? previousFromItems(prevByKey.get(row.key)?.items ?? []) : null,
    }));
    // Groups that only existed in the previous period (e.g. a court with no active process now).
    for (const [key, entry] of prevByKey) {
      if (groups.has(key)) continue;
      out.push({
        key,
        label: entry.label,
        processCount: 0,
        bucket: emptyBucket(),
        previous: previousFromItems(entry.items),
      });
    }
    return { key: dim, label: EXPOSURE_DIMENSION_LABELS[dim], rows: out };
  });

  const total = totalRow(
    "total",
    base.scope.totalLabel,
    rows.map((r) => ({ number: r.number, item: bucketItem(r) })),
  );

  return {
    ...stripMaps(base),
    type: "exposicao",
    comparison: snap ? snapshotRef(snap) : null,
    comparisonNote,
    dimensions,
    totals: { ...total, previous: snap ? previousFromItems(prevItems) : null },
    hasEstimates: bucketHasEstimates(total.bucket),
  };
}

// ---------------------------------------------------------------------------
// Provisão por competência (somente competências FECHADAS)
// ---------------------------------------------------------------------------

function provisionAmounts(p: { provisionCents: number | null; provisionIsEstimate: boolean }): ProvisionAmounts {
  const v = p.provisionCents ?? 0;
  return p.provisionIsEstimate ? { provisionCents: 0, provisionEstimateCents: v } : { provisionCents: v, provisionEstimateCents: 0 };
}

function addAmounts(a: ProvisionAmounts, b: ProvisionAmounts, sign = 1): ProvisionAmounts {
  return {
    provisionCents: a.provisionCents + sign * b.provisionCents,
    provisionEstimateCents: a.provisionEstimateCents + sign * b.provisionEstimateCents,
  };
}

const ZERO: ProvisionAmounts = { provisionCents: 0, provisionEstimateCents: 0 };

function sameProvision(a: SnapshotItem, b: SnapshotItem): boolean {
  return (
    a.provisionCents === b.provisionCents &&
    a.provisionIsEstimate === b.provisionIsEstimate &&
    a.classification === b.classification &&
    a.percentageBp === b.percentageBp
  );
}

export async function getProvisionReport(ctx: AuthContext, filters: ReportFilters = {}): Promise<ProvisionReport> {
  assertCan(ctx, "report:read");
  const f = parseFilters(filters);
  const closed = await listSnapshots(ctx, "closed");
  const target = f.period ? closed.find((s) => s.period === f.period) : closed[0];
  const extra = target ? [`Competência: ${periodLabel(target.period)}`] : [];
  const base = await reportContext(ctx, f, extra);
  const closedPeriods = closed.map((s) => s.period);

  const emptyTotals: ProvisionClassRow = {
    key: "unclassified",
    label: base.scope.totalLabel,
    percentageBp: null,
    processCount: 0,
    current: ZERO,
    previous: null,
  };
  if (!target) {
    return {
      ...stripMaps(base),
      type: "provisao",
      closedPeriods,
      snapshot: null,
      previous: null,
      byClassification: [],
      totals: emptyTotals,
      movement: null,
      items: [],
      hasEstimates: false,
    };
  }

  const [meta] = await getDb()
    .select({ params: portfolioSnapshots.params, closedByName: users.name })
    .from(portfolioSnapshots)
    .leftJoin(users, and(eq(users.id, portfolioSnapshots.closedById), eq(users.organizationId, ctx.organizationId)))
    .where(and(eq(portfolioSnapshots.id, target.id), eq(portfolioSnapshots.organizationId, ctx.organizationId)));

  // Previous CLOSED competência (the latest one before the target).
  const prevSnap = closed.find((s) => s.period < target.period) ?? null;
  const [items, prevItems] = await Promise.all([
    loadSnapshotItems(ctx, target.id, f),
    prevSnap ? loadSnapshotItems(ctx, prevSnap.id, f) : Promise.resolve([] as SnapshotItem[]),
  ]);

  const pct = meta?.params?.riskPercentages;
  const classPct = (k: ClassificationKey): number | null =>
    k === "unclassified" || !pct ? null : percentToBp(pct[k as LossProbability]);

  const byClassification: ProvisionClassRow[] = CLASSIFICATION_KEYS.map((k) => {
    const cur = items.filter((i) => (i.classification ?? "unclassified") === k);
    const prev = prevItems.filter((i) => (i.classification ?? "unclassified") === k);
    return {
      key: k,
      label: CLASSIFICATION_LABELS[k],
      percentageBp: classPct(k),
      processCount: new Set(cur.map((i) => cnjKey(i.number))).size,
      current: cur.reduce((acc, i) => addAmounts(acc, provisionAmounts(i)), ZERO),
      previous: prevSnap
        ? {
            processCount: new Set(prev.map((i) => cnjKey(i.number))).size,
            ...prev.reduce((acc, i) => addAmounts(acc, provisionAmounts(i)), ZERO),
          }
        : null,
    };
  });

  const totals: ProvisionClassRow = {
    key: "unclassified",
    label: base.scope.totalLabel,
    percentageBp: null,
    processCount: new Set(items.map((i) => cnjKey(i.number))).size,
    current: items.reduce((acc, i) => addAmounts(acc, provisionAmounts(i)), ZERO),
    previous: prevSnap
      ? {
          processCount: new Set(prevItems.map((i) => cnjKey(i.number))).size,
          ...prevItems.reduce((acc, i) => addAmounts(acc, provisionAmounts(i)), ZERO),
        }
      : null,
  };

  // Movement of the period, process by process.
  const prevById = new Map(prevItems.map((i) => [i.processId, i]));
  const curIds = new Set(items.map((i) => i.processId));
  const movementTotals = new Map<ProvisionMovementKind, { count: number; amounts: ProvisionAmounts }>();
  const bump = (kind: ProvisionMovementKind, delta: ProvisionAmounts) => {
    const m = movementTotals.get(kind) ?? { count: 0, amounts: ZERO };
    movementTotals.set(kind, { count: m.count + 1, amounts: addAmounts(m.amounts, delta) });
  };

  const detail: ProvisionItem[] = items.map((i) => {
    const prev = prevById.get(i.processId);
    let movement: ProvisionMovementKind | null = null;
    if (prevSnap) {
      if (!prev) {
        movement = "entered";
        bump(movement, provisionAmounts(i));
      } else if (!sameProvision(i, prev)) {
        movement = "changed";
        bump(movement, addAmounts(provisionAmounts(i), provisionAmounts(prev), -1));
      } else {
        movement = "unchanged";
        bump(movement, ZERO);
      }
    }
    return {
      processId: i.processId,
      number: i.number,
      classification: i.classification,
      percentageBp: i.percentageBp,
      claimCents: i.claimAmountCents,
      liquidatedCents: i.liquidatedAmountCents,
      guaranteesCents: i.guaranteesCents,
      provisionCents: i.provisionCents,
      provisionIsEstimate: i.provisionIsEstimate,
      previousProvisionCents: prev ? prev.provisionCents : null,
      previousIsEstimate: prev ? prev.provisionIsEstimate : false,
      movement,
    };
  });
  for (const prev of prevItems) {
    if (curIds.has(prev.processId)) continue;
    bump("left", addAmounts(ZERO, provisionAmounts(prev), -1));
    detail.push({
      processId: prev.processId,
      number: prev.number,
      classification: null,
      percentageBp: null,
      claimCents: null,
      liquidatedCents: null,
      guaranteesCents: 0,
      provisionCents: null,
      provisionIsEstimate: false,
      previousProvisionCents: prev.provisionCents,
      previousIsEstimate: prev.provisionIsEstimate,
      movement: "left",
    });
  }

  const movement = prevSnap
    ? {
        opening: totals.previous ? { provisionCents: totals.previous.provisionCents, provisionEstimateCents: totals.previous.provisionEstimateCents } : ZERO,
        rows: (["entered", "left", "changed", "unchanged"] as const).map((kind) => ({
          kind,
          processCount: movementTotals.get(kind)?.count ?? 0,
          ...(movementTotals.get(kind)?.amounts ?? ZERO),
        })),
        closing: totals.current,
      }
    : null;

  return {
    ...stripMaps(base),
    type: "provisao",
    closedPeriods,
    snapshot: meta
      ? { ...snapshotRef(target), closedAt: target.closedAt, closedByName: meta.closedByName ?? null, params: meta.params }
      : null,
    previous: prevSnap ? snapshotRef(prevSnap) : null,
    byClassification,
    totals,
    movement,
    items: detail,
    hasEstimates: items.some((i) => i.provisionIsEstimate || i.exposureIsEstimate),
  };
}

// ---------------------------------------------------------------------------
// Carta de auditoria (RF-18)
// ---------------------------------------------------------------------------

function rowCaveats(r: {
  claimCents: number | null;
  liquidatedCents: number | null;
  classification: LossProbability | null;
  exposureCents: number | null;
  exposureIsEstimate: boolean;
  provisionCents: number | null;
  provisionIsEstimate: boolean;
  needsVerification?: boolean;
}): string[] {
  const out: string[] = [];
  if (r.classification === null) out.push("Sem classificação de risco vigente: provisão não calculada.");
  if (r.provisionIsEstimate) out.push("Provisão estimada sobre o valor da causa (sem valor liquidado) — RN-07.");
  else if (r.exposureIsEstimate) out.push("Exposição estimada (valor da causa × percentual de risco) — RN-07.");
  if (r.liquidatedCents === null) out.push("Valor liquidado não apurado.");
  if (r.claimCents === null) out.push("Valor da causa não informado.");
  if (r.exposureCents === null && r.classification !== null && r.liquidatedCents === null && r.claimCents === null) {
    out.push("Exposição não calculável sem valores.");
  }
  if (r.needsVerification) out.push("Cadastro marcado para conferência interna.");
  return out;
}

export async function getAuditLetterReport(ctx: AuthContext, filters: ReportFilters = {}): Promise<AuditLetterReport> {
  assertCan(ctx, "report:read");
  const f = parseFilters(filters);
  const closed = await listSnapshots(ctx, "closed");
  const closedPeriods = closed.map((s) => s.period);
  const snap = f.period ? closed.find((s) => s.period === f.period) : undefined;
  if (f.period && !snap) {
    throw new ValidationError(
      `A competência ${periodLabel(f.period)} não está fechada. A carta de auditoria usa uma competência fechada (imutável) ou a posição atual.`,
      { period: ["Selecione uma competência fechada ou a posição atual."] },
    );
  }
  const baseDate = snap ? snap.referenceDate : todayISO();
  const base = await reportContext(ctx, f, [`Data-base: ${formatDate(baseDate)}`]);

  let rows: AuditLetterRow[];
  if (snap) {
    const items = await loadSnapshotItems(ctx, snap.id, f);
    rows = items.map((i) => {
      const r = {
        processId: i.processId,
        number: i.number,
        title: i.title,
        court: i.court,
        courtDivision: i.courtDivision,
        instance: i.instance,
        phase: i.phase,
        classification: i.classification,
        percentageBp: i.percentageBp,
        claimCents: i.claimAmountCents,
        liquidatedCents: i.liquidatedAmountCents,
        guaranteesCents: i.guaranteesCents,
        exposureCents: i.exposureCents,
        exposureIsEstimate: i.exposureIsEstimate,
        provisionCents: i.provisionCents,
        provisionIsEstimate: i.provisionIsEstimate,
      };
      return { ...r, caveats: rowCaveats(r) };
    });
  } else {
    const { rows: current } = await getPortfolioExposure(ctx, exposureFilters(f));
    const meta = await getDb()
      .select({
        id: legalProcesses.id,
        courtDivision: legalProcesses.courtDivision,
        needsVerification: legalProcesses.needsVerification,
      })
      .from(legalProcesses)
      .where(
        and(
          processWhere(ctx),
          f.companyId ? eq(legalProcesses.companyId, f.companyId) : undefined,
          f.unitId ? eq(legalProcesses.unitId, f.unitId) : undefined,
        ),
      );
    const metaById = new Map(meta.map((m) => [m.id, m]));
    rows = current
      .map((p) => {
        const m = metaById.get(p.processId);
        const r = {
          processId: p.processId,
          number: p.number,
          title: p.title,
          court: p.court,
          courtDivision: m?.courtDivision ?? null,
          instance: p.instance,
          phase: p.phase,
          classification: p.classification,
          percentageBp: p.percentageBp,
          claimCents: p.claimCents,
          liquidatedCents: p.liquidatedCents,
          guaranteesCents: p.guaranteesCents,
          exposureCents: p.exposure.exposureCents,
          exposureIsEstimate: p.exposure.isEstimate,
          provisionCents: p.provision.provisionCents,
          provisionIsEstimate: p.provision.isEstimate,
        };
        return { ...r, caveats: rowCaveats({ ...r, needsVerification: m?.needsVerification ?? false }) };
      })
      .sort((a, b) => a.number.localeCompare(b.number));
  }

  const byClassification = Object.fromEntries(CLASSIFICATION_KEYS.map((k) => [k, 0])) as Record<ClassificationKey, number>;
  const totals = {
    processCount: new Set(rows.map((r) => cnjKey(r.number))).size,
    claimCents: 0,
    claimUnknown: 0,
    liquidatedCents: 0,
    liquidatedUnknown: 0,
    provisionCents: 0,
    provisionEstimateCents: 0,
    unclassified: 0,
    byClassification,
  };
  for (const r of rows) {
    if (r.claimCents === null) totals.claimUnknown += 1;
    else totals.claimCents += r.claimCents;
    if (r.liquidatedCents === null) totals.liquidatedUnknown += 1;
    else totals.liquidatedCents += r.liquidatedCents;
    if (r.provisionCents !== null) {
      if (r.provisionIsEstimate) totals.provisionEstimateCents += r.provisionCents;
      else totals.provisionCents += r.provisionCents;
    }
    const k: ClassificationKey = r.classification ?? "unclassified";
    byClassification[k] += 1;
    if (!r.classification) totals.unclassified += 1;
  }
  const hasEstimates = rows.some((r) => r.provisionIsEstimate || r.exposureIsEstimate);

  const generalCaveats = [
    "Relação gerada automaticamente a partir dos registros do sistema. Não constitui parecer jurídico: a classificação de risco e os percentuais são os registrados e aprovados pelos responsáveis no sistema.",
    snap
      ? `Posições lidas da competência ${periodLabel(snap.period)}, fechada${snap.closedAt ? ` em ${formatDate(snap.closedAt)}` : ""} (registro imutável).`
      : "Posição atual da carteira na data de emissão; não corresponde a uma competência fechada e pode mudar.",
    "Valor da causa e valor liquidado são grandezas distintas e não são somados (RN-02).",
  ];
  if (totals.liquidatedUnknown > 0) {
    generalCaveats.push(
      `${totals.liquidatedUnknown} processo(s) sem valor liquidado apurado: “não apurado” não equivale a zero (RN-03).`,
    );
  }
  if (hasEstimates) {
    generalCaveats.push(
      "Há exposições ou provisões ESTIMADAS a partir do valor da causa (sem valor liquidado): estão sinalizadas e devem ser lidas com ressalva (RN-07).",
    );
  }
  if (totals.unclassified > 0) {
    generalCaveats.push(`${totals.unclassified} processo(s) sem classificação de risco vigente: provisão não calculada.`);
  }
  if (!base.scope.orgWide) generalCaveats.push("Relação restrita aos processos visíveis para o emissor; não representa a carteira inteira.");
  else if (!base.scope.includesConfidential) generalCaveats.push("Processos sigilosos não constam desta relação (perfil do emissor).");

  return {
    ...stripMaps(base),
    type: "auditoria",
    baseDate,
    source: snap ? "snapshot" : "current",
    snapshot: snap ? { ...snapshotRef(snap), closedAt: snap.closedAt } : null,
    closedPeriods,
    rows,
    totals,
    generalCaveats,
    hasEstimates,
  };
}

// ---------------------------------------------------------------------------
// Movimentação do período
// ---------------------------------------------------------------------------

function periodBounds(f: ReportFilters): { from: string; to: string } {
  const today = todayISO();
  const from = f.from ?? (f.period ? `${f.period}-01` : `${today.slice(0, 7)}-01`);
  const to = f.to ?? (f.period ? periodReferenceDate(f.period) : today);
  if (from > to) {
    throw new ValidationError("A data inicial deve ser anterior à data final.", { from: ["Ajuste o período."] });
  }
  return { from, to };
}

function dayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00${SAO_PAULO_OFFSET}`);
}

const MOVEMENT_KIND_ORDER: Record<MovementEvent["kind"], number> = {
  closed: 0,
  added: 1,
  value_change: 2,
  phase_change: 3,
  status_change: 4,
};

type AuditChange = { from: unknown; to: unknown };

function phaseLabel(v: unknown): string {
  return typeof v === "string" && v in PROCESS_PHASE_LABELS ? PROCESS_PHASE_LABELS[v as ProcessPhase] : "não informada";
}

function statusLabel(v: unknown): string {
  return typeof v === "string" && v in PROCESS_STATUS_LABELS ? PROCESS_STATUS_LABELS[v as ProcessStatus] : "não informada";
}

export async function getMovementReport(ctx: AuthContext, filters: ReportFilters = {}): Promise<MovementReport> {
  assertCan(ctx, "report:read");
  const f = parseFilters(filters);
  const { from, to } = periodBounds(f);
  const base = await reportContext(ctx, f, [`Período: ${formatDate(from)} a ${formatDate(to)}`]);
  const db = getDb();
  const start = dayStart(from);
  const end = dayStart(addDaysISO(to, 1));
  const lp = legalProcesses;
  const processFilter = and(
    processWhere(ctx),
    f.companyId ? eq(lp.companyId, f.companyId) : undefined,
    f.unitId ? eq(lp.unitId, f.unitId) : undefined,
  );
  const limit = MAX_MOVEMENT_EVENTS + 1;

  const prev = alias(processValuations, "report_prev_valuation");
  const valuationMoment = sql<Date>`coalesce(${processValuations.reviewedAt}, ${processValuations.createdAt})`;

  const [added, closedRows, valuations, [pending], audits] = await Promise.all([
    db
      .select({
        id: lp.id,
        number: lp.number,
        title: lp.title,
        createdAt: lp.createdAt,
        filedAt: lp.filedAt,
        dataOrigin: lp.dataOrigin,
      })
      .from(lp)
      .where(and(processFilter, gte(lp.createdAt, start), lt(lp.createdAt, end)))
      .orderBy(desc(lp.createdAt))
      .limit(limit),
    db
      .select({ id: lp.id, number: lp.number, title: lp.title, closedAt: lp.closedAt, closureReason: lp.closureReason })
      .from(lp)
      .where(and(processFilter, sql`${lp.closedAt} between ${from} and ${to}`))
      .orderBy(desc(lp.closedAt))
      .limit(limit),
    db
      .select({
        processId: lp.id,
        number: lp.number,
        title: lp.title,
        kind: processValuations.kind,
        amountCents: processValuations.amountCents,
        source: processValuations.source,
        isEstimate: processValuations.isEstimate,
        moment: valuationMoment,
        previousCents: prev.amountCents,
      })
      .from(processValuations)
      .innerJoin(lp, and(eq(lp.id, processValuations.processId), processFilter))
      .leftJoin(prev, and(eq(prev.id, processValuations.supersedesId), eq(prev.organizationId, ctx.organizationId)))
      .where(
        and(
          valuationWhere(ctx),
          inArray(processValuations.status, ["official", "superseded"]),
          sql`${valuationMoment} >= ${start}`,
          sql`${valuationMoment} < ${end}`,
        ),
      )
      .orderBy(desc(valuationMoment))
      .limit(limit),
    db
      .select({ n: count() })
      .from(processValuations)
      .innerJoin(lp, and(eq(lp.id, processValuations.processId), processFilter))
      .where(
        and(
          valuationWhere(ctx),
          eq(processValuations.status, "proposed"),
          gte(processValuations.createdAt, start),
          lt(processValuations.createdAt, end),
        ),
      ),
    db
      .select({
        processId: lp.id,
        number: lp.number,
        title: lp.title,
        createdAt: auditLogs.createdAt,
        changes: auditLogs.changes,
      })
      .from(auditLogs)
      .innerJoin(lp, and(eq(lp.id, auditLogs.entityId), processFilter))
      .where(
        and(
          eq(auditLogs.organizationId, ctx.organizationId),
          eq(auditLogs.entityType, "legal_process"),
          ne(auditLogs.action, "legal_process.create"),
          gte(auditLogs.createdAt, start),
          lt(auditLogs.createdAt, end),
          sql`((${auditLogs.changes} -> 'phase' ->> 'from') is not null or (${auditLogs.changes} -> 'status' ->> 'from') is not null)`,
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit),
  ]);

  const events: MovementEvent[] = [];
  const blank = { closureReason: null, valuationKind: null, previousCents: null, newCents: null, isEstimate: false };

  for (const p of added) {
    events.push({
      ...blank,
      date: toISODate(p.createdAt),
      kind: "added",
      processId: p.id,
      number: p.number,
      title: p.title,
      detail: `${p.dataOrigin === "imported" ? "Cadastro por importação" : "Cadastro no sistema"}${p.filedAt ? ` · distribuído em ${formatDate(p.filedAt)}` : ""}`,
    });
  }
  const closedByReason = new Map<ClosureReason | "unknown", number>();
  for (const p of closedRows) {
    const reason = p.closureReason ?? "unknown";
    closedByReason.set(reason, (closedByReason.get(reason) ?? 0) + 1);
    events.push({
      ...blank,
      date: p.closedAt ?? from,
      kind: "closed",
      processId: p.id,
      number: p.number,
      title: p.title,
      detail: p.closureReason ? CLOSURE_REASON_LABELS[p.closureReason] : "Motivo de encerramento não informado",
      closureReason: p.closureReason,
    });
  }
  for (const v of valuations) {
    const moment = v.moment instanceof Date ? v.moment : new Date(v.moment);
    events.push({
      ...blank,
      date: toISODate(moment),
      kind: "value_change",
      processId: v.processId,
      number: v.number,
      title: v.title,
      detail: `${VALUATION_KIND_LABELS[v.kind]} · ${VALUATION_SOURCE_LABELS[v.source]}${v.previousCents === null ? " · primeiro valor oficial" : ""}`,
      valuationKind: v.kind,
      previousCents: v.previousCents,
      newCents: v.amountCents,
      isEstimate: v.isEstimate,
    });
  }
  let phaseChanges = 0;
  let statusChanges = 0;
  for (const a of audits) {
    const changes = (a.changes ?? {}) as Record<string, AuditChange | undefined>;
    const date = toISODate(a.createdAt);
    const phase = changes.phase;
    if (phase && phase.from !== null && phase.from !== undefined) {
      phaseChanges += 1;
      events.push({
        ...blank,
        date,
        kind: "phase_change",
        processId: a.processId,
        number: a.number,
        title: a.title,
        detail: `${phaseLabel(phase.from)} → ${phaseLabel(phase.to)}`,
      });
    }
    const status = changes.status;
    // Closures are listed from the closing date (with the reason) — not repeated here.
    if (status && status.from !== null && status.from !== undefined && status.to !== "closed" && status.to !== "archived") {
      statusChanges += 1;
      events.push({
        ...blank,
        date,
        kind: "status_change",
        processId: a.processId,
        number: a.number,
        title: a.title,
        detail: `${statusLabel(status.from)} → ${statusLabel(status.to)}`,
      });
    }
  }

  events.sort(
    (a, b) => b.date.localeCompare(a.date) || MOVEMENT_KIND_ORDER[a.kind] - MOVEMENT_KIND_ORDER[b.kind] || a.number.localeCompare(b.number),
  );
  const truncated =
    added.length > MAX_MOVEMENT_EVENTS ||
    closedRows.length > MAX_MOVEMENT_EVENTS ||
    valuations.length > MAX_MOVEMENT_EVENTS ||
    audits.length > MAX_MOVEMENT_EVENTS ||
    events.length > MAX_MOVEMENT_EVENTS;

  return {
    ...stripMaps(base),
    type: "movimentacao",
    from,
    to,
    summary: {
      added: added.length,
      closed: closedRows.length,
      closedByReason: [...closedByReason.entries()]
        .map(([reason, n]) => ({
          reason,
          label: reason === "unknown" ? "Motivo não informado" : CLOSURE_REASON_LABELS[reason],
          count: n,
        }))
        .sort((a, b) => b.count - a.count),
      valueChanges: valuations.length,
      phaseChanges,
      statusChanges,
    },
    events: events.slice(0, MAX_MOVEMENT_EVENTS),
    pendingProposedValuations: Number(pending?.n ?? 0),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Por responsável e escritório
// ---------------------------------------------------------------------------

function withUnclassified(rows: BucketRow[], unclassified: Map<string, number>): ResponsibleRow[] {
  return rows.map((r) => ({ ...r, unclassified: unclassified.get(r.key) ?? 0 }));
}

export async function getResponsiblesReport(ctx: AuthContext, filters: ReportFilters = {}): Promise<ResponsiblesReport> {
  assertCan(ctx, "report:read");
  const f = parseFilters(filters);
  const base = await reportContext(ctx, f, ["Carteira ativa"]);
  const db = getDb();
  const [{ rows }, meta, people, firms] = await Promise.all([
    getPortfolioExposure(ctx, exposureFilters(f)),
    db
      .select({ id: legalProcesses.id, responsibleId: legalProcesses.responsibleId, lawFirmId: legalProcesses.lawFirmId })
      .from(legalProcesses)
      .where(
        and(
          processWhere(ctx),
          f.companyId ? eq(legalProcesses.companyId, f.companyId) : undefined,
          f.unitId ? eq(legalProcesses.unitId, f.unitId) : undefined,
        ),
      ),
    db.select({ id: users.id, name: users.name }).from(users).where(eq(users.organizationId, ctx.organizationId)),
    db.select({ id: lawFirms.id, name: lawFirms.name }).from(lawFirms).where(eq(lawFirms.organizationId, ctx.organizationId)),
  ]);
  const metaById = new Map(meta.map((m) => [m.id, m]));
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const firmName = new Map(firms.map((p) => [p.id, p.name]));

  const lawyers = new BucketGroups();
  const lawFirmGroups = new BucketGroups();
  const unclassifiedLawyer = new Map<string, number>();
  const unclassifiedFirm = new Map<string, number>();
  let unclassifiedTotal = 0;
  for (const r of rows) {
    const m = metaById.get(r.processId);
    const item = bucketItem(r);
    const lawyerKey = m?.responsibleId ?? NONE_KEY;
    const firmKey = m?.lawFirmId ?? NONE_KEY;
    lawyers.add(
      lawyerKey,
      m?.responsibleId ? (personName.get(m.responsibleId) ?? "Usuário não identificado") : "Sem responsável definido",
      r.number,
      item,
    );
    lawFirmGroups.add(
      firmKey,
      m?.lawFirmId ? (firmName.get(m.lawFirmId) ?? "Escritório não identificado") : "Sem escritório externo (condução interna)",
      r.number,
      item,
    );
    if (!r.classification) {
      unclassifiedLawyer.set(lawyerKey, (unclassifiedLawyer.get(lawyerKey) ?? 0) + 1);
      unclassifiedFirm.set(firmKey, (unclassifiedFirm.get(firmKey) ?? 0) + 1);
      unclassifiedTotal += 1;
    }
  }
  const total = totalRow(
    "total",
    base.scope.totalLabel,
    rows.map((r) => ({ number: r.number, item: bucketItem(r) })),
  );

  return {
    ...stripMaps(base),
    type: "responsaveis",
    lawyers: withUnclassified(lawyers.rows(noneLast), unclassifiedLawyer),
    lawFirms: withUnclassified(lawFirmGroups.rows(noneLast), unclassifiedFirm),
    totals: { ...total, unclassified: unclassifiedTotal },
    hasEstimates: bucketHasEstimates(total.bucket),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher, filter options and export
// ---------------------------------------------------------------------------

export async function getReport(ctx: AuthContext, type: ReportType, filters: ReportFilters = {}): Promise<ReportData> {
  switch (type) {
    case "carteira":
      return getPortfolioReport(ctx, filters);
    case "exposicao":
      return getExposureReport(ctx, filters);
    case "provisao":
      return getProvisionReport(ctx, filters);
    case "auditoria":
      return getAuditLetterReport(ctx, filters);
    case "movimentacao":
      return getMovementReport(ctx, filters);
    case "responsaveis":
      return getResponsiblesReport(ctx, filters);
  }
}

export async function listReportFilterOptions(ctx: AuthContext): Promise<ReportFilterOptions> {
  assertCan(ctx, "report:read");
  const db = getDb();
  const [companyRows, unitRows, snapshots] = await Promise.all([
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.organizationId, ctx.organizationId), eq(companies.isActive, true)))
      .orderBy(asc(companies.name)),
    db
      .select({ id: units.id, name: units.name })
      .from(units)
      .where(and(eq(units.organizationId, ctx.organizationId), eq(units.isActive, true)))
      .orderBy(asc(units.name)),
    listSnapshots(ctx),
  ]);
  return {
    companies: companyRows,
    units: unitRows,
    snapshots: snapshots.map((s) => ({ period: s.period, status: s.status, referenceDate: s.referenceDate })),
  };
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export type ReportFile = { fileName: string; contentType: string; body: Uint8Array; rowCount: number };

/**
 * Builds the CSV/XLSX file of a report and records `report.export` in the
 * audit trail (type, format, filters and row count only).
 */
export async function exportReport(
  ctx: AuthContext,
  type: ReportType,
  filters: ReportFilters,
  format: ExportFormat,
): Promise<ReportFile> {
  assertCan(ctx, "report:read");
  const f = parseFilters(filters);
  const report = await getReport(ctx, type, f);
  const exp = buildReportExport(report);
  const main = exp.sheets[exp.csvSheet];
  const rowCount = main?.rows.length ?? 0;
  const body = format === "csv" ? new TextEncoder().encode(sheetToCsv(main)) : new Uint8Array(await reportToXlsxLazy(exp));

  await recordAudit(ctx, {
    action: "report.export",
    entityType: "organization",
    entityId: ctx.organizationId,
    summary: `Relatório “${REPORT_TYPE_LABELS[type]}” exportado (${format.toUpperCase()}, ${rowCount} linha(s)).`,
    metadata: {
      reportType: type,
      format,
      filters: {
        companyId: f.companyId ?? null,
        unitId: f.unitId ?? null,
        period: f.period ?? null,
        from: f.from ?? null,
        to: f.to ?? null,
      },
      rowCount,
    },
  });

  return { fileName: `${exp.fileBase}.${format}`, contentType: CONTENT_TYPES[format], body, rowCount };
}

/** write-excel-file is only loaded when an XLSX is requested. */
async function reportToXlsxLazy(exp: ReportExport): Promise<Buffer> {
  const { reportToXlsx } = await import("./xlsx");
  return reportToXlsx(exp);
}
