/**
 * Pedidos do processo: risk per claim, derived process risk, append-only
 * assessments, manual override persistence, suggestions from the preliminary
 * analysis and row visibility (external counsel firm scope, organization isolation).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StoredCaseBrief } from "@/domain/case-brief";
import { percentageForClassification } from "@/domain/contingency";
import {
  applyDerivedRisk,
  assessClaim,
  confirmClaim,
  createClaim,
  dismissClaim,
  getClaimRiskLinkKinds,
  getProcessClaims,
  overrideProcessRisk,
  removeClaim,
  reviewAlertKey,
  suggestClaimsFromBrief,
  updateClaim,
} from "@/modules/claims/service";
import { claimsRiskAttribution } from "@/modules/claims/labels";
import { loadSettings } from "@/modules/contingency/internal";
import { addRiskAssessment, listRiskAssessments } from "@/modules/contingency/risk-service";
import { addValuation } from "@/modules/contingency/service";
import { getDb } from "@/server/db/client";
import {
  alerts,
  auditLogs,
  caseBriefs,
  legalProcesses,
  processClaimAssessments,
  processClaimRiskLinks,
  processClaims,
  processRiskAssessments,
} from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, today, type Fixture } from "../helpers/fixtures";

let fx: Fixture;
/** Organization percentage of "Provável" (bp). */
let probableBp: number;
/** Process of unit SP linked to law firm A (visible to the external counsel). */
let pFirm: string;
/** Process of unit SP without law firm (invisible to the external counsel). */
let pSp: string;

async function setLawFirm(processId: string, lawFirmId: string | null) {
  await getDb().update(legalProcesses).set({ lawFirmId }).where(eq(legalProcesses.id, processId));
}

async function riskRows(processId: string) {
  return getDb()
    .select()
    .from(processRiskAssessments)
    .where(eq(processRiskAssessments.processId, processId))
    .orderBy(asc(processRiskAssessments.createdAt));
}

async function openReviewAlerts(processId: string) {
  return getDb()
    .select()
    .from(alerts)
    .where(and(eq(alerts.organizationId, fx.orgA), eq(alerts.dedupeKey, reviewAlertKey(processId)), isNull(alerts.resolvedAt)));
}

async function processMirror(processId: string) {
  const [p] = await getDb()
    .select({ lossProbability: legalProcesses.lossProbability, riskPercentageBp: legalProcesses.riskPercentageBp })
    .from(legalProcesses)
    .where(eq(legalProcesses.id, processId));
  return p;
}

function emptyBrief(claims: StoredCaseBrief["claims"]): StoredCaseBrief {
  return {
    headline: "Resumo fictício de teste.",
    identification: [],
    factsSummary: [],
    timeline: [],
    claims,
    amounts: [],
    evidence: [],
    plaintiffArguments: [],
    defendantArguments: [],
    contradictions: [],
    missingDocuments: [],
    theses: [],
    risks: [],
    urgencies: [],
    nextSteps: [],
    possibleDeadlines: [],
    gaps: [],
    limitations: [],
    promptInjectionSuspected: false,
    systemNotices: [],
  };
}

