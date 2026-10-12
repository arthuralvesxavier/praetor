/**
 * Pedidos do processo (verbas pleiteadas) and the process risk derived from them.
 *
 * Permissions (claims are part of the process):
 * - read claims: `process:read` + row visibility of the process (`processChildWhere`);
 * - assessments, derivation and override: read with `contingency:read`;
 * - create / edit / confirm / dismiss / remove claims: `process:write` (identified person);
 * - assess a claim, apply the derived risk, override it: `contingency:write` (identified person).
 *
 * Derivation (see ./derivation.ts): classification = worst claim, provision =
 * Σ claim base × claim %. When it differs from the process assessment in force,
 * a NEW official process assessment (origin `system`, opinion "Derivado dos
 * pedidos: ...", in force from the latest effective date of the counted claim
 * assessments, see `derivedEffectiveFrom`; overrides, and an explicit "aplicar
 * derivada" that ends one, are dated the day they are recorded) is recorded in
 * the same transaction, the contingency mirrors
 * are re-synced (`syncProcessMirrors`) and the link is kept in
 * `process_claim_risk_links`. A manual override (justified, kind `override`)
 * is never undone silently: when the claim assessments change, it is kept and
 * flagged for review (alert `claims_risk_review` + flag on read). The same
 * holds for an official classification recorded OUTSIDE the claims panel (aba
 * de valores, approved rule suggestion) after the claims were first assessed:
 * it is a human decision, so derivations keep it (override "outside_panel").
 *
 * Review flags (one open alert per process, dedupe `claims_risk_review:<id>`):
 * an override kept after the claims changed (including the removal of every
 * assessed claim); a derived classification whose claims no longer have an
 * assessment; a derived classification that mixes quantified and unquantified
 * claims (it records the organization percentage of the classification, see
 * `derivedProcessRate`, because an unquantified claim is not zero).
 *
 * The contingency module has no reusable function to record a system-origin
 * official assessment inside another transaction, so the insert lives here with
 * the same invariants as `addRiskAssessment` (official + identified person,
 * percentage in bp, rulesVersion, mirrors, audit with `riskAssessmentId`).
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { BriefCitation, StoredCaseBrief } from "@/domain/case-brief";
import {
  formatBp,
  percentageForClassification,
  percentToBp,
  type ProvisionResult,
  type RiskPercentages,
} from "@/domain/contingency";
import {
  CLAIM_CATEGORY_LABELS,
  CLAIM_STATUS_LABELS,
  CORRECTION_INDEX_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROCESS_INSTANCE_LABELS,
  type AiMode,
  type CaseBriefStatus,
  type ClaimCategory,
  type ClaimOrigin,
  type ClaimRiskLinkKind,
  type ClaimStatus,
  type CorrectionIndex,
  type DataOrigin,
  type LossProbability,
  type ProcessInstance,
} from "@/domain/enums";
import { formatDate, formatMoneyCents, todayISO } from "@/lib/format";
import { resolveAlertsByDedupeKeys, upsertAlert } from "@/modules/alerts/service";
import { loadSettings, loadVisibleProcess, parseId, parseOrThrow, syncProcessMirrors } from "@/modules/contingency/internal";
import { getProcessContingencySummary } from "@/modules/contingency/service";
import type { AuthContext } from "@/server/auth/context";
import { systemContext } from "@/server/auth/context";
import { caseBriefWhere, processChildWhere, riskAssessmentWhere } from "@/server/auth/access";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  caseBriefs,
  legalProcesses,
  processClaimAssessments,
  processClaimRiskLinks,
  processClaims,
  processRiskAssessments,
  users,
  type OrganizationSettings,
} from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { recordAudit } from "@/server/services/audit";
import {
  deriveProcessRisk,
  derivationOpinion,
  derivedEffectiveFrom,
  derivedProcessRate,
  derivedRateNeedsReview,
  differsFromInForce,
  type ClaimsRiskDerivation,
  type DerivationClaim,
  type DerivedRate,
} from "./derivation";
import {
  claimAssessmentSchema,
  claimSchema,
  dismissClaimSchema,
  removeClaimSchema,
  riskOverrideSchema,
  type ClaimAssessmentInput,
  type ClaimData,
  type ClaimInput,
  type RiskOverrideInput,
} from "./schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaimAssessmentItem = {
  id: string;
  classification: LossProbability;
  percentageBp: number;
  baseAmountCents: number | null;
  baseDate: string | null;
  correctionIndex: CorrectionIndex | null;
  /** base × % (null when the claim is not quantified). */
  provisionCents: number | null;
  opinion: string;
  effectiveFrom: string;
  rulesVersion: number;
  assessedByName: string | null;
  createdAt: Date;
  /** True for the assessment in force today. */
  inForce: boolean;
};

export type ProcessClaimItem = {
  id: string;
  description: string;
  category: ClaimCategory | null;
  claimedAmountCents: number | null;
  amountBaseDate: string | null;
  correctionIndex: CorrectionIndex | null;
  instance: ProcessInstance | null;
  origin: ClaimOrigin;
  status: ClaimStatus;
  sourceBriefId: string | null;
  sourceNote: string | null;
  /** Suggested by a SIMULATED preliminary analysis (demonstrative content). */
  sourceIsDemo: boolean;
  createdByName: string | null;
  createdAt: Date;
  confirmedByName: string | null;
  confirmedAt: Date | null;
  dismissedAt: Date | null;
  /** Assessment in force (null when none or without `contingency:read`). */
  assessment: ClaimAssessmentItem | null;
  /** Every assessment, newest first ([] without `contingency:read`). */
  history: ClaimAssessmentItem[];
  /** The base of the assessment in force is not the current claim value (value edited after the assessment). */
  baseDiffersFromClaim: boolean;
};

export type ProcessRiskInForce = {
  id: string;
  classification: LossProbability;
  percentageBp: number;
  origin: DataOrigin;
  effectiveFrom: string;
  opinion: string;
  assessedByName: string | null;
  /** How it relates to the claims: derived, override or recorded elsewhere (null). */
  link: ClaimRiskLinkKind | null;
};

/**
 * How the classification in force overrides the claims:
 * - `panel`: defined manually in the claims panel, with justification (link `override`);
 * - `outside_panel`: official classification recorded elsewhere (aba de valores,
 *   approved rule suggestion) after the claims were first assessed, different
 *   from the derived one. Kept like an override; its parecer is the justification.
 */
export type ClaimsOverrideKind = "panel" | "outside_panel";

/** Official provision of the process (contingency mirrors, values at their base dates). */
export type OfficialProvision = {
  classification: LossProbability | null;
  percentageBp: number | null;
  provision: ProvisionResult;
};

export type ClaimsRiskState = {
  derivation: ClaimsRiskDerivation;
  /** Percentage (bp) a derived assessment records (`derivedRate.bp`). */
  derivedBp: number | null;
  /** Percentage a derived assessment records and its basis (null without derived classification). */
  derivedRate: DerivedRate | null;
  /** Mix of quantified and unquantified assessed claims: the derived percentage must be reviewed. */
  derivedNeedsReview: boolean;
  inForce: ProcessRiskInForce | null;
  /** Derived result differs from the assessment in force. */
  differs: boolean;
  overrideInForce: boolean;
  /** Null when no override is in force. */
  overrideKind: ClaimsOverrideKind | null;
  /** Override in force and the claim assessments changed after it (including the removal of every assessed claim). */
  overrideNeedsReview: boolean;
  /** What the derivation said when the override in force was recorded (panel overrides only). */
  overrideDerivedAtTime: { classification: LossProbability | null; percentageBp: number | null } | null;
  /** The classification in force was derived from the claims, but no confirmed claim has an assessment in force anymore. */
  derivedWithoutBasis: boolean;
  /** Official provision of the process (null when it could not be read). */
  official: OfficialProvision | null;
  /**
   * Official provision differs from the provision by the claims (Σ base × %):
   * the official one applies the process percentage to the net liquidated value
   * or, without it, to the valor da causa (RN-05), not to the claim bases.
   */
  provisionDiffers: boolean;
};

