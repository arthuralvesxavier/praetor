import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

// Cross-module services of other packages (briefs, e-mails): mocked so the
// pipeline orchestration is tested on its own. Other exports stay real.
const mocks = vi.hoisted(() => ({
  requestCaseBrief: vi.fn(),
  getCaseBriefEmailDigest: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  buildDemoCaseDocuments: vi.fn(),
}));
vi.mock("@/modules/briefs/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/briefs/service")>()),
  requestCaseBrief: mocks.requestCaseBrief,
  getCaseBriefEmailDigest: mocks.getCaseBriefEmailDigest,
}));
vi.mock("@/modules/emails/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/emails/service")>()),
  sendTemplatedEmail: mocks.sendTemplatedEmail,
}));
vi.mock("@/modules/briefs/demo-documents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/briefs/demo-documents")>()),
  buildDemoCaseDocuments: mocks.buildDemoCaseDocuments,
}));

import { runJobs, setupFixture, utf8, type Fixture } from "../helpers/fixtures";
import { isValidCnj, laborCourtFromCnj, parseCnj } from "@/domain/cnj";
import type { DemoCaseInfo } from "@/modules/briefs/demo-documents";
import { todayISO } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { reviewValuation } from "@/modules/contingency/service";
import { runSimulatedFeedRoutine } from "@/modules/court-sync/routines";
import { normalizeCourt } from "@/modules/distribution/matching";
import { FICTITIOUS_PLAINTIFFS, buildSimulatedCnj } from "@/modules/intake/simulation";
import type { RegisterIntakeInput } from "@/modules/intake/schemas";
import {
  assignIntakeManually,
  autoAssignIntake,
  getIntake,
  getIntakeCounts,
  listIntakes,
  processIntakeJob,
  regenerateIntakeBrief,
  registerIncomingProcess,
  requestIntakeProcessing,
  resendIntakeEmail,
  simulateIncomingProcess,
} from "@/modules/intake/service";
import { getProcess } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import {
  alerts,
  auditLogs,
  caseBriefs,
  caseIntakes,
  companies,
  documents,
  jobs,
  organizations,
  processParties,
  processValuations,
  users,
} from "@/server/db/schema";
import { DEFAULT_ORGANIZATION_SETTINGS } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";

let f: Fixture;
let seq = 100;

function cnj(opts: { origin?: string; tribunal?: string } = {}): string {
  seq += 1;
  return buildSimulatedCnj({ seed: seq, year: 2026, tribunal: opts.tribunal ?? "10", origin: opts.origin ?? "0801" });
}

function input(overrides: Partial<RegisterIntakeInput> = {}): RegisterIntakeInput {
  return {
    number: cnj(),
    court: "TRT10",
    city: "Palmas",
    state: "TO",
    processClass: "ATOrd",
    area: "labor",
    phase: "knowledge",
    instance: "first",
    plaintiffName: "Fulano de Tal Exemplo",
    defendantName: "Empresa Fictícia A Ltda.",
    claimAmountCents: 4_500_000,
    ...overrides,
  };
}

/** Claim (valor da causa) valuations of a process, oldest first. */
async function claimValuations(processId: string) {
  return f.db
    .select()
    .from(processValuations)
    .where(and(eq(processValuations.processId, processId), eq(processValuations.kind, "claim")))
    .orderBy(processValuations.createdAt);
}

async function intakeRow(id: string) {
  const [row] = await f.db.select().from(caseIntakes).where(eq(caseIntakes.id, id));
  return row;
}

function callsFor(mock: ReturnType<typeof vi.fn>, processId: string) {
  return mock.mock.calls.filter((c) => c[1] === processId || (c[1] as { processId?: string })?.processId === processId);
}

/** "Análise preliminar disponível" e-mails of a process (the assignment e-mail is another template). */
function briefEmailsFor(processId: string) {
  return mocks.sendTemplatedEmail.mock.calls.filter((c) => c[1].processId === processId && c[1].template === "case_brief_ready");
}

