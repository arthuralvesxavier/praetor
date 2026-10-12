import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isFictitiousEmailAddress } from "@/modules/admin/schemas";
import {
  getOrganizationSettings,
  updateContingencySettings,
  updateEmailIntakeSettings,
  updateOrganizationSettings,
} from "@/modules/admin/service";
import { auditLogs, organizations } from "@/server/db/schema";
import { ForbiddenError, ValidationError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let fx: Fixture;

beforeAll(async () => {
  fx = await setupFixture("setv2");
});

afterAll(async () => fx.teardown());

const contingencyAudits = () =>
  fx.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, fx.orgA), eq(auditLogs.action, "organization.contingency_settings_update")))
    .orderBy(desc(auditLogs.createdAt));

describe("contingency parameters (RN-05, RN-11, RNF-14)", () => {
  it("require admin:organization", async () => {
    for (const c of [fx.ctx.manager, fx.ctx.accountant, fx.ctx.auditor]) {
      await expect(
        updateContingencySettings(c, { riskRemote: 0, riskPossible: 40, riskProbable: 100, confidenceThreshold: 85, idleGuaranteeDays: 180 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("validates bounds and the order remota ≤ possível ≤ provável", async () => {
    const ok = { riskRemote: 0, riskPossible: 50, riskProbable: 100, confidenceThreshold: 85, idleGuaranteeDays: 180 };
    await expect(updateContingencySettings(fx.ctx.admin, { ...ok, riskProbable: 101 })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateContingencySettings(fx.ctx.admin, { ...ok, confidenceThreshold: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateContingencySettings(fx.ctx.admin, { ...ok, idleGuaranteeDays: 0 })).rejects.toBeInstanceOf(ValidationError);
    try {
      await updateContingencySettings(fx.ctx.admin, { ...ok, riskPossible: 10, riskRemote: 20 });
      throw new Error("expected a validation error");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fieldErrors?.riskPossible).toBeDefined();
    }
  });

  it("bumps rulesVersion only when a percentage changes, auditing before/after", async () => {
    const before = (await getOrganizationSettings(fx.ctx.admin)).settings.contingency;
    expect(before.rulesVersion).toBe(1);

    // Same values: nothing recorded.
    const same = await updateContingencySettings(fx.ctx.admin, {
      riskRemote: before.riskPercentages.remote,
      riskPossible: before.riskPercentages.possible,
      riskProbable: before.riskPercentages.probable,
      confidenceThreshold: before.confidenceThreshold,
      idleGuaranteeDays: before.idleGuaranteeDays,
    });
    expect(same).toEqual({ rulesVersion: 1, rulesVersionChanged: false });
    expect(await contingencyAudits()).toHaveLength(0);

    // Threshold only: saved and audited, same rules version.
    const t = await updateContingencySettings(fx.ctx.admin, {
      riskRemote: 0,
      riskPossible: 50,
      riskProbable: 100,
      confidenceThreshold: 90,
      idleGuaranteeDays: 120,
    });
    expect(t).toEqual({ rulesVersion: 1, rulesVersionChanged: false });
    let audits = await contingencyAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].changes).toEqual({
      confidenceThreshold: { from: 85, to: 90 },
      idleGuaranteeDays: { from: 180, to: 120 },
    });

    // A percentage change creates rules version 2.
    const r = await updateContingencySettings(fx.ctx.admin, {
      riskRemote: 0,
      riskPossible: 40,
      riskProbable: 100,
      confidenceThreshold: 90,
      idleGuaranteeDays: 120,
    });
    expect(r).toEqual({ rulesVersion: 2, rulesVersionChanged: true });
    audits = await contingencyAudits();
    expect(audits).toHaveLength(2);
    expect(audits[0].changes).toEqual({
      riskPercentPossible: { from: 50, to: 40 },
      rulesVersion: { from: 1, to: 2 },
    });
    expect(audits[0].metadata).toMatchObject({
      rulesVersionBefore: 1,
      rulesVersionAfter: 2,
      riskPercentagesBefore: { remote: 0, possible: 50, probable: 100 },
      riskPercentagesAfter: { remote: 0, possible: 40, probable: 100 },
    });

    const after = (await getOrganizationSettings(fx.ctx.admin)).settings;
    expect(after.contingency).toEqual({
      riskPercentages: { remote: 0, possible: 40, probable: 100 },
      confidenceThreshold: 90,
      idleGuaranteeDays: 120,
      rulesVersion: 2,
      // P1.7: not edited by this form, kept as stored.
      defaultCorrectionIndex: "none",
    });
    // Other sections are untouched.
    expect(after.email.mode).toBe("simulated");
    expect(after.alerts.upcomingDeadlineDays).toBe(7);

    // Organization B is never affected.
    const [orgB] = await fx.db.select().from(organizations).where(eq(organizations.id, fx.orgB));
    expect(orgB.settings.contingency?.rulesVersion ?? 1).toBe(1);
  });
});

describe("e-mail (simulated) and intake settings", () => {
  it("accept only fictitious sender addresses and keep the mode simulated", async () => {
    expect(isFictitiousEmailAddress("nao-responda@praetor.invalid")).toBe(true);
    expect(isFictitiousEmailAddress("juridico@empresa.example.com")).toBe(true);
    expect(isFictitiousEmailAddress("alguem@gmail.com")).toBe(false);

    const base = {
      senderName: "Jurídico (simulação)",
      senderAddress: "juridico@empresa.test",
      notifyOnBriefReady: false,
      notifyOnAssignment: true,
      autoAssign: false,
      autoGenerateBrief: true,
      autoNotify: false,
    };
    await expect(updateEmailIntakeSettings(fx.ctx.manager, base)).rejects.toBeInstanceOf(ForbiddenError);
    try {
      await updateEmailIntakeSettings(fx.ctx.admin, { ...base, senderAddress: "juridico@empresa.com.br" });
      throw new Error("expected a validation error");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fieldErrors?.senderAddress?.[0]).toMatch(/fictício/);
    }

    await updateEmailIntakeSettings(fx.ctx.admin, base);
    const s = (await getOrganizationSettings(fx.ctx.admin)).settings;
    expect(s.email).toEqual({
      mode: "simulated",
      senderName: "Jurídico (simulação)",
      senderAddress: "juridico@empresa.test",
      notifyOnBriefReady: false,
      notifyOnAssignment: true,
    });
    expect(s.intake).toEqual({ autoAssign: false, autoGenerateBrief: true, autoNotify: false });
    const [audit] = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, fx.orgA), eq(auditLogs.action, "organization.email_intake_settings_update")));
    expect(audit.changes).toMatchObject({
      autoAssign: { from: true, to: false },
      senderAddress: { from: "nao-responda@praetor.invalid", to: "juridico@empresa.test" },
    });
  });

  it("stores the new alert windows and keeps them when omitted", async () => {
    const current = await getOrganizationSettings(fx.ctx.admin);
    const base = {
      name: current.name,
      monthlyTokenBudget: current.settings.ai.monthlyTokenBudget,
      maxInputChars: current.settings.ai.maxInputChars,
      autoAnalyzeOnUpload: current.settings.ai.autoAnalyzeOnUpload,
      upcomingDeadlineDays: 7,
      contractExpirationDays: 60,
      closedRecordRetentionDays: 1825,
      auditLogRetentionDays: 1825,
    };
    await expect(
      updateOrganizationSettings(fx.ctx.admin, { ...base, upcomingHearingDays: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await updateOrganizationSettings(fx.ctx.admin, { ...base, upcomingHearingDays: 21, installmentDueDays: 5 });
    let s = (await getOrganizationSettings(fx.ctx.admin)).settings;
    expect(s.alerts).toMatchObject({ upcomingHearingDays: 21, installmentDueDays: 5 });
    await updateOrganizationSettings(fx.ctx.admin, { ...base, upcomingDeadlineDays: 9 });
    s = (await getOrganizationSettings(fx.ctx.admin)).settings;
    expect(s.alerts).toMatchObject({ upcomingDeadlineDays: 9, upcomingHearingDays: 21, installmentDueDays: 5 });
    // Contingency parameters set above are preserved by the general form.
    expect(s.contingency.rulesVersion).toBe(2);
  });
});
