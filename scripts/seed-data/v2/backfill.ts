/**
 * Generic v2 backfill (all organizations), used by `npm run db:backfill:v2`
 * (scripts/backfill-v2.ts) and by tests/seed. Idempotent and additive: it
 * never deletes or overwrites history, it only records the v2 history that
 * records created before v2 lack.
 *
 * (a) Process with `claimAmountCents` and NO claim valuation (and not loaded
 *     by a v2 spreadsheet import, which records its own valuations) → one
 *     OFFICIAL claim valuation: source `manual`, base date = filing date (or
 *     the creation date), the person who registered the process as creator and
 *     reviewer, reason "Valor da causa do cadastro anterior à v2 (migrado)".
 * (b) Process with `lossProbability` and NO risk assessment → one OFFICIAL
 *     assessment with the organization's percentage for that classification,
 *     in force since the creation date, with the current rules version and an
 *     opinion asking for review. The contingency mirrors of the process
 *     (`riskPercentageBp`, `lossProbability`, `provisionAmountCents`, RN-05)
 *     are then recomputed with the same rules as the contingency service.
 *
 * One transaction per organization, audited with the system context (no
 * content in the audit entries: ids, classification and amounts only).
 */
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { formatBp, percentageForClassification, provisionFor } from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS } from "@/domain/enums";
import { formatDate, formatMoneyCents, todayISO, toISODate } from "@/lib/format";
import { mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import { systemContext } from "@/server/auth/context";
import { getDb, type Database, type DbOrTx } from "@/server/db/client";
import {
  legalProcesses,
  organizations,
  processGuarantees,
  processRiskAssessments,
  processValuations,
  type OrganizationSettings,
} from "@/server/db/schema";
import { recordAudit } from "@/server/services/audit";

export const BACKFILL_CLAIM_REASON = "Valor da causa do cadastro anterior à v2 (migrado)";
export const BACKFILL_RISK_OPINION =
  "Classificação registrada no cadastro anterior à v2 (migrada automaticamente); revisar o parecer.";

export type OrganizationBackfillResult = {
  organizationId: string;
  name: string;
  /** Official claim valuations created (a). */
  claimValuations: number;
  /** Official risk assessments created (b). */
  riskAssessments: number;
  /** Processes whose contingency mirrors changed after (b). */
  mirrorsUpdated: number;
  /** Records created without an identified person (no creator to name as reviewer). */
  withoutCreator: number;
};

type ProcessRow = {
  id: string;
  number: string;
  instance: (typeof legalProcesses.$inferSelect)["instance"];
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  riskPercentageBp: number | null;
  lossProbability: (typeof legalProcesses.$inferSelect)["lossProbability"];
  provisionAmountCents: number | null;
  filedAt: string | null;
  createdAt: Date;
  createdById: string | null;
  importBatchId: string | null;
};

const MIRROR_FIELDS = ["claimAmountCents", "liquidatedAmountCents", "riskPercentageBp", "lossProbability", "provisionAmountCents"] as const;

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/** Runs the backfill for every organization (one transaction each). */
export async function backfillV2(db: Database = getDb()): Promise<OrganizationBackfillResult[]> {
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .orderBy(organizations.createdAt, organizations.id);
  const results: OrganizationBackfillResult[] = [];
  for (const org of orgs) {
    results.push(await backfillOrganization(db, { id: org.id, name: org.name, settings: mergeOrganizationSettings(org.settings) }));
  }
  return results;
}

async function backfillOrganization(
  db: Database,
  org: { id: string; name: string; settings: OrganizationSettings },
): Promise<OrganizationBackfillResult> {
  const ctx = systemContext(org.id);
  const today = todayISO();
  return db.transaction(async (tx) => {
    const result: OrganizationBackfillResult = {
      organizationId: org.id,
      name: org.name,
      claimValuations: 0,
      riskAssessments: 0,
      mirrorsUpdated: 0,
      withoutCreator: 0,
    };
    const procs: ProcessRow[] = await tx
      .select({
        id: legalProcesses.id,
        number: legalProcesses.number,
        instance: legalProcesses.instance,
        claimAmountCents: legalProcesses.claimAmountCents,
        liquidatedAmountCents: legalProcesses.liquidatedAmountCents,
        riskPercentageBp: legalProcesses.riskPercentageBp,
        lossProbability: legalProcesses.lossProbability,
        provisionAmountCents: legalProcesses.provisionAmountCents,
        filedAt: legalProcesses.filedAt,
        createdAt: legalProcesses.createdAt,
        createdById: legalProcesses.createdById,
        importBatchId: legalProcesses.importBatchId,
      })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.organizationId, org.id), isNull(legalProcesses.deletedAt)))
      .orderBy(legalProcesses.createdAt, legalProcesses.id);
    if (procs.length === 0) return result;

    // Processes that already have a claim valuation / a risk assessment (any status).
    // Queries run one at a time: a transaction holds a single connection.
    const claimRows = await tx
      .selectDistinct({ processId: processValuations.processId })
      .from(processValuations)
      .where(and(eq(processValuations.organizationId, org.id), eq(processValuations.kind, "claim")));
    const riskRows = await tx
      .selectDistinct({ processId: processRiskAssessments.processId })
      .from(processRiskAssessments)
      .where(eq(processRiskAssessments.organizationId, org.id));
    const hasClaim = new Set(claimRows.map((r) => r.processId));
    const hasRisk = new Set(riskRows.map((r) => r.processId));

    // (a) Valor da causa → official claim valuation.
    for (const p of procs) {
      if (p.claimAmountCents === null || hasClaim.has(p.id) || p.importBatchId !== null) continue;
      const baseDate = minDate(p.filedAt ?? toISODate(p.createdAt), today);
      const [v] = await tx
        .insert(processValuations)
        .values({
          organizationId: org.id,
          processId: p.id,
          kind: "claim",
          amountCents: p.claimAmountCents,
          baseDate,
          instance: p.instance,
          source: "manual",
          status: "official",
          isEstimate: false,
          reason: BACKFILL_CLAIM_REASON,
          createdById: p.createdById,
          reviewedById: p.createdById,
          reviewedAt: p.createdById ? p.createdAt : null,
        })
        .returning({ id: processValuations.id });
      if (!p.createdById) result.withoutCreator++;
      result.claimValuations++;
      await recordAudit(
        ctx,
        {
          action: "valuation.create",
          entityType: "legal_process",
          entityId: p.id,
          summary:
            `Valor da causa (${formatMoneyCents(p.claimAmountCents)}) do cadastro anterior à v2 registrado no histórico de valores ` +
            `do processo ${p.number} (migração automática).`,
          metadata: { valuationId: v.id, backfill: "v2", baseDate },
        },
        tx,
      );
    }

    // (b) Loss probability → official risk assessment + mirrors.
    const percentages = org.settings.contingency.riskPercentages;
    const rulesVersion = org.settings.contingency.rulesVersion;
    for (const p of procs) {
      if (!p.lossProbability || hasRisk.has(p.id)) continue;
      const percentageBp = percentageForClassification(percentages, p.lossProbability);
      const effectiveFrom = minDate(toISODate(p.createdAt), today);
      const [r] = await tx
        .insert(processRiskAssessments)
        .values({
          organizationId: org.id,
          processId: p.id,
          classification: p.lossProbability,
          percentageBp,
          opinion: BACKFILL_RISK_OPINION,
          effectiveFrom,
          status: "official",
          origin: "manual",
          rulesVersion,
          assessedById: p.createdById,
          reviewedById: p.createdById,
          reviewedAt: p.createdById ? p.createdAt : null,
        })
        .returning({ id: processRiskAssessments.id });
      if (!p.createdById) result.withoutCreator++;
      result.riskAssessments++;
      const changes = await recomputeMirrors(tx, org.id, p, org.settings, today);
      if (changes) result.mirrorsUpdated++;
      await recordAudit(
        ctx,
        {
          action: "risk_assessment.create",
          entityType: "legal_process",
          entityId: p.id,
          summary:
            `Classificação de risco "${LOSS_PROBABILITY_LABELS[p.lossProbability]}" (${formatBp(percentageBp)}) do cadastro anterior à v2 ` +
            `registrada no histórico do processo ${p.number} (migração automática), vigente desde ${formatDate(effectiveFrom)}.`,
          changes,
          metadata: { riskAssessmentId: r.id, rulesVersion, backfill: "v2" },
        },
        tx,
      );
    }
    return result;
  });
}