beforeAll(async () => {
  f = await setupFixture("intk");
  mocks.requestCaseBrief.mockImplementation(async (ctx: AuthContext, processId: string, opts: { intakeId?: string | null }) => {
    const [{ n }] = await f.db
      .select({ n: sql<number>`count(*)::int` })
      .from(caseBriefs)
      .where(eq(caseBriefs.processId, processId));
    const [row] = await f.db
      .insert(caseBriefs)
      .values({
        organizationId: ctx.organizationId,
        processId,
        intakeId: opts.intakeId ?? null,
        version: n + 1,
        status: "ready_for_review",
        mode: "demo",
        provider: "simulated",
        model: "simulado",
        promptVersion: "test",
        inputHash: "x",
        generatedAt: new Date(),
        requestedById: ctx.userId,
      })
      .returning({ id: caseBriefs.id });
    return { briefId: row.id, status: "ready_for_review" };
  });
  mocks.getCaseBriefEmailDigest.mockImplementation(async (_ctx: AuthContext, briefId: string) => ({
    briefId,
    version: 1,
    headline: "Resumo demonstrativo do caso (simulação).",
    urgencies: ["Conferir prazo de defesa"],
    possibleDeadlines: [{ description: "Apresentar defesa", date: null }],
    gapsCount: 2,
    missingDocumentsCount: 1,
    isDemo: true,
  }));
  mocks.sendTemplatedEmail.mockImplementation(async () => ({ emailId: randomUUID() }));
  mocks.buildDemoCaseDocuments.mockImplementation(async (info: DemoCaseInfo) => [
    {
      title: "Petição inicial (fictícia)",
      category: "initial_petition",
      description: "DOCUMENTO FICTÍCIO — GERADO PARA DEMONSTRAÇÃO",
      fileName: "peticao-inicial.txt",
      mimeType: "application/pdf",
      bytes: utf8(`DOCUMENTO FICTÍCIO — GERADO PARA DEMONSTRAÇÃO\nProcesso ${info.number}\nReclamante: ${info.plaintiff}`),
    },
    {
      title: "Procuração (fictícia)",
      category: "power_of_attorney",
      description: "DOCUMENTO FICTÍCIO — GERADO PARA DEMONSTRAÇÃO",
      fileName: "procuracao.txt",
      mimeType: "application/pdf",
      bytes: utf8("DOCUMENTO FICTÍCIO — GERADO PARA DEMONSTRAÇÃO\nProcuração."),
    },
  ]);
});

afterAll(async () => {
  await f?.teardown();
});

beforeEach(async () => {
  await f.db.delete(jobs);
});

