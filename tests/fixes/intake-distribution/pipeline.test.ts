/**
 * Review fixes (intake-distribution): intake pipeline and registration
 * (findings 4, 7, 9, 10, 11, 12, 13).
 *
 * Briefs are mocked (the briefs package is tested on its own); e-mails are
 * REAL, wrapped so a failure can be injected right after a message is stored.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  requestCaseBrief: vi.fn(),
  getCaseBriefEmailDigest: vi.fn(),
  failAfterBriefEmail: { on: false },
  addParty: vi.fn(),
  upsertAlert: vi.fn(),
}));
vi.mock("@/modules/briefs/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/briefs/service")>()),
  requestCaseBrief: mocks.requestCaseBrief,
  getCaseBriefEmailDigest: mocks.getCaseBriefEmailDigest,
}));
vi.mock("@/modules/emails/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/emails/service")>();
  return {
    ...real,
    sendTemplatedEmail: async (...args: Parameters<typeof real.sendTemplatedEmail>) => {
      const result = await real.sendTemplatedEmail(...args);
      // Delivered and stored, then the caller's next write fails (DB hiccup).
      if (mocks.failAfterBriefEmail.on && args[1].template === "case_brief_ready") {
        mocks.failAfterBriefEmail.on = false;
        throw new Error("conexão com o banco perdida");
      }
      return result;
    },
  };
});
vi.mock("@/modules/processes/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/processes/service")>();
  mocks.addParty.mockImplementation(real.addParty);
  return { ...real, addParty: mocks.addParty };
});
vi.mock("@/modules/alerts/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/alerts/service")>();
  mocks.upsertAlert.mockImplementation(real.upsertAlert);
  return { ...real, upsertAlert: mocks.upsertAlert };
});

import { makeOccurrence, setupFixture, utf8, type Fixture } from "../../helpers/fixtures";
import { buildSimulatedCnj } from "@/modules/intake/simulation";
import type { RegisterIntakeInput } from "@/modules/intake/schemas";
import { effectiveIntakeStatus } from "@/modules/intake/status";
import {
  getIntake,
  getIntakeCounts,
  getIntakeStatusCounts,
  listIntakes,
  processIntakeJob,
  registerIncomingProcess,
  requestIntakeProcessing,
} from "@/modules/intake/service";
import { getProcess } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import {
  DEFAULT_ORGANIZATION_SETTINGS,
  alerts,
  auditLogs,
  caseBriefSources,
  caseBriefs,
  caseIntakes,
  documents,
  emailMessages,
  jobs,
  legalProcesses,
  organizations,
  type OrganizationSettings,
} from "@/server/db/schema";
import { NotFoundError } from "@/server/lib/errors";

let f: Fixture;
let seq = 9000;

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
    plaintiffName: "Ciclana Fictícia de Teste",
    defendantName: "Empresa Fictícia A Ltda.",
    unitId: f.unitSp,
    ...overrides,
  };
}

async function intakeRow(id: string) {
  const [row] = await f.db.select().from(caseIntakes).where(eq(caseIntakes.id, id));
  return row;
}

async function briefMails(intakeId: string) {
  return f.db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.intakeId, intakeId), eq(emailMessages.template, "case_brief_ready")));
}

async function openAlert(key: string) {
  return f.db.select().from(alerts).where(and(eq(alerts.dedupeKey, key), isNull(alerts.resolvedAt)));
}

async function withSettings(patch: (s: OrganizationSettings) => OrganizationSettings, run: () => Promise<void>) {
  await f.db.update(organizations).set({ settings: patch(structuredClone(DEFAULT_ORGANIZATION_SETTINGS)) }).where(eq(organizations.id, f.orgA));
  try {
    await run();
  } finally {
    await f.db.update(organizations).set({ settings: DEFAULT_ORGANIZATION_SETTINGS }).where(eq(organizations.id, f.orgA));
  }
}

/** Default brief mock: a ready version whose sources are the process documents (like the real generator). */
async function insertBrief(ctx: AuthContext, processId: string, intakeId: string | null, status: "ready_for_review" | "generating") {
  const [{ n }] = await f.db.select({ n: sql<number>`count(*)::int` }).from(caseBriefs).where(eq(caseBriefs.processId, processId));
  const [row] = await f.db
    .insert(caseBriefs)
    .values({
      organizationId: ctx.organizationId,
      processId,
      intakeId,
      version: n + 1,
      status,
      mode: "demo",
      provider: "simulated",
      model: "simulado",
      promptVersion: "test",
      inputHash: "x",
      generatedAt: status === "generating" ? null : new Date(),
      requestedById: ctx.userId,
    })
    .returning({ id: caseBriefs.id });
  const docs = await f.db
    .select({ id: documents.id, title: documents.title, versionId: documents.currentVersionId })
    .from(documents)
    .where(eq(documents.processId, processId));
  for (const [i, d] of docs.entries()) {
    await f.db.insert(caseBriefSources).values({
      organizationId: ctx.organizationId,
      briefId: row.id,
      ref: `D${i + 1}`,
      sourceType: "document_version",
      entityId: d.id,
      versionId: d.versionId,
      label: d.title,
      contentHash: "x",
    });
  }
  return row.id;
}