export type BriefClaimsOffer = {
  briefId: string;
  version: number;
  demo: boolean;
  status: CaseBriefStatus;
  /** Claims of the brief that can become suggestions (not gaps or illustrative examples). */
  eligible: number;
  /** Eligible claims not yet in the process. */
  notImported: number;
};

export type ProcessClaimsOverview = {
  processId: string;
  processNumber: string;
  /** Filing date of the record: suggested base date when confirming a suggested claim with a value. */
  processFiledAt: string | null;
  claims: ProcessClaimItem[];
  /** Null without `contingency:read`. */
  risk: ClaimsRiskState | null;
  riskPercentages: RiskPercentages | null;
  permissions: { canEditClaims: boolean; canAssess: boolean };
  /** Null when there is nothing to offer or the user cannot act on it. */
  briefOffer: BriefClaimsOffer | null;
};

export type DerivationOutcome =
  /** `needsReview`: recorded with the organization percentage because some assessed claims are unquantified. */
  | { status: "recorded"; riskAssessmentId: string; needsReview: boolean }
  | { status: "unchanged" }
  | { status: "override_kept"; needsReview: boolean }
  /** `needsReview`: the classification in force was derived from claims that no longer have an assessment. */
  | { status: "no_assessed_claims"; needsReview: boolean }
  | { status: "skipped_without_permission" };

type ClaimRow = typeof processClaims.$inferSelect;
type AssessmentRow = typeof processClaimAssessments.$inferSelect;

/** Statuses of a case brief whose content can be applied (same rule as the briefs module). */
const APPLICABLE_BRIEF_STATUSES: readonly CaseBriefStatus[] = ["ready_for_review", "in_review", "approved"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requirePerson(ctx: AuthContext): string {
  if (ctx.kind !== "user" || !ctx.userId) {
    throw new ValidationError("Somente uma pessoa identificada pode registrar pedidos e avaliações de risco.");
  }
  return ctx.userId;
}

function hashFingerprint(fp: string): string {
  return createHash("sha256").update(fp).digest("hex");
}

export function reviewAlertKey(processId: string): string {
  return `claims_risk_review:${processId}`;
}

function provisionOf(baseCents: number | null, bp: number): number | null {
  return baseCents === null ? null : Math.round((baseCents * bp) / 10_000);
}

function normalizeDescription(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

function money(cents: number | null, baseDate: string | null): string {
  if (cents === null) return "não quantificado";
  return baseDate ? `${formatMoneyCents(cents)} em ${formatDate(baseDate)}` : formatMoneyCents(cents);
}

/** Locks the process row: claim writes and derivations of the same process run one at a time. */
async function lockProcess(organizationId: string, processId: string, tx: DbOrTx): Promise<void> {
  await tx
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId)))
    .for("update");
}

async function loadVisibleClaim(ctx: AuthContext, claimId: string, db: DbOrTx): Promise<ClaimRow & { processNumber: string }> {
  const [row] = await db
    .select({ c: processClaims, processNumber: legalProcesses.number })
    .from(processClaims)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processClaims.processId))
    .where(and(eq(processClaims.id, parseId(claimId)), processChildWhere(ctx, processClaims)));
  if (!row) throw new NotFoundError("Pedido não encontrado ou sem permissão de acesso.");
  return { ...row.c, processNumber: row.processNumber };
}

/**
 * Visible claim, read again after locking its process row, so concurrent
 * writes on the same process see each other's committed state.
 */
async function loadVisibleClaimLocked(ctx: AuthContext, claimId: string, tx: DbOrTx): Promise<ClaimRow & { processNumber: string }> {
  const first = await loadVisibleClaim(ctx, claimId, tx);
  await lockProcess(ctx.organizationId, first.processId, tx);
  return loadVisibleClaim(ctx, claimId, tx);
}

/** Assessments of the process claims, newest first (effective date, then creation). */
async function loadAssessments(organizationId: string, processId: string, db: DbOrTx): Promise<AssessmentRow[]> {
  return db
    .select()
    .from(processClaimAssessments)
    .where(and(eq(processClaimAssessments.organizationId, organizationId), eq(processClaimAssessments.processId, processId)))
    .orderBy(
      desc(processClaimAssessments.effectiveFrom),
      desc(processClaimAssessments.createdAt),
      desc(processClaimAssessments.id),
    );
}

/** Assessment in force today per claim id (rows must be sorted newest first). */
function inForceByClaim(rows: readonly AssessmentRow[], today: string): Map<string, AssessmentRow> {
  const out = new Map<string, AssessmentRow>();
  for (const r of rows) {
    if (r.effectiveFrom > today || out.has(r.claimId)) continue;
    out.set(r.claimId, r);
  }
  return out;
}

async function loadDerivationInput(organizationId: string, processId: string, db: DbOrTx): Promise<DerivationClaim[]> {
  const [claims, assessments] = await Promise.all([
    db
      .select({ id: processClaims.id, description: processClaims.description, status: processClaims.status })
      .from(processClaims)
      .where(
        and(
          eq(processClaims.organizationId, organizationId),
          eq(processClaims.processId, processId),
          isNull(processClaims.deletedAt),
        ),
      )
      .orderBy(asc(processClaims.createdAt), asc(processClaims.id)),
    loadAssessments(organizationId, processId, db),
  ]);
  const inForce = inForceByClaim(assessments, todayISO());
  return claims.map((c) => {
    const a = inForce.get(c.id);
    return {
      id: c.id,
      description: c.description,
      status: c.status,
      assessment: a
        ? {
            id: a.id,
            classification: a.classification,
            percentageBp: a.percentageBp,
            baseAmountCents: a.baseAmountCents,
            effectiveFrom: a.effectiveFrom,
          }
        : null,
    };
  });
}

type InForceRow = {
  id: string;
  classification: LossProbability;
  percentageBp: number;
  origin: DataOrigin;
  effectiveFrom: string;
  opinion: string;
  assessedById: string | null;
  linkKind: ClaimRiskLinkKind | null;
  linkFingerprint: string | null;
  linkDerivedClassification: LossProbability | null;
  linkDerivedBp: number | null;
  /** Recorded (approved, for a rule suggestion) after the first claim assessment of the process. */
  recordedAfterClaims: boolean;
  /** A claim assessment was recorded, or an assessed claim removed, after this classification was recorded. */
  claimsChangedAfter: boolean;
};

/**
 * Official process assessment in force today (same order as `syncProcessMirrors`) and its claims link.
 * Time comparisons run in the database (full timestamp precision).
 */
