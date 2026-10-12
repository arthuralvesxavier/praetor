/**
 * Claims-derived process assessments and the monthly close gate (P1.6 + P1.9, PGlite).
 *
 * A derived process assessment is dated by the claim assessments that produced
 * it (latest `effective_from` among the counted ones in force), never earlier
 * than the official classification in force, so a claim assessment backdated
 * into a competência satisfies the gate of that competência. Append-only.
 *
 * Competência = previous month (reference date = its last day):
 *   X  claim assessed from day 15 of the competência          -> derived from day 15, classified
 *   Z  manual "remote" from day 25, then claim from day 10       -> derived from day 25 (in force), classified
 *   W  claim assessed from today (after the reference date)      -> derived from today, unclassified
 *   Y  claim not assessed, later assessed from day 20           -> unclassified, then classified (stale preview)
 *   V  claim from day 10, then Valores-tab "remote" from day 25 (override outside the panel), then
 *      "aplicar derivada" today                                  -> derived from TODAY: the human "remote"
 *      stays in force on the reference date (no retroactive replacement)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, desc, eq } from "drizzle-orm";
import { periodReferenceDate, previousPeriod } from "@/domain/contingency";
import { formatDate, todayISO } from "@/lib/format";
import { applyDerivedRisk, assessClaim, createClaim, getProcessClaims } from "@/modules/claims/service";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { periodOf } from "@/modules/contingency/rules";
import { CloseBlockedError, closeSnapshot, generateSnapshot, getCloseGate } from "@/modules/contingency/snapshot-service";
import {
  auditLogs,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processClaimRiskLinks,
  processRiskAssessments,
  snapshotCloseOverrides,
} from "@/server/db/schema";
import { ConflictError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let f: Fixture;
const today = todayISO();
const previous = previousPeriod(periodOf(today));
const ref = periodReferenceDate(previous);
const day = (dd: number) => `${previous}-${String(dd).padStart(2, "0")}`;
const JUSTIFICATION = "Pedido avaliado só depois da data-base; classificação do processo concluída na próxima competência.";

type Key = "X" | "Y" | "Z" | "W" | "V";
const ids: Record<Key, string> = { X: "", Y: "", Z: "", W: "", V: "" };
const claims: Record<Key, string> = { X: "", Y: "", Z: "", W: "", V: "" };
const NUMBER: Record<Key, string> = {
  X: "0004001-11.2025.5.10.0009",
  Y: "0004002-11.2025.5.10.0009",
  Z: "0004003-11.2025.5.10.0009",
  W: "0004004-11.2025.5.10.0009",
  V: "0004005-11.2025.5.10.0009",
};

async function insertProcess(key: Key) {
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      unitId: f.unitSp,
      number: NUMBER[key],
      title: `Processo fictício ${key}`,
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      filedAt: "2025-01-10",
      claimAmountCents: 2_000_000,
    })
    .returning({ id: legalProcesses.id });
  ids[key] = p.id;
  claims[key] = (
    await createClaim(f.ctx.manager, p.id, {
      description: `Horas extras do processo ${key} (fictício)`,
      category: "overtime",
      claimedAmountCents: 1_000_000,
      amountBaseDate: "2025-01-10",
    })
  ).id;
}

const assess = (key: Key, effectiveFrom: string) =>
  assessClaim(f.ctx.manager, claims[key], {
    classification: "probable",
    percentage: null,
    opinion: `Parecer fictício do pedido do processo ${key}.`,
    effectiveFrom,
  });

async function riskRows(processId: string) {
  return f.db
    .select({
      id: processRiskAssessments.id,
      classification: processRiskAssessments.classification,
      effectiveFrom: processRiskAssessments.effectiveFrom,
      origin: processRiskAssessments.origin,
      status: processRiskAssessments.status,
      link: processClaimRiskLinks.kind,
    })
    .from(processRiskAssessments)
    .leftJoin(processClaimRiskLinks, eq(processClaimRiskLinks.riskAssessmentId, processRiskAssessments.id))
    .where(eq(processRiskAssessments.processId, processId))
    .orderBy(asc(processRiskAssessments.createdAt));
}

async function expectError<T extends Error>(p: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected ${type.name}`);
}

beforeAll(async () => {
  f = await setupFixture("claimsgate");
  for (const key of ["X", "Y", "Z", "W", "V"] as const) await insertProcess(key);
}, 180_000);

afterAll(async () => {
  await f?.teardown();
});

describe("effective date of the derived process assessment", () => {
  it("a claim assessment backdated into the competência dates the derived assessment there", async () => {
    const r = await assess("X", day(15));
    expect(r.derivation.status).toBe("recorded");
    const rows = await riskRows(ids.X);
    expect(rows).toEqual([
      expect.objectContaining({ classification: "probable", effectiveFrom: day(15), origin: "system", status: "official", link: "derived" }),
    ]);
    const [audit] = await f.db
      .select({ summary: auditLogs.summary })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.X), eq(auditLogs.action, "risk_assessment.derive")));
    expect(audit.summary).toContain(`vigente desde ${formatDate(day(15))}`);
  });

  it("is never earlier than the official classification in force (the derived one replaces it), append-only", async () => {
    await addRiskAssessment(f.ctx.manager, ids.Z, {
      classification: "remote",
      opinion: "Parecer fictício anterior aos pedidos.",
      effectiveFrom: day(25),
    });
    const r = await assess("Z", day(10));
    expect(r.derivation.status).toBe("recorded");
    const rows = await riskRows(ids.Z);
    expect(rows.map((x) => [x.classification, x.effectiveFrom, x.origin, x.link])).toEqual([
      ["remote", day(25), "manual", null],
      ["probable", day(25), "system", "derived"],
    ]);
    const overview = await getProcessClaims(f.ctx.manager, ids.Z);
    expect(overview.risk?.inForce).toMatchObject({ classification: "probable", link: "derived", effectiveFrom: day(25) });
    const [mirror] = await f.db.select({ loss: legalProcesses.lossProbability }).from(legalProcesses).where(eq(legalProcesses.id, ids.Z));
    expect(mirror.loss).toBe("probable");
  });

  it("a claim assessment from today dates the derived assessment today", async () => {
    await assess("W", today);
    expect((await riskRows(ids.W)).map((x) => x.effectiveFrom)).toEqual([today]);
  });

  it("'aplicar derivada' that ends a past-dated classification of the Valores tab is dated today, append-only", async () => {
    expect((await assess("V", day(10))).derivation.status).toBe("recorded");
    // Recorded after the claim assessment: a human decision the derivations keep (override outside the panel).
    await addRiskAssessment(f.ctx.manager, ids.V, {
      classification: "remote",
      opinion: "Parecer fictício divergente registrado na aba de valores.",
      effectiveFrom: day(25),
    });
    const before = await getProcessClaims(f.ctx.manager, ids.V);
    expect(before.risk?.overrideKind).toBe("outside_panel");

    const out = await applyDerivedRisk(f.ctx.manager, ids.V);
    expect(out.status).toBe("recorded");
    expect((await riskRows(ids.V)).map((x) => [x.classification, x.effectiveFrom, x.origin, x.link])).toEqual([
      ["probable", day(10), "system", "derived"],
      ["remote", day(25), "manual", null],
      ["probable", today, "system", "derived"],
    ]);
    const after = await getProcessClaims(f.ctx.manager, ids.V);
    expect(after.risk?.inForce).toMatchObject({ classification: "probable", link: "derived", effectiveFrom: today });
    const [audit] = await f.db
      .select({ summary: auditLogs.summary, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.V), eq(auditLogs.action, "risk_assessment.derive")))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit.summary).toContain(`vigente desde ${formatDate(today)}`);
    expect(audit.metadata).toMatchObject({ trigger: "manual", endedOverride: "outside_panel", effectiveFrom: today });
  });
});

describe("close gate of the competência", () => {
  it("lists only the processes whose derived classification is not in force on the reference date", async () => {
    await generateSnapshot(f.ctx.manager, previous);
    const gate = await getCloseGate(f.ctx.manager, previous);
    expect(gate.isStale).toBe(false);
    expect(gate.items.map((i) => i.number).sort()).toEqual([NUMBER.W, NUMBER.Y].sort());
    expect(gate.items.find((i) => i.number === NUMBER.W)?.classifiedFrom).toBe(today);
    const err = await expectError(closeSnapshot(f.ctx.manager, previous), CloseBlockedError);
    expect(err.unclassified.map((u) => u.number).sort()).toEqual([NUMBER.W, NUMBER.Y].sort());
  });

  it("assessing the claim backdated into the competência makes the preview stale; recalculated, only W stays pending", async () => {
    await assess("Y", day(20));
    expect((await riskRows(ids.Y)).map((x) => [x.effectiveFrom, x.link])).toEqual([[day(20), "derived"]]);
    await expectError(closeSnapshot(f.ctx.manager, previous, { justification: JUSTIFICATION }), ConflictError);

    await generateSnapshot(f.ctx.manager, previous);
    const gate = await getCloseGate(f.ctx.manager, previous);
    expect(gate.isStale).toBe(false);
    expect(gate.items.map((i) => i.number)).toEqual([NUMBER.W]);
    const blocked = await expectError(closeSnapshot(f.ctx.manager, previous), CloseBlockedError);
    expect(blocked.unclassified.map((u) => u.number)).toEqual([NUMBER.W]);

    const closed = await closeSnapshot(f.ctx.manager, previous, { justification: JUSTIFICATION });
    expect(closed.override?.unclassifiedCount).toBe(1);
    const [override] = await f.db.select().from(snapshotCloseOverrides).where(eq(snapshotCloseOverrides.id, closed.override!.id));
    expect(override.unclassifiedProcessIds).toEqual([ids.W]);

    const [snap] = await f.db
      .select({ id: portfolioSnapshots.id, referenceDate: portfolioSnapshots.referenceDate })
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.organizationId, f.orgA), eq(portfolioSnapshots.period, previous)));
    expect(snap.referenceDate).toBe(ref);
    const items = await f.db.select().from(portfolioSnapshotItems).where(eq(portfolioSnapshotItems.snapshotId, snap.id));
    const classOf = (key: Key) => items.find((i) => i.processId === ids[key])?.classification;
    expect(classOf("X")).toBe("probable");
    expect(classOf("Y")).toBe("probable");
    expect(classOf("Z")).toBe("probable");
    // The human classification of the Valores tab stays the one of the competência ("aplicar derivada" was today).
    expect(classOf("V")).toBe("remote");
  });
});