describe("registerIncomingProcess", () => {
  it("creates process, parties, documents, intake, alert and the pipeline job", async () => {
    const formatted = cnj();
    const result = await registerIncomingProcess(f.ctx.lawyer, {
      ...input({ number: formatted.replace(/\D/g, ""), companyId: f.companyA, defendantName: null, unitId: f.unitSp }),
      documents: [
        {
          title: "Petição inicial",
          category: "initial_petition",
          file: { name: "peticao.txt", bytes: utf8("DOCUMENTO FICTÍCIO — petição inicial de teste.") },
        },
      ],
    });
    expect(result.jobQueued).toBe(true);
    expect(result.documentIds).toHaveLength(1);

    const proc = await getProcess(f.ctx.lawyer, result.processId);
    expect(proc).toMatchObject({
      number: formatted,
      court: "TRT10",
      area: "labor",
      companyId: f.companyA,
      city: "Palmas",
      instance: "first",
      createdById: f.ctx.lawyer.userId,
      responsibleId: null,
    });
    const parties = await f.db.select().from(processParties).where(eq(processParties.processId, result.processId));
    expect(parties.map((p) => [p.role, p.name, p.isClient])).toEqual(
      expect.arrayContaining([
        ["plaintiff", "Fulano de Tal Exemplo", false],
        ["defendant", "Empresa Fictícia A Ltda.", true],
      ]),
    );
    const docs = await f.db.select().from(documents).where(eq(documents.processId, result.processId));
    expect(docs).toHaveLength(1);

    const intake = await intakeRow(result.intakeId);
    expect(intake).toMatchObject({ status: "received", source: "manual", createdById: f.ctx.lawyer.userId, processId: result.processId });
    expect(intake.steps).toHaveLength(1);
    expect(intake.steps[0]).toMatchObject({ status: "received", actorName: f.ctx.lawyer.name });
    expect(intake.steps[0].detail).toContain("1 documento");

    const [alert] = await f.db.select().from(alerts).where(eq(alerts.dedupeKey, `new_process_received:${result.intakeId}`));
    expect(alert).toMatchObject({ type: "new_process_received", entityType: "intake", entityId: result.intakeId, resolvedAt: null });
    const queued = await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `intake.process:${result.intakeId}`));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: "intake.process", status: "queued", payload: { intakeId: result.intakeId } });
    const [audit] = await f.db.select().from(auditLogs).where(and(eq(auditLogs.action, "intake.create"), eq(auditLogs.entityId, result.intakeId)));
    expect(audit.actorId).toBe(f.ctx.lawyer.userId);
  });

  it("analysts register through intake:manage (no process:write) and remain creator and actor", async () => {
    const r = await registerIncomingProcess(f.ctx.analyst, input({ unitId: f.unitSp }));
    const proc = await getProcess(f.ctx.analyst, r.processId);
    expect(proc.createdById).toBe(f.ctx.analyst.userId);
    expect(proc.isConfidential).toBe(false);
    // A typed valor da causa is a manual proposal (never labeled as simulated).
    expect(proc.claimAmountCents).toBeNull();
    expect(await claimValuations(r.processId)).toMatchObject([{ status: "proposed", source: "manual", amountCents: 4_500_000 }]);
    const received = (await intakeRow(r.intakeId)).steps[0].detail.replace(/\s/g, " ");
    expect(received).toContain("Valor da causa de R$ 45.000,00 enviado para a conferência de valores");
    expect(received).not.toContain("simulado");
    const [audit] = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "legal_process.create"), eq(auditLogs.entityId, r.processId)));
    expect(audit.actorId).toBe(f.ctx.analyst.userId);
  });

  it("validates the number, the parties and every foreign id", async () => {
    // The simulated feed has its own entry point (demo organizations, simulated valor da causa).
    await expect(registerIncomingProcess(f.ctx.manager, { ...input(), source: "simulated_feed" })).rejects.toBeInstanceOf(ValidationError);
    await expect(registerIncomingProcess(f.ctx.executive, { ...input(), source: "simulated_feed" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(registerIncomingProcess(f.ctx.manager, input({ number: "12345" }))).rejects.toMatchObject({
      fieldErrors: { number: expect.any(Array) },
    });
    const dup = input();
    await registerIncomingProcess(f.ctx.manager, dup);
    await expect(registerIncomingProcess(f.ctx.manager, { ...input(), number: dup.number })).rejects.toMatchObject({
      fieldErrors: { number: expect.any(Array) },
    });
    await expect(registerIncomingProcess(f.ctx.manager, input({ defendantName: null }))).rejects.toMatchObject({
      fieldErrors: { defendantName: expect.any(Array) },
    });
    await expect(registerIncomingProcess(f.ctx.manager, input({ responsibleId: f.ctx.analyst.userId }))).rejects.toMatchObject({
      fieldErrors: { responsibleId: expect.any(Array) },
    });
    const [companyB] = await f.db.insert(companies).values({ organizationId: f.orgB, name: "Empresa B (fictícia)" }).returning();
    await expect(registerIncomingProcess(f.ctx.manager, input({ companyId: companyB.id }))).rejects.toMatchObject({
      fieldErrors: { companyId: expect.any(Array) },
    });
    await expect(registerIncomingProcess(f.ctx.manager, input({ unitId: f.unitB }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts a number whose check digit does not match, flagged for verification", async () => {
    const good = cnj();
    const parts = parseCnj(good)!;
    const wrong = `${parts.sequence}-${parts.checkDigit === "00" ? "01" : "00"}.2026.5.10.0801`;
    expect(isValidCnj(wrong)).toBe(false);
    const r = await registerIncomingProcess(f.ctx.manager, input({ number: wrong }));
    const proc = await getProcess(f.ctx.manager, r.processId);
    expect(proc.needsVerification).toBe(true);
    expect((await intakeRow(r.intakeId)).steps[0].detail).toContain("Dígito verificador");
  });

  it("requires intake:manage", async () => {
    for (const ctx of [f.ctx.executive, f.ctx.accountant, f.ctx.auditor, f.ctx.externalCounsel]) {
      await expect(registerIncomingProcess(ctx, input())).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("deferred registration waits for the uploads and starts on request", async () => {
    const r = await registerIncomingProcess(f.ctx.lawyer, { ...input({ unitId: f.unitSp }), deferProcessing: true });
    expect(r.jobQueued).toBe(false);
    expect(await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `intake.process:${r.intakeId}`))).toHaveLength(0);
    const res = await requestIntakeProcessing(f.ctx.lawyer, r.intakeId, { reason: "start", failedUploads: 1 });
    expect(res.deduplicated).toBe(false);
    expect(await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `intake.process:${r.intakeId}`))).toHaveLength(1);
    const steps = (await intakeRow(r.intakeId)).steps;
    expect(steps[steps.length - 1].detail).toContain("1 arquivo não pôde ser enviado");
    // Asking again while queued is deduplicated.
    expect((await requestIntakeProcessing(f.ctx.lawyer, r.intakeId, { reason: "retry" })).deduplicated).toBe(true);
  });
});

describe("processIntakeJob", () => {
  it("assigns, generates the brief (simulation) and sends the simulated e-mail, recording each step", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input({ unitId: f.unitSp, plaintiffName: "Beltrana Fictícia da Silva" }));
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });

    const intake = await intakeRow(r.intakeId);
    expect(intake.status).toBe("notified");
    expect(intake.assignedToId).toBe(f.ctx.lawyer.userId); // only lawyer of unit SP
    expect(intake.assignmentMethod).toBe("least_loaded");
    expect(intake.assignmentReason).toContain("Nenhuma regra aplicável");
    expect(intake.briefId).toBeTruthy();
    expect(intake.lastEmailId).toBeTruthy();
    expect(intake.steps.map((s) => s.status)).toEqual(["received", "assigned", "analyzing", "brief_ready", "notified"]);
    for (const s of intake.steps) expect(Number.isNaN(Date.parse(s.at))).toBe(false);
    expect(intake.steps[2].detail).toContain("simulação");
    expect(intake.steps[4].detail).toContain("Nenhuma mensagem real foi enviada");
    expect((await getProcess(f.ctx.manager, r.processId)).responsibleId).toBe(f.ctx.lawyer.userId);

    const briefCalls = callsFor(mocks.requestCaseBrief, r.processId);
    expect(briefCalls).toHaveLength(1);
    expect(briefCalls[0][0]).toMatchObject({ kind: "system", organizationId: f.orgA });
    expect(briefCalls[0][2]).toEqual({ intakeId: r.intakeId, inline: true });
    const emailCalls = briefEmailsFor(r.processId);
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0][1]).toMatchObject({
      template: "case_brief_ready",
      toUserId: f.ctx.lawyer.userId,
      linkPath: `/processos/${r.processId}?aba=documentos-e-analises#analise-preliminar`,
      briefId: intake.briefId,
      intakeId: r.intakeId,
      entity: { type: "intake", id: r.intakeId },
      data: expect.objectContaining({ isDemo: true, gapsCount: 2, briefVersion: 1 }),
    });
    expect(emailCalls[0][1].data.parties).toContain("Beltrana Fictícia da Silva");

    const [alert] = await f.db.select().from(alerts).where(eq(alerts.dedupeKey, `new_process_received:${r.intakeId}`));
    expect(alert.resolvedAt).not.toBeNull();

    // Idempotent: running again does nothing new.
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    expect(callsFor(mocks.requestCaseBrief, r.processId)).toHaveLength(1);
    expect(briefEmailsFor(r.processId)).toHaveLength(1);
    expect((await intakeRow(r.intakeId)).steps).toHaveLength(5);
  });

  it("records a sanitized failure, rethrows for the queue and resumes from the failed step on retry", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input({ unitId: f.unitRe }));
    let failBriefEmail = true;
    mocks.sendTemplatedEmail.mockImplementation(async (_ctx: AuthContext, mail: { template: string }) => {
      if (mail.template === "case_brief_ready" && failBriefEmail) {
        failBriefEmail = false;
        throw new Error("conexão recusada: texto sigiloso do documento");
      }
      return { emailId: randomUUID() };
    });
    await expect(processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 })).rejects.toThrow();
    let intake = await intakeRow(r.intakeId);
    expect(intake.status).toBe("failed");
    expect(intake.briefId).toBeTruthy();
    expect(intake.lastEmailId).toBeNull();
    expect(intake.errorMessage).toContain("E-mail ao advogado (simulado)");
    expect(intake.errorMessage).not.toContain("sigiloso");
    const failedStep = intake.steps[intake.steps.length - 1];
    expect(failedStep.status).toBe("failed");
    expect(failedStep.detail).toContain("tentativa 1 de 3");
    expect(failedStep.detail).not.toContain("sigiloso");

    await processIntakeJob(r.intakeId, { attempt: 2, maxAttempts: 3 });
    intake = await intakeRow(r.intakeId);
    expect(intake.status).toBe("notified");
    expect(intake.errorMessage).toBeNull();
    expect(callsFor(mocks.requestCaseBrief, r.processId)).toHaveLength(1);
  });

  it("runs through the real queue (intake.process handler)", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input({ unitId: f.unitSp }));
    await runJobs();
    const intake = await intakeRow(r.intakeId);
    expect(intake.status).toBe("notified");
  });

  it("without an eligible lawyer the intake stays received with an alert; manual distribution resolves it", async () => {
    const r = await registerIncomingProcess(f.ctx.adminB, input({ defendantName: "Empresa B (fictícia)" }));
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    let intake = await intakeRow(r.intakeId);
    expect(intake.status).toBe("received");
    expect(intake.assignedToId).toBeNull();
    expect(intake.steps[intake.steps.length - 1].detail).toContain("Nenhum responsável definido");
    const open = await f.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.dedupeKey, `intake_unassigned:${r.intakeId}`), isNull(alerts.resolvedAt)));
    expect(open).toHaveLength(1);
    expect(open[0].organizationId).toBe(f.orgB);
    expect(callsFor(mocks.requestCaseBrief, r.processId)).toHaveLength(0);

    await expect(autoAssignIntake(f.ctx.adminB, r.intakeId)).rejects.toThrow(/Nenhuma regra aplicável/);
    const [lawyerB] = await f.db
      .insert(users)
      .values({ organizationId: f.orgB, name: "Bia Advogada B", email: "intk.bia@b.test", passwordHash: "x", role: "lawyer", unitId: f.unitB })
      .returning();
    const d = await autoAssignIntake(f.ctx.adminB, r.intakeId);
    expect(d.userId).toBe(lawyerB.id);
    intake = await intakeRow(r.intakeId);
    expect(intake).toMatchObject({ status: "assigned", assignedToId: lawyerB.id });
    const stillOpen = await f.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.dedupeKey, `intake_unassigned:${r.intakeId}`), isNull(alerts.resolvedAt)));
    expect(stillOpen).toHaveLength(0);
    expect(await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `intake.process:${r.intakeId}`))).toHaveLength(1);
  });

  it("respects settings.intake (brief generation disabled) and allows manual generation", async () => {
    await f.db
      .update(organizations)
      .set({ settings: { ...DEFAULT_ORGANIZATION_SETTINGS, intake: { autoAssign: true, autoGenerateBrief: false, autoNotify: true } } })
      .where(eq(organizations.id, f.orgA));
    try {
      const r = await registerIncomingProcess(f.ctx.manager, input({ unitId: f.unitSp }));
      await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
      let intake = await intakeRow(r.intakeId);
      expect(intake.status).toBe("assigned");
      expect(intake.briefId).toBeNull();
      expect(intake.steps[intake.steps.length - 1].detail).toContain("desativada");
      expect(callsFor(mocks.requestCaseBrief, r.processId)).toHaveLength(0);
      // Second run: no duplicated note.
      await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
      expect((await intakeRow(r.intakeId)).steps).toHaveLength(intake.steps.length);

      await expect(regenerateIntakeBrief(f.ctx.executive, r.intakeId)).rejects.toBeInstanceOf(ForbiddenError);
      const { briefId } = await regenerateIntakeBrief(f.ctx.manager, r.intakeId);
      intake = await intakeRow(r.intakeId);
      expect(intake).toMatchObject({ status: "brief_ready", briefId });
      const calls = callsFor(mocks.requestCaseBrief, r.processId);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toMatchObject({ kind: "user", userId: f.ctx.manager.userId });
      expect(await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `intake.process:${r.intakeId}`))).toHaveLength(1);
    } finally {
      await f.db.update(organizations).set({ settings: DEFAULT_ORGANIZATION_SETTINGS }).where(eq(organizations.id, f.orgA));
    }
  });
});