async function loadRiskInForce(organizationId: string, processId: string, db: DbOrTx): Promise<InForceRow | null> {
  const recordedAt = sql`coalesce(${processRiskAssessments.reviewedAt}, ${processRiskAssessments.createdAt})`;
  const [row] = await db
    .select({
      id: processRiskAssessments.id,
      classification: processRiskAssessments.classification,
      percentageBp: processRiskAssessments.percentageBp,
      origin: processRiskAssessments.origin,
      effectiveFrom: processRiskAssessments.effectiveFrom,
      opinion: processRiskAssessments.opinion,
      assessedById: processRiskAssessments.assessedById,
      linkKind: processClaimRiskLinks.kind,
      linkFingerprint: processClaimRiskLinks.basisFingerprint,
      linkDerivedClassification: processClaimRiskLinks.derivedClassification,
      linkDerivedBp: processClaimRiskLinks.derivedPercentageBp,
      recordedAfterClaims: sql<boolean>`exists (
        select 1 from process_claim_assessments pca
        where pca.organization_id = ${processRiskAssessments.organizationId}
          and pca.process_id = ${processRiskAssessments.processId}
          and pca.created_at < ${recordedAt})`,
      claimsChangedAfter: sql<boolean>`(exists (
        select 1 from process_claim_assessments pca
        where pca.organization_id = ${processRiskAssessments.organizationId}
          and pca.process_id = ${processRiskAssessments.processId}
          and pca.created_at > ${recordedAt})
        or exists (
        select 1 from process_claims pc
        where pc.organization_id = ${processRiskAssessments.organizationId}
          and pc.process_id = ${processRiskAssessments.processId}
          and pc.deleted_at > ${recordedAt}
          and exists (select 1 from process_claim_assessments pcx where pcx.claim_id = pc.id and pcx.created_at <= pc.deleted_at)))`,
    })
    .from(processRiskAssessments)
    .leftJoin(processClaimRiskLinks, eq(processClaimRiskLinks.riskAssessmentId, processRiskAssessments.id))
    .where(
      and(
        eq(processRiskAssessments.organizationId, organizationId),
        eq(processRiskAssessments.processId, processId),
        eq(processRiskAssessments.status, "official"),
        lte(processRiskAssessments.effectiveFrom, todayISO()),
      ),
    )
    .orderBy(
      desc(processRiskAssessments.effectiveFrom),
      desc(sql`coalesce(${processRiskAssessments.reviewedAt}, ${processRiskAssessments.createdAt})`),
      desc(processRiskAssessments.createdAt),
      desc(processRiskAssessments.id),
    )
    .limit(1);
  return row ? { ...row, recordedAfterClaims: row.recordedAfterClaims === true, claimsChangedAfter: row.claimsChangedAfter === true } : null;
}

function orgBp(settings: OrganizationSettings) {
  return (c: LossProbability) => percentageForClassification(settings.contingency.riskPercentages, c);
}

type OverrideState = { kind: ClaimsOverrideKind; needsReview: boolean };

/**
 * Override in force, if any (see `ClaimsOverrideKind`). `basisHash` = hash of the
 * current claims fingerprint ("" when no claim is assessed, so removing every
 * assessed claim also counts as a change).
 */
function overrideOf(inForce: InForceRow | null, basisHash: string): OverrideState | null {
  if (!inForce) return null;
  if (inForce.linkKind === "override") return { kind: "panel", needsReview: inForce.linkFingerprint !== basisHash };
  if (inForce.linkKind === null && inForce.recordedAfterClaims) return { kind: "outside_panel", needsReview: inForce.claimsChangedAfter };
  return null;
}

type ReviewReason = "override_changed" | "outside_panel_changed" | "override_without_claims" | "derived_without_claims" | "unquantified";

const REVIEW_MESSAGES: Record<ReviewReason, string> = {
  override_changed:
    "A classificação definida manualmente foi mantida, mas a avaliação dos pedidos mudou depois dela. " +
    "Confira os pedidos e aplique a classificação derivada ou registre nova justificativa.",
  outside_panel_changed:
    "A classificação registrada na aba de valores e risco depois da avaliação dos pedidos foi mantida, mas a avaliação " +
    "dos pedidos mudou depois dela. Confira os pedidos e aplique a classificação derivada ou registre a classificação " +
    "manual com justificativa no painel de pedidos.",
  override_without_claims:
    "A classificação definida manualmente foi mantida, mas nenhum pedido confirmado tem mais avaliação vigente. " +
    "Avalie os pedidos ou registre nova classificação na aba de valores e risco.",
  derived_without_claims:
    "A classificação vigente foi derivada dos pedidos, mas nenhum pedido confirmado tem mais avaliação vigente. " +
    "Avalie os pedidos ou registre nova classificação na aba de valores e risco.",
  unquantified:
    "A classificação derivada dos pedidos registrou o percentual da organização para a classificação, porque há pedido " +
    "avaliado sem valor (pedido sem valor não vale zero). Quantifique os pedidos ou defina a classificação manualmente com justificativa.",
};

/** Opens (or updates) the review alert of the process, or resolves it when `reason` is null. */
async function syncReviewAlert(
  organizationId: string,
  process: { id: string; number: string },
  reason: ReviewReason | null,
  tx: DbOrTx,
): Promise<void> {
  if (reason === null) {
    await resolveAlertsByDedupeKeys(organizationId, [reviewAlertKey(process.id)], tx);
    return;
  }
  await upsertAlert(
    {
      organizationId,
      type: "claims_risk_review",
      severity: "warning",
      title: `Rever a classificação de risco do processo ${process.number}`,
      message: REVIEW_MESSAGES[reason],
      entityType: "legal_process",
      entityId: process.id,
      dedupeKey: reviewAlertKey(process.id),
    },
    tx,
  );
}

/**
 * Records an official process assessment + its claims link, re-syncs the
 * mirrors and opens or resolves the review alert (inside `tx`). Append-only:
 * always a new dated record.
 */
async function insertProcessAssessment(
  ctx: AuthContext,
  input: {
    processId: string;
    processNumber: string;
    classification: LossProbability;
    percentageBp: number;
    opinion: string;
    /** Derived: `derivedEffectiveFrom` (dates of the claim assessments). Override, or derived ending an override: today. */
    effectiveFrom: string;
    origin: DataOrigin;
    kind: ClaimRiskLinkKind;
    derivation: ClaimsRiskDerivation;
    derivedBp: number | null;
    userId: string;
    /** Review still needed after this record (null resolves any open review alert). */
    review: ReviewReason | null;
  },
  settings: OrganizationSettings,
  tx: DbOrTx,
): Promise<{ id: string; mirrors: Awaited<ReturnType<typeof syncProcessMirrors>> }> {
  const now = new Date();
  const [created] = await tx
    .insert(processRiskAssessments)
    .values({
      organizationId: ctx.organizationId,
      processId: input.processId,
      classification: input.classification,
      percentageBp: input.percentageBp,
      opinion: input.opinion.slice(0, 4000),
      effectiveFrom: input.effectiveFrom,
      status: "official",
      origin: input.origin,
      rulesVersion: settings.contingency.rulesVersion,
      assessedById: input.userId,
      reviewedById: input.userId,
      reviewedAt: now,
    })
    .returning({ id: processRiskAssessments.id });
  const d = input.derivation;
  await tx.insert(processClaimRiskLinks).values({
    organizationId: ctx.organizationId,
    processId: input.processId,
    riskAssessmentId: created.id,
    kind: input.kind,
    derivedClassification: d.classification,
    derivedPercentageBp: input.derivedBp,
    derivedProvisionCents: d.provisionCents,
    quantifiedBaseCents: d.quantifiedBaseCents,
    unquantifiedCount: d.unquantified.length,
    unassessedCount: d.unassessed.length,
    basisFingerprint: hashFingerprint(d.fingerprint),
    createdById: input.userId,
  });
  const mirrors = await syncProcessMirrors(ctx.organizationId, input.processId, tx, settings);
  // A new assessment in force ends any pending review of an older one (unless it needs review itself).
  await syncReviewAlert(ctx.organizationId, { id: input.processId, number: input.processNumber }, input.review, tx);
  return { id: created.id, mirrors };
}

