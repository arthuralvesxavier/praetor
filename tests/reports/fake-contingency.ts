/**
 * Test double of `getPortfolioExposure` (@/modules/contingency/service, owned
 * by the contingency package). It follows the published contract: processes
 * visible to ctx (processWhere), active portfolio by default, mirrors on
 * legal_processes, linked guarantees and the @/domain/contingency math — so
 * the reports can be tested independently of that package's progress.
 *
 *   vi.mock("@/modules/contingency/service", async () => (await import("./fake-contingency")).contingencyServiceMock());
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { vi } from "vitest";
import { addToBucket, emptyBucket, netExposure, provisionFor } from "@/domain/contingency";
import { processWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { legalProcesses, processGuarantees } from "@/server/db/schema";

type Filters = { companyId?: string; unitId?: string; includeClosed?: boolean };

export async function fakePortfolioExposure(ctx: AuthContext, filters: Filters = {}) {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const lp = legalProcesses;
  const rows = await db
    .select()
    .from(lp)
    .where(
      and(
        processWhere(ctx),
        filters.companyId ? eq(lp.companyId, filters.companyId) : undefined,
        filters.unitId ? eq(lp.unitId, filters.unitId) : undefined,
        filters.includeClosed ? undefined : inArray(lp.status, ["active", "suspended"]),
      ),
    )
    .orderBy(lp.number);
  const g = await db
    .select({
      processId: processGuarantees.processId,
      total: sql<number>`sum(${processGuarantees.amountCents})`.mapWith(Number),
    })
    .from(processGuarantees)
    .where(
      and(
        eq(processGuarantees.organizationId, ctx.organizationId),
        eq(processGuarantees.status, "linked"),
        isNull(processGuarantees.deletedAt),
      ),
    )
    .groupBy(processGuarantees.processId);
  const gMap = new Map(g.map((x) => [x.processId, x.total]));
  const totals = emptyBucket();
  const out = rows.map((r) => {
    const input = {
      liquidatedCents: r.liquidatedAmountCents,
      linkedGuaranteesCents: gMap.get(r.id) ?? 0,
      claimCents: r.claimAmountCents,
      riskPercentageBp: r.riskPercentageBp,
    };
    addToBucket(totals, input);
    return {
      processId: r.id,
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
      percentageBp: r.riskPercentageBp,
      claimCents: r.claimAmountCents,
      liquidatedCents: r.liquidatedAmountCents,
      guaranteesCents: input.linkedGuaranteesCents,
      exposure: netExposure(input),
      provision: provisionFor(input),
    };
  });
  return { rows: out, totals };
}

export function contingencyServiceMock() {
  return { getPortfolioExposure: vi.fn(fakePortfolioExposure) };
}