describe("manual actions", () => {
  it("manual reassignment needs a reason and notifies the new responsible again", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input());
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const before = await intakeRow(r.intakeId);
    expect(before.lastEmailId).toBeTruthy();
    const target = before.assignedToId === f.ctx.lawyerRe.userId ? f.ctx.lawyer : f.ctx.lawyerRe;

    await expect(assignIntakeManually(f.ctx.executive, r.intakeId, { userId: target.userId!, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    // Replacing a responsible is a redistribution (distribution:manage): a lawyer with intake:manage cannot.
    await expect(assignIntakeManually(f.ctx.lawyer, r.intakeId, { userId: target.userId!, reason: "Férias" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignIntakeManually(f.ctx.manager, r.intakeId, { userId: target.userId!, reason: "" })).rejects.toBeInstanceOf(ValidationError);
    const d = await assignIntakeManually(f.ctx.manager, r.intakeId, { userId: target.userId!, reason: "Redistribuição por férias" });
    expect(d.method).toBe("manual");
    const after = await intakeRow(r.intakeId);
    expect(after).toMatchObject({ assignedToId: target.userId, assignmentMethod: "manual", lastEmailId: null, status: "brief_ready" });
    expect(after.steps[after.steps.length - 1].detail).toContain("Redistribuição por férias");

    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const emails = briefEmailsFor(r.processId);
    expect(emails).toHaveLength(2);
    expect(emails[1][1].toUserId).toBe(target.userId);
    expect((await intakeRow(r.intakeId)).status).toBe("notified");
  });

  it("resending the simulated e-mail requires email:send", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input({ unitId: f.unitSp }));
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    await expect(resendIntakeEmail(f.ctx.analyst, r.intakeId)).rejects.toBeInstanceOf(ForbiddenError);
    await resendIntakeEmail(f.ctx.lawyer, r.intakeId);
    const emails = briefEmailsFor(r.processId);
    expect(emails).toHaveLength(2);
    expect(emails[1][0]).toMatchObject({ kind: "user", userId: f.ctx.lawyer.userId });
    const steps = (await intakeRow(r.intakeId)).steps;
    expect(steps[steps.length - 1].detail).toContain("reenviado");
  });
});

describe("queries, effective status and visibility", () => {
  it("effective status follows the brief at read time without writing into it", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input({ unitId: f.unitSp }));
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const { briefId } = await intakeRow(r.intakeId);
    const before = await getIntakeCounts(f.ctx.manager);

    await f.db.update(caseBriefs).set({ status: "in_review", lastEditedAt: new Date(), lastEditedById: f.ctx.lawyer.userId }).where(eq(caseBriefs.id, briefId!));
    let detail = await getIntake(f.ctx.manager, r.intakeId);
    expect(detail.status).toBe("notified");
    expect(detail.effectiveStatus).toBe("in_review");
    expect(detail.stages.find((s) => s.key === "review")).toMatchObject({ state: "current", actor: f.ctx.lawyer.name });
    let list = await listIntakes(f.ctx.manager, { status: "in_review" });
    expect(list.items.map((i) => i.id)).toContain(r.intakeId);

    await f.db.update(caseBriefs).set({ status: "approved", approvedAt: new Date(), approvedById: f.ctx.lawyer.userId }).where(eq(caseBriefs.id, briefId!));
    detail = await getIntake(f.ctx.manager, r.intakeId);
    expect(detail.effectiveStatus).toBe("approved");
    expect(detail.stages.find((s) => s.key === "approval")).toMatchObject({ state: "done", actor: f.ctx.lawyer.name });
    list = await listIntakes(f.ctx.manager, { status: "approved" });
    expect(list.items.map((i) => i.id)).toContain(r.intakeId);
    const after = await getIntakeCounts(f.ctx.manager);
    expect(after.approved).toBe(before.approved + 1);
    expect(after.awaitingReview).toBe(before.awaitingReview - 1);
    expect((await intakeRow(r.intakeId)).status).toBe("notified");
  });

  it("intakes inherit the visibility of the process; organizations are isolated", async () => {
    const re = await registerIncomingProcess(f.ctx.manager, input({ unitId: f.unitRe }));
    await expect(getIntake(f.ctx.lawyer, re.intakeId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getIntake(f.ctx.adminB, re.intakeId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignIntakeManually(f.ctx.lawyer, re.intakeId, { userId: f.ctx.lawyer.userId!, reason: "teste" })).rejects.toBeInstanceOf(NotFoundError);
    const lawyerList = await listIntakes(f.ctx.lawyer, { pageSize: 100 });
    expect(lawyerList.items.map((i) => i.id)).not.toContain(re.intakeId);
    const reList = await listIntakes(f.ctx.lawyerRe, { pageSize: 100 });
    expect(reList.items.map((i) => i.id)).toContain(re.intakeId);
    const reNumber = (await getProcess(f.ctx.manager, re.processId)).number;
    const byDigits = await listIntakes(f.ctx.lawyerRe, { q: reNumber.replace(/\D/g, "") });
    expect(byDigits.items.map((i) => i.id)).toEqual([re.intakeId]);
    expect((await listIntakes(f.ctx.lawyer, { q: reNumber })).total).toBe(0);
    const bList = await listIntakes(f.ctx.adminB, { pageSize: 100 });
    expect(bList.items.map((i) => i.id)).not.toContain(re.intakeId);
    const countsB = await getIntakeCounts(f.ctx.adminB);
    const totalB = Object.values(countsB).reduce((a, b) => a + b, 0);
    const [{ n }] = await f.db.select({ n: sql<number>`count(*)::int` }).from(caseIntakes).where(eq(caseIntakes.organizationId, f.orgB));
    expect(totalB).toBe(n);
    expect(bList.total).toBe(n);
  });

  it("detail exposes the stepper, documents and permission flags per role", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, {
      ...input({ unitId: f.unitSp }),
      documents: [{ title: "Petição", category: "initial_petition", file: { name: "p.txt", bytes: utf8("DOCUMENTO FICTÍCIO") } }],
    });
    const d = await getIntake(f.ctx.analyst, r.intakeId);
    expect(d.stages.map((s) => s.key)).toEqual(["received", "assigned", "analysis", "email", "review", "approval"]);
    expect(d.stages[0].state).toBe("done");
    expect(d.processing).toBe(true); // job queued
    expect(d.documents).toHaveLength(1);
    expect(d.permissions).toMatchObject({ canAssign: true, canResendEmail: false, canGenerateBrief: true });
    const exec = await getIntake(f.ctx.executive, r.intakeId);
    expect(exec.permissions).toMatchObject({ canAssign: false, canProcess: false, canResendEmail: false });
  });
});

