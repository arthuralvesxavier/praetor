import net from "node:net";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  getEmail,
  listEmailFilterOptions,
  listEmails,
  resendEmail,
  sendDailyDigest,
  sendTemplatedEmail,
} from "@/modules/emails/service";
import type { EmailTemplateDataMap } from "@/modules/emails/templates";
import { systemContext, type AuthContext } from "@/server/auth/context";
import { auditLogs, caseBriefs, deadlines, emailEvents, emailMessages, legalProcesses, users } from "@/server/db/schema";
import {
  EmailProviderError,
  SimulatedEmailProvider,
  setEmailProviderForTesting,
  type EmailProvider,
} from "@/server/integrations/email";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";

let fx: Fixture;
let sys: AuthContext;
const ids: Record<string, string> = {};

async function expectRejects<T extends Error>(p: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected ${type.name}`);
}

let seq = 0;
async function insertProcess(
  orgId: string,
  values: Partial<typeof legalProcesses.$inferInsert> = {},
): Promise<string> {
  seq += 1;
  const [p] = await fx.db
    .insert(legalProcesses)
    .values({
      organizationId: orgId,
      number: `${String(seq).padStart(7, "0")}-11.2026.5.10.0001`,
      title: `Processo fictício ${seq}`,
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      ...values,
    })
    .returning({ id: legalProcesses.id });
  return p.id;
}

async function insertBrief(processId: string, status: "ready_for_review" | "approved" = "ready_for_review", version = 1) {
  const [b] = await fx.db
    .insert(caseBriefs)
    .values({
      organizationId: fx.orgA,
      processId,
      version,
      status,
      mode: "demo",
      provider: "simulated",
      model: "simulated",
      promptVersion: "test",
      inputHash: `hash-${processId}-${version}`,
    })
    .returning({ id: caseBriefs.id });
  return b.id;
}

const BRIEF_DATA = (title: string): EmailTemplateDataMap["case_brief_ready"] => ({
  processNumber: "0000001-11.2026.5.10.0001",
  processTitle: title,
  court: "1ª Vara do Trabalho de Palmas",
  parties: "Autor Fictício x Empresa Fictícia",
  headline: "Síntese fictícia do caso.",
  urgencies: ["Ponto de atenção fictício"],
  possibleDeadlines: [],
  gapsCount: 1,
  missingDocumentsCount: 0,
  isDemo: true,
  briefVersion: 1,
});

beforeAll(async () => {
  fx = await setupFixture("eml");
  sys = systemContext(fx.orgA);
  ids.processSp = await insertProcess(fx.orgA, { unitId: fx.unitSp, title: "Processo SP <confidencial?>" });
  ids.processRe = await insertProcess(fx.orgA, { unitId: fx.unitRe });
  ids.processFirm = await insertProcess(fx.orgA, { unitId: fx.unitRe, lawFirmId: fx.lawFirmA });
  ids.processConfidential = await insertProcess(fx.orgA, { unitId: fx.unitSp, isConfidential: true });
  ids.processB = await insertProcess(fx.orgB);
  ids.briefSp = await insertBrief(ids.processSp);
});

afterAll(async () => {
  setEmailProviderForTesting(null);
  await fx.teardown();
});

afterEach(() => {
  vi.restoreAllMocks();
  setEmailProviderForTesting(null);
});

describe("sendTemplatedEmail", () => {
  it("stores a simulated message with events and a content-free audit entry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const connectSpy = vi.spyOn(net.Socket.prototype, "connect");

    const { emailId, status } = await sendTemplatedEmail(sys, {
      template: "case_brief_ready",
      toUserId: fx.ctx.lawyerRe.userId!,
      data: BRIEF_DATA("Reclamação <b>fictícia</b> — título sigiloso"),
      linkPath: `/processos/${ids.processSp}?aba=analise-preliminar`,
      briefId: ids.briefSp,
    });
    ids.e1 = emailId;
    expect(status).toBe("simulated");
    // The simulated provider never opens a connection.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();

    const [m] = await fx.db.select().from(emailMessages).where(eq(emailMessages.id, emailId));
    expect(m).toMatchObject({
      organizationId: fx.orgA,
      mode: "simulated",
      provider: "simulated",
      status: "simulated",
      template: "case_brief_ready",
      toUserId: fx.ctx.lawyerRe.userId,
      toName: "Rafael Advogado RE",
      fromName: "Praetor (simulação)",
      fromAddress: "nao-responda@praetor.invalid",
      processId: ids.processSp, // adopted from the brief
      briefId: ids.briefSp,
      triggeredById: null,
      errorMessage: null,
    });
    expect(m.subject).toBe("[Simulação] Análise preliminar disponível: Proc. 0000001-11.2026.5.10.0001");
    expect(m.providerMessageId).toMatch(/^sim-/);
    expect(m.sentAt).toBeInstanceOf(Date);
    expect(m.linkUrl).toBe(`http://localhost:3000/processos/${ids.processSp}?aba=analise-preliminar`);
    expect(m.bodyHtml).toContain("SIMULAÇÃO: este e-mail não foi enviado");
    expect(m.bodyHtml).toContain("Reclamação &lt;b&gt;fictícia&lt;/b&gt;");
    expect(m.bodyHtml).not.toContain("<b>fictícia</b>");

    const events = await fx.db
      .select({ type: emailEvents.type })
      .from(emailEvents)
      .where(eq(emailEvents.messageId, emailId))
      .orderBy(asc(emailEvents.createdAt), asc(emailEvents.id));
    expect(events.map((e) => e.type)).toEqual(["composed", "simulated_delivery"]);

    const audit = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "email"), eq(auditLogs.entityId, emailId)));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("email.simulated_send");
    expect(audit[0].metadata).toMatchObject({ template: "case_brief_ready", toUserId: fx.ctx.lawyerRe.userId, briefId: ids.briefSp });
    const dump = JSON.stringify(audit);
    for (const secret of [m.subject, m.toAddress, m.fromAddress, "título sigiloso", "Síntese fictícia", "Olá"]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("creates the scenario used by the visibility tests", async () => {
    ids.e2 = (
      await sendTemplatedEmail(sys, {
        template: "intake_assigned",
        toUserId: fx.ctx.manager.userId!,
        data: {
          processNumber: "0000002-11.2026.5.10.0001",
          processTitle: "Processo RE",
          court: null,
          assignmentReason: "Regra fictícia de distribuição.",
          receivedAt: new Date().toISOString(),
        },
        linkPath: `/processos/${ids.processRe}`,
        processId: ids.processRe,
      })
    ).emailId;
    ids.e3 = (
      await sendTemplatedEmail(sys, {
        template: "deadline_reminder",
        toUserId: fx.ctx.lawyer.userId!,
        data: { title: "Prazo interno fictício", dueDate: addDaysISO(todayISO(), 3), processNumber: null, pendingValidation: false },
        linkPath: "/prazos?aba=prazos",
      })
    ).emailId;
    ids.e4 = (
      await sendTemplatedEmail(sys, {
        template: "hearing_reminder",
        toUserId: fx.ctx.admin.userId!,
        data: {
          processNumber: "0000003-11.2026.5.10.0001",
          processTitle: "Processo do escritório",
          kindLabel: "Audiência inicial",
          modeLabel: "Telepresencial",
          scheduledAt: new Date().toISOString(),
          location: null,
        },
        linkPath: `/processos/${ids.processFirm}?aba=audiencias`,
        processId: ids.processFirm,
      })
    ).emailId;
    ids.e5 = (
      await sendTemplatedEmail(fx.ctx.manager, {
        template: "brief_approved",
        toUserId: fx.ctx.manager.userId!,
        data: { processNumber: "0000004-11.2026.5.10.0001", processTitle: "Confidencial", approvedByName: "Gustavo", briefVersion: 1 },
        linkPath: `/processos/${ids.processConfidential}`,
        processId: ids.processConfidential,
      })
    ).emailId;
    const [m5] = await fx.db.select().from(emailMessages).where(eq(emailMessages.id, ids.e5));
    expect(m5.triggeredById).toBe(fx.ctx.manager.userId);
  });

  it("validates recipient, link, data and every foreign id", async () => {
    const base = {
      template: "deadline_reminder" as const,
      toUserId: fx.ctx.lawyer.userId!,
      data: { title: "Prazo", dueDate: todayISO(), processNumber: null, pendingValidation: false },
      linkPath: "/prazos",
    };
    const otherOrg = await expectRejects(sendTemplatedEmail(sys, { ...base, toUserId: fx.ctx.adminB.userId! }), ValidationError);
    expect(otherOrg.fieldErrors?.toUserId).toBeDefined();

    const [inactive] = await fx.db
      .insert(users)
      .values({ organizationId: fx.orgA, name: "Inativo", email: "eml.inativo@a.test", passwordHash: "x", role: "lawyer", isActive: false })
      .returning({ id: users.id });
    expect((await expectRejects(sendTemplatedEmail(sys, { ...base, toUserId: inactive.id }), ValidationError)).fieldErrors?.toUserId).toBeDefined();

    for (const linkPath of ["https://evil.example/x", "//evil.example", "javascript:alert(1)"]) {
      expect((await expectRejects(sendTemplatedEmail(sys, { ...base, linkPath }), ValidationError)).fieldErrors?.linkPath).toBeDefined();
    }
    const badData = await expectRejects(
      sendTemplatedEmail(sys, { ...base, data: { title: "x" } as unknown as typeof base.data }),
      ValidationError,
    );
    expect(Object.keys(badData.fieldErrors ?? {}).some((k) => k.startsWith("data"))).toBe(true);

    expect((await expectRejects(sendTemplatedEmail(sys, { ...base, processId: ids.processB }), ValidationError)).fieldErrors?.processId).toBeDefined();
    expect(
      (await expectRejects(sendTemplatedEmail(sys, { ...base, processId: ids.processRe, briefId: ids.briefSp }), ValidationError)).fieldErrors
        ?.briefId,
    ).toBeDefined();
    expect(
      (await expectRejects(sendTemplatedEmail(sys, { ...base, entity: { type: "legal_process", id: ids.processB } }), ValidationError))
        .fieldErrors?.entity,
    ).toBeDefined();
    expect(
      (await expectRejects(sendTemplatedEmail(sys, { ...base, entity: { type: "user", id: fx.ctx.lawyer.userId! } }), ValidationError))
        .fieldErrors?.entity,
    ).toBeDefined();
    // A user can only send about processes they can see.
    expect(
      (await expectRejects(sendTemplatedEmail(fx.ctx.lawyer, { ...base, processId: ids.processRe }), ValidationError)).fieldErrors
        ?.processId,
    ).toBeDefined();
  });

  it("requires email:send for user contexts", async () => {
    const input = {
      template: "deadline_reminder" as const,
      toUserId: fx.ctx.analyst.userId!,
      data: { title: "Prazo", dueDate: todayISO(), processNumber: null, pendingValidation: false },
      linkPath: "/prazos",
    };
    await expectRejects(sendTemplatedEmail(fx.ctx.analyst, input), ForbiddenError);
    await expectRejects(sendTemplatedEmail(fx.ctx.executive, input), ForbiddenError);
    await expectRejects(sendTemplatedEmail(fx.ctx.externalCounsel, input), ForbiddenError);
    await expectRejects(sendTemplatedEmail(fx.ctx.auditor, input), ForbiddenError);
  });

  it("records a sanitized failure without throwing when the provider fails", async () => {
    const failing: EmailProvider = {
      name: "falha-teste",
      mode: "simulated",
      send: async () => {
        throw new EmailProviderError("550 rejected for laura@exemplo.com", {
          retryable: true,
          userMessage: "Provedor indisponível (simulação).",
        });
      },
    };
    setEmailProviderForTesting(failing);
    const { emailId, status } = await sendTemplatedEmail(sys, {
      template: "deadline_reminder",
      toUserId: fx.ctx.lawyer.userId!,
      data: { title: "Prazo com falha", dueDate: todayISO(), processNumber: null, pendingValidation: false },
      linkPath: "/prazos",
    });
    expect(status).toBe("failed");
    const [m] = await fx.db.select().from(emailMessages).where(eq(emailMessages.id, emailId));
    expect(m.status).toBe("failed");
    expect(m.errorMessage).toBe("Provedor indisponível (simulação).");
    expect(m.sentAt).toBeNull();
    const events = await fx.db.select({ type: emailEvents.type, detail: emailEvents.detail }).from(emailEvents).where(eq(emailEvents.messageId, emailId));
    expect(events.map((e) => e.type).sort()).toEqual(["composed", "failed"]);
    expect(JSON.stringify(events)).not.toContain("laura@exemplo.com");
    const [audit] = await fx.db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "email"), eq(auditLogs.entityId, emailId)));
    expect(audit.metadata).toMatchObject({ status: "failed" });
    // Cleanup so the visibility counts below stay simple.
    await fx.db.delete(emailMessages).where(eq(emailMessages.id, emailId));
  });

  it("simulated provider returns a synthetic id without delivering anything", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await new SimulatedEmailProvider().send({
      from: { name: "a", address: "a@a.invalid" },
      to: { name: "b", address: "b@b.invalid" },
      subject: "[Simulação] x",
      text: "x",
      html: "<p>x</p>",
      messageId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.simulated).toBe(true);
    expect(result.providerMessageId).toMatch(/^sim-[0-9a-f-]{36}$/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Safety net: a message that does not say it is a simulation is refused.
    await expect(
      new SimulatedEmailProvider().send({
        from: { name: "a", address: "a@a.invalid" },
        to: { name: "b", address: "b@b.invalid" },
        subject: "Assunto sem prefixo",
        text: "x",
        html: "<p>x</p>",
        messageId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toBeInstanceOf(EmailProviderError);
  });
});

describe("emailWhere visibility", () => {
  const visibleIds = async (ctx: AuthContext) => (await listEmails(ctx, { pageSize: 100 })).items.map((m) => m.id).sort();
  const expected = (...keys: string[]) => keys.map((k) => ids[k]).sort();

  it("admins and legal managers see every message of the organization", async () => {
    expect(await visibleIds(fx.ctx.admin)).toEqual(expected("e1", "e2", "e3", "e4", "e5"));
    expect(await visibleIds(fx.ctx.manager)).toEqual(expected("e1", "e2", "e3", "e4", "e5"));
  });

  it("lawyers see messages to/from them and about processes they can see", async () => {
    // SP lawyer: e1 (SP process) + e3 (addressed to them).
    expect(await visibleIds(fx.ctx.lawyer)).toEqual(expected("e1", "e3"));
    // RE lawyer: e1 (addressed to them, process not visible) + RE processes (e2, e4).
    expect(await visibleIds(fx.ctx.lawyerRe)).toEqual(expected("e1", "e2", "e4"));
    const e1ForRe = (await listEmails(fx.ctx.lawyerRe, { pageSize: 100 })).items.find((m) => m.id === ids.e1)!;
    expect(e1ForRe.processId).toBe(ids.processSp);
    expect(e1ForRe.processNumber).toBeNull(); // parent scope applied to the join
    await expectRejects(getEmail(fx.ctx.lawyer, ids.e2), NotFoundError);
  });

  it("external counsel only sees messages about the firm's processes", async () => {
    expect(await visibleIds(fx.ctx.externalCounsel)).toEqual(expected("e4"));
    await expectRejects(getEmail(fx.ctx.externalCounsel, ids.e1), NotFoundError);
  });

  it("auditor sees messages about non-confidential processes only", async () => {
    expect(await visibleIds(fx.ctx.auditor)).toEqual(expected("e1", "e2", "e4"));
  });

  it("roles without email:read are refused", async () => {
    await expectRejects(listEmails(fx.ctx.executive, {}), ForbiddenError);
    await expectRejects(getEmail(fx.ctx.executive, ids.e1), ForbiddenError);
    await expectRejects(listEmails(fx.ctx.accountant, {}), ForbiddenError);
  });

  it("isolates organizations", async () => {
    expect((await listEmails(fx.ctx.adminB, {})).total).toBe(0);
    await expectRejects(getEmail(fx.ctx.adminB, ids.e1), NotFoundError);
    await expectRejects(resendEmail(fx.ctx.adminB, ids.e1), NotFoundError);
    expect(await listEmailFilterOptions(fx.ctx.adminB)).toEqual({ recipients: [], processes: [] });
  });

  it("filters by template, recipient and process, and builds filter options from visible messages only", async () => {
    expect((await listEmails(fx.ctx.admin, { template: "hearing_reminder" })).items.map((m) => m.id)).toEqual([ids.e4]);
    expect((await listEmails(fx.ctx.admin, { toUserId: fx.ctx.manager.userId! })).items.map((m) => m.id).sort()).toEqual(
      expected("e2", "e5"),
    );
    expect((await listEmails(fx.ctx.admin, { processId: ids.processRe })).items.map((m) => m.id)).toEqual([ids.e2]);

    const opts = await listEmailFilterOptions(fx.ctx.lawyerRe);
    expect(opts.recipients.map((r) => r.id).sort()).toEqual(
      [fx.ctx.lawyerRe.userId, fx.ctx.manager.userId, fx.ctx.admin.userId].sort(),
    );
    // processSp is referenced by a visible message but the process itself is not visible.
    expect(opts.processes.map((p) => p.id).sort()).toEqual([ids.processRe, ids.processFirm].sort());
    await expectRejects(getEmail(fx.ctx.admin, "nao-e-uuid"), NotFoundError);
  });
});

describe("getEmail", () => {
  it("records a single 'viewed' event when the recipient opens the message", async () => {
    const viewed = async () =>
      (await fx.db.select().from(emailEvents).where(and(eq(emailEvents.messageId, ids.e1), eq(emailEvents.type, "viewed")))).length;
    await getEmail(fx.ctx.admin, ids.e1);
    expect(await viewed()).toBe(0);
    const detail = await getEmail(fx.ctx.lawyerRe, ids.e1);
    await getEmail(fx.ctx.lawyerRe, ids.e1);
    expect(await viewed()).toBe(1);
    expect(detail.process).toBeNull(); // process not visible to the RE lawyer
    expect(detail.processId).toBe(ids.processSp);
    expect(detail.bodyHtml).toContain("SIMULAÇÃO");
    expect(detail.events.map((e) => e.type)).toEqual(expect.arrayContaining(["composed", "simulated_delivery"]));

    const forSp = await getEmail(fx.ctx.lawyer, ids.e1);
    expect(forSp.process).toMatchObject({ id: ids.processSp });
    expect(forSp.briefVisible).toBe(true);
  });
});

describe("resendEmail", () => {
  it("creates a copy, links both messages and audits only ids", async () => {
    const { emailId, status } = await resendEmail(fx.ctx.lawyer, ids.e1);
    expect(status).toBe("simulated");
    expect(emailId).not.toBe(ids.e1);
    const [[orig], [copy]] = await Promise.all([
      fx.db.select().from(emailMessages).where(eq(emailMessages.id, ids.e1)),
      fx.db.select().from(emailMessages).where(eq(emailMessages.id, emailId)),
    ]);
    expect(copy).toMatchObject({
      subject: orig.subject,
      bodyText: orig.bodyText,
      bodyHtml: orig.bodyHtml,
      toUserId: orig.toUserId,
      processId: orig.processId,
      briefId: orig.briefId,
      template: orig.template,
      triggeredById: fx.ctx.lawyer.userId,
      status: "simulated",
    });

    const original = await getEmail(fx.ctx.admin, ids.e1);
    const resent = original.events.find((e) => e.type === "resent");
    expect(resent?.relatedEmailId).toBe(emailId);
    const copyDetail = await getEmail(fx.ctx.admin, emailId);
    expect(copyDetail.resendOfId).toBe(ids.e1);

    const [audit] = await fx.db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "email"), eq(auditLogs.entityId, emailId)));
    expect(audit.action).toBe("email.resend");
    expect(audit.metadata).toMatchObject({ originalEmailId: ids.e1, template: "case_brief_ready" });
    expect(JSON.stringify(audit)).not.toContain(orig.subject);
    expect(JSON.stringify(audit)).not.toContain(orig.toAddress);
  });

  it("requires email:send and visibility", async () => {
    await expectRejects(resendEmail(fx.ctx.analyst, ids.e1), ForbiddenError);
    await expectRejects(resendEmail(fx.ctx.auditor, ids.e1), ForbiddenError);
    await expectRejects(resendEmail(fx.ctx.lawyer, ids.e2), NotFoundError);
  });
});