beforeAll(async () => {
  fx = await setupFixture("claims");
  probableBp = percentageForClassification((await loadSettings(fx.orgA)).contingency.riskPercentages, "probable");
  pFirm = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
  await setLawFirm(pFirm, fx.lawFirmA);
  pSp = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("derived process risk", () => {
  let claimA: string;
  let claimB: string;
  let claimC: string;

  it("creates manual claims as confirmed and lists them with process:read", async () => {
    claimA = (
      await createClaim(fx.ctx.lawyer, pSp, {
        description: "Horas extras (fictício)",
        category: "overtime",
        claimedAmountCents: 10_000_000,
        amountBaseDate: "2026-01-10",
        correctionIndex: "ipca_e",
      })
    ).id;
    claimB = (
      await createClaim(fx.ctx.lawyer, pSp, {
        description: "Dano moral (fictício)",
        category: "moral_damages",
        claimedAmountCents: 5_000_000,
        amountBaseDate: "2026-01-10",
      })
    ).id;
    claimC = (await createClaim(fx.ctx.lawyer, pSp, { description: "Multa do artigo 477 (fictício, sem valor)" })).id;

    const overview = await getProcessClaims(fx.ctx.analyst, pSp);
    expect(overview.claims.map((c) => c.id)).toEqual([claimA, claimB, claimC]);
    expect(overview.claims.every((c) => c.status === "confirmed" && c.origin === "manual")).toBe(true);
    expect(overview.claims[2].claimedAmountCents).toBeNull();
    expect(overview.risk?.derivation.classification).toBeNull();
    expect(overview.risk?.derivation.unassessed).toHaveLength(3);
  });

  it("requires a base date when the claim has a value", async () => {
    await expect(createClaim(fx.ctx.lawyer, pSp, { description: "Pedido sem data-base", claimedAmountCents: 100 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("assessing a claim records a NEW official process assessment derived from the claims", async () => {
    const r = await assessClaim(fx.ctx.lawyer, claimA, {
      classification: "probable",
      percentage: 100,
      opinion: "Parecer fictício: prova documental desfavorável.",
      effectiveFrom: today(),
    });
    expect(r.derivation.status).toBe("recorded");
    const rows = await riskRows(pSp);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ classification: "probable", percentageBp: 10_000, status: "official", origin: "system" });
    expect(rows[0].opinion.startsWith("Derivado dos pedidos:")).toBe(true);
    expect(rows[0].reviewedById).toBe(fx.ctx.lawyer.userId);
    expect(await processMirror(pSp)).toEqual({ lossProbability: "probable", riskPercentageBp: 10_000 });

    // Base defaulted to the claim value, with its base date and index.
    const [assessment] = await getDb().select().from(processClaimAssessments).where(eq(processClaimAssessments.id, r.id));
    expect(assessment).toMatchObject({ baseAmountCents: 10_000_000, baseDate: "2026-01-10", correctionIndex: "ipca_e" });
  });

  it("provision = Σ base × % and the process records the weighted percentage", async () => {
    const r = await assessClaim(fx.ctx.lawyer, claimB, {
      classification: "possible",
      percentage: 50,
      opinion: "Parecer fictício: tese controvertida.",
      effectiveFrom: today(),
    });
    expect(r.derivation.status).toBe("recorded");
    const overview = await getProcessClaims(fx.ctx.lawyer, pSp);
    const d = overview.risk!.derivation;
    expect(d.classification).toBe("probable");
    expect(d.provisionCents).toBe(10_000_000 + 2_500_000);
    expect(d.quantifiedBaseCents).toBe(15_000_000);
    expect(overview.risk!.derivedBp).toBe(8_333);
    expect(overview.risk!.inForce).toMatchObject({ classification: "probable", percentageBp: 8_333, link: "derived" });
    expect(overview.risk!.differs).toBe(false);
    expect(await riskRows(pSp)).toHaveLength(2);
  });

  it("an unquantified claim is listed, not summed; mixed with quantified claims the organization percentage is recorded and flagged", async () => {
    const r = await assessClaim(fx.ctx.lawyer, claimC, {
      classification: "probable",
      percentage: null,
      opinion: "Parecer fictício: pedido sem valor na inicial.",
      effectiveFrom: today(),
    });
    expect(r.derivation).toMatchObject({ status: "recorded", needsReview: true });
    const overview = await getProcessClaims(fx.ctx.lawyer, pSp);
    expect(overview.risk!.derivation.unquantified.map((c) => c.id)).toEqual([claimC]);
    expect(overview.risk!.derivation.provisionCents).toBe(12_500_000);
    expect(overview.claims.find((c) => c.id === claimC)!.assessment!.provisionCents).toBeNull();
    // The weighted 83,33% would count C as zero: the organization percentage of "Provável" is recorded instead.
    expect(overview.risk!.derivedRate).toEqual({ bp: probableBp, basis: "organization_unquantified", weightedBp: 8_333 });
    expect(overview.risk!.derivedNeedsReview).toBe(true);
    expect(overview.risk!.inForce).toMatchObject({ classification: "probable", percentageBp: probableBp, link: "derived" });
    const rows = await riskRows(pSp);
    expect(rows).toHaveLength(3);
    expect(rows[2].opinion).toContain("não vale zero");
    expect(await openReviewAlerts(pSp)).toHaveLength(1);
  });

  it("claim assessments are append-only (a new assessment is a new dated record)", async () => {
    const [before] = await getDb()
      .select()
      .from(processClaimAssessments)
      .where(eq(processClaimAssessments.claimId, claimA));
    await assessClaim(fx.ctx.lawyer, claimA, {
      classification: "remote",
      percentage: 0,
      opinion: "Parecer fictício: acordo coletivo juntado aos autos.",
      effectiveFrom: today(),
    });
    const rows = await getDb()
      .select()
      .from(processClaimAssessments)
      .where(eq(processClaimAssessments.claimId, claimA))
      .orderBy(asc(processClaimAssessments.createdAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before);
    const overview = await getProcessClaims(fx.ctx.lawyer, pSp);
    const a = overview.claims.find((c) => c.id === claimA)!;
    expect(a.history).toHaveLength(2);
    expect(a.assessment!.classification).toBe("remote");
    expect(a.history.filter((h) => h.inForce)).toHaveLength(1);
    // C (unquantified) is still probable: worst classification stays probable with the organization percentage
    // (the weighted 16,67% of the quantified claims would count C as zero).
    expect(overview.risk!.derivedRate).toMatchObject({ bp: probableBp, weightedBp: 1_667 });
    expect(overview.risk!.inForce).toMatchObject({ classification: "probable", percentageBp: probableBp });
  });

  it("rejects an assessment that starts in the future", async () => {
    await expect(
      assessClaim(fx.ctx.lawyer, claimA, {
        classification: "remote",
        percentage: null,
        opinion: "Parecer fictício com data futura.",
        effectiveFrom: "2999-01-01",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("override needs a classification different from the derived one", async () => {
    await expect(
      overrideProcessRisk(fx.ctx.lawyer, pSp, {
        classification: "probable",
        percentage: probableBp / 100,
        justification: "Justificativa fictícia igual à derivada.",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps a manual override when claim assessments change and flags it for review", async () => {
    await overrideProcessRisk(fx.ctx.manager, pSp, {
      classification: "possible",
      percentage: 30,
      justification: "Justificativa fictícia: jurisprudência local favorável à empresa.",
    });
    let overview = await getProcessClaims(fx.ctx.lawyer, pSp);
    expect(overview.risk!.inForce).toMatchObject({ classification: "possible", percentageBp: 3_000, link: "override", origin: "manual" });
    expect(overview.risk!.inForce!.opinion).toContain("Justificativa");
    expect(overview.risk!.overrideInForce).toBe(true);
    expect(overview.risk!.overrideKind).toBe("panel");
    expect(overview.risk!.overrideNeedsReview).toBe(false);
    // The justified override is the human review of the unquantified flag.
    expect(await openReviewAlerts(pSp)).toHaveLength(0);
    const countBefore = (await riskRows(pSp)).length;

    const r = await assessClaim(fx.ctx.lawyer, claimB, {
      classification: "probable",
      percentage: 100,
      opinion: "Parecer fictício: nova prova testemunhal.",
      effectiveFrom: today(),
    });
    expect(r.derivation).toEqual({ status: "override_kept", needsReview: true });
    expect(await riskRows(pSp)).toHaveLength(countBefore);
    expect(await processMirror(pSp)).toEqual({ lossProbability: "possible", riskPercentageBp: 3_000 });
    overview = await getProcessClaims(fx.ctx.lawyer, pSp);
    expect(overview.risk!.overrideNeedsReview).toBe(true);
    const open = await getDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.organizationId, fx.orgA), eq(alerts.dedupeKey, reviewAlertKey(pSp))));
    expect(open.filter((x) => !x.resolvedAt)).toHaveLength(1);
    expect(open[0].type).toBe("claims_risk_review");

    // An explicit "apply derived" ends the override; C is still unquantified, so the derived record is flagged.
    const applied = await applyDerivedRisk(fx.ctx.lawyer, pSp);
    expect(applied).toMatchObject({ status: "recorded", needsReview: true });
    overview = await getProcessClaims(fx.ctx.lawyer, pSp);
    expect(overview.risk!.inForce).toMatchObject({ classification: "probable", link: "derived" });
    expect(overview.risk!.overrideInForce).toBe(false);
    const after = await openReviewAlerts(pSp);
    expect(after).toHaveLength(1);
    expect(after[0].message).toContain("sem valor");
    await expect(applyDerivedRisk(fx.ctx.lawyer, pSp)).rejects.toBeInstanceOf(ConflictError);

    const links = await getDb().select().from(processClaimRiskLinks).where(eq(processClaimRiskLinks.processId, pSp));
    expect(links.map((l) => l.kind).sort()).toEqual(["derived", "derived", "derived", "derived", "override"]);
  });

  it("removing an assessed claim runs the derivation again", async () => {
    // C (probable, unquantified) leaves: every assessed claim is quantified again, so the weighted rate is
    // recorded (A remote 0% of 10M, B probable 100% of 5M = 33,33%) and the review flag is resolved.
    const r = await removeClaim(fx.ctx.lawyer, claimC, { reason: "Lançado em duplicidade (teste)." });
    expect(r.derivation).toMatchObject({ status: "recorded", needsReview: false });
    const overview = await getProcessClaims(fx.ctx.lawyer, pSp);
    expect(overview.claims.map((c) => c.id)).not.toContain(claimC);
    expect(overview.risk!.derivation.unquantified).toHaveLength(0);
    expect(overview.risk!.inForce).toMatchObject({ classification: "probable", percentageBp: 3_333, link: "derived" });
    expect(overview.risk!.derivedNeedsReview).toBe(false);
    expect(await openReviewAlerts(pSp)).toHaveLength(0);
  });

  it("edits keep the base used by existing assessments and are audited without the description", async () => {
    await updateClaim(fx.ctx.lawyer, claimB, {
      description: "Dano moral por assédio (texto que não pode ir para a auditoria)",
      category: "moral_damages",
      claimedAmountCents: 6_000_000,
      amountBaseDate: "2026-02-01",
    });
    const overview = await getProcessClaims(fx.ctx.lawyer, pSp);
    const b = overview.claims.find((c) => c.id === claimB)!;
    expect(b.assessment!.baseAmountCents).toBe(5_000_000);
    expect(b.baseDiffersFromClaim).toBe(true);
    const logs = await getDb().select().from(auditLogs).where(eq(auditLogs.entityId, pSp));
    const text = JSON.stringify(logs);
    expect(text).not.toContain("assédio");
    expect(text).not.toContain("Horas extras (fictício)");
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining([
        "claim.create",
        "claim.update",
        "claim.delete",
        "claim_assessment.create",
        "risk_assessment.derive",
        "risk_assessment.override",
      ]),
    );
  });
});

describe("review flags: null is not zero and manual classifications are never undone silently", () => {
  it("worst claim unquantified: the official percentage is the organization one, never the 0% of the quantified claims", async () => {
    const p = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
    await addValuation(fx.ctx.accountant, { processId: p, kind: "claim", amountCents: 10_000_000, baseDate: "2026-01-10" });
    const a = (await createClaim(fx.ctx.lawyer, p, { description: "Dano moral sem valor (fictício)" })).id;
    const b = (
      await createClaim(fx.ctx.lawyer, p, { description: "FGTS (fictício)", claimedAmountCents: 5_000_000, amountBaseDate: "2026-01-10" })
    ).id;
    const first = await assessClaim(fx.ctx.lawyer, b, {
      classification: "remote",
      percentage: 0,
      opinion: "Parecer fictício remoto.",
      effectiveFrom: today(),
    });
    expect(first.derivation).toMatchObject({ status: "recorded", needsReview: false });
    expect(await openReviewAlerts(p)).toHaveLength(0);

    const r = await assessClaim(fx.ctx.lawyer, a, {
      classification: "probable",
      percentage: 100,
      opinion: "Parecer fictício provável.",
      effectiveFrom: today(),
    });
    expect(r.derivation).toMatchObject({ status: "recorded", needsReview: true });
    const mirror = await processMirror(p);
    expect(mirror).toEqual({ lossProbability: "probable", riskPercentageBp: probableBp });
    // Official provision = valor da causa x organization percentage: the unquantified probable claim is not zero.
    const [proc] = await getDb()
      .select({ provision: legalProcesses.provisionAmountCents })
      .from(legalProcesses)
      .where(eq(legalProcesses.id, p));
    expect(proc.provision).toBe(Math.round((10_000_000 * probableBp) / 10_000));
    expect(proc.provision).toBeGreaterThan(0);

    const overview = await getProcessClaims(fx.ctx.lawyer, p);
    const risk = overview.risk!;
    expect(risk.derivation.provisionCents).toBe(0);
    expect(risk.derivation.unquantified.map((c) => c.id)).toEqual([a]);
    expect(risk.derivedRate).toEqual({ bp: probableBp, basis: "organization_unquantified", weightedBp: 0 });
    expect(risk.derivedNeedsReview).toBe(true);
    // The panel shows the official provision next to the claims provision and flags the difference.
    expect(risk.official?.provision.provisionCents).toBe(proc.provision);
    expect(risk.official?.provision.base).toBe("claim");
    expect(risk.provisionDiffers).toBe(true);
    const open = await openReviewAlerts(p);
    expect(open).toHaveLength(1);
    expect(open[0].message).toContain("sem valor");
    const rows = await riskRows(p);
    expect(rows.at(-1)!.opinion).toContain("não vale zero");
    expect(rows.at(-1)!.opinion).not.toMatch(/—| – /);
  });

  it("an official classification recorded in the Valores tab after the claims is kept and flagged when a claim changes", async () => {
    const p = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
    const c = (await createClaim(fx.ctx.lawyer, p, { description: "Horas extras (fictício)" })).id;
    await assessClaim(fx.ctx.lawyer, c, { classification: "possible", percentage: null, opinion: "Parecer fictício 1.", effectiveFrom: today() });
    const manual = await addRiskAssessment(fx.ctx.manager, p, {
      classification: "probable",
      percentage: null,
      opinion: "Classificação manual fictícia pela aba de valores, com fundamento.",
      effectiveFrom: today(),
    });
    let overview = await getProcessClaims(fx.ctx.lawyer, p);
    expect(overview.risk!.inForce).toMatchObject({ id: manual.id, classification: "probable", link: null });
    expect(overview.risk!.differs).toBe(true);
    expect(overview.risk!.overrideInForce).toBe(true);
    expect(overview.risk!.overrideKind).toBe("outside_panel");
    expect(overview.risk!.overrideNeedsReview).toBe(false);
    const before = (await riskRows(p)).length;

    const r = await assessClaim(fx.ctx.lawyer, c, { classification: "remote", percentage: null, opinion: "Parecer fictício 2.", effectiveFrom: today() });
    expect(r.derivation).toEqual({ status: "override_kept", needsReview: true });
    expect(await riskRows(p)).toHaveLength(before);
    expect((await processMirror(p)).lossProbability).toBe("probable");
    overview = await getProcessClaims(fx.ctx.lawyer, p);
    expect(overview.risk!.inForce).toMatchObject({ id: manual.id, classification: "probable" });
    expect(overview.risk!.overrideNeedsReview).toBe(true);
    const open = await openReviewAlerts(p);
    expect(open).toHaveLength(1);
    expect(open[0].message).toContain("aba de valores e risco");

    // Only an explicit action replaces it.
    expect((await applyDerivedRisk(fx.ctx.lawyer, p)).status).toBe("recorded");
    overview = await getProcessClaims(fx.ctx.lawyer, p);
    expect(overview.risk!.inForce).toMatchObject({ classification: "remote", link: "derived" });
    expect(overview.risk!.overrideInForce).toBe(false);
    expect(await openReviewAlerts(p)).toHaveLength(0);
  });

  it("a classification recorded before any claim assessment is not an override: the derivation replaces it", async () => {
    const p = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
    await addRiskAssessment(fx.ctx.manager, p, {
      classification: "probable",
      percentage: null,
      opinion: "Classificação fictícia anterior aos pedidos.",
      effectiveFrom: today(),
    });
    const c = (await createClaim(fx.ctx.lawyer, p, { description: "Insalubridade (fictício)" })).id;
    const r = await assessClaim(fx.ctx.lawyer, c, { classification: "possible", percentage: null, opinion: "Parecer fictício.", effectiveFrom: today() });
    expect(r.derivation.status).toBe("recorded");
    const overview = await getProcessClaims(fx.ctx.lawyer, p);
    expect(overview.risk!.inForce).toMatchObject({ classification: "possible", link: "derived" });
    expect(overview.risk!.overrideInForce).toBe(false);
  });

  it("an override is flagged when every assessed claim is removed", async () => {
    const p = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
    const c = (await createClaim(fx.ctx.lawyer, p, { description: "Insalubridade (fictício)" })).id;
    await assessClaim(fx.ctx.lawyer, c, { classification: "possible", percentage: null, opinion: "Parecer fictício 1.", effectiveFrom: today() });
    await overrideProcessRisk(fx.ctx.lawyer, p, {
      classification: "probable",
      percentage: null,
      justification: "Justificativa fictícia longa o suficiente.",
    });
    const r = await removeClaim(fx.ctx.lawyer, c, { reason: "Lançado por engano (teste)." });
    expect(r.derivation).toEqual({ status: "override_kept", needsReview: true });
    const overview = await getProcessClaims(fx.ctx.lawyer, p);
    expect(overview.risk!.derivation.classification).toBeNull();
    expect(overview.risk!.overrideInForce).toBe(true);
    expect(overview.risk!.overrideKind).toBe("panel");
    expect(overview.risk!.overrideNeedsReview).toBe(true);
    expect((await processMirror(p)).lossProbability).toBe("probable");
    const open = await openReviewAlerts(p);
    expect(open).toHaveLength(1);
    expect(open[0].message).toContain("nenhum pedido confirmado tem mais avaliação vigente");
  });

  it("a derived classification whose claims lose every assessment is kept and flagged", async () => {
    const p = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
    const c = (await createClaim(fx.ctx.lawyer, p, { description: "Equiparação salarial (fictício)" })).id;
    await assessClaim(fx.ctx.lawyer, c, { classification: "possible", percentage: null, opinion: "Parecer fictício.", effectiveFrom: today() });
    const r = await removeClaim(fx.ctx.lawyer, c, { reason: "Lançado por engano (teste)." });
    expect(r.derivation).toEqual({ status: "no_assessed_claims", needsReview: true });
    const overview = await getProcessClaims(fx.ctx.lawyer, p);
    expect(overview.risk!.derivedWithoutBasis).toBe(true);
    expect(overview.risk!.inForce).toMatchObject({ classification: "possible", link: "derived" });
    expect(await openReviewAlerts(p)).toHaveLength(1);

    // A new assessed claim gives the derivation a basis again and resolves the flag.
    const d = (await createClaim(fx.ctx.lawyer, p, { description: "Verbas rescisórias (fictício)" })).id;
    await assessClaim(fx.ctx.lawyer, d, { classification: "possible", percentage: null, opinion: "Parecer fictício.", effectiveFrom: today() });
    expect((await getProcessClaims(fx.ctx.lawyer, p)).risk!.derivedWithoutBasis).toBe(false);
    expect(await openReviewAlerts(p)).toHaveLength(0);
  });

  it("links tell derived rows apart from rule suggestions in the risk history", async () => {
    const p = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
    const c = (await createClaim(fx.ctx.lawyer, p, { description: "Horas extras (fictício)" })).id;
    await assessClaim(fx.ctx.lawyer, c, { classification: "possible", percentage: null, opinion: "Parecer fictício.", effectiveFrom: today() });
    const { id: overrideId } = await overrideProcessRisk(fx.ctx.lawyer, p, {
      classification: "remote",
      percentage: null,
      justification: "Justificativa fictícia longa o suficiente.",
    });
    const kinds = await getClaimRiskLinkKinds(fx.ctx.accountant, p);
    const history = await listRiskAssessments(fx.ctx.accountant, p);
    const derived = history.find((h) => kinds[h.id] === "derived")!;
    expect(derived.origin).toBe("system");
    expect(kinds[overrideId]).toBe("override");
    const label = claimsRiskAttribution("derived", derived);
    expect(label).toContain("Derivada dos pedidos");
    expect(label).not.toContain("Sugestão");
    expect(label).not.toMatch(/—| – /);
    expect(claimsRiskAttribution("override", history.find((h) => h.id === overrideId)!)).toContain("Definida manualmente");
    await expect(getClaimRiskLinkKinds(fx.ctx.adminB, p)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getClaimRiskLinkKinds(fx.ctx.lawyerRe, p)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("permissions", () => {
  it("claims need process:write; assessments need contingency:write", async () => {
    await expect(createClaim(fx.ctx.accountant, pSp, { description: "Pedido do contador" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createClaim(fx.ctx.analyst, pSp, { description: "Pedido do analista" })).rejects.toBeInstanceOf(ForbiddenError);
    const { id } = await createClaim(fx.ctx.lawyer, pSp, { description: "FGTS (fictício)", category: "fgts" });
    await expect(
      assessClaim(fx.ctx.executive, id, { classification: "remote", percentage: null, opinion: "Parecer da diretoria.", effectiveFrom: today() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const r = await assessClaim(fx.ctx.accountant, id, {
      classification: "remote",
      percentage: null,
      opinion: "Parecer fictício da contabilidade.",
      effectiveFrom: today(),
    });
    expect(r.processId).toBe(pSp);
  });

  it("read-only profiles see claims and risk but cannot act", async () => {
    const overview = await getProcessClaims(fx.ctx.executive, pSp);
    expect(overview.risk).not.toBeNull(); // executive has contingency:read
    expect(overview.permissions).toEqual({ canEditClaims: false, canAssess: false });
    expect(overview.briefOffer).toBeNull();
  });
});

describe("visibility", () => {
  let firmClaim: string;
  let spClaim: string;

  beforeAll(async () => {
    firmClaim = (await createClaim(fx.ctx.externalCounsel, pFirm, { description: "Verbas rescisórias (fictício)", category: "severance_pay" })).id;
    spClaim = (await createClaim(fx.ctx.manager, pSp, { description: "Equiparação salarial (fictício)" })).id;
  });

  it("external counsel sees and assesses only processes of their law firm", async () => {
    const overview = await getProcessClaims(fx.ctx.externalCounsel, pFirm);
    expect(overview.claims.map((c) => c.id)).toEqual([firmClaim]);
    const r = await assessClaim(fx.ctx.externalCounsel, firmClaim, {
      classification: "possible",
      percentage: null,
      opinion: "Parecer fictício do escritório externo.",
      effectiveFrom: today(),
    });
    expect(r.derivation.status).toBe("recorded");

    await expect(getProcessClaims(fx.ctx.externalCounsel, pSp)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createClaim(fx.ctx.externalCounsel, pSp, { description: "Pedido indevido" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      assessClaim(fx.ctx.externalCounsel, spClaim, { classification: "remote", percentage: null, opinion: "Parecer indevido.", effectiveFrom: today() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateClaim(fx.ctx.externalCounsel, spClaim, { description: "Alteração indevida" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the firm loses access when the process leaves it", async () => {
    await setLawFirm(pFirm, null);
    await expect(getProcessClaims(fx.ctx.externalCounsel, pFirm)).rejects.toBeInstanceOf(NotFoundError);
    await setLawFirm(pFirm, fx.lawFirmA);
  });

  it("a lawyer of another unit (RE) never sees or changes claims of an SP process", async () => {
    const before = await getDb().select().from(processClaims).where(eq(processClaims.processId, pSp));
    const risksBefore = (await riskRows(pSp)).length;
    await expect(getProcessClaims(fx.ctx.lawyerRe, pSp)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createClaim(fx.ctx.lawyerRe, pSp, { description: "Pedido indevido RE" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateClaim(fx.ctx.lawyerRe, spClaim, { description: "Alteração indevida RE" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      assessClaim(fx.ctx.lawyerRe, spClaim, { classification: "remote", percentage: null, opinion: "Parecer indevido RE.", effectiveFrom: today() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeClaim(fx.ctx.lawyerRe, spClaim, { reason: "Exclusão indevida RE" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(applyDerivedRisk(fx.ctx.lawyerRe, pSp)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      overrideProcessRisk(fx.ctx.lawyerRe, pSp, { classification: "remote", percentage: null, justification: "Justificativa indevida da unidade RE." }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await getDb().select().from(processClaims).where(eq(processClaims.processId, pSp))).toEqual(before);
    expect(await riskRows(pSp)).toHaveLength(risksBefore);
  });

  it("another organization never sees the claims", async () => {
    await expect(getProcessClaims(fx.ctx.adminB, pSp)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      assessClaim(fx.ctx.adminB, spClaim, { classification: "remote", percentage: null, opinion: "Parecer de outra organização.", effectiveFrom: today() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeClaim(fx.ctx.adminB, spClaim, { reason: "Outra organização" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(overrideProcessRisk(fx.ctx.adminB, pSp, { classification: "remote", percentage: null, justification: "Justificativa de outra organização." })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("suggestions from the preliminary analysis", () => {
  let pBrief: string;
  let briefId: string;

  beforeAll(async () => {
    pBrief = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, filedAt: "2026-03-02" });
    const citation = { ref: "D1", page: 3, excerpt: "trecho literal que não deve ser copiado" };
    const [b] = await getDb()
      .insert(caseBriefs)
      .values({
        organizationId: fx.orgA,
        processId: pBrief,
        version: 1,
        status: "ready_for_review",
        mode: "demo",
        provider: "simulated",
        model: "simulacao",
        promptVersion: "test",
        inputHash: "test",
        content: emptyBrief([
          { description: "Horas extras e reflexos", amountCents: 3_000_000, provenance: "extracted", citations: [citation], note: null },
          { description: "Indenização por dano moral", amountCents: null, provenance: "extracted", citations: [citation], note: null },
          { description: "Exemplo ilustrativo", amountCents: 10, provenance: "illustrative", citations: [], note: null },
          { description: "Pedido não localizado", amountCents: null, provenance: "missing", citations: [], note: null },
        ]),
      })
      .returning({ id: caseBriefs.id });
    briefId = b.id;
  });

  it("offers and creates ai_suggested claims pending confirmation (idempotent)", async () => {
    let overview = await getProcessClaims(fx.ctx.lawyer, pBrief);
    expect(overview.briefOffer).toMatchObject({ briefId, version: 1, demo: true, eligible: 2, notImported: 2 });

    const first = await suggestClaimsFromBrief(fx.ctx.lawyer, briefId);
    expect(first).toMatchObject({ processId: pBrief, created: 2 });
    const second = await suggestClaimsFromBrief(fx.ctx.lawyer, briefId);
    expect(second.created).toBe(0);

    overview = await getProcessClaims(fx.ctx.lawyer, pBrief);
    expect(overview.claims).toHaveLength(2);
    expect(overview.claims.every((c) => c.origin === "ai_suggested" && c.status === "pending_confirmation" && c.sourceIsDemo)).toBe(true);
    expect(overview.claims[0].sourceNote).toContain("SIMULAÇÃO");
    expect(overview.claims[0].sourceNote).toContain("D1, p. 3");
    expect(overview.claims[0].sourceNote).not.toContain("trecho literal");
    expect(overview.briefOffer?.notImported).toBe(0);
    expect(overview.risk!.derivation.pendingConfirmation).toHaveLength(2);
  });

  it("suggested claims do not count until a person confirms them", async () => {
    const overview = await getProcessClaims(fx.ctx.lawyer, pBrief);
    const withValue = overview.claims.find((c) => c.claimedAmountCents !== null)!;
    const withoutValue = overview.claims.find((c) => c.claimedAmountCents === null)!;
    await expect(
      assessClaim(fx.ctx.lawyer, withValue.id, { classification: "probable", percentage: null, opinion: "Parecer fictício.", effectiveFrom: today() }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await riskRows(pBrief)).toHaveLength(0);

    await expect(confirmClaim(fx.ctx.lawyer, withValue.id, { description: withValue.description, claimedAmountCents: 3_000_000 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await confirmClaim(fx.ctx.lawyer, withValue.id, {
      description: withValue.description,
      category: "overtime",
      claimedAmountCents: 3_000_000,
      amountBaseDate: "2026-03-02",
    });
    await dismissClaim(fx.ctx.lawyer, withoutValue.id, { reason: "Não consta da petição (teste)." });
    await expect(dismissClaim(fx.ctx.lawyer, withValue.id, {})).rejects.toBeInstanceOf(ConflictError);

    const r = await assessClaim(fx.ctx.lawyer, withValue.id, {
      classification: "probable",
      percentage: null,
      opinion: "Parecer fictício após confirmação.",
      effectiveFrom: today(),
    });
    expect(r.derivation.status).toBe("recorded");
    const after = await getProcessClaims(fx.ctx.lawyer, pBrief);
    expect(after.risk!.derivation.classification).toBe("probable");
    expect(after.risk!.derivation.provisionCents).toBe(3_000_000);
    expect(after.claims.find((c) => c.id === withoutValue.id)!.status).toBe("dismissed");

    // A dismissed suggestion is not suggested again.
    expect((await suggestClaimsFromBrief(fx.ctx.lawyer, briefId)).created).toBe(0);
    const stored = await getDb().select().from(processClaims).where(eq(processClaims.processId, pBrief));
    expect(stored).toHaveLength(2);
  });

  it("a removed manual claim does not block the same description; a used brief item is never suggested again", async () => {
    const p = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
    const manual = (await createClaim(fx.ctx.lawyer, p, { description: "Horas extras e reflexos" })).id;
    await removeClaim(fx.ctx.lawyer, manual, { reason: "Lançado por engano (teste)." });
    const [b] = await getDb()
      .insert(caseBriefs)
      .values({
        organizationId: fx.orgA,
        processId: p,
        version: 1,
        status: "ready_for_review",
        mode: "demo",
        provider: "simulated",
        model: "simulacao",
        promptVersion: "test",
        inputHash: "test-removed",
        content: emptyBrief([
          { description: "Horas extras e reflexos", amountCents: 100_000, provenance: "extracted", citations: [], note: null },
        ]),
      })
      .returning({ id: caseBriefs.id });
    expect((await getProcessClaims(fx.ctx.lawyer, p)).briefOffer?.notImported).toBe(1);
    expect(await suggestClaimsFromBrief(fx.ctx.lawyer, b.id)).toMatchObject({ created: 1, skipped: 0 });
    const suggested = (await getProcessClaims(fx.ctx.lawyer, p)).claims.find((c) => c.origin === "ai_suggested")!;
    expect(suggested.status).toBe("pending_confirmation");
    await removeClaim(fx.ctx.lawyer, suggested.id, { reason: "Removido para teste." });
    expect(await suggestClaimsFromBrief(fx.ctx.lawyer, b.id)).toMatchObject({ created: 0, skipped: 1 });
  });

  it("the offer needs process:write and brief:read", async () => {
    expect((await getProcessClaims(fx.ctx.accountant, pBrief)).briefOffer).toBeNull();
    await expect(suggestClaimsFromBrief(fx.ctx.accountant, briefId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
