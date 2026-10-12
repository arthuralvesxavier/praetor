/**
 * Classificação de risco (RF-11/RF-12). APPEND-ONLY with validity: the
 * classification in force on a date is the OFFICIAL assessment with the
 * greatest `effectiveFrom <= date`. Every assessment records the opinion
 * (parecer) and the version of the risk parameters (`rulesVersion`, RNF-14).
 *
 * Permissions (decision documented in docs/STATUS.md by the integrator):
 * - registering an official classification, and approving/rejecting a rule
 *   suggestion, require `contingency:write` AND an identified person. Risk is a
 *   legal judgement (the lawyer's or the external firm's opinion), so the legal
 *   team decides it; `contingency:approve` (accounting) is for monetary values.
 * - rule suggestions (RF-12) are always `proposed`: they never change the
 *   mirrors until a person approves them.
 */
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { formatBp, percentageForClassification, percentToBp } from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS, type DataOrigin, type LossProbability, type ValuationStatus } from "@/domain/enums";
import { formatDate, todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { riskAssessmentWhere } from "@/server/auth/access";
import { assertCan } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { legalProcesses, processRiskAssessments, users } from "@/server/db/schema";
import { recordAudit } from "@/server/services/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { loadSettings, loadVisibleProcess, parseId, parseOrThrow, requireHuman, syncProcessMirrors } from "./internal";
import { RISK_SUGGESTION_PREFIX, ruleSuggestionOpinion, suggestRiskByRule } from "./rules";
import { riskAssessmentSchema, riskProposalReviewSchema, type RiskAssessmentInput } from "./schemas";

export type RiskAssessmentItem = {
  id: string;
  classification: LossProbability;
  percentageBp: number;
  opinion: string;
  effectiveFrom: string;
  status: ValuationStatus;
  origin: DataOrigin;
  rulesVersion: number;
  assessedByName: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  /** True for the official assessment in force today. */
  inForce: boolean;
};

type RiskRow = typeof processRiskAssessments.$inferSelect;

async function loadAssessment(ctx: AuthContext, id: string, db: DbOrTx): Promise<RiskRow & { processNumber: string }> {
  const [row] = await db
    .select({ r: processRiskAssessments, processNumber: legalProcesses.number })
    .from(processRiskAssessments)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processRiskAssessments.processId))
    .where(and(eq(processRiskAssessments.id, parseId(id)), riskAssessmentWhere(ctx)));
  if (!row) throw new NotFoundError("Classificação não encontrada ou sem permissão de acesso.");
  return { ...row.r, processNumber: row.processNumber };
}

/** Every assessment of a visible process (official history, proposals and rejected), newest first. */
export async function listRiskAssessments(ctx: AuthContext, processId: string): Promise<RiskAssessmentItem[]> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const assessor = alias(users, "risk_assessor");
  const reviewer = alias(users, "risk_reviewer");
  const rows = await db
    .select({ r: processRiskAssessments, assessedByName: assessor.name, reviewedByName: reviewer.name })
    .from(processRiskAssessments)
    .leftJoin(assessor, eq(assessor.id, processRiskAssessments.assessedById))
    .leftJoin(reviewer, eq(reviewer.id, processRiskAssessments.reviewedById))
    .where(and(riskAssessmentWhere(ctx), eq(processRiskAssessments.processId, p.id)))
    .orderBy(desc(processRiskAssessments.effectiveFrom), desc(processRiskAssessments.createdAt));
  const today = todayISO();
  const inForce = rows.find((x) => x.r.status === "official" && x.r.effectiveFrom <= today)?.r.id ?? null;
  return rows.map(({ r, assessedByName, reviewedByName }) => ({
    id: r.id,
    classification: r.classification,
    percentageBp: r.percentageBp,
    opinion: r.opinion,
    effectiveFrom: r.effectiveFrom,
    status: r.status,
    origin: r.origin,
    rulesVersion: r.rulesVersion,
    assessedByName,
    reviewedByName,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
    inForce: r.id === inForce,
  }));
}

