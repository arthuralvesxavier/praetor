/**
 * Review fixes "briefs-work-forms" (preliminary analyses):
 * - deadlines/tasks created from a brief keep document text out of the
 *   description, and descriptions of suggestions whose source the viewer
 *   cannot open are hidden (also for rows stored before the fix);
 * - a new version re-links the intake of the process, superseded versions can
 *   no longer be reviewed or applied and leave the review queue;
 * - analysts (intake:manage) request a version only with an intake of the process;
 * - an intake that reused a running generation continues (intake.process) when
 *   the generation finishes, never when it fails.
 */
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyBriefDeadline,
  applyBriefNextStep,
  approveCaseBrief,
  countCaseBriefsByStatus,
  getCaseBrief,
  listCaseBriefs,
  proposeBriefAmount,
  regenerateCaseBrief,
  rejectCaseBrief,
  requestCaseBrief,
  runCaseBriefJob,
  saveCaseBriefSection,
  SUPERSEDED_MESSAGE,
} from "@/modules/briefs/service";
import { processIntakeJob, regenerateIntakeBrief } from "@/modules/intake/service";
import { getDeadline, getTask, HIDDEN_SOURCE_DESCRIPTION, listDeadlines, listTasks } from "@/modules/work/service";
import { caseBriefs, caseIntakes, deadlines, jobs, organizations, tasks } from "@/server/db/schema";
import { setCaseBriefProviderForTesting } from "@/server/integrations/ai/case-brief";
import { AiProviderError } from "@/server/integrations/ai/provider";
import { processPendingJobs } from "@/server/jobs/worker";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { demoInfo, insertIntake, makeLaborProcess, uploadDemoPack } from "../../briefs/helpers";
import { setupFixture, type Fixture } from "../../helpers/fixtures";

let fx: Fixture;

beforeAll(async () => {
  fx = await setupFixture("bwfbrief");
  // Demo organization: the intake pipeline sends simulated e-mails.
  await fx.db.update(organizations).set({ isDemo: true }).where(eq(organizations.id, fx.orgA));
});
afterAll(async () => {
  setCaseBriefProviderForTesting(null);
  await fx?.teardown();
});

/** SP process whose responsible is the SP lawyer, with the demo document pack. */
async function processWithPack(opts: { confidentiality?: "internal" | "restricted"; variant?: number } = {}) {
  const info = demoInfo();
  const processId = await makeLaborProcess(fx.ctx.admin, info, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId });
  await uploadDemoPack(fx.ctx.admin, processId, info, { variant: opts.variant ?? 1, confidentiality: opts.confidentiality });
  return processId;
}

async function intakeRow(id: string) {
  const [row] = await fx.db.select().from(caseIntakes).where(eq(caseIntakes.id, id));
  return row;
}

async function queuedIntakeJobs(intakeId: string) {
  return fx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, `intake.process:${intakeId}`), eq(jobs.status, "queued")));
}

/** Leaves only the given queued job of the organization (the rest of this test's queue is not under test). */
async function keepOnlyQueued(dedupeKey: string) {
  await fx.db.delete(jobs).where(and(eq(jobs.organizationId, fx.orgA), ne(jobs.dedupeKey, dedupeKey)));
  await fx.db.delete(jobs).where(and(eq(jobs.organizationId, fx.orgA), eq(jobs.status, "succeeded")));
}

