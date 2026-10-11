/**
 * Action permissions: the static ROLE_PERMISSIONS matrix AND its enforcement
 * inside every module service (hiding a button is never authorization).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ROLES, type Role } from "@/domain/enums";
import {
  createUnit,
  createUser,
  listAuditLogs,
  listUsers,
  updateOrganizationSettings,
} from "@/modules/admin/service";
import { resolveAlert } from "@/modules/alerts/service";
import {
  applySuggestedDeadline,
  applySuggestedTask,
  getAnalysis,
  requestAnalysis,
  reviewAnalysis,
} from "@/modules/analyses/service";
import { addComment } from "@/modules/comments/service";
import {
  addObligation,
  createContract,
  deleteContract,
  updateContract,
} from "@/modules/contracts/service";
import {
  addDocumentVersion,
  deleteDocument,
  updateDocumentMetadata,
  uploadDocument,
} from "@/modules/documents/service";
import {
  createOccurrence,
  deleteOccurrence,
  linkOccurrenceToProcess,
  updateOccurrence,
} from "@/modules/occurrences/service";
import {
  addParty,
  addProcessEvent,
  createProcess,
  deleteProcess,
  updateProcess,
} from "@/modules/processes/service";
import {
  createDeadline,
  createSuggestedDeadline,
  createTask,
  getDeadline,
  setDeadlineStatus,
  updateTask,
  validateDeadline,
} from "@/modules/work/service";
import { PERMISSIONS, ROLE_PERMISSIONS, can, type Permission } from "@/server/auth/permissions";
import { aiAnalyses, alerts, deadlines } from "@/server/db/schema";
import { ForbiddenError } from "@/server/lib/errors";
import {
  daysFromToday,
  brDate,
  makeContract,
  makeDeadline,
  makeOccurrence,
  makeProcess,
  makeTask,
  makeTextDocument,
  runJobs,
  setupFixture,
  utf8,
  type Fixture,
} from "../helpers/fixtures";

let f: Fixture;
const ids: Record<string, string> = {};

const perms = (role: Role) => new Set<Permission>(ROLE_PERMISSIONS[role]);

beforeAll(async () => {
  f = await setupFixture("perm");
  const { admin, lawyer } = f.ctx;
  ids.process = await makeProcess(admin, { unitId: f.unitSp, responsibleId: lawyer.userId });
  ids.occurrence = await makeOccurrence(admin, { unitId: f.unitSp });
  ids.contract = await makeContract(admin, { unitId: f.unitSp });
  const doc = await makeTextDocument(admin, {
    processId: ids.process,
    text:
      "Notificação extrajudicial recebida pela empresa (fictícia). " +
      `A audiência foi designada para ${brDate(daysFromToday(20))}. Pedido de indenização de R$ 10.000,00.`,
  });
  ids.document = doc.documentId;
  ids.task = await makeTask(admin, { processId: ids.process });
  ids.deadline = await makeDeadline(admin, { processId: ids.process });
  await runJobs();

  const { analysisId } = await requestAnalysis(lawyer, { type: "risk_signals", subjectType: "legal_process", subjectId: ids.process });
  await runJobs();
  ids.analysis = analysisId;
  const analysis = await getAnalysis(lawyer, analysisId);
  expect(analysis.status).toBe("succeeded");
  expect(analysis.result?.suggestedDeadlines.length).toBeGreaterThan(0);
  const { deadlineId } = await applySuggestedDeadline(lawyer, analysisId, 0);
  ids.suggestedDeadline = deadlineId;

  const [alert] = await f.db.select({ id: alerts.id }).from(alerts).where(eq(alerts.organizationId, f.orgA)).limit(1);
  expect(alert).toBeDefined();
  ids.alert = alert.id;
});

afterAll(async () => f.teardown());

describe("ROLE_PERMISSIONS matrix", () => {
  it("defines every role and only known permissions", () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
    }
  });

  it("admin has every permission", () => {
    expect([...perms("admin")].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("executive only reads (and sees the dashboard)", () => {
    const exec = [...perms("executive")];
    for (const p of exec) expect(p === "dashboard:read" || p.endsWith(":read")).toBe(true);
    expect(exec).toContain("dashboard:read");
    expect(exec).not.toContain("audit:read");
    for (const p of PERMISSIONS) {
      if (!p.endsWith(":read")) expect(exec).not.toContain(p);
    }
  });

  it("analyst cannot validate deadlines, write processes or review analyses", () => {
    const a = perms("analyst");
    expect(a.has("deadline:validate")).toBe(false);
    expect(a.has("process:write")).toBe(false);
    expect(a.has("analysis:review")).toBe(false);
    expect(a.has("occurrence:write")).toBe(true);
    expect(a.has("analysis:request")).toBe(true);
  });

  it("lawyer cannot delete anything nor administer", () => {
    const l = perms("lawyer");
    for (const p of PERMISSIONS) {
      if (p.endsWith(":delete")) expect(l.has(p)).toBe(false);
    }
    expect(l.has("admin:users")).toBe(false);
    expect(l.has("admin:organization")).toBe(false);
    expect(l.has("audit:read")).toBe(false);
    expect(l.has("deadline:validate")).toBe(true);
    expect(l.has("analysis:review")).toBe(true);
  });

  it("legal manager cannot administer users nor the organization", () => {
    const m = perms("legal_manager");
    expect(m.has("admin:users")).toBe(false);
    expect(m.has("admin:organization")).toBe(false);
    expect(m.has("process:delete")).toBe(true);
    expect(m.has("audit:read")).toBe(true);
  });

  it("system context bypasses action permissions", () => {
    expect(can({ kind: "system", role: "executive" }, "admin:users")).toBe(true);
    expect(can({ kind: "user", role: "executive" }, "process:write")).toBe(false);
  });
});

describe("service-level enforcement", () => {
  it("executive gets ForbiddenError from every create/update/delete function", async () => {
    const e = f.ctx.executive;
    const file = { name: "x.txt", bytes: utf8("texto") };
    const attempts: [string, () => Promise<unknown>][] = [
      ["createProcess", () => createProcess(e, { number: "9", title: "x", court: "TJ", area: "civil", phase: "knowledge" })],
      ["updateProcess", () => updateProcess(e, ids.process, { title: "Alterado pelo executivo" })],
      ["deleteProcess", () => deleteProcess(e, ids.process)],
      ["addParty", () => addParty(e, ids.process, { name: "Parte", role: "plaintiff" })],
      ["addProcessEvent", () => addProcessEvent(e, ids.process, { occurredAt: "2026-01-10", type: "other", title: "Evento" })],
      ["createOccurrence", () => createOccurrence(e, { title: "Ocorrência", facts: "Fatos com mais de dez letras.", category: "other" })],
      ["updateOccurrence", () => updateOccurrence(e, ids.occurrence, { title: "Alterada" })],
      ["deleteOccurrence", () => deleteOccurrence(e, ids.occurrence)],
      ["linkOccurrenceToProcess", () => linkOccurrenceToProcess(e, ids.occurrence, ids.process)],
      ["createContract", () => createContract(e, { title: "Contrato", counterparty: "Parte", type: "services" })],
      ["updateContract", () => updateContract(e, ids.contract, { title: "Contrato", counterparty: "Parte", type: "services" })],
      ["deleteContract", () => deleteContract(e, ids.contract)],
      ["addObligation", () => addObligation(e, ids.contract, { description: "Obrigação" })],
      ["uploadDocument", () => uploadDocument(e, { title: "Doc", category: "other", file })],
      ["addDocumentVersion", () => addDocumentVersion(e, ids.document, { file })],
      ["updateDocumentMetadata", () => updateDocumentMetadata(e, ids.document, { title: "Novo" })],
      ["deleteDocument", () => deleteDocument(e, ids.document)],
      ["createTask", () => createTask(e, { title: "Tarefa" })],
      ["updateTask", () => updateTask(e, ids.task, { status: "done" })],
      ["createDeadline", () => createDeadline(e, { title: "Prazo", dueDate: daysFromToday(3), kind: "internal" })],
      ["setDeadlineStatus", () => setDeadlineStatus(e, ids.deadline, "done")],
      ["validateDeadline", () => validateDeadline(e, ids.suggestedDeadline, { decision: "validated" })],
      [
        "createSuggestedDeadline",
        () =>
          createSuggestedDeadline(e, {
            title: "Prazo",
            dueDate: daysFromToday(3),
            kind: "internal",
            sourceAnalysisId: ids.analysis,
            sourceExcerpt: "trecho",
          }),
      ],
      ["addComment", () => addComment(e, { type: "legal_process", id: ids.process }, "Comentário")],
      ["requestAnalysis", () => requestAnalysis(e, { type: "summary", subjectType: "legal_process", subjectId: ids.process })],
      ["reviewAnalysis", () => reviewAnalysis(e, ids.analysis, { decision: "reviewed" })],
      ["applySuggestedTask", () => applySuggestedTask(e, ids.analysis, 0)],
      ["applySuggestedDeadline", () => applySuggestedDeadline(e, ids.analysis, 0)],
      ["resolveAlert", () => resolveAlert(e, ids.alert)],
      ["createUser", () => createUser(e, { name: "Novo", email: "novo@a.test", role: "admin", password: "SenhaForte123" })],
      ["createUnit", () => createUnit(e, { name: "Nova unidade" })],
      ["updateOrganizationSettings", () => updateOrganizationSettings(e, {} as never)],
      ["listAuditLogs", () => listAuditLogs(e, {})],
    ];
    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("analyst cannot validate AI deadlines, review analyses nor write processes", async () => {
    const a = f.ctx.analyst;
    await expect(validateDeadline(a, ids.suggestedDeadline, { decision: "validated" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(validateDeadline(a, ids.suggestedDeadline, { decision: "rejected", note: "não" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(reviewAnalysis(a, ids.analysis, { decision: "reviewed" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reviewAnalysis(a, ids.analysis, { decision: "dismissed" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createProcess(a, { number: "8", title: "x", court: "TJ", area: "civil", phase: "knowledge" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateProcess(a, ids.process, { title: "x" })).rejects.toBeInstanceOf(ForbiddenError);

    // Nothing changed.
    const [d] = await f.db.select().from(deadlines).where(eq(deadlines.id, ids.suggestedDeadline));
    expect(d.validationStatus).toBe("pending_validation");
    const [an] = await f.db.select().from(aiAnalyses).where(eq(aiAnalyses.id, ids.analysis));
    expect(an.reviewStatus).toBe("pending_review");
  });

  it("lawyer cannot delete records", async () => {
    const l = f.ctx.lawyer;
    await expect(deleteProcess(l, ids.process)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteOccurrence(l, ids.occurrence)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteContract(l, ids.contract)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteDocument(l, ids.document)).rejects.toBeInstanceOf(ForbiddenError);
    // Legal hold governs deletion: a lawyer cannot toggle it either.
    await expect(updateDocumentMetadata(l, ids.document, { legalHold: true })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("legal manager cannot administer users nor organization settings", async () => {
    const m = f.ctx.manager;
    await expect(listUsers(m, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createUser(m, { name: "Novo", email: "novo2@a.test", role: "admin", password: "SenhaForte123" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createUnit(m, { name: "Outra unidade" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateOrganizationSettings(m, {} as never)).rejects.toBeInstanceOf(ForbiddenError);
    // ...but can read the audit log.
    await expect(listAuditLogs(m, {})).resolves.toBeDefined();
  });

  it("the lawyer (who holds deadline:validate) can validate the same suggestion", async () => {
    await validateDeadline(f.ctx.lawyer, ids.suggestedDeadline, { decision: "validated" });
    const d = await getDeadline(f.ctx.lawyer, ids.suggestedDeadline);
    expect(d.validationStatus).toBe("validated");
    expect(d.countsAsDeadline).toBe(true);
  });
});
