/**
 * Loader of the process decision band (P0.4, `./decision-band` builds the model).
 *
 * Read-only. Every query applies the viewer's row scope (`processWhere`,
 * `visibleAlertsWhere`, `deadlineWhere`, `hearingWhere`, `valuationWhere`,
 * `riskAssessmentWhere`) and the parts the viewer has no permission for are not
 * queried at all: without `contingency:read` no valuation, risk assessment,
 * percentage or value alert is read.
 */
import { and, asc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { todayISO } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { alertHrefKey, resolveAlertHrefs, visibleAlertsWhere } from "@/modules/alerts/service";
import { recordRiskBp } from "@/modules/contingency/position";
import {
  deadlineWhere,
  hearingWhere,
  processWhere,
  riskAssessmentWhere,
  valuationWhere,
} from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  alerts,
  deadlines,
  hearings,
  lawFirms,
  legalProcesses,
  processGuarantees,
  processRiskAssessments,
  processValuations,
  settlements,
  users,
} from "@/server/db/schema";
import { NotFoundError } from "@/server/lib/errors";
import {
  BAND_REDUNDANT_ALERT_TYPES,
  buildProcessDecisionBand,
  CONTINGENCY_ALERT_TYPES,
  COUNTED_DEADLINE_VALIDATION,
  type BandAccess,
  type BandAlert,
  type BandDeadline,
  type BandHearing,
  type BandRiskAssessment,
  type BandValuation,
  type ProcessDecisionBand,
} from "./decision-band";

/** Entity types whose open alerts belong to the band: the process and its hearings, settlements and guarantees. */
const BAND_ALERT_ENTITY_TYPES = ["legal_process", "hearing", "settlement", "guarantee"] as const;

/** What `ctx` may see or do in the band. */
export function processBandAccess(ctx: AuthContext): BandAccess {
  return {
    alerts: can(ctx, "dashboard:read"),
    deadlines: can(ctx, "deadline:read"),
    contingency: can(ctx, "contingency:read"),
    classify: can(ctx, "contingency:read") && can(ctx, "contingency:write"),
    distribute: can(ctx, "distribution:manage"),
  };
}

const none = <T>(): Promise<T[]> => Promise.resolve([]);

async function loadAlerts(ctx: AuthContext, processId: string, access: BandAccess): Promise<BandAlert[]> {
  const db = getDb();
  const org = ctx.organizationId;
  // Children of this process only (the alert's own visibility comes from visibleAlertsWhere).
  const hearingIds = db
    .select({ id: hearings.id })
    .from(hearings)
    .where(and(eq(hearings.organizationId, org), eq(hearings.processId, processId)));
  const settlementIds = db
    .select({ id: settlements.id })
    .from(settlements)
    .where(and(eq(settlements.organizationId, org), eq(settlements.processId, processId)));
  const guaranteeIds = db
    .select({ id: processGuarantees.id })
    .from(processGuarantees)
    .where(and(eq(processGuarantees.organizationId, org), eq(processGuarantees.processId, processId)));
  const rows = await db
    .select({
      id: alerts.id,
      type: alerts.type,
      severity: alerts.severity,
      title: alerts.title,
      entityType: alerts.entityType,
      entityId: alerts.entityId,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .where(
      and(
        // Organization + module read permission + row visibility of the referenced record.
        visibleAlertsWhere(ctx, BAND_ALERT_ENTITY_TYPES),
        isNull(alerts.resolvedAt),
        // Shown by dedicated blocks, and value alerts only with contingency:read (the builder filters again).
        notInArray(alerts.type, [...BAND_REDUNDANT_ALERT_TYPES, ...(access.contingency ? [] : CONTINGENCY_ALERT_TYPES)]),
        or(
          and(eq(alerts.entityType, "legal_process"), eq(alerts.entityId, processId)),
          and(eq(alerts.entityType, "hearing"), inArray(alerts.entityId, hearingIds)),
          and(eq(alerts.entityType, "settlement"), inArray(alerts.entityId, settlementIds)),
          and(eq(alerts.entityType, "guarantee"), inArray(alerts.entityId, guaranteeIds)),
        ),
      ),
    )
    .orderBy(asc(alerts.createdAt), asc(alerts.id))
    .limit(100);
  const hrefs = await resolveAlertHrefs(org, rows);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    severity: r.severity,
    title: r.title,
    // Per-alert key: alerts of different types on the same process open different tabs.
    href: hrefs.get(alertHrefKey(r)) ?? null,
    createdAt: r.createdAt,
  }));
}