describe("suggestions applied from a brief (finding: document text in descriptions)", () => {
  it("keeps the quoted text only in the gated excerpt and hides descriptions from users who cannot open the source", async () => {
    const { lawyer, analyst } = fx.ctx;
    // Restricted documents: the responsible lawyer reads them, the SP analyst does not.
    const processId = await processWithPack({ confidentiality: "restricted" });
    const { briefId, status } = await requestCaseBrief(lawyer, processId, { inline: true });
    expect(status).toBe("ready_for_review");
    const content = (await getCaseBrief(lawyer, briefId)).content!;
    const dated = content.possibleDeadlines.findIndex((d) => d.date !== null);
    expect(dated).toBeGreaterThanOrEqual(0);
    const possible = content.possibleDeadlines[dated];
    const quote = possible.citations.find((c) => c.excerpt)?.excerpt ?? possible.basis;
    expect(possible.basis).toContain("Data copiada literalmente");

    const { deadlineId } = await applyBriefDeadline(lawyer, briefId, dated);
    const [stored] = await fx.db.select().from(deadlines).where(eq(deadlines.id, deadlineId));
    expect(stored.description).toContain("Possível prazo da análise preliminar v1, SIMULAÇÃO");
    expect(stored.description).toContain("confirme o prazo antes de validar");
    expect(stored.description).not.toContain("Data copiada literalmente");
    expect(stored.description).not.toContain(quote.slice(0, 40));
    expect(stored.sourceExcerpt).toContain(quote.slice(0, 40));

    const stepIndex = content.nextSteps.findIndex((s) => !!s.note);
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    const { taskId } = await applyBriefNextStep(lawyer, briefId, stepIndex);
    const [task] = await fx.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task.description).toContain("SIMULAÇÃO");
    expect(task.description).not.toContain("Observação");
    expect(task.description).not.toContain(content.nextSteps[stepIndex].note!);

    // The SP analyst sees the process (and so the deadline and the task) but not the brief.
    await expect(getCaseBrief(analyst, briefId)).rejects.toBeInstanceOf(NotFoundError);
    const forAnalyst = await getDeadline(analyst, deadlineId);
    expect(forAnalyst.sourceExcerpt).toBeNull();
    expect(forAnalyst.description).toBe(HIDDEN_SOURCE_DESCRIPTION);
    expect((await getTask(analyst, taskId)).description).toBe(HIDDEN_SOURCE_DESCRIPTION);
    // Whoever opens the brief keeps the full description and the excerpt.
    const forLawyer = await getDeadline(lawyer, deadlineId);
    expect(forLawyer.description).toBe(stored.description);
    expect(forLawyer.sourceExcerpt).toBe(stored.sourceExcerpt);
    expect((await getTask(lawyer, taskId)).description).toBe(task.description);
  });

  it("hides document text stored in descriptions before the fix (lists and single reads)", async () => {
    const { lawyer, analyst } = fx.ctx;
    const processId = await processWithPack({ confidentiality: "restricted" });
    const { briefId } = await requestCaseBrief(lawyer, processId, { inline: true });
    const content = (await getCaseBrief(lawyer, briefId)).content!;
    const { deadlineId } = await applyBriefDeadline(
      lawyer,
      briefId,
      content.possibleDeadlines.findIndex((d) => d.date !== null),
    );
    const { taskId } = await applyBriefNextStep(lawyer, briefId, 0);
    // What the previous version stored (scratch scenario of the review).
    const legacy =
      "Data copiada literalmente de “Notificação de audiência inicial” (p. 1): “comparecer à audiência inicial designada para 26/10/2026, às 08:30, por videoconferência,”…";
    await fx.db.update(deadlines).set({ description: legacy }).where(eq(deadlines.id, deadlineId));
    await fx.db.update(tasks).set({ description: `Passo\n\nObservação: ${legacy}` }).where(eq(tasks.id, taskId));

    const pending = await listDeadlines(analyst, { validationStatus: "pending_validation", processId });
    const listed = pending.items.find((d) => d.id === deadlineId);
    expect(listed?.description).toBe(HIDDEN_SOURCE_DESCRIPTION);
    expect(JSON.stringify(pending.items)).not.toContain("comparecer à audiência");
    const taskList = await listTasks(analyst, { processId });
    expect(taskList.items.find((t) => t.id === taskId)?.description).toBe(HIDDEN_SOURCE_DESCRIPTION);
    expect(JSON.stringify(taskList.items)).not.toContain("comparecer à audiência");

    expect((await getDeadline(lawyer, deadlineId)).description).toBe(legacy);
  });
});