/** Official classification with the opinion of an identified person (RF-11). */
export async function addRiskAssessment(ctx: AuthContext, processId: string, input: RiskAssessmentInput): Promise<{ id: string }> {
  assertCan(ctx, "contingency:write");
  const userId = requireHuman(ctx);
  const data = parseOrThrow(riskAssessmentSchema, input);
  if (data.effectiveFrom > todayISO()) {
    throw new ValidationError("Verifique os campos informados.", {
      effectiveFrom: ["A vigência não pode começar no futuro."],
    });
  }
  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, processId, tx);
    const settings = await loadSettings(ctx.organizationId, tx);
    const percentageBp =
      data.percentage !== null
        ? percentToBp(data.percentage)
        : percentageForClassification(settings.contingency.riskPercentages, data.classification);
    const [created] = await tx
      .insert(processRiskAssessments)
      .values({
        organizationId: ctx.organizationId,
        processId: p.id,
        classification: data.classification,
        percentageBp,
        opinion: data.opinion,
        effectiveFrom: data.effectiveFrom,
        status: "official",
        origin: "manual",
        rulesVersion: settings.contingency.rulesVersion,
        assessedById: userId,
        reviewedById: userId,
        reviewedAt: new Date(),
      })
      .returning({ id: processRiskAssessments.id });
    const mirrors = await syncProcessMirrors(ctx.organizationId, p.id, tx, settings);
    await recordAudit(
      ctx,
      {
        action: "risk_assessment.create",
        entityType: "legal_process",
        entityId: p.id,
        summary:
          `Classificação de risco "${LOSS_PROBABILITY_LABELS[data.classification]}" (${formatBp(percentageBp)}) ` +
          `registrada no processo ${p.number}, vigente desde ${formatDate(data.effectiveFrom)}.`,
        changes: mirrors,
        metadata: { riskAssessmentId: created.id, rulesVersion: settings.contingency.rulesVersion },
      },
      tx,
    );
    return { id: created.id };
  });
}

/**
 * RF-12: deterministic rule suggestion (no AI). Always `proposed`; the opinion
 * starts with "Sugestão automática por regra (não oficial):" and explains the
 * rule. Returns the existing pending suggestion when an identical one exists.
 */
export async function suggestRiskAssessment(
  ctx: AuthContext,
  processId: string,
): Promise<{ id: string; classification: LossProbability; reused: boolean }> {
  assertCan(ctx, "contingency:write");
  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, processId, tx);
    const settings = await loadSettings(ctx.organizationId, tx);
    const result = suggestRiskByRule({
      status: p.status,
      phase: p.phase,
      instance: p.instance,
      closureReason: p.closureReason,
      liquidatedCents: p.liquidatedAmountCents,
    });
    const [pending] = await tx
      .select({ id: processRiskAssessments.id })
      .from(processRiskAssessments)
      .where(
        and(
          eq(processRiskAssessments.organizationId, ctx.organizationId),
          eq(processRiskAssessments.processId, p.id),
          eq(processRiskAssessments.status, "proposed"),
          eq(processRiskAssessments.classification, result.classification),
          eq(processRiskAssessments.origin, "system"),
        ),
      )
      .limit(1);
    if (pending) return { id: pending.id, classification: result.classification, reused: true };

    const percentageBp = percentageForClassification(settings.contingency.riskPercentages, result.classification);
    const [created] = await tx
      .insert(processRiskAssessments)
      .values({
        organizationId: ctx.organizationId,
        processId: p.id,
        classification: result.classification,
        percentageBp,
        opinion: ruleSuggestionOpinion(result, settings.contingency.rulesVersion, formatBp(percentageBp)),
        effectiveFrom: todayISO(),
        status: "proposed",
        origin: "system",
        rulesVersion: settings.contingency.rulesVersion,
        assessedById: ctx.userId,
      })
      .returning({ id: processRiskAssessments.id });
    await recordAudit(
      ctx,
      {
        action: "risk_assessment.suggest",
        entityType: "legal_process",
        entityId: p.id,
        summary: `Classificação "${LOSS_PROBABILITY_LABELS[result.classification]}" sugerida por regra (não oficial) para o processo ${p.number}.`,
        metadata: { riskAssessmentId: created.id, rulesVersion: settings.contingency.rulesVersion },
      },
      tx,
    );
    return { id: created.id, classification: result.classification, reused: false };
  });
}