function loadDeadlines(ctx: AuthContext, processId: string): Promise<BandDeadline[]> {
  return getDb()
    .select({
      id: deadlines.id,
      title: deadlines.title,
      kind: deadlines.kind,
      dueDate: deadlines.dueDate,
      validationStatus: deadlines.validationStatus,
    })
    .from(deadlines)
    .where(
      and(
        deadlineWhere(ctx),
        eq(deadlines.processId, processId),
        eq(deadlines.status, "open"),
        // Real deadlines and suggestions awaiting validation; rejected ones never count.
        inArray(deadlines.validationStatus, [...COUNTED_DEADLINE_VALIDATION, "pending_validation"]),
      ),
    )
    .orderBy(asc(deadlines.dueDate), asc(deadlines.createdAt), asc(deadlines.id))
    .limit(200);
}

function loadHearings(ctx: AuthContext, processId: string): Promise<BandHearing[]> {
  return getDb()
    .select({ id: hearings.id, kind: hearings.kind, mode: hearings.mode, scheduledAt: hearings.scheduledAt })
    .from(hearings)
    .where(and(hearingWhere(ctx), eq(hearings.processId, processId), eq(hearings.status, "scheduled")))
    .orderBy(asc(hearings.scheduledAt), asc(hearings.id))
    .limit(200);
}

function loadValuations(ctx: AuthContext, processId: string): Promise<BandValuation[]> {
  return getDb()
    .select({
      id: processValuations.id,
      kind: processValuations.kind,
      amountCents: processValuations.amountCents,
      baseDate: processValuations.baseDate,
      source: processValuations.source,
      isEstimate: processValuations.isEstimate,
      createdAt: processValuations.createdAt,
    })
    .from(processValuations)
    .where(and(valuationWhere(ctx), eq(processValuations.processId, processId), eq(processValuations.status, "proposed")))
    .orderBy(asc(processValuations.createdAt), asc(processValuations.id));
}

function loadRisks(ctx: AuthContext, processId: string): Promise<BandRiskAssessment[]> {
  return getDb()
    .select({
      id: processRiskAssessments.id,
      classification: processRiskAssessments.classification,
      percentageBp: processRiskAssessments.percentageBp,
      effectiveFrom: processRiskAssessments.effectiveFrom,
      status: processRiskAssessments.status,
      createdAt: processRiskAssessments.createdAt,
    })
    .from(processRiskAssessments)
    .where(
      and(
        riskAssessmentWhere(ctx),
        eq(processRiskAssessments.processId, processId),
        inArray(processRiskAssessments.status, ["official", "proposed"]),
      ),
    );
}

/**
 * Decision band of a visible process (`process:read` + `processWhere`; NotFoundError otherwise).
 * Each block follows its own permission (see `processBandAccess`).
 */
export async function getProcessDecisionBand(
  ctx: AuthContext,
  processId: string,
  opts: { today?: string } = {},
): Promise<ProcessDecisionBand> {
  assertCan(ctx, "process:read");
  const db = getDb();
  const org = ctx.organizationId;
  const [row] = await db
    .select({
      id: legalProcesses.id,
      needsVerification: legalProcesses.needsVerification,
      verificationNote: legalProcesses.verificationNote,
      responsibleId: legalProcesses.responsibleId,
      responsibleName: users.name,
      lawFirmName: lawFirms.name,
      lossProbability: legalProcesses.lossProbability,
      riskPercentageBp: legalProcesses.riskPercentageBp,
    })
    .from(legalProcesses)
    .leftJoin(users, and(eq(users.id, legalProcesses.responsibleId), eq(users.organizationId, org)))
    .leftJoin(lawFirms, and(eq(lawFirms.id, legalProcesses.lawFirmId), eq(lawFirms.organizationId, org)))
    .where(and(eq(legalProcesses.id, processId), processWhere(ctx)))
    .limit(1);
  if (!row) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");

  const access = processBandAccess(ctx);
  const [alertRows, deadlineRows, hearingRows, valuationRows, riskRows, organization] = await Promise.all([
    access.alerts ? loadAlerts(ctx, row.id, access) : none<BandAlert>(),
    access.deadlines ? loadDeadlines(ctx, row.id) : none<BandDeadline>(),
    loadHearings(ctx, row.id),
    access.contingency ? loadValuations(ctx, row.id) : none<BandValuation>(),
    access.contingency ? loadRisks(ctx, row.id) : none<BandRiskAssessment>(),
    access.contingency ? loadOrganization(org) : Promise.resolve(null),
  ]);

  return buildProcessDecisionBand({
    today: opts.today ?? todayISO(),
    access,
    process: {
      id: row.id,
      needsVerification: row.needsVerification,
      verificationNote: row.verificationNote,
      responsibleId: row.responsibleId,
      responsibleName: row.responsibleName ?? null,
      lawFirmName: row.lawFirmName ?? null,
      // Classification and percentage are contingency data: read only with contingency:read.
      lossProbability: organization ? row.lossProbability : null,
      recordRiskBp: organization ? recordRiskBp(row, organization.settings.contingency.riskPercentages) : null,
    },
    alerts: alertRows,
    deadlines: deadlineRows,
    hearings: hearingRows,
    valuations: valuationRows,
    risks: riskRows,
  });
}