describe("versions and the intake (finding: intake bound to the first version)", () => {
  it("regenerating re-links the intake to the new version, which resumes the intake when ready", async () => {
    const { lawyer } = fx.ctx;
    const processId = await processWithPack();
    const intakeId = await insertIntake(fx.orgA, processId, {
      status: "assigned",
      assignedToId: lawyer.userId,
      assignedAt: new Date(),
      assignmentMethod: "manual",
    });
    const v1 = await requestCaseBrief(lawyer, processId, { intakeId, inline: true });
    expect(v1.status).toBe("ready_for_review");
    // State left by the intake pipeline after the e-mail step.
    await fx.db
      .update(caseIntakes)
      .set({ briefId: v1.briefId, status: "notified", lastEmailId: randomUUID() })
      .where(eq(caseIntakes.id, intakeId));

    await rejectCaseBrief(lawyer, v1.briefId, { reason: "Documentos de outro processo (teste)." });
    const v2 = await regenerateCaseBrief(lawyer, v1.briefId);
    expect(v2.status).toBe("generating");

    let intake = await intakeRow(intakeId);
    expect(intake.briefId).toBe(v2.briefId);
    expect(intake.status).toBe("analyzing");
    expect(intake.lastEmailId).toBeNull();
    expect(intake.steps.at(-1)).toMatchObject({ status: "analyzing", actorName: lawyer.name });
    expect(intake.steps.at(-1)?.detail).toContain("versão 2");
    const [v2Row] = await fx.db.select().from(caseBriefs).where(eq(caseBriefs.id, v2.briefId));
    expect(v2Row.intakeId).toBe(intakeId);

    // The generation job finishes: the intake reads "brief_ready" and its pipeline is queued (e-mail step).
    await runCaseBriefJob(v2.briefId, { attempt: 1, maxAttempts: 3 });
    intake = await intakeRow(intakeId);
    expect(intake.status).toBe("brief_ready");
    expect(intake.steps.at(-1)).toMatchObject({ status: "brief_ready" });
    expect(intake.steps.at(-1)?.detail).toContain("versão 2");
    expect(await queuedIntakeJobs(intakeId)).toHaveLength(1);

    // Approving the new version in the briefs module is what the intake follows.
    await approveCaseBrief(lawyer, v2.briefId);
    intake = await intakeRow(intakeId);
    const [approved] = await fx.db.select().from(caseBriefs).where(eq(caseBriefs.id, intake.briefId!));
    expect(approved).toMatchObject({ id: v2.briefId, status: "approved" });

    // An approved intake is not moved by a later version.
    const v3 = await regenerateCaseBrief(lawyer, v2.briefId);
    expect((await intakeRow(intakeId)).briefId).toBe(v2.briefId);
    const [v3Row] = await fx.db.select().from(caseBriefs).where(eq(caseBriefs.id, v3.briefId));
    expect(v3Row.intakeId).toBeNull();
  });

  it("does not approve, reject, edit or apply a version superseded by a newer generated one", async () => {
    const { lawyer } = fx.ctx;
    const processId = await processWithPack();
    const v1 = await requestCaseBrief(lawyer, processId, { inline: true });
    const v2 = await requestCaseBrief(lawyer, processId, { inline: true });
    expect(v2.status).toBe("ready_for_review");

    const superseded = { name: "ConflictError", message: SUPERSEDED_MESSAGE };
    await expect(approveCaseBrief(lawyer, v1.briefId)).rejects.toMatchObject(superseded);
    await expect(rejectCaseBrief(lawyer, v1.briefId, { reason: "Motivo de teste." })).rejects.toMatchObject(superseded);
    await expect(
      saveCaseBriefSection(lawyer, v1.briefId, { section: "headline", value: "Resumo editado", baseRevision: 1 }),
    ).rejects.toMatchObject(superseded);
    await expect(applyBriefNextStep(lawyer, v1.briefId, 0)).rejects.toMatchObject(superseded);
    await expect(proposeBriefAmount(lawyer, v1.briefId, 0)).rejects.toBeInstanceOf(ConflictError);

    const detail = await getCaseBrief(lawyer, v1.briefId);
    expect(detail.superseded).toBe(true);
    expect(detail.latestVersion).toEqual({ id: v2.briefId, version: 2 });
    expect((await getCaseBrief(lawyer, v2.briefId)).superseded).toBe(false);

    // Review queue: the superseded version is marked and left out of the review filters and counts.
    const all = await listCaseBriefs(lawyer, { processId });
    expect(all.items.find((i) => i.id === v1.briefId)?.superseded).toBe(true);
    expect(all.items.find((i) => i.id === v2.briefId)?.superseded).toBe(false);
    const ready = await listCaseBriefs(lawyer, { processId, status: "ready_for_review" });
    expect(ready.items.map((i) => i.id)).toEqual([v2.briefId]);
    const counts = await countCaseBriefsByStatus(lawyer);
    expect(counts.ready_for_review).toBe((await listCaseBriefs(lawyer, { status: "ready_for_review" })).total);

    await approveCaseBrief(lawyer, v2.briefId);
  });

  it("a newer version still being generated does not block the review of the current one", async () => {
    const { lawyer } = fx.ctx;
    const processId = await processWithPack();
    const v1 = await requestCaseBrief(lawyer, processId, { inline: true });
    const v2 = await requestCaseBrief(lawyer, processId);
    expect(v2.status).toBe("generating");
    await approveCaseBrief(lawyer, v1.briefId);
    expect((await getCaseBrief(lawyer, v1.briefId)).status).toBe("approved");
  });
});

