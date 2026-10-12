import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import {
  auditLogs,
  legalProcesses,
  organizations,
  processGuarantees,
  processRiskAssessments,
  processValuations,
  users,
} from "@/server/db/schema";
import { createTestDatabase } from "../helpers/db";
import { BACKFILL_CLAIM_REASON, BACKFILL_RISK_OPINION, backfillV2, totalsOf } from "../../scripts/seed-data/v2/backfill";

/**
 * The v2 backfill (scripts/backfill-v2.ts) on data shaped like records created
 * before v2: processes with valor da causa / probabilidade de perda but no
 * valuation or risk history.
 */
describe("v2 backfill", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgA: string;
  let orgB: string;
  let userA: string;
  const ids: Record<string, string> = {};

  async function process(
    key: string,
    org: string,
    values: Partial<typeof legalProcesses.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(legalProcesses)
      .values({
        organizationId: org,
        number: `00000${Object.keys(ids).length + 10}-00.2025.5.02.0000`,
        title: `Processo ${key} (dados fictícios)`,
        court: "TRT2",
        area: "labor",
        phase: "knowledge",
        createdById: org === orgA ? userA : null,
        createdAt: new Date("2025-03-10T15:00:00Z"),
        ...values,
      })
      .returning({ id: legalProcesses.id });
    ids[key] = row.id;
    return row.id;
  }

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    const [a] = await db.insert(organizations).values({ name: "Org A (teste)", slug: "org-a-backfill" }).returning();
    // Org B with custom percentages (settings may be partial: merged with the defaults).
    const [b] = await db
      .insert(organizations)
      .values({
        name: "Org B (teste)",
        slug: "org-b-backfill",
        settings: { contingency: { riskPercentages: { possible: 40 }, rulesVersion: 3 } } as never,
      })
      .returning();
    orgA = a.id;
    orgB = b.id;
    const [u] = await db
      .insert(users)
      .values({ organizationId: orgA, name: "Pessoa Teste", email: "pessoa@backfill.test", passwordHash: "x", role: "lawyer" })
      .returning();
    userA = u.id;

    await process("claimAndRisk", orgA, { claimAmountCents: 100_000_00, lossProbability: "possible", provisionAmountCents: 12_345_00, filedAt: "2025-02-01" });
    await process("claimOnly", orgA, { claimAmountCents: 50_000_00, provisionAmountCents: 7_000_00 });
    await process("riskOnly", orgA, { lossProbability: "probable" });
    await process("liquidated", orgA, { claimAmountCents: 80_000_00, liquidatedAmountCents: 30_000_00, lossProbability: "probable" });
    await process("withGuarantee", orgA, { claimAmountCents: 60_000_00, liquidatedAmountCents: 20_000_00, lossProbability: "probable" });
    await process("imported", orgA, { claimAmountCents: 40_000_00, importBatchId: randomUUID() });
    await process("deleted", orgA, { claimAmountCents: 10_000_00, lossProbability: "possible", deletedAt: new Date() });
    await process("hasHistory", orgA, { claimAmountCents: 90_000_00, lossProbability: "remote" });
    await process("orgB", orgB, { claimAmountCents: 100_000_00, lossProbability: "possible" });

    await db.insert(processGuarantees).values({
      organizationId: orgA,
      processId: ids.withGuarantee,
      kind: "judicial_deposit",
      amountCents: 5_000_00,
      status: "linked",
    });
    await db.insert(processValuations).values({
      organizationId: orgA,
      processId: ids.hasHistory,
      kind: "claim",
      amountCents: 90_000_00,
      baseDate: "2025-01-01",
      source: "manual",
      status: "official",
      reviewedById: userA,
    });
    await db.insert(processRiskAssessments).values({
      organizationId: orgA,
      processId: ids.hasHistory,
      classification: "remote",
      percentageBp: 0,
      opinion: "Parecer já registrado (teste).",
      effectiveFrom: "2025-01-01",
    });
  });

  afterAll(async () => {
    await close();
  });

  it("records the missing history once, for every organization", async () => {
    const results = await backfillV2(db);
    const a = results.find((r) => r.organizationId === orgA)!;
    const b = results.find((r) => r.organizationId === orgB)!;
    // claim: claimAndRisk, claimOnly, liquidated, withGuarantee (imported, deleted and hasHistory are skipped)
    expect(a).toMatchObject({ claimValuations: 4, riskAssessments: 4, withoutCreator: 0 });
    expect(b).toMatchObject({ claimValuations: 1, riskAssessments: 1, withoutCreator: 2 });

    const [claim] = await db
      .select()
      .from(processValuations)
      .where(and(eq(processValuations.processId, ids.claimAndRisk), eq(processValuations.kind, "claim")));
    expect(claim).toMatchObject({
      status: "official",
      source: "manual",
      amountCents: 100_000_00,
      baseDate: "2025-02-01",
      reason: BACKFILL_CLAIM_REASON,
      createdById: userA,
      reviewedById: userA,
    });
    const [claimOnly] = await db.select().from(processValuations).where(eq(processValuations.processId, ids.claimOnly));
    expect(claimOnly.baseDate).toBe("2025-03-10"); // no filing date: creation date

    const [risk] = await db.select().from(processRiskAssessments).where(eq(processRiskAssessments.processId, ids.claimAndRisk));
    expect(risk).toMatchObject({
      classification: "possible",
      percentageBp: 5000,
      status: "official",
      opinion: BACKFILL_RISK_OPINION,
      effectiveFrom: "2025-03-10",
      rulesVersion: 1,
      assessedById: userA,
    });
    const [riskB] = await db.select().from(processRiskAssessments).where(eq(processRiskAssessments.processId, ids.orgB));
    expect(riskB).toMatchObject({ percentageBp: 4000, rulesVersion: 3, assessedById: null });
  });

  it("recomputes the contingency mirrors with the v2 rules (RN-04/RN-05)", async () => {
    const get = async (key: string) => (await db.select().from(legalProcesses).where(eq(legalProcesses.id, ids[key])))[0];
    // claim x 50% (estimate base), replacing the typed provision
    expect(await get("claimAndRisk")).toMatchObject({ riskPercentageBp: 5000, lossProbability: "possible", provisionAmountCents: 50_000_00 });
    // no risk classification: the record is left as it was
    expect(await get("claimOnly")).toMatchObject({ riskPercentageBp: null, provisionAmountCents: 7_000_00 });
    // no claim and no liquidated value: provision unknown
    expect(await get("riskOnly")).toMatchObject({ riskPercentageBp: 10000, provisionAmountCents: null });
    // net liquidated x 100%
    expect(await get("liquidated")).toMatchObject({ provisionAmountCents: 30_000_00 });
    expect(await get("withGuarantee")).toMatchObject({ provisionAmountCents: 15_000_00 });
    // untouched: soft-deleted and records that already had history
    expect(await get("deleted")).toMatchObject({ riskPercentageBp: null });
    expect(await get("hasHistory")).toMatchObject({ riskPercentageBp: null });
    expect(await get("orgB")).toMatchObject({ riskPercentageBp: 4000, provisionAmountCents: 40_000_00 });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, ids.claimAndRisk));
    expect(audits.map((x) => x.action).sort()).toEqual(["risk_assessment.create", "valuation.create"]);
    for (const x of audits) {
      expect(x.actorId).toBeNull();
      expect(x.metadata).toMatchObject({ backfill: "v2" });
    }
  });

  it("is idempotent", async () => {
    const before = (await db.select().from(processValuations)).length + (await db.select().from(processRiskAssessments)).length;
    const results = await backfillV2(db);
    expect(totalsOf(results)).toEqual({ claimValuations: 0, riskAssessments: 0, mirrorsUpdated: 0, withoutCreator: 0 });
    const after = (await db.select().from(processValuations)).length + (await db.select().from(processRiskAssessments)).length;
    expect(after).toBe(before);
  });
});