beforeAll(async () => {
  f = await setupFixture("fixpipe");
  mocks.requestCaseBrief.mockImplementation(async (ctx: AuthContext, processId: string, opts: { intakeId?: string | null }) => ({
    briefId: await insertBrief(ctx, processId, opts.intakeId ?? null, "ready_for_review"),
    status: "ready_for_review",
  }));
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
  mocks.failAfterBriefEmail.on = false;
});

describe("rejected brief (finding 4)", () => {
  it("is shown as “Análise rejeitada” and leaves the “awaiting review” counter", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input());
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const { briefId } = await intakeRow(r.intakeId);
    const before = await getIntakeCounts(f.ctx.manager);

    await f.db
      .update(caseBriefs)
      .set({ status: "rejected", rejectedAt: new Date(), rejectedById: f.ctx.lawyer.userId })
      .where(eq(caseBriefs.id, briefId!));

    const after = await getIntakeCounts(f.ctx.manager);
    expect(after.awaitingReview).toBe(before.awaitingReview - 1);
    expect(after.inProgress).toBe(before.inProgress);
    const detail = await getIntake(f.ctx.manager, r.intakeId);
    expect(detail.effectiveStatus).toBe("brief_rejected");
    expect(detail.stages.find((s) => s.key === "approval")?.state).toBe("failed");
    expect((await listIntakes(f.ctx.manager, { status: "brief_rejected", pageSize: 100 })).items.map((i) => i.id)).toContain(r.intakeId);
    expect((await listIntakes(f.ctx.manager, { status: "notified", pageSize: 100 })).items.map((i) => i.id)).not.toContain(r.intakeId);
    expect((await getIntakeStatusCounts(f.ctx.manager)).brief_rejected).toBeGreaterThanOrEqual(1);
    expect(effectiveIntakeStatus("notified", "rejected")).toBe("brief_rejected");
    expect(effectiveIntakeStatus("failed", "rejected")).toBe("failed");
  });
});

describe("registration is undone when it is interrupted (finding 7)", () => {
  it("a failure after the process was created frees the number for a retry", async () => {
    const data = input();
    mocks.addParty.mockRejectedValueOnce(new Error("falha transitória do banco"));
    await expect(registerIncomingProcess(f.ctx.manager, data)).rejects.toThrow();
    const orphans = await f.db.select().from(legalProcesses).where(eq(legalProcesses.number, data.number));
    expect(orphans).toHaveLength(1);
    expect(orphans[0].deletedAt).not.toBeNull();
    const [audit] = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "legal_process.delete"), eq(auditLogs.entityId, orphans[0].id)));
    expect(audit.summary).toContain("interrompido");

    const retry = await registerIncomingProcess(f.ctx.manager, data);
    expect((await getProcess(f.ctx.manager, retry.processId)).number).toBe(data.number);
  });

  it("a failure after the uploads also removes the uploaded documents", async () => {
    const data = input();
    mocks.upsertAlert.mockRejectedValueOnce(new Error("falha transitória do banco"));
    await expect(
      registerIncomingProcess(f.ctx.manager, {
        ...data,
        documents: [{ title: "Petição inicial", category: "initial_petition", file: { name: "p.txt", bytes: utf8("DOCUMENTO FICTÍCIO") } }],
      }),
    ).rejects.toThrow();
    const [orphan] = await f.db.select().from(legalProcesses).where(eq(legalProcesses.number, data.number));
    expect(orphan.deletedAt).not.toBeNull();
    const docs = await f.db.select().from(documents).where(eq(documents.processId, orphan.id));
    expect(docs).toHaveLength(1);
    expect(docs[0].deletedAt).not.toBeNull();
    expect(await f.db.select().from(caseIntakes).where(eq(caseIntakes.processId, orphan.id))).toHaveLength(0);
    await expect(getProcess(f.ctx.manager, orphan.id)).rejects.toBeInstanceOf(NotFoundError);

    const retry = await registerIncomingProcess(f.ctx.manager, data);
    expect(retry.processId).not.toBe(orphan.id);
  });
});

describe("the “análise disponível” e-mail is idempotent (finding 9)", () => {
  it("a failure after the message was stored does not send it twice on retry", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input());
    mocks.failAfterBriefEmail.on = true;
    await expect(processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 })).rejects.toThrow();
    expect((await intakeRow(r.intakeId)).lastEmailId).toBeNull();
    expect(await briefMails(r.intakeId)).toHaveLength(1);

    await processIntakeJob(r.intakeId, { attempt: 2, maxAttempts: 3 });
    const sent = await briefMails(r.intakeId);
    expect(sent).toHaveLength(1);
    expect(await intakeRow(r.intakeId)).toMatchObject({ status: "notified", lastEmailId: sent[0].id });
  });
});

