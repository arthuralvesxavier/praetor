/**
 * End-to-end of the central flow WITHOUT mocks: simulated arrival (real demo
 * documents) → queue → distribution → text extraction → simulated case brief →
 * simulated e-mail. Depends on the briefs and e-mails packages.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runJobs, setupFixture, type Fixture } from "../helpers/fixtures";
import { isValidCnj } from "@/domain/cnj";
import { getIntake, simulateIncomingProcess } from "@/modules/intake/service";
import { caseBriefs, caseIntakes, emailMessages, organizations } from "@/server/db/schema";

let f: Fixture;

beforeAll(async () => {
  f = await setupFixture("intkflow");
  await f.db.update(organizations).set({ isDemo: true }).where(eq(organizations.id, f.orgA));
});

afterAll(async () => {
  await f?.teardown();
});

describe("central flow (simulated arrival → brief → e-mail)", () => {
  it("runs through the queue and ends with a brief to review and a simulated e-mail", async () => {
    const r = await simulateIncomingProcess(f.ctx.manager);
    expect(isValidCnj(r.number)).toBe(true);
    expect(r.documentIds.length).toBeGreaterThan(0);
    await runJobs();

    const [intake] = await f.db.select().from(caseIntakes).where(eq(caseIntakes.id, r.intakeId));
    expect(intake.errorMessage).toBeNull();
    expect(intake.status).toBe("notified");
    expect(intake.assignedToId).toBeTruthy();

    const [brief] = await f.db.select().from(caseBriefs).where(eq(caseBriefs.id, intake.briefId!));
    expect(brief.status).toBe("ready_for_review");
    expect(brief.intakeId).toBe(r.intakeId);
    // The extraction jobs that finish after the inline extraction must not mark the fresh brief stale.
    expect(brief.isStale).toBe(false);

    const [email] = await f.db.select().from(emailMessages).where(eq(emailMessages.id, intake.lastEmailId!));
    expect(email).toMatchObject({ mode: "simulated", template: "case_brief_ready", toUserId: intake.assignedToId, intakeId: r.intakeId });
    expect(email.subject.startsWith("[Simulação]")).toBe(true);

    const detail = await getIntake(f.ctx.manager, r.intakeId);
    expect(detail.stages.slice(0, 4).every((s) => s.state === "done")).toBe(true);
    expect(detail.stages[4]).toMatchObject({ key: "review", state: "current" });
    expect(detail.brief?.id).toBe(brief.id);
    expect(detail.email?.id).toBe(email.id);
    expect(detail.documents.every((d) => d.extractionStatus === "succeeded")).toBe(true);
  });
});