/**
 * Approves a PROPOSED (rule) classification: it becomes official, in force
 * from the approval date, with the approver identified (RN-11 spirit). The
 * opinion keeps the rule's explanation, re-labelled as approved.
 */
export async function approveRiskProposal(ctx: AuthContext, id: string, input: { note?: string | null } = {}): Promise<void> {
  assertCan(ctx, "contingency:write");
  const userId = requireHuman(ctx);
  const { note } = parseOrThrow(riskProposalReviewSchema, input);
  await getDb().transaction(async (tx) => {
    const r = await loadAssessment(ctx, id, tx);
    if (r.status !== "proposed") throw new ConflictError("Esta classificação já foi conferida.");
    const today = todayISO();
    const approvedPrefix = `Sugestão automática por regra, aprovada por ${ctx.name} em ${formatDate(today)}:`;
    let opinion = r.opinion.startsWith(RISK_SUGGESTION_PREFIX)
      ? `${approvedPrefix}${r.opinion.slice(RISK_SUGGESTION_PREFIX.length)}`
      : r.opinion;
    if (note) opinion = `${opinion}\n\nParecer de quem aprovou: ${note}`;
    await tx
      .update(processRiskAssessments)
      .set({ status: "official", reviewedById: userId, reviewedAt: new Date(), effectiveFrom: today, opinion: opinion.slice(0, 4000) })
      .where(and(eq(processRiskAssessments.id, r.id), eq(processRiskAssessments.organizationId, ctx.organizationId)));
    const mirrors = await syncProcessMirrors(ctx.organizationId, r.processId, tx);
    await recordAudit(
      ctx,
      {
        action: "risk_assessment.approve",
        entityType: "legal_process",
        entityId: r.processId,
        summary: `Classificação "${LOSS_PROBABILITY_LABELS[r.classification]}" sugerida por regra aprovada no processo ${r.processNumber}.`,
        changes: mirrors,
        metadata: { riskAssessmentId: r.id },
      },
      tx,
    );
  });
}

export async function rejectRiskProposal(ctx: AuthContext, id: string, input: { note?: string | null } = {}): Promise<void> {
  assertCan(ctx, "contingency:write");
  const userId = requireHuman(ctx);
  const { note } = parseOrThrow(riskProposalReviewSchema, input);
  await getDb().transaction(async (tx) => {
    const r = await loadAssessment(ctx, id, tx);
    if (r.status !== "proposed") throw new ConflictError("Esta classificação já foi conferida.");
    const opinion = note ? `${r.opinion}\n\nRejeitada: ${note}` : r.opinion;
    await tx
      .update(processRiskAssessments)
      .set({ status: "rejected", reviewedById: userId, reviewedAt: new Date(), opinion: opinion.slice(0, 4000) })
      .where(and(eq(processRiskAssessments.id, r.id), eq(processRiskAssessments.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "risk_assessment.reject",
        entityType: "legal_process",
        entityId: r.processId,
        summary: `Classificação "${LOSS_PROBABILITY_LABELS[r.classification]}" sugerida por regra rejeitada no processo ${r.processNumber}.`,
        metadata: { riskAssessmentId: r.id },
      },
      tx,
    );
  });
}

export async function getRiskAssessmentProcessId(ctx: AuthContext, id: string): Promise<string> {
  assertCan(ctx, "contingency:read");
  return (await loadAssessment(ctx, id, getDb())).processId;
}