describe("sendDailyDigest", () => {
  it("sends the current user's counts, scoped like the screens", async () => {
    await fx.db.insert(deadlines).values({
      organizationId: fx.orgA,
      title: "Prazo fictício da semana",
      dueDate: addDaysISO(todayISO(), 3),
      kind: "internal",
      responsibleId: fx.ctx.lawyer.userId,
      unitId: fx.unitSp,
    });
    const { emailId } = await sendDailyDigest(fx.ctx.lawyer);
    const [m] = await fx.db.select().from(emailMessages).where(eq(emailMessages.id, emailId));
    expect(m.template).toBe("daily_digest");
    expect(m.toUserId).toBe(fx.ctx.lawyer.userId);
    expect(m.triggeredById).toBe(fx.ctx.lawyer.userId);
    expect(m.subject).toMatch(/^\[Simulação\] Resumo diário de pendências de \d{2}\/\d{2}\/\d{4}$/);
    expect(m.bodyText).toMatch(/Prazos com vencimento nos próximos 7 dias: 1 /);
    expect(m.bodyText).toContain("Análises preliminares prontas para revisão: 1 ");
    expect(m.bodyText).toContain("Alertas abertos: 0 ");
    expect(m.bodyText).toContain("Audiências nos próximos 7 dias:");
    expect(m.bodyHtml).toContain("http://localhost:3000/analises-preliminares?status=ready_for_review");

    // The RE lawyer cannot see the SP brief: their digest counts 0.
    const re = await sendDailyDigest(fx.ctx.lawyerRe);
    const [mRe] = await fx.db.select().from(emailMessages).where(eq(emailMessages.id, re.emailId));
    expect(mRe.bodyText).toContain("Análises preliminares prontas para revisão: 0 ");
    expect(mRe.bodyText).toContain("Prazos com vencimento nos próximos 7 dias: 0 ");
  });

  it("requires a user with email:send", async () => {
    await expectRejects(sendDailyDigest(fx.ctx.analyst), ForbiddenError);
    await expectRejects(sendDailyDigest(fx.ctx.executive), ForbiddenError);
    await expectRejects(sendDailyDigest(sys), ValidationError);
  });
});