describe("brief digest only for a recipient who can open the brief (finding 10)", () => {
  it("a source document also linked to an occurrence hidden from the responsible: e-mail without the digest", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, {
      ...input(),
      documents: [{ title: "Petição inicial", category: "initial_petition", file: { name: "p.txt", bytes: utf8("DOCUMENTO FICTÍCIO") } }],
    });
    // The document is also linked to an occurrence of another unit: the SP lawyer cannot open it.
    const occurrenceId = await makeOccurrence(f.ctx.manager, { unitId: f.unitRe });
    await f.db.update(documents).set({ occurrenceId }).where(eq(documents.id, r.documentIds[0]));
    const digestCalls = mocks.getCaseBriefEmailDigest.mock.calls.length;

    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const row = await intakeRow(r.intakeId);
    expect(row.assignedToId).toBe(f.ctx.lawyer.userId);
    expect(row.status).toBe("notified");
    const [mail] = await briefMails(r.intakeId);
    expect(mail.toUserId).toBe(f.ctx.lawyer.userId);
    expect(mail.bodyText).toContain("não foi incluído neste e-mail");
    expect(mail.bodyText).not.toContain("Resumo demonstrativo do caso");
    expect(mail.bodyText).not.toContain("Conferir prazo de defesa");
    expect(mocks.getCaseBriefEmailDigest.mock.calls.length).toBe(digestCalls);
    expect(row.steps[row.steps.length - 1].detail).toContain("não foi incluído");
  });

  it("a recipient who can open the brief gets the digest", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, {
      ...input(),
      documents: [{ title: "Petição inicial", category: "initial_petition", file: { name: "p.txt", bytes: utf8("DOCUMENTO FICTÍCIO") } }],
    });
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const [mail] = await briefMails(r.intakeId);
    expect(mail.bodyText).toContain("Resumo demonstrativo do caso");
    expect(mail.bodyText).not.toContain("não foi incluído neste e-mail");
  });
});

describe("pipeline settings (findings 11 and 12)", () => {
  it("automatic distribution off: the responsible chosen at registration is kept", async () => {
    await withSettings(
      (s) => ({ ...s, intake: { ...s.intake, autoAssign: false } }),
      async () => {
        const r = await registerIncomingProcess(f.ctx.manager, input({ responsibleId: f.ctx.lawyer.userId }));
        await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
        const row = await intakeRow(r.intakeId);
        expect(row).toMatchObject({ assignedToId: f.ctx.lawyer.userId, assignmentMethod: "kept", status: "notified" });
        expect(await openAlert(`intake_unassigned:${r.intakeId}`)).toHaveLength(0);

        // Without a responsible it still waits for a manual assignment.
        const none = await registerIncomingProcess(f.ctx.manager, input());
        await processIntakeJob(none.intakeId, { attempt: 1, maxAttempts: 3 });
        expect(await intakeRow(none.intakeId)).toMatchObject({ assignedToId: null, status: "received" });
        expect(await openAlert(`intake_unassigned:${none.intakeId}`)).toHaveLength(1);
      },
    );
  });

  it.each([
    ["intake.autoNotify", (s: OrganizationSettings) => ({ ...s, intake: { ...s.intake, autoNotify: false } })],
    ["email.notifyOnBriefReady", (s: OrganizationSettings) => ({ ...s, email: { ...s.email, notifyOnBriefReady: false } })],
  ])("e-mail step off (%s): the “novo processo recebido” alert is resolved", async (_name, patch) => {
    await withSettings(patch, async () => {
      const r = await registerIncomingProcess(f.ctx.manager, input());
      expect(await openAlert(`new_process_received:${r.intakeId}`)).toHaveLength(1);
      await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
      expect((await intakeRow(r.intakeId)).status).toBe("brief_ready");
      expect(await openAlert(`new_process_received:${r.intakeId}`)).toHaveLength(0);
      expect(await briefMails(r.intakeId)).toHaveLength(0);
    });
  });
});

describe("linked brief that failed (finding 13)", () => {
  it("a reused version still generating waits; once it failed, “Continuar processamento” generates a new one", async () => {
    const r = await registerIncomingProcess(f.ctx.manager, input());
    mocks.requestCaseBrief.mockImplementationOnce(async (ctx: AuthContext, processId: string, opts: { intakeId?: string | null }) => ({
      briefId: await insertBrief(ctx, processId, opts.intakeId ?? null, "generating"),
      status: "generating",
    }));
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const first = await intakeRow(r.intakeId);
    expect(first.status).toBe("analyzing");
    expect(first.briefId).toBeTruthy();

    // Still generating: nothing new is requested.
    const calls = mocks.requestCaseBrief.mock.calls.length;
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    expect(mocks.requestCaseBrief.mock.calls.length).toBe(calls);

    await f.db.update(caseBriefs).set({ status: "failed" }).where(eq(caseBriefs.id, first.briefId!));
    await requestIntakeProcessing(f.ctx.manager, r.intakeId, { reason: "retry" });
    await processIntakeJob(r.intakeId, { attempt: 1, maxAttempts: 3 });
    const after = await intakeRow(r.intakeId);
    expect(mocks.requestCaseBrief.mock.calls.length).toBe(calls + 1);
    expect(after.briefId).not.toBe(first.briefId);
    expect(after.status).toBe("notified");
    expect(await briefMails(r.intakeId)).toHaveLength(1);
  });
});