/**
 * Re-derives the process risk from its claims inside `tx` (process already
 * locked). `force` = explicit "apply derived" (ends an override in force).
 *
 * Never undoes a human decision silently: an override in force (panel or
 * outside the panel) is kept and, when the claims changed after it, flagged
 * for review. A derived record that mixes quantified and unquantified claims
 * is recorded with the organization percentage and flagged for review.
 */
async function runDerivation(
  ctx: AuthContext,
  process: { id: string; number: string },
  settings: OrganizationSettings,
  tx: DbOrTx,
  opts: { force: boolean; trigger: string },
): Promise<DerivationOutcome> {
  if (!can(ctx, "contingency:write") || ctx.kind !== "user" || !ctx.userId) return { status: "skipped_without_permission" };
  const userId = ctx.userId;
  const claims = await loadDerivationInput(ctx.organizationId, process.id, tx);
  const d = deriveProcessRisk(claims);
  const rate = derivedProcessRate(d, orgBp(settings));
  const inForce = await loadRiskInForce(ctx.organizationId, process.id, tx);
  const override = overrideOf(inForce, hashFingerprint(d.fingerprint));
  const matchesInForce =
    !!inForce && rate !== null && inForce.classification === d.classification && inForce.percentageBp === rate.bp;

  if (!opts.force && override) {
    // A classification recorded outside the panel that matches the derived one needs no review.
    if (override.kind === "outside_panel" && matchesInForce) {
      await syncReviewAlert(ctx.organizationId, process, derivedRateNeedsReview(rate) ? "unquantified" : null, tx);
      return { status: "unchanged" };
    }
    if (override.needsReview) {
      const reason: ReviewReason =
        d.classification === null ? "override_without_claims" : override.kind === "panel" ? "override_changed" : "outside_panel_changed";
      await syncReviewAlert(ctx.organizationId, process, reason, tx);
    }
    return { status: "override_kept", needsReview: override.needsReview };
  }

  if (d.classification === null || rate === null) {
    // The derived classification in force lost its basis: kept (nothing to derive) and flagged.
    const needsReview = inForce?.linkKind === "derived";
    if (needsReview) await syncReviewAlert(ctx.organizationId, process, "derived_without_claims", tx);
    return { status: "no_assessed_claims", needsReview };
  }

  const review: ReviewReason | null = derivedRateNeedsReview(rate) ? "unquantified" : null;
  if (matchesInForce && !(opts.force && override?.kind === "panel")) {
    if (opts.force) throw new ConflictError("A classificação vigente já corresponde à derivada dos pedidos.");
    await syncReviewAlert(ctx.organizationId, process, review, tx);
    return { status: "unchanged" };
  }

  // Ending an override ("aplicar derivada" over a panel or outside-panel classification) is a decision
  // taken today, dated today like the override itself: the human classification stays in force for the
  // days before it (backdating here would replace it retroactively in the still-open competência).
  const effectiveFrom = override ? todayISO() : derivedEffectiveFrom(claims, inForce?.effectiveFrom ?? null, todayISO());
  const { id, mirrors } = await insertProcessAssessment(
    ctx,
    {
      processId: process.id,
      processNumber: process.number,
      classification: d.classification,
      percentageBp: rate.bp,
      opinion: derivationOpinion(d, rate, ctx.name),
      effectiveFrom,
      origin: "system",
      kind: "derived",
      derivation: d,
      derivedBp: rate.bp,
      userId,
      review,
    },
    settings,
    tx,
  );
  await recordAudit(
    ctx,
    {
      action: "risk_assessment.derive",
      entityType: "legal_process",
      entityId: process.id,
      summary:
        `Classificação de risco "${LOSS_PROBABILITY_LABELS[d.classification]}" (${formatBp(rate.bp)}) derivada dos pedidos ` +
        `registrada no processo ${process.number}, vigente desde ${formatDate(effectiveFrom)}.` +
        (review ? " Marcada para revisão: há pedido avaliado sem valor, percentual da organização para a classificação." : ""),
      changes: mirrors,
      metadata: {
        riskAssessmentId: id,
        trigger: opts.trigger,
        endedOverride: override?.kind ?? null,
        rateBasis: rate.basis,
        needsReview: review !== null,
        effectiveFrom,
        rulesVersion: settings.contingency.rulesVersion,
      },
    },
    tx,
  );
  return { status: "recorded", riskAssessmentId: id, needsReview: review !== null };
}

function toAssessmentItem(r: AssessmentRow, names: Map<string, string>, inForceId: string | null): ClaimAssessmentItem {
  return {
    id: r.id,
    classification: r.classification,
    percentageBp: r.percentageBp,
    baseAmountCents: r.baseAmountCents,
    baseDate: r.baseDate,
    correctionIndex: r.correctionIndex,
    provisionCents: provisionOf(r.baseAmountCents, r.percentageBp),
    opinion: r.opinion,
    effectiveFrom: r.effectiveFrom,
    rulesVersion: r.rulesVersion,
    assessedByName: names.get(r.assessedById) ?? null,
    createdAt: r.createdAt,
    inForce: r.id === inForceId,
  };
}

