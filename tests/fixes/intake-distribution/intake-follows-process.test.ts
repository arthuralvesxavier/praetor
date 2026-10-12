/**
 * Review fixes (intake-distribution): the intake follows the process
 * responsible (redistribution or process edit) and the simulated
 * "Novo processo atribuído" e-mail is really generated (findings 3 and 5).
 *
 * Briefs are mocked (the briefs package is tested on its own); e-mails are REAL
 * (rows in email_messages).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ requestCaseBrief: vi.fn(), getCaseBriefEmailDigest: vi.fn() }));
vi.mock("@/modules/briefs/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/briefs/service")>()),
  requestCaseBrief: mocks.requestCaseBrief,
  getCaseBriefEmailDigest: mocks.getCaseBriefEmailDigest,
}));

import { setupFixture, type Fixture } from "../../helpers/fixtures";
import {
  assignResponsible,
  createRule,
  decideAssignment,
  deleteRule,
  reassignResponsible,
} from "@/modules/distribution/service";
import { buildSimulatedCnj } from "@/modules/intake/simulation";
import type { RegisterIntakeInput } from "@/modules/intake/schemas";
import {
  assignIntakeManually,
  getIntake,
  listIntakes,
  processIntakeJob,
  registerIncomingProcess,
  resendIntakeEmail,
} from "@/modules/intake/service";
import { createProcess } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import {
  DEFAULT_ORGANIZATION_SETTINGS,
  caseBriefs,
  caseIntakes,
  emailMessages,
  jobs,
  legalProcesses,
  organizations,
  users,
} from "@/server/db/schema";
import { ConflictError } from "@/server/lib/errors";

let f: Fixture;
let seq = 8000;

function cnj(): string {
  seq += 1;
  return buildSimulatedCnj({ seed: seq, year: 2026, tribunal: "10", origin: "0801" });
}

function input(overrides: Partial<RegisterIntakeInput> = {}): RegisterIntakeInput {
  return {
    number: cnj(),
    court: "TRT10",
    city: "Palmas",
    state: "TO",
    area: "labor",
    phase: "knowledge",
    instance: "first",
    plaintiffName: "Fulana Fictícia de Teste",
    defendantName: "Empresa Fictícia A Ltda.",
    unitId: f.unitSp,
    ...overrides,
  };
}

async function intakeRow(id: string) {
  const [row] = await f.db.select().from(caseIntakes).where(eq(caseIntakes.id, id));
  return row;
}

async function mails(processId: string, template: "case_brief_ready" | "intake_assigned") {
  return f.db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.processId, processId), eq(emailMessages.template, template)))
    .orderBy(emailMessages.createdAt);
}

async function setNotifyOnAssignment(on: boolean) {
  await f.db
    .update(organizations)
    .set({ settings: { ...DEFAULT_ORGANIZATION_SETTINGS, email: { ...DEFAULT_ORGANIZATION_SETTINGS.email, notifyOnAssignment: on } } })
    .where(eq(organizations.id, f.orgA));
}

async function addLawyer(name: string, unitId: string): Promise<AuthContext> {
  seq += 1;
  const [u] = await f.db
    .insert(users)
    .values({ organizationId: f.orgA, name, email: `fixfollow.${seq}@a.test`, passwordHash: "x", role: "lawyer", unitId })
    .returning();
  return { kind: "user", userId: u.id, organizationId: f.orgA, role: "lawyer", unitId, lawFirmId: null, name, email: u.email, isDemoOrganization: false };
}

beforeAll(async () => {
  f = await setupFixture("fixfollow");
  mocks.requestCaseBrief.mockImplementation(async (ctx: AuthContext, processId: string, opts: { intakeId?: string | null }) => {
    const [{ n }] = await f.db.select({ n: sql<number>`count(*)::int` }).from(caseBriefs).where(eq(caseBriefs.processId, processId));
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
});

afterAll(async () => {
  await f?.teardown();
});

beforeEach(async () => {
  await f.db.delete(jobs);
  await setNotifyOnAssignment(true);
});

describe("the intake follows the process responsible (finding 3)", () => {
  it("redistribution from /distribuicao moves the intake, notifies the new responsible and resends to them", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input());
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    expect((await intakeRow(r.intakeId)).assignedToId).toBe(f.ctx.lawyer.userId);

    await reassignResponsible(f.ctx.manager, r.processId, { userId: f.ctx.lawyerRe.userId!, reason: "Férias da titular" });
    const row = await intakeRow(r.intakeId);
    expect(row).toMatchObject({ assignedToId: f.ctx.lawyerRe.userId, assignmentMethod: "manual", lastEmailId: null, status: "brief_ready" });
    expect(row.steps[row.steps.length - 1].detail).toContain("Férias da titular");
    expect(await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `intake.process:${r.intakeId}`))).toHaveLength(1);

    const detail = await getIntake(f.ctx.manager, r.intakeId);
    expect(detail).toMatchObject({ assignedToId: f.ctx.lawyerRe.userId, assignedToName: f.ctx.lawyerRe.name });

    // The queued pipeline sends the "análise disponível" e-mail to the new responsible.
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    let brief = await mails(r.processId, "case_brief_ready");
    expect(brief.map((m) => m.toUserId)).toEqual([f.ctx.lawyer.userId, f.ctx.lawyerRe.userId]);

    await resendIntakeEmail(f.ctx.manager, r.intakeId);
    brief = await mails(r.processId, "case_brief_ready");
    expect(brief[brief.length - 1].toUserId).toBe(f.ctx.lawyerRe.userId);
  });

  it("a process edit (responsible changed directly) is followed by the reads and by the e-mail", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input());
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    await f.db.update(legalProcesses).set({ responsibleId: f.ctx.lawyerRe.userId }).where(eq(legalProcesses.id, r.processId));

    const detail = await getIntake(f.ctx.manager, r.intakeId);
    expect(detail).toMatchObject({ assignedToId: f.ctx.lawyerRe.userId, assignedToName: f.ctx.lawyerRe.name, assignmentMethod: null });
    const number = (await f.db.select({ n: legalProcesses.number }).from(legalProcesses).where(eq(legalProcesses.id, r.processId)))[0].n;
    const list = await listIntakes(f.ctx.manager, { q: number });
    expect(list.items[0]).toMatchObject({ id: r.intakeId, assignedToName: f.ctx.lawyerRe.name, assignmentMethod: null });

    await resendIntakeEmail(f.ctx.manager, r.intakeId);
    const brief = await mails(r.processId, "case_brief_ready");
    expect(brief[brief.length - 1].toUserId).toBe(f.ctx.lawyerRe.userId);
    expect((await intakeRow(r.intakeId)).assignedToId).toBe(f.ctx.lawyerRe.userId);
  });

  it("“Reatribuir” to the person who already is the process responsible syncs the intake instead of failing", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input());
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    await f.db.update(legalProcesses).set({ responsibleId: f.ctx.lawyerRe.userId }).where(eq(legalProcesses.id, r.processId));

    const d = await assignIntakeManually(f.ctx.manager, r.intakeId, { userId: f.ctx.lawyerRe.userId!, reason: "Alinhar com o processo" });
    expect(d.userId).toBe(f.ctx.lawyerRe.userId);
    expect(await intakeRow(r.intakeId)).toMatchObject({ assignedToId: f.ctx.lawyerRe.userId, lastEmailId: null });
    await expect(
      assignIntakeManually(f.ctx.manager, r.intakeId, { userId: f.ctx.lawyerRe.userId!, reason: "De novo" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("distribution loads count the open intake for the current process responsible", async () => {
    const a1 = await addLawyer("Alice Carga Um", f.unitRe);
    const a2 = await addLawyer("Bruna Carga Dois", f.unitRe);
    const r = await registerIncomingProcess(f.ctx.manager, { ...input({ unitId: f.unitRe }), deferProcessing: true });
    await assignIntakeManually(f.ctx.manager, r.intakeId, { userId: a1.userId!, reason: "Primeira atribuição" });
    // The process changes hands outside the intake.
    await f.db.update(legalProcesses).set({ responsibleId: a2.userId }).where(eq(legalProcesses.id, r.processId));

    const ruleA1 = await createRule(f.ctx.manager, { name: "Carga A1", priority: 1, method: "least_loaded", courts: ["TRT9"], userIds: [a1.userId!] });
    const ruleA2 = await createRule(f.ctx.manager, { name: "Carga A2", priority: 2, method: "least_loaded", courts: ["TRT8"], userIds: [a2.userId!] });
    try {
      const { id: p9 } = await createProcess(f.ctx.manager, { number: cnj(), title: "Processo fictício TRT9", court: "TRT9", area: "labor", phase: "knowledge" });
      const { id: p8 } = await createProcess(f.ctx.manager, { number: cnj(), title: "Processo fictício TRT8", court: "TRT8", area: "labor", phase: "knowledge" });
      expect((await decideAssignment(f.ctx.manager, p9)).reason).toContain(`${a1.name} (0 processos ativos e 0 entradas em aberto)`);
      expect((await decideAssignment(f.ctx.manager, p8)).reason).toContain(`${a2.name} (1 processo ativo e 1 entrada em aberto)`);
    } finally {
      await deleteRule(f.ctx.manager, ruleA1.id);
      await deleteRule(f.ctx.manager, ruleA2.id);
    }
  });
});

describe("“Novo processo atribuído” e-mail (finding 5)", () => {
  it("setting on: the new responsible receives one simulated e-mail per assignment, never the person who assigned", async () => {
    const r = await registerIncomingProcess(f.ctx.analyst, { ...input(), deferProcessing: true });
    const first = await assignIntakeManually(f.ctx.analyst, r.intakeId, { userId: f.ctx.lawyer.userId!, reason: "Primeira atribuição" });
    expect(first.assignmentEmail).toBe("sent");
    let sent = await mails(r.processId, "intake_assigned");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ toUserId: f.ctx.lawyer.userId, status: "simulated", intakeId: r.intakeId, entityType: "intake" });
    expect(sent[0].subject.startsWith("[Simulação]")).toBe(true);
    expect(sent[0].bodyText).toContain("Primeira atribuição");

    await reassignResponsible(f.ctx.manager, r.processId, { userId: f.ctx.lawyerRe.userId!, reason: "Redistribuição" });
    sent = await mails(r.processId, "intake_assigned");
    expect(sent.map((m) => m.toUserId)).toEqual([f.ctx.lawyer.userId, f.ctx.lawyerRe.userId]);

    // Assigning to oneself: no e-mail.
    const self = await assignIntakeManually(f.ctx.manager, r.intakeId, { userId: f.ctx.manager.userId!, reason: "Assumo o caso" });
    expect(self.assignmentEmail).toBe("skipped");
    expect(await mails(r.processId, "intake_assigned")).toHaveLength(2);
  });

  it("the automatic distribution of the pipeline also sends it; the bulk distribution (no notify) does not", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input());
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const sent = await mails(r.processId, "intake_assigned");
    expect(sent).toHaveLength(1);
    expect(sent[0].toUserId).toBe(f.ctx.lawyer.userId);

    // Bulk distribution after an import calls assignResponsible without `notify`.
    const { id: p } = await createProcess(f.ctx.manager, { number: cnj(), title: "Importado fictício", court: "TRT10", area: "labor", phase: "knowledge", unitId: f.unitSp });
    const d = await assignResponsible(f.ctx.manager, p);
    expect(d.userId).toBeTruthy();
    expect(await mails(p, "intake_assigned")).toHaveLength(0);

    // "Distribuir pelas regras" on /distribuicao passes notify: a process without intake links to the process.
    const { id: p2 } = await createProcess(f.ctx.manager, {
      number: cnj(),
      title: "Carteira fictícia",
      court: "TRT10",
      area: "labor",
      phase: "knowledge",
      unitId: f.unitSp,
      responsibleId: f.ctx.lawyerRe.userId,
    });
    const forced = await assignResponsible(f.ctx.manager, p2, { force: true, notify: true });
    expect(forced.userId).toBe(f.ctx.lawyer.userId);
    const forcedMail = await mails(p2, "intake_assigned");
    expect(forcedMail).toHaveLength(1);
    expect(forcedMail[0]).toMatchObject({ toUserId: f.ctx.lawyer.userId, entityType: "legal_process", entityId: p2, intakeId: null });
  });

  it("setting off: no e-mail, and the result says so", async () => {
    await setNotifyOnAssignment(false);
    const r = await registerIncomingProcess(f.ctx.analyst, { ...input(), deferProcessing: true });
    const res = await assignIntakeManually(f.ctx.analyst, r.intakeId, { userId: f.ctx.lawyer.userId!, reason: "Primeira atribuição" });
    expect(res.assignmentEmail).toBe("disabled");
    await reassignResponsible(f.ctx.manager, r.processId, { userId: f.ctx.lawyerRe.userId!, reason: "Redistribuição" });
    expect(await mails(r.processId, "intake_assigned")).toHaveLength(0);
  });
});