describe("who requests a new version (finding: intake:manage)", () => {
  it("accepts analysts only with an intake of the process; the intake page path still works", async () => {
    const { analyst, lawyer, admin } = fx.ctx;
    const processId = await processWithPack();
    await expect(requestCaseBrief(analyst, processId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestCaseBrief(analyst, processId, { inline: true })).rejects.toBeInstanceOf(ForbiddenError);

    const otherProcess = await makeLaborProcess(admin, demoInfo(), { unitId: fx.unitSp });
    const otherIntake = await insertIntake(fx.orgA, otherProcess);
    await expect(requestCaseBrief(analyst, processId, { intakeId: otherIntake, inline: true })).rejects.toBeInstanceOf(
      ValidationError,
    );

    const intakeId = await insertIntake(fx.orgA, processId, {
      status: "assigned",
      assignedToId: lawyer.userId,
      assignedAt: new Date(),
      assignmentMethod: "manual",
    });
    // "Gerar nova versão da análise (simulação)" on the intake page.
    const { briefId } = await regenerateIntakeBrief(analyst, intakeId);
    expect(briefId).toBeTruthy();
    const [brief] = await fx.db.select().from(caseBriefs).where(eq(caseBriefs.id, briefId!));
    expect(brief).toMatchObject({ intakeId, status: "ready_for_review", requestedById: analyst.userId });
    expect((await intakeRow(intakeId)).briefId).toBe(briefId);

    // Reviewers keep requesting from the process tab.
    expect((await requestCaseBrief(lawyer, processId)).status).toBe("generating");
  });
});

describe("intake that reused a running generation (finding: never resumed)", () => {
  it("continues to the simulated e-mail once the generation job finishes (queue processed inline)", async () => {
    const { lawyer } = fx.ctx;
    const processId = await processWithPack();
    // The lawyer asks for the analysis on the process tab before the intake job runs.
    const running = await requestCaseBrief(lawyer, processId);
    expect(running.status).toBe("generating");
    const intakeId = await insertIntake(fx.orgA, processId, {
      status: "assigned",
      assignedToId: lawyer.userId,
      assignedAt: new Date(),
      assignmentMethod: "manual",
    });

    // Intake pipeline: reuses the running generation and stops while it is not ready.
    await processIntakeJob(intakeId, { attempt: 1, maxAttempts: 3 });
    let intake = await intakeRow(intakeId);
    expect(intake.briefId).toBe(running.briefId);
    expect(intake.status).toBe("analyzing");
    expect(intake.lastEmailId).toBeNull();

    // The generation job runs through the queue…
    await keepOnlyQueued(`case_brief:${running.briefId}`);
    expect((await processPendingJobs({ organizationId: fx.orgA, limit: 1 })).processed).toBe(1);
    intake = await intakeRow(intakeId);
    expect(intake.status).toBe("brief_ready");
    expect(await queuedIntakeJobs(intakeId)).toHaveLength(1);

    // …and queues the intake pipeline, which sends the (simulated) e-mail without manual action.
    await keepOnlyQueued(`intake.process:${intakeId}`);
    expect((await processPendingJobs({ organizationId: fx.orgA, limit: 1 })).processed).toBe(1);
    intake = await intakeRow(intakeId);
    expect(intake.status).toBe("notified");
    expect(intake.lastEmailId).toBeTruthy();
    expect(intake.errorMessage).toBeNull();
  });

  it("does not queue the intake when the generation fails", async () => {
    const { lawyer } = fx.ctx;
    const processId = await processWithPack();
    const running = await requestCaseBrief(lawyer, processId);
    const intakeId = await insertIntake(fx.orgA, processId, {
      status: "analyzing",
      assignedToId: lawyer.userId,
      assignedAt: new Date(),
      assignmentMethod: "manual",
      briefId: running.briefId,
    });
    setCaseBriefProviderForTesting({
      name: "falha-simulada",
      model: "falha-simulada",
      mode: "demo",
      promptVersion: "teste",
      generate: async () => {
        throw new AiProviderError("forced_failure", { retryable: false, userMessage: "Falha simulada no teste." });
      },
    });
    try {
      await expect(runCaseBriefJob(running.briefId, { attempt: 1, maxAttempts: 1 })).rejects.toBeInstanceOf(AiProviderError);
    } finally {
      setCaseBriefProviderForTesting(null);
    }
    const [brief] = await fx.db.select().from(caseBriefs).where(eq(caseBriefs.id, running.briefId));
    expect(brief.status).toBe("failed");
    expect((await intakeRow(intakeId)).status).toBe("analyzing");
    expect(await queuedIntakeJobs(intakeId)).toHaveLength(0);
  });
});