async function userNames(organizationId: string, ids: (string | null)[], db: DbOrTx): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), inArray(users.id, unique)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Claims of a visible process + (with `contingency:read`) assessments and derived vs in-force risk. */
export async function getProcessClaims(ctx: AuthContext, processId: string): Promise<ProcessClaimsOverview> {
  assertCan(ctx, "process:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const readRisk = can(ctx, "contingency:read");

  const claimRows = await db
    .select({ c: processClaims, briefMode: caseBriefs.mode })
    .from(processClaims)
    .leftJoin(
      caseBriefs,
      and(eq(caseBriefs.id, processClaims.sourceBriefId), eq(caseBriefs.organizationId, processClaims.organizationId)),
    )
    .where(and(processChildWhere(ctx, processClaims), eq(processClaims.processId, p.id)))
    .orderBy(asc(processClaims.createdAt), asc(processClaims.id));
  const claims = claimRows.map((r) => r.c);
  const demoClaims = new Set(claimRows.filter((r) => r.briefMode === "demo").map((r) => r.c.id));

  const assessments = readRisk
    ? await db
        .select()
        .from(processClaimAssessments)
        .where(and(processChildWhere(ctx, processClaimAssessments), eq(processClaimAssessments.processId, p.id)))
        .orderBy(
          desc(processClaimAssessments.effectiveFrom),
          desc(processClaimAssessments.createdAt),
          desc(processClaimAssessments.id),
        )
    : [];
  const today = todayISO();
  const inForce = inForceByClaim(assessments, today);

  let risk: ClaimsRiskState | null = null;
  let riskPercentages: RiskPercentages | null = null;
  let inForceRisk: InForceRow | null = null;
  if (readRisk) {
    const settings = await loadSettings(ctx.organizationId, db);
    riskPercentages = settings.contingency.riskPercentages;
    const derivation = deriveProcessRisk(
      claims
        .filter((c) => !c.deletedAt)
        .map((c) => {
          const a = inForce.get(c.id);
          return {
            id: c.id,
            description: c.description,
            status: c.status,
            assessment: a
              ? { id: a.id, classification: a.classification, percentageBp: a.percentageBp, baseAmountCents: a.baseAmountCents }
              : null,
          };
        }),
    );
    const derivedRate = derivedProcessRate(derivation, orgBp(settings));
    const derivedBp = derivedRate?.bp ?? null;
    // The process assessment in force is read through the risk-assessment visibility rule.
    inForceRisk = await loadRiskInForce(ctx.organizationId, p.id, db);
    if (inForceRisk) {
      const [visible] = await db
        .select({ id: processRiskAssessments.id })
        .from(processRiskAssessments)
        .where(and(eq(processRiskAssessments.id, inForceRisk.id), riskAssessmentWhere(ctx)));
      if (!visible) inForceRisk = null;
    }
    const differs = differsFromInForce({ classification: derivation.classification, percentageBp: derivedBp }, inForceRisk);
    const override = overrideOf(inForceRisk, hashFingerprint(derivation.fingerprint));
    // A classification recorded outside the panel counts as an override only while it differs from the
    // derived one (or lost its claims basis after it was recorded); when it matches, it is shown as matching.
    const overrideKind =
      override && (override.kind === "panel" || differs || (derivation.classification === null && override.needsReview))
        ? override.kind
        : null;
    const summary = await getProcessContingencySummary(ctx, p.id);
    const official: OfficialProvision = {
      classification: summary.classification,
      percentageBp: summary.percentageBp,
      provision: summary.provision,
    };
    risk = {
      derivation,
      derivedBp,
      derivedRate,
      derivedNeedsReview: derivedRateNeedsReview(derivedRate),
      inForce: null,
      differs,
      overrideInForce: overrideKind !== null,
      overrideKind,
      overrideNeedsReview: overrideKind !== null && override!.needsReview,
      overrideDerivedAtTime:
        overrideKind === "panel"
          ? { classification: inForceRisk!.linkDerivedClassification, percentageBp: inForceRisk!.linkDerivedBp }
          : null,
      derivedWithoutBasis: inForceRisk?.linkKind === "derived" && derivation.classification === null,
      official,
      provisionDiffers:
        (derivation.provisionCents !== null || official.provision.provisionCents !== null) &&
        derivation.provisionCents !== official.provision.provisionCents,
    };
  }

  const names = await userNames(
    ctx.organizationId,
    [
      ...claims.flatMap((c) => [c.createdById, c.confirmedById]),
      ...assessments.map((a) => a.assessedById),
      inForceRisk?.assessedById ?? null,
    ],
    db,
  );
  if (risk && inForceRisk) {
    risk.inForce = {
      id: inForceRisk.id,
      classification: inForceRisk.classification,
      percentageBp: inForceRisk.percentageBp,
      origin: inForceRisk.origin,
      effectiveFrom: inForceRisk.effectiveFrom,
      opinion: inForceRisk.opinion,
      assessedByName: inForceRisk.assessedById ? (names.get(inForceRisk.assessedById) ?? null) : null,
      link: inForceRisk.linkKind,
    };
  }

  const byClaim = new Map<string, AssessmentRow[]>();
  for (const a of assessments) {
    const list = byClaim.get(a.claimId) ?? [];
    list.push(a);
    byClaim.set(a.claimId, list);
  }

  const items: ProcessClaimItem[] = claims.map((c) => {
    const current = inForce.get(c.id) ?? null;
    const history = (byClaim.get(c.id) ?? []).map((a) => toAssessmentItem(a, names, current?.id ?? null));
    return {
      id: c.id,
      description: c.description,
      category: c.category,
      claimedAmountCents: c.claimedAmountCents,
      amountBaseDate: c.amountBaseDate,
      correctionIndex: c.correctionIndex,
      instance: c.instance,
      origin: c.origin,
      status: c.status,
      sourceBriefId: c.sourceBriefId,
      sourceNote: c.sourceNote,
      sourceIsDemo: demoClaims.has(c.id),
      createdByName: c.createdById ? (names.get(c.createdById) ?? null) : null,
      createdAt: c.createdAt,
      confirmedByName: c.confirmedById ? (names.get(c.confirmedById) ?? null) : null,
      confirmedAt: c.confirmedAt,
      dismissedAt: c.dismissedAt,
      assessment: current ? toAssessmentItem(current, names, current.id) : null,
      history,
      baseDiffersFromClaim:
        !!current &&
        (current.baseAmountCents !== c.claimedAmountCents ||
          (current.baseAmountCents !== null && current.baseDate !== c.amountBaseDate)),
    };
  });

  const canEditClaims = can(ctx, "process:write") && ctx.kind === "user";
  return {
    processId: p.id,
    processNumber: p.number,
    processFiledAt: p.filedAt ?? null,
    claims: items,
    risk,
    riskPercentages,
    permissions: { canEditClaims, canAssess: can(ctx, "contingency:write") && ctx.kind === "user" },
    briefOffer: canEditClaims ? await getBriefClaimsOffer(ctx, p.id) : null,
  };
}

/**
 * Claims link of each process risk assessment of a visible process, keyed by
 * `process_risk_assessments.id` (assessments without a link are absent). For
 * the risk history of the "Valores e risco" tab: a `derived` row has origin
 * `system` but is NOT a rule suggestion approved by someone (label it with
 * `claimsRiskAttribution` from ../labels).
 */
export async function getClaimRiskLinkKinds(ctx: AuthContext, processId: string): Promise<Record<string, ClaimRiskLinkKind>> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const rows = await db
    .select({ riskAssessmentId: processClaimRiskLinks.riskAssessmentId, kind: processClaimRiskLinks.kind })
    .from(processClaimRiskLinks)
    .where(and(processChildWhere(ctx, processClaimRiskLinks), eq(processClaimRiskLinks.processId, p.id)));
  return Object.fromEntries(rows.map((r) => [r.riskAssessmentId, r.kind]));
}

/** Process id of a visible claim (server actions use it to revalidate the page). */
export async function getClaimProcessId(ctx: AuthContext, claimId: string): Promise<string> {
  assertCan(ctx, "process:read");
  return (await loadVisibleClaim(ctx, claimId, getDb())).processId;
}

// ---------------------------------------------------------------------------
// Claim writes (process:write)
// ---------------------------------------------------------------------------

function claimValues(data: ClaimData) {
  return {
    description: data.description,
    category: data.category,
    claimedAmountCents: data.claimedAmountCents,
    amountBaseDate: data.claimedAmountCents === null ? null : data.amountBaseDate,
    correctionIndex: data.claimedAmountCents === null ? null : data.correctionIndex,
    instance: data.instance,
  };
}

function claimSummary(data: Pick<ClaimData, "category" | "claimedAmountCents" | "amountBaseDate">): string {
  const category = data.category ? CLAIM_CATEGORY_LABELS[data.category] : "sem categoria";
  return `categoria ${category}, valor ${money(data.claimedAmountCents, data.amountBaseDate)}`;
}

/** Manual claim, confirmed by its author. */
export async function createClaim(ctx: AuthContext, processId: string, input: ClaimInput): Promise<{ id: string; processId: string }> {
  assertCan(ctx, "process:write");
  const userId = requirePerson(ctx);
  const data = parseOrThrow(claimSchema, input);
  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, processId, tx);
    await lockProcess(ctx.organizationId, p.id, tx);
    const now = new Date();
    const [created] = await tx
      .insert(processClaims)
      .values({
        organizationId: ctx.organizationId,
        processId: p.id,
        ...claimValues(data),
        origin: "manual",
        status: "confirmed",
        confirmedById: userId,
        confirmedAt: now,
        createdById: userId,
      })
      .returning({ id: processClaims.id });
    await recordAudit(
      ctx,
      {
        action: "claim.create",
        entityType: "legal_process",
        entityId: p.id,
        summary: `Pedido incluído no processo ${p.number} (${claimSummary(data)}).`,
        metadata: { claimId: created.id },
      },
      tx,
    );
    return { id: created.id, processId: p.id };
  });
}

/**
 * Audited fields of a claim, keyed with a `claim*` prefix (the audit entry is
 * filed under the process) and with enum values already in pt-BR.
 */