/**
 * Same rules as the contingency service's mirror sync:
 *   liquidated = latest OFFICIAL liquidated valuation (kept when none),
 *   claim = latest OFFICIAL claim valuation (kept when none),
 *   risk = OFFICIAL assessment in force today (kept when none),
 *   provision = provisionFor(...) with the linked guarantees (RN-04/RN-05).
 */
async function recomputeMirrors(
  tx: DbOrTx,
  organizationId: string,
  p: ProcessRow,
  settings: OrganizationSettings,
  today: string,
): Promise<Record<string, { from: unknown; to: unknown }> | null> {
  const latestOfficial = (kind: "claim" | "liquidated") =>
    tx
      .select({ amountCents: processValuations.amountCents })
      .from(processValuations)
      .where(
        and(
          eq(processValuations.organizationId, organizationId),
          eq(processValuations.processId, p.id),
          eq(processValuations.kind, kind),
          eq(processValuations.status, "official"),
        ),
      )
      .orderBy(desc(processValuations.baseDate), desc(processValuations.createdAt))
      .limit(1);
  // Sequential on purpose: the transaction holds a single connection.
  const [liq] = await latestOfficial("liquidated");
  const [claim] = await latestOfficial("claim");
  const [risk] = await tx
    .select({ classification: processRiskAssessments.classification, percentageBp: processRiskAssessments.percentageBp })
    .from(processRiskAssessments)
    .where(
      and(
        eq(processRiskAssessments.organizationId, organizationId),
        eq(processRiskAssessments.processId, p.id),
        eq(processRiskAssessments.status, "official"),
        lte(processRiskAssessments.effectiveFrom, today),
      ),
    )
    .orderBy(desc(processRiskAssessments.effectiveFrom), desc(processRiskAssessments.createdAt))
    .limit(1);
  const [guarantees] = await tx
    .select({ total: sql<number>`coalesce(sum(${processGuarantees.amountCents}), 0)`.mapWith(Number) })
    .from(processGuarantees)
    .where(
      and(
        eq(processGuarantees.organizationId, organizationId),
        eq(processGuarantees.processId, p.id),
        inArray(processGuarantees.status, ["linked"]),
        isNull(processGuarantees.deletedAt),
      ),
    );
  const next = {
    claimAmountCents: claim ? claim.amountCents : p.claimAmountCents,
    liquidatedAmountCents: liq ? liq.amountCents : p.liquidatedAmountCents,
    riskPercentageBp: risk ? risk.percentageBp : p.riskPercentageBp,
    lossProbability: risk ? risk.classification : p.lossProbability,
    provisionAmountCents: null as number | null,
  };
  const bp =
    next.riskPercentageBp ??
    (next.lossProbability ? percentageForClassification(settings.contingency.riskPercentages, next.lossProbability) : null);
  next.provisionAmountCents = provisionFor({
    liquidatedCents: next.liquidatedAmountCents,
    linkedGuaranteesCents: guarantees?.total ?? 0,
    claimCents: next.claimAmountCents,
    riskPercentageBp: bp,
  }).provisionCents;

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of MIRROR_FIELDS) {
    const from = p[key] ?? null;
    const to = next[key] ?? null;
    if (from !== to) changes[key] = { from, to };
  }
  if (Object.keys(changes).length === 0) return null;
  await tx
    .update(legalProcesses)
    .set({ ...next, updatedAt: new Date() })
    .where(and(eq(legalProcesses.id, p.id), eq(legalProcesses.organizationId, organizationId)));
  return changes;
}

/** "a (b)" totals line used by the CLI. */
export function totalsOf(results: readonly OrganizationBackfillResult[]) {
  return results.reduce(
    (acc, r) => ({
      claimValuations: acc.claimValuations + r.claimValuations,
      riskAssessments: acc.riskAssessments + r.riskAssessments,
      mirrorsUpdated: acc.mirrorsUpdated + r.mirrorsUpdated,
      withoutCreator: acc.withoutCreator + r.withoutCreator,
    }),
    { claimValuations: 0, riskAssessments: 0, mirrorsUpdated: 0, withoutCreator: 0 },
  );
}