describe("simulateIncomingProcess (demo)", () => {
  it("is only available in demo organizations", async () => {
    await expect(simulateIncomingProcess(f.ctx.manager)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creates a NEW fictitious labor case with a valid CNJ, fictitious labels and demo documents", async () => {
    await f.db.update(organizations).set({ isDemo: true });
    const r = await simulateIncomingProcess(f.ctx.analyst, { seed: 3 });
    expect(isValidCnj(r.number)).toBe(true);
    const parts = parseCnj(r.number)!;
    expect(parts.segment).toBe("5");
    expect(parts.year).toBe(new Date().getFullYear());
    const proc = await getProcess(f.ctx.manager, r.processId);
    expect(laborCourtFromCnj(r.number)).toBe(normalizeCourt(proc.court));
    expect(proc.title).toContain("chegada simulada com dados fictícios");
    expect(proc.description).toContain("dados fictícios");
    expect(proc.area).toBe("labor");
    // An analyst cannot make values official: the simulated valor da causa waits in the
    // review queue, labeled as simulated, and the record stays without it (null, never 0).
    expect(proc.claimAmountCents).toBeNull();
    const analystClaims = await claimValuations(r.processId);
    expect(analystClaims).toHaveLength(1);
    expect(analystClaims[0]).toMatchObject({
      status: "proposed",
      source: "simulation",
      reviewedById: null,
      createdById: f.ctx.analyst.userId,
    });
    expect(analystClaims[0].amountCents).toBeGreaterThan(0);
    expect(analystClaims[0].reason).toContain("simulado (demonstração)");
    expect(proc.companyId).toBe(f.companyA);
    const parties = await f.db.select().from(processParties).where(eq(processParties.processId, r.processId));
    const plaintiff = parties.find((p) => p.role === "plaintiff")!;
    expect(FICTITIOUS_PLAINTIFFS).toContain(plaintiff.name);
    expect(parties.find((p) => p.role === "defendant")?.name).toBe("Empresa Fictícia A Ltda.");
    expect(r.documentIds).toHaveLength(2);
    const intake = await intakeRow(r.intakeId);
    expect(intake.source).toBe("simulated_feed");
    expect(intake.steps[0].detail).toContain("Chegada simulada com dados fictícios");
    const info = mocks.buildDemoCaseDocuments.mock.calls.at(-1)![0] as DemoCaseInfo;
    expect(info).toMatchObject({ number: r.number, plaintiff: plaintiff.name, defendant: "Empresa Fictícia A Ltda." });
    expect(await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `intake.process:${r.intakeId}`))).toHaveLength(1);

    // Same seed again: still a new, different number.
    const again = await simulateIncomingProcess(f.ctx.manager, { seed: 3 });
    expect(again.number).not.toBe(r.number);
    expect(isValidCnj(again.number)).toBe(true);
    // A gestor makes it official at once, still labeled as simulated.
    const managerClaims = await claimValuations(again.processId);
    expect(managerClaims).toHaveLength(1);
    expect(managerClaims[0]).toMatchObject({ status: "official", source: "simulation", reviewedById: f.ctx.manager.userId });
    expect(managerClaims[0].amountCents).toBeGreaterThan(0);
    expect((await getProcess(f.ctx.manager, again.processId)).claimAmountCents).toBe(managerClaims[0].amountCents);
  });

  it("the automatic feed (no identified person) keeps the simulated valor da causa off the record, as a labeled proposal", async () => {
    await f.db.update(organizations).set({ isDemo: true });
    // The worker routine runs `simulateIncomingProcess(systemContext(org, true))`: userId null.
    await f.db
      .update(caseIntakes)
      .set({ receivedAt: sql`now() - interval '1 day'` })
      .where(and(eq(caseIntakes.organizationId, f.orgA), eq(caseIntakes.source, "simulated_feed")));
    const org = await loadOrganization(f.orgA);
    const settings = {
      ...org.settings,
      integrations: { ...org.settings.integrations, simulatedFeed: { enabled: true, intervalMinutes: 60 } },
    };
    const status = await runSimulatedFeedRoutine({ organizationId: f.orgA, isDemo: true, settings, config: {}, today: todayISO() });
    expect(status).toContain("Chegada simulada (dados fictícios)");
    const [intake] = await f.db
      .select()
      .from(caseIntakes)
      .where(and(eq(caseIntakes.organizationId, f.orgA), eq(caseIntakes.source, "simulated_feed")))
      .orderBy(desc(caseIntakes.receivedAt))
      .limit(1);
    expect(intake.createdById).toBeNull();

    // Nothing unlabeled on the record (null, never 0): one PROPOSED valuation, source simulation, no author.
    expect((await getProcess(f.ctx.manager, intake.processId)).claimAmountCents).toBeNull();
    const proposed = await claimValuations(intake.processId);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ status: "proposed", source: "simulation", createdById: null, reviewedById: null, isEstimate: false });
    expect(proposed[0].amountCents).toBeGreaterThan(0);
    expect(proposed[0].reason).toContain("simulado (demonstração)");
    expect(intake.steps[0].detail).toContain("Valor da causa simulado (demonstração)");
    expect(intake.steps[0].detail).toContain("conferência de valores");
    expect(intake.steps[0].detail).not.toContain("—");

    // A gestor confers it in the queue: official, still labeled as simulated, and only then on the record.
    expect((await reviewValuation(f.ctx.manager, proposed[0].id, { decision: "approve" })).status).toBe("official");
    const [official] = (await claimValuations(intake.processId)).filter((v) => v.status === "official");
    expect(official).toMatchObject({ source: "simulation", amountCents: proposed[0].amountCents, reviewedById: f.ctx.manager.userId });
    expect((await getProcess(f.ctx.manager, intake.processId)).claimAmountCents).toBe(proposed[0].amountCents);
  });

  it("an analyst's arrival says in the received step that the valor da causa waits for the review", async () => {
    const r = await simulateIncomingProcess(f.ctx.analyst, { seed: 21 });
    const [claim] = await claimValuations(r.processId);
    expect(claim).toMatchObject({ status: "proposed", source: "simulation" });
    expect((await intakeRow(r.intakeId)).steps[0].detail).toContain("Valor da causa simulado (demonstração)");
    // A gestor's value is official at once: no pending note.
    const g = await simulateIncomingProcess(f.ctx.manager, { seed: 22 });
    expect((await intakeRow(g.intakeId)).steps[0].detail).not.toContain("conferência de valores");
  });

  it("samples court/city from the labor portfolio and falls back to TRT10 / Palmas-TO", async () => {
    // Organization B has no labor portfolio → fallback.
    const b = await simulateIncomingProcess(f.ctx.adminB, { seed: 5 });
    const procB = await getProcess(f.ctx.adminB, b.processId);
    expect(procB).toMatchObject({ court: "TRT10", city: "Palmas", state: "TO" });
    expect(parseCnj(b.number)!.tribunal).toBe("10");

    // Organization A: a TRT2 portfolio in a city with an origin code taken from its own numbers.
    for (let i = 0; i < 6; i++) {
      await registerIncomingProcess(f.ctx.manager, input({ number: cnj({ tribunal: "02", origin: "0062" }), court: "TRT2", city: "São Paulo - SP", state: null }));
    }
    const sampled = new Set<string>();
    for (const seed of [11, 12, 13, 14]) {
      const r = await simulateIncomingProcess(f.ctx.manager, { seed });
      const proc = await getProcess(f.ctx.manager, r.processId);
      sampled.add(proc.court);
      if (proc.court === "TRT2") {
        expect(proc.city).toBe("São Paulo");
        expect(proc.state).toBe("SP");
        expect(parseCnj(r.number)).toMatchObject({ tribunal: "02", origin: "0062" });
      }
    }
    expect([...sampled].every((c) => /^TRT\d+$/.test(c))).toBe(true);
    expect(sampled.has("TRT2")).toBe(true);
  });
});