const AUDITED_CLAIM_FIELDS: { key: keyof ReturnType<typeof claimValues>; audit: string; label?: (v: string) => string }[] = [
  { key: "category", audit: "claimCategory", label: (v) => CLAIM_CATEGORY_LABELS[v as ClaimCategory] ?? v },
  { key: "claimedAmountCents", audit: "claimedAmountCents" },
  { key: "amountBaseDate", audit: "claimAmountBaseDate" },
  { key: "correctionIndex", audit: "claimCorrectionIndex", label: (v) => CORRECTION_INDEX_LABELS[v as CorrectionIndex] ?? v },
  { key: "instance", audit: "claimInstance", label: (v) => PROCESS_INSTANCE_LABELS[v as ProcessInstance] ?? v },
];

function claimDiff(before: ClaimRow, after: ReturnType<typeof claimValues>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of AUDITED_CLAIM_FIELDS) {
    const from = before[f.key] ?? null;
    const to = after[f.key] ?? null;
    if (from === to) continue;
    const show = (v: unknown) => (typeof v === "string" && f.label ? f.label(v) : v);
    changes[f.audit] = { from: show(from), to: show(to) };
  }
  // The description may come from a document (preliminary analysis): never copied to the audit trail.
  if (before.description !== after.description) changes.claimDescription = { from: "(anterior)", to: "(alterada)" };
  return Object.keys(changes).length ? changes : null;
}

/** Edits a confirmed or pending claim. Assessments keep the base they used (append-only). */
export async function updateClaim(ctx: AuthContext, claimId: string, input: ClaimInput): Promise<{ processId: string }> {
  assertCan(ctx, "process:write");
  requirePerson(ctx);
  const data = parseOrThrow(claimSchema, input);
  return getDb().transaction(async (tx) => {
    const c = await loadVisibleClaimLocked(ctx, claimId, tx);
    if (c.status === "dismissed") throw new ConflictError("Pedido descartado não pode ser alterado.");
    const values = claimValues(data);
    const changes = claimDiff(c, values);
    if (!changes) return { processId: c.processId };
    await tx
      .update(processClaims)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(processClaims.id, c.id), eq(processClaims.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "claim.update",
        entityType: "legal_process",
        entityId: c.processId,
        summary: `Pedido do processo ${c.processNumber} alterado.`,
        changes,
        metadata: { claimId: c.id },
      },
      tx,
    );
    return { processId: c.processId };
  });
}

/**
 * Confirms a claim suggested by the preliminary analysis (with the reviewer's
 * corrections). From now on it can be assessed and counts in the derived risk.
 */
export async function confirmClaim(ctx: AuthContext, claimId: string, input: ClaimInput): Promise<{ processId: string }> {
  assertCan(ctx, "process:write");
  const userId = requirePerson(ctx);
  const data = parseOrThrow(claimSchema, input);
  return getDb().transaction(async (tx) => {
    const c = await loadVisibleClaimLocked(ctx, claimId, tx);
    if (c.status !== "pending_confirmation") throw new ConflictError("Este pedido não aguarda confirmação.");
    const values = claimValues(data);
    const changes = claimDiff(c, values);
    const now = new Date();
    await tx
      .update(processClaims)
      .set({ ...values, status: "confirmed", confirmedById: userId, confirmedAt: now, updatedAt: now })
      .where(and(eq(processClaims.id, c.id), eq(processClaims.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "claim.confirm",
        entityType: "legal_process",
        entityId: c.processId,
        summary: `Pedido sugerido pela análise preliminar confirmado no processo ${c.processNumber} (${claimSummary(data)}).`,
        changes: { claimStatus: { from: CLAIM_STATUS_LABELS[c.status], to: CLAIM_STATUS_LABELS.confirmed }, ...(changes ?? {}) },
        metadata: { claimId: c.id },
      },
      tx,
    );
    return { processId: c.processId };
  });
}

/** Discards a suggestion (kept as "Descartado" so the same item is not suggested again). */
export async function dismissClaim(ctx: AuthContext, claimId: string, input: { reason?: string | null } = {}): Promise<{ processId: string }> {
  assertCan(ctx, "process:write");
  const userId = requirePerson(ctx);
  const { reason } = parseOrThrow(dismissClaimSchema, input);
  return getDb().transaction(async (tx) => {
    const c = await loadVisibleClaimLocked(ctx, claimId, tx);
    if (c.status !== "pending_confirmation") throw new ConflictError("Somente pedidos aguardando confirmação podem ser descartados.");
    const now = new Date();
    await tx
      .update(processClaims)
      .set({ status: "dismissed", dismissedById: userId, dismissedAt: now, updatedAt: now })
      .where(and(eq(processClaims.id, c.id), eq(processClaims.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "claim.dismiss",
        entityType: "legal_process",
        entityId: c.processId,
        summary: `Pedido sugerido pela análise preliminar descartado no processo ${c.processNumber}${reason ? `. Motivo: ${clip(reason, 300)}` : ""}.`,
        changes: { claimStatus: { from: CLAIM_STATUS_LABELS[c.status], to: CLAIM_STATUS_LABELS.dismissed } },
        metadata: { claimId: c.id },
      },
      tx,
    );
    return { processId: c.processId };
  });
}

/**
 * Removes a claim registered by mistake (soft delete, audited). When it had an
 * assessment in force, the process risk is derived again (only for users with
 * `contingency:write`; otherwise the panel shows the difference).
 */
export async function removeClaim(
  ctx: AuthContext,
  claimId: string,
  input: { reason: string },
): Promise<{ processId: string; derivation: DerivationOutcome | null }> {
  assertCan(ctx, "process:write");
  requirePerson(ctx);
  const { reason } = parseOrThrow(removeClaimSchema, input);
  return getDb().transaction(async (tx) => {
    const c = await loadVisibleClaimLocked(ctx, claimId, tx);
    const now = new Date();
    await tx
      .update(processClaims)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(processClaims.id, c.id), eq(processClaims.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "claim.delete",
        entityType: "legal_process",
        entityId: c.processId,
        summary: `Pedido excluído do processo ${c.processNumber}. Motivo: ${clip(reason, 300)}.`,
        metadata: { claimId: c.id },
      },
      tx,
    );
    const assessed = c.status === "confirmed" && inForceByClaim(await loadAssessments(ctx.organizationId, c.processId, tx), todayISO()).has(c.id);
    if (!assessed) return { processId: c.processId, derivation: null };
    const settings = await loadSettings(ctx.organizationId, tx);
    const derivation = await runDerivation(ctx, { id: c.processId, number: c.processNumber }, settings, tx, {
      force: false,
      trigger: "claim_removed",
    });
    return { processId: c.processId, derivation };
  });
}

// ---------------------------------------------------------------------------
// Assessments and process risk (contingency:write)
// ---------------------------------------------------------------------------

/**
 * Appends an assessment to a CONFIRMED claim and derives the process risk
 * again in the same transaction.
 */
export async function assessClaim(
  ctx: AuthContext,
  claimId: string,
  input: ClaimAssessmentInput,
): Promise<{ id: string; processId: string; derivation: DerivationOutcome }> {
  assertCan(ctx, "contingency:write");
  const userId = requirePerson(ctx);
  const data = parseOrThrow(claimAssessmentSchema, input);
  if (data.effectiveFrom > todayISO()) {
    throw new ValidationError("Verifique os campos informados.", { effectiveFrom: ["A vigência não pode começar no futuro."] });
  }
  return getDb().transaction(async (tx) => {
    const c = await loadVisibleClaimLocked(ctx, claimId, tx);
    if (c.status !== "confirmed") {
      throw new ConflictError("Confirme o pedido antes de avaliá-lo: sugestões da análise preliminar não contam no risco.");
    }
    const settings = await loadSettings(ctx.organizationId, tx);
    const percentageBp =
      data.percentage !== null
        ? percentToBp(data.percentage)
        : percentageForClassification(settings.contingency.riskPercentages, data.classification);
    let baseAmountCents: number | null;
    let baseDate: string | null;
    let correctionIndex: CorrectionIndex | null;
    if (data.baseAmountCents === undefined) {
      baseAmountCents = c.claimedAmountCents;
      baseDate = c.claimedAmountCents === null ? null : c.amountBaseDate;
      correctionIndex = c.claimedAmountCents === null ? null : c.correctionIndex;
      if (baseAmountCents !== null && !baseDate) {
        throw new ValidationError("Verifique os campos informados.", {
          baseDate: ["O valor do pedido não tem data-base: informe a data-base da base de cálculo."],
        });
      }
    } else {
      baseAmountCents = data.baseAmountCents;
      baseDate = baseAmountCents === null ? null : data.baseDate;
      correctionIndex = baseAmountCents === null ? null : data.correctionIndex;
    }
    const [created] = await tx
      .insert(processClaimAssessments)
      .values({
        organizationId: ctx.organizationId,
        claimId: c.id,
        processId: c.processId,
        classification: data.classification,
        percentageBp,
        baseAmountCents,
        baseDate,
        correctionIndex,
        opinion: data.opinion,
        effectiveFrom: data.effectiveFrom,
        rulesVersion: settings.contingency.rulesVersion,
        assessedById: userId,
      })
      .returning({ id: processClaimAssessments.id });
    await recordAudit(
      ctx,
      {
        action: "claim_assessment.create",
        entityType: "legal_process",
        entityId: c.processId,
        summary:
          `Pedido do processo ${c.processNumber} avaliado como "${LOSS_PROBABILITY_LABELS[data.classification]}" (${formatBp(percentageBp)}), ` +
          `base ${money(baseAmountCents, baseDate)}, vigente desde ${formatDate(data.effectiveFrom)}.`,
        metadata: { claimId: c.id, claimAssessmentId: created.id, rulesVersion: settings.contingency.rulesVersion },
      },
      tx,
    );
    const derivation = await runDerivation(ctx, { id: c.processId, number: c.processNumber }, settings, tx, {
      force: false,
      trigger: "claim_assessed",
    });
    return { id: created.id, processId: c.processId, derivation };
  });
}

/** Records the derived classification explicitly (also ends a manual override in force). */
export async function applyDerivedRisk(ctx: AuthContext, processId: string): Promise<DerivationOutcome> {
  assertCan(ctx, "contingency:write");
  requirePerson(ctx);
  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, processId, tx);
    await lockProcess(ctx.organizationId, p.id, tx);
    const settings = await loadSettings(ctx.organizationId, tx);
    const outcome = await runDerivation(ctx, { id: p.id, number: p.number }, settings, tx, { force: true, trigger: "manual" });
    if (outcome.status === "no_assessed_claims") {
      throw new ValidationError("Nenhum pedido confirmado tem avaliação vigente: não há classificação derivada.");
    }
    return outcome;
  });
}

