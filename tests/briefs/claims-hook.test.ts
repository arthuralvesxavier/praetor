/**
 * Automation: when a preliminary analysis becomes `ready_for_review`, its pedidos
 * become SUGGESTIONS in the process (claims module: origin `ai_suggested`, pending
 * confirmation, never counted in the risk until a person confirms them). The hook
 * is best effort: a failure is logged without content and never fails the brief.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCaseBrief, regenerateCaseBrief, requestCaseBrief } from "@/modules/briefs/service";
import { getProcessClaims, suggestClaimsFromBrief } from "@/modules/claims/service";
import { auditLogs, caseBriefs, processClaims, processRiskAssessments } from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { runJobs, setupFixture, type Fixture } from "../helpers/fixtures";
import { demoInfo, makeLaborProcess, uploadDemoPack } from "./helpers";

const hook = vi.hoisted(() => ({ fail: false, calls: 0 }));
const LEAK = "TEXTO SIGILOSO DO PEDIDO (fictício)";
vi.mock("@/modules/claims/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/claims/service")>();
  return {
    ...original,
    suggestClaimsFromBriefAsSystem: async (organizationId: string, briefId: string) => {
      hook.calls += 1;
      if (hook.fail) throw new Error(`Falha simulada: ${LEAK}`);
      return original.suggestClaimsFromBriefAsSystem(organizationId, briefId);
    },
  };
});

let fx: Fixture;

beforeAll(async () => {
  fx = await setupFixture("briefclaims");
}, 180_000);
afterAll(async () => {
  await fx?.teardown();
});

async function processWithDocuments() {
  const { admin, lawyer } = fx.ctx;
  const info = demoInfo();
  const processId = await makeLaborProcess(admin, info, { unitId: fx.unitSp, responsibleId: lawyer.userId });
  await uploadDemoPack(admin, processId, info, { variant: 1 });
  await runJobs();
  return processId;
}

async function claimsOf(processId: string) {
  return fx.db.select().from(processClaims).where(and(eq(processClaims.organizationId, fx.orgA), eq(processClaims.processId, processId)));
}

describe("pedidos of a ready preliminary analysis", () => {
  it("become suggestions pending confirmation that do not count in the risk", async () => {
    const processId = await processWithDocuments();
    const { briefId, status } = await requestCaseBrief(fx.ctx.lawyer, processId, { inline: true });
    expect(status).toBe("ready_for_review");

    const detail = await getCaseBrief(fx.ctx.lawyer, briefId);
    const eligible = detail.content!.claims.filter(
      (c) => c.provenance !== "missing" && c.provenance !== "illustrative" && c.description.trim().length >= 3,
    );
    expect(eligible.length).toBeGreaterThan(0);

    const rows = await claimsOf(processId);
    expect(rows).toHaveLength(eligible.length);
    for (const r of rows) {
      expect(r).toMatchObject({ origin: "ai_suggested", status: "pending_confirmation", sourceBriefId: briefId, confirmedAt: null });
      // Simulated analysis: the suggestion says it is demonstrative.
      expect(r.sourceNote).toContain("SIMULAÇÃO");
    }

    // Nothing counts until a person confirms: no process assessment, no derived classification.
    expect(await fx.db.select().from(processRiskAssessments).where(eq(processRiskAssessments.processId, processId))).toHaveLength(0);
    const overview = await getProcessClaims(fx.ctx.manager, processId);
    expect(overview.risk?.derivation.classification).toBeNull();
    expect(overview.risk?.derivation.pendingConfirmation).toHaveLength(eligible.length);

    // Audited without the claim descriptions (they may come from documents).
    const audits = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, processId), eq(auditLogs.action, "claim.suggest")));
    expect(audits).toHaveLength(1);
    expect(audits[0].summary).toContain("aguardando confirmação");
    for (const c of eligible) expect(JSON.stringify(audits)).not.toContain(c.description);

    // Idempotent: the manual import finds nothing new.
    expect((await suggestClaimsFromBrief(fx.ctx.lawyer, briefId)).created).toBe(0);
  });

  it("a new version does not duplicate the suggestions already in the process (job path)", async () => {
    const processId = await processWithDocuments();
    const first = await requestCaseBrief(fx.ctx.lawyer, processId, { inline: true });
    const before = (await claimsOf(processId)).length;
    expect(before).toBeGreaterThan(0);

    const callsBefore = hook.calls;
    const second = await regenerateCaseBrief(fx.ctx.lawyer, first.briefId);
    await runJobs();
    const [b] = await fx.db.select({ status: caseBriefs.status }).from(caseBriefs).where(eq(caseBriefs.id, second.briefId));
    expect(b.status).toBe("ready_for_review");
    expect(hook.calls).toBe(callsBefore + 1);
    expect(await claimsOf(processId)).toHaveLength(before);
  });

  it("a failure of the hook is logged without content and never fails the brief", async () => {
    const processId = await processWithDocuments();
    const warn = vi.spyOn(logger, "warn");
    hook.fail = true;
    try {
      const { briefId, status } = await requestCaseBrief(fx.ctx.lawyer, processId, { inline: true });
      expect(status).toBe("ready_for_review");
      const [b] = await fx.db.select({ status: caseBriefs.status }).from(caseBriefs).where(eq(caseBriefs.id, briefId));
      expect(b.status).toBe("ready_for_review");
      expect(await claimsOf(processId)).toHaveLength(0);

      const call = warn.mock.calls.find(([msg]) => msg === "case_brief_claims_suggest_failed");
      expect(call?.[1]).toEqual({ briefId, errorName: "Error", errorCode: null });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(LEAK);
    } finally {
      hook.fail = false;
      warn.mockRestore();
    }

    // The claims panel still offers the manual import.
    const overview = await getProcessClaims(fx.ctx.lawyer, processId);
    expect(overview.briefOffer?.notImported).toBeGreaterThan(0);
  });
});