/**
 * Manual process classification DIFFERENT from the derived one, with a
 * justification (stored as the opinion of the official assessment and flagged
 * `override`). Kept by later derivations until a person reviews it.
 */
export async function overrideProcessRisk(
  ctx: AuthContext,
  processId: string,
  input: RiskOverrideInput,
): Promise<{ id: string; processId: string }> {
  assertCan(ctx, "contingency:write");
  const userId = requirePerson(ctx);
  const data = parseOrThrow(riskOverrideSchema, input);
  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, processId, tx);
    await lockProcess(ctx.organizationId, p.id, tx);
    const settings = await loadSettings(ctx.organizationId, tx);
    const d = deriveProcessRisk(await loadDerivationInput(ctx.organizationId, p.id, tx));
    if (d.classification === null) {
      throw new ValidationError(
        "Nenhum pedido confirmado tem avaliação vigente: não há classificação derivada. Classifique o processo na aba de valores e risco.",
      );
    }
    const derivedBp = derivedProcessRate(d, orgBp(settings))!.bp;
    const bp = data.percentage !== null ? percentToBp(data.percentage) : orgBp(settings)(data.classification);
    if (data.classification === d.classification && bp === derivedBp) {
      throw new ValidationError("Verifique os campos informados.", {
        classification: ["Igual à classificação derivada dos pedidos: use \"Aplicar classificação derivada\"."],
      });
    }
    const opinion =
      `Classificação definida manualmente, diferente da derivada dos pedidos ` +
      `(derivada: ${LOSS_PROBABILITY_LABELS[d.classification]}, ${formatBp(derivedBp)}). Justificativa: ${data.justification}`;
    const { id, mirrors } = await insertProcessAssessment(
      ctx,
      {
        processId: p.id,
        processNumber: p.number,
        classification: data.classification,
        percentageBp: bp,
        opinion,
        // A manual decision taken now (dated today, so it is the one in force).
        effectiveFrom: todayISO(),
        origin: "manual",
        kind: "override",
        derivation: d,
        derivedBp,
        userId,
        // A justified manual classification is the human review: it resolves any open review alert.
        review: null,
      },
      settings,
      tx,
    );
    await recordAudit(
      ctx,
      {
        action: "risk_assessment.override",
        entityType: "legal_process",
        entityId: p.id,
        summary:
          `Classificação de risco "${LOSS_PROBABILITY_LABELS[data.classification]}" (${formatBp(bp)}) definida manualmente no processo ${p.number}, ` +
          `diferente da derivada dos pedidos ("${LOSS_PROBABILITY_LABELS[d.classification]}", ${formatBp(derivedBp)}), com justificativa.`,
        changes: mirrors,
        metadata: { riskAssessmentId: id, rulesVersion: settings.contingency.rulesVersion },
      },
      tx,
    );
    return { id, processId: p.id };
  });
}

// ---------------------------------------------------------------------------
// Suggestions from the preliminary analysis (case brief)
// ---------------------------------------------------------------------------

type BriefRef = { id: string; processId: string; version: number; mode: AiMode; status: CaseBriefStatus; content: StoredCaseBrief | null };

/** Latest version WITH content of the process (whatever its visibility). */
async function latestBriefOfProcess(organizationId: string, processId: string, db: DbOrTx): Promise<BriefRef | null> {
  const [b] = await db
    .select({
      id: caseBriefs.id,
      processId: caseBriefs.processId,
      version: caseBriefs.version,
      mode: caseBriefs.mode,
      status: caseBriefs.status,
      content: caseBriefs.content,
    })
    .from(caseBriefs)
    .where(and(eq(caseBriefs.organizationId, organizationId), eq(caseBriefs.processId, processId), isNotNull(caseBriefs.content)))
    .orderBy(desc(caseBriefs.version))
    .limit(1);
  return b ?? null;
}

/** Claims of the brief that may become suggestions: facts of the case (not gaps, not illustrative examples). */
function eligibleBriefClaims(content: StoredCaseBrief): { index: number; description: string; amountCents: number | null; citations: BriefCitation[] }[] {
  return content.claims
    .map((c, index) => ({ index, description: c.description, amountCents: c.amountCents, citations: c.citations, provenance: c.provenance }))
    .filter((c) => c.provenance !== "missing" && c.provenance !== "illustrative" && c.description.trim().length >= 3)
    .map(({ index, description, amountCents, citations }) => ({ index, description, amountCents, citations }));
}

function briefSourceNote(b: Pick<BriefRef, "version" | "mode">, citations: BriefCitation[]): string {
  const refs = citations.map((c) => (c.page ? `${c.ref}, p. ${c.page}` : c.ref));
  const origin =
    b.mode === "demo"
      ? `Análise preliminar v${b.version} (SIMULAÇÃO: conteúdo demonstrativo, sem inteligência artificial real)`
      : `Análise preliminar v${b.version} (IA)`;
  return `${origin}; fonte: ${refs.length ? refs.join("; ") : "sem citação"}. Confira na petição antes de confirmar.`.slice(0, 500);
}

async function existingClaimKeys(organizationId: string, processId: string, db: DbOrTx) {
  const rows = await db
    .select({
      description: processClaims.description,
      sourceBriefId: processClaims.sourceBriefId,
      sourceIndex: processClaims.sourceIndex,
      deletedAt: processClaims.deletedAt,
    })
    .from(processClaims)
    .where(and(eq(processClaims.organizationId, organizationId), eq(processClaims.processId, processId)));
  return {
    // Soft-deleted claims are ignored by description (a manual claim removed as a mistake may come back
    // as a suggestion, pending confirmation), but a brief item is never re-suggested once it was used,
    // even when that claim was removed (unique source_brief_id + source_index).
    descriptions: new Set(rows.filter((r) => r.deletedAt === null).map((r) => normalizeDescription(r.description))),
    items: new Set(rows.filter((r) => r.sourceBriefId).map((r) => `${r.sourceBriefId}:${r.sourceIndex}`)),
  };
}

/** Offer shown on the claims panel: latest visible applicable brief with claims not yet in the process. */
export async function getBriefClaimsOffer(ctx: AuthContext, processId: string): Promise<BriefClaimsOffer | null> {
  if (!can(ctx, "process:write") || !can(ctx, "brief:read")) return null;
  const db = getDb();
  const b = await latestBriefOfProcess(ctx.organizationId, processId, db);
  if (!b || !b.content || !APPLICABLE_BRIEF_STATUSES.includes(b.status)) return null;
  const [visible] = await db.select({ id: caseBriefs.id }).from(caseBriefs).where(and(eq(caseBriefs.id, b.id), caseBriefWhere(ctx)));
  if (!visible) return null;
  const eligible = eligibleBriefClaims(b.content);
  if (!eligible.length) return null;
  const keys = await existingClaimKeys(ctx.organizationId, processId, db);
  const notImported = eligible.filter(
    (c) => !keys.items.has(`${b.id}:${c.index}`) && !keys.descriptions.has(normalizeDescription(c.description)),
  ).length;
  return { briefId: b.id, version: b.version, demo: b.mode === "demo", status: b.status, eligible: eligible.length, notImported };
}

async function createSuggestions(
  ctx: AuthContext,
  b: BriefRef & { content: StoredCaseBrief },
  processNumber: string,
  tx: DbOrTx,
): Promise<{ created: number; skipped: number }> {
  const eligible = eligibleBriefClaims(b.content);
  const keys = await existingClaimKeys(ctx.organizationId, b.processId, tx);
  let created = 0;
  for (const c of eligible) {
    const norm = normalizeDescription(c.description);
    if (keys.items.has(`${b.id}:${c.index}`) || keys.descriptions.has(norm)) continue;
    const amount = c.amountCents !== null && Number.isInteger(c.amountCents) && c.amountCents >= 0 ? c.amountCents : null;
    const rows = await tx
      .insert(processClaims)
      .values({
        organizationId: ctx.organizationId,
        processId: b.processId,
        description: clip(c.description, 500),
        claimedAmountCents: amount,
        origin: "ai_suggested",
        status: "pending_confirmation",
        sourceBriefId: b.id,
        sourceIndex: c.index,
        sourceNote: briefSourceNote(b, c.citations),
        createdById: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ id: processClaims.id });
    if (rows.length) {
      created += 1;
      keys.descriptions.add(norm);
    }
  }
  const skipped = eligible.length - created;
  if (created > 0) {
    await recordAudit(
      ctx,
      {
        action: "claim.suggest",
        entityType: "legal_process",
        entityId: b.processId,
        summary:
          `${created} pedido(s) sugerido(s) pela análise preliminar v${b.version}${b.mode === "demo" ? " (simulação, demonstrativo)" : ""} ` +
          `registrado(s) no processo ${processNumber}, aguardando confirmação.`,
        metadata: { briefId: b.id, created, skipped },
      },
      tx,
    );
  }
  return { created, skipped };
}

/**
 * Explicit user action: brings the claims of the latest preliminary analysis of
 * the process as SUGGESTIONS (`ai_suggested`, pending confirmation). They do
 * not count in the risk until a person confirms them. Idempotent.
 */
export async function suggestClaimsFromBrief(ctx: AuthContext, briefId: string): Promise<{ processId: string; created: number; skipped: number }> {
  assertCan(ctx, "process:write");
  assertCan(ctx, "brief:read");
  requirePerson(ctx);
  return getDb().transaction(async (tx) => {
    const [b] = await tx
      .select({
        id: caseBriefs.id,
        processId: caseBriefs.processId,
        version: caseBriefs.version,
        mode: caseBriefs.mode,
        status: caseBriefs.status,
        content: caseBriefs.content,
      })
      .from(caseBriefs)
      .where(and(eq(caseBriefs.id, parseId(briefId)), caseBriefWhere(ctx)));
    if (!b) throw new NotFoundError("Análise preliminar não encontrada ou sem permissão de acesso.");
    const p = await loadVisibleProcess(ctx, b.processId, tx);
    await lockProcess(ctx.organizationId, p.id, tx);
    if (!b.content || !APPLICABLE_BRIEF_STATUSES.includes(b.status)) {
      throw new ConflictError("Somente análises prontas, em revisão ou aprovadas podem sugerir pedidos.");
    }
    const latest = await latestBriefOfProcess(ctx.organizationId, p.id, tx);
    if (latest && latest.id !== b.id) {
      throw new ConflictError("Existe uma versão mais recente da análise preliminar: use a versão atual.");
    }
    const result = await createSuggestions(ctx, { ...b, content: b.content }, p.number, tx);
    return { processId: p.id, ...result };
  });
}

/**
 * System hook (for the briefs pipeline): when a brief becomes ready, its claims
 * become suggestions pending confirmation. Never confirms anything. Returns
 * zeros when the brief is not applicable or not the latest version.
 */
export async function suggestClaimsFromBriefAsSystem(
  organizationId: string,
  briefId: string,
): Promise<{ created: number; skipped: number }> {
  const ctx = systemContext(organizationId);
  return getDb().transaction(async (tx) => {
    const [b] = await tx
      .select({
        id: caseBriefs.id,
        processId: caseBriefs.processId,
        version: caseBriefs.version,
        mode: caseBriefs.mode,
        status: caseBriefs.status,
        content: caseBriefs.content,
      })
      .from(caseBriefs)
      .where(and(eq(caseBriefs.id, parseId(briefId)), eq(caseBriefs.organizationId, organizationId)));
    if (!b || !b.content || !APPLICABLE_BRIEF_STATUSES.includes(b.status)) return { created: 0, skipped: 0 };
    const [p] = await tx
      .select({ id: legalProcesses.id, number: legalProcesses.number })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, b.processId), eq(legalProcesses.organizationId, organizationId), isNull(legalProcesses.deletedAt)));
    if (!p) return { created: 0, skipped: 0 };
    await lockProcess(organizationId, p.id, tx);
    const latest = await latestBriefOfProcess(organizationId, p.id, tx);
    if (latest && latest.id !== b.id) return { created: 0, skipped: 0 };
    return createSuggestions(ctx, { ...b, content: b.content }, p.number, tx);
  });
}
