/**
 * Tenant isolation: an administrator of organization B (who holds every
 * permission) can neither read, list, update nor delete ANY record of
 * organization A through any module service, and cannot reference A's ids
 * (units, users, records) inside B's own inputs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  getUnit,
  getUser,
  listAuditLogs,
  listEntityHistory,
  listRoutines,
  listUnitOptions,
  listUserOptions,
  runRoutineNow,
  updateUser,
} from "@/modules/admin/service";
import { listAlerts, resolveAlert } from "@/modules/alerts/service";
import {
  applySuggestedDeadline,
  applySuggestedTask,
  getAnalysis,
  listAnalyses,
  requestAnalysis,
  reviewAnalysis,
} from "@/modules/analyses/service";
import { addComment, deleteComment, listComments } from "@/modules/comments/service";
import {
  addObligation,
  createContract,
  deleteContract,
  getContract,
  listContractOptions,
  listContracts,
  updateContract,
} from "@/modules/contracts/service";
import { getDashboardData } from "@/modules/dashboard/service";
import {
  addDocumentVersion,
  deleteDocument,
  getDocument,
  listDocuments,
  openDocumentVersion,
  updateDocumentMetadata,
  uploadDocument,
} from "@/modules/documents/service";
import {
  createOccurrence,
  deleteOccurrence,
  getOccurrence,
  linkOccurrenceToProcess,
  listOccurrenceOptions,
  listOccurrences,
  updateOccurrence,
} from "@/modules/occurrences/service";
import {
  addParty,
  addProcessEvent,
  createProcess,
  deleteProcess,
  getProcess,
  listProcessOptions,
  listProcesses,
  updateProcess,
} from "@/modules/processes/service";
import {
  createDeadline,
  createSuggestedDeadline,
  createTask,
  deleteTask,
  getDeadline,
  getTask,
  listDeadlines,
  listTasks,
  setDeadlineStatus,
  updateTask,
  validateDeadline,
} from "@/modules/work/service";
import type { EntityRef } from "@/domain/entities";
import {
  alerts,
  aiAnalyses,
  auditLogs,
  comments,
  contracts,
  deadlines,
  documents,
  legalProcesses,
  occurrences,
  tasks,
} from "@/server/db/schema";
import { ensureDefaultRoutines } from "@/server/jobs/routines";
import { AppError, NotFoundError, ValidationError } from "@/server/lib/errors";
import {
  brDate,
  daysFromToday,
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
const A: Record<string, string> = {};
const B: Record<string, string> = {};

beforeAll(async () => {
  f = await setupFixture("iso");
  const { admin, lawyer } = f.ctx;

  A.process = await makeProcess(admin, { unitId: f.unitSp, responsibleId: lawyer.userId, number: "0000001-00.2026.8.26.0001" });
  A.occurrence = await makeOccurrence(admin, { unitId: f.unitSp });
  A.contract = await makeContract(admin, { unitId: f.unitSp });
  const doc = await makeTextDocument(admin, {
    processId: A.process,
    text:
      "Notificação extrajudicial: descumprimento contratual e pedido de indenização (texto fictício). " +
      `Reunião marcada para ${brDate(daysFromToday(15))}.`,
  });
  A.document = doc.documentId;
  A.version = doc.versionId;
  A.task = await makeTask(admin, { processId: A.process });
  A.deadline = await makeDeadline(admin, { processId: A.process });
  A.comment = (await addComment(admin, { type: "legal_process", id: A.process }, "Comentário interno de A")).id;
  await runJobs();

  const req = await requestAnalysis(lawyer, { type: "risk_signals", subjectType: "legal_process", subjectId: A.process });
  await runJobs();
  A.analysis = req.analysisId;
  const detail = await getAnalysis(lawyer, A.analysis);
  expect(detail.status).toBe("succeeded");
  expect(detail.result?.suggestedTasks.length).toBeGreaterThan(0);
  expect(detail.result?.suggestedDeadlines.length).toBeGreaterThan(0);
  A.suggestedDeadline = (await applySuggestedDeadline(lawyer, A.analysis, 0)).deadlineId;

  const [alert] = await f.db.select({ id: alerts.id }).from(alerts).where(eq(alerts.organizationId, f.orgA)).limit(1);
  A.alert = alert.id;

  // Organization B has its own small data set.
  B.occurrence = await makeOccurrence(f.ctx.adminB, { title: "Ocorrência de B" });
  B.process = await makeProcess(f.ctx.adminB, { title: "Processo de B", number: "0000001-00.2026.8.26.0001" });
});

afterAll(async () => f.teardown());

const notFound = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundError);

describe("org B cannot read org A records", () => {
  it("single reads answer NotFoundError", async () => {
    const b = f.ctx.adminB;
    await notFound(getProcess(b, A.process));
    await notFound(getOccurrence(b, A.occurrence));
    await notFound(getContract(b, A.contract));
    await notFound(getDocument(b, A.document));
    await notFound(openDocumentVersion(b, A.document, A.version));
    await notFound(getTask(b, A.task));
    await notFound(getDeadline(b, A.deadline));
    await notFound(getDeadline(b, A.suggestedDeadline));
    await notFound(getAnalysis(b, A.analysis));
    await notFound(listComments(b, { type: "legal_process", id: A.process }));
    await notFound(getUser(b, f.ctx.lawyer.userId!));
    await notFound(getUnit(b, f.unitSp));
  });

  it("lists and options never contain org A rows", async () => {
    const b = f.ctx.adminB;
    const aIds = new Set(Object.values(A));
    const noA = (items: { id: string }[]) => expect(items.filter((i) => aIds.has(i.id))).toEqual([]);

    noA((await listProcesses(b, { pageSize: 100 })).items);
    noA((await listOccurrences(b, { pageSize: 100 })).items);
    noA((await listContracts(b, { pageSize: 100 })).items);
    expect((await listDocuments(b, { pageSize: 100 })).items).toEqual([]);
    expect((await listTasks(b, { pageSize: 100 })).items).toEqual([]);
    expect((await listDeadlines(b, { pageSize: 100 })).items).toEqual([]);
    expect((await listAnalyses(b, { pageSize: 100 })).items).toEqual([]);
    expect(await listAlerts(b, { openOnly: false, limit: 200 })).toEqual([]);
    noA(await listProcessOptions(b));
    noA(await listOccurrenceOptions(b));
    expect(await listContractOptions(b)).toEqual([]);

    // Filtering by A's ids does not leak either.
    expect((await listDocuments(b, { processId: A.process })).items).toEqual([]);
    expect((await listDeadlines(b, { processId: A.process })).items).toEqual([]);
    expect((await listAnalyses(b, { subjectType: "legal_process", subjectId: A.process })).items).toEqual([]);

    // Admin lookups are scoped to B.
    const userOptions = await listUserOptions(b);
    expect(userOptions.map((u) => u.id)).toEqual([f.ctx.adminB.userId]);
    expect((await listUnitOptions(b)).map((u) => u.id)).toEqual([f.unitB]);
  });

  it("entity history of A's records is empty for B", async () => {
    const b = f.ctx.adminB;
    const refs: EntityRef[] = [
      { type: "legal_process", id: A.process },
      { type: "occurrence", id: A.occurrence },
      { type: "contract", id: A.contract },
      { type: "document", id: A.document },
      { type: "task", id: A.task },
      { type: "deadline", id: A.deadline },
      { type: "analysis", id: A.analysis },
    ];
    for (const ref of refs) {
      expect(await listEntityHistory(f.ctx.admin, ref), `A sees ${ref.type}`).not.toEqual([]);
      expect(await listEntityHistory(b, ref), ref.type).toEqual([]);
    }
  });

  it("audit log of B never shows A's entries", async () => {
    const page = await listAuditLogs(f.ctx.adminB, { pageSize: 100 });
    const rows = await f.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, f.orgA));
    const aAuditIds = new Set(rows.map((r) => r.id));
    expect(aAuditIds.size).toBeGreaterThan(0);
    expect(page.items.filter((i) => aAuditIds.has(i.id))).toEqual([]);
  });

  it("dashboard of B counts none of A's records", async () => {
    const data = await getDashboardData(f.ctx.adminB);
    expect(data.processes.total).toBe(1); // B's own process
    expect(data.occurrences.total).toBe(1); // B's own occurrence
    expect(data.deadlines).toMatchObject({ overdue: 0, upcoming: 0, pendingValidation: 0, next: [] });
    expect(data.contracts.active).toBe(0);
    expect(data.analyses).toMatchObject({ pendingReview: 0, stale: 0, failedLast7Days: 0, running: 0 });
    expect(data.workload.rows.filter((r) => r.userId !== f.ctx.adminB.userId)).toEqual([]);
    const aIds = new Set(Object.values(A));
    expect(data.activity.filter((a) => a.entityHref && [...aIds].some((id) => a.entityHref!.includes(id)))).toEqual([]);

    const dataA = await getDashboardData(f.ctx.admin);
    expect(dataA.processes.total).toBe(1);
    expect(dataA.deadlines.pendingValidation).toBe(1);
  });
});

describe("org B cannot change org A records", () => {
  it("updates, deletes and child writes answer NotFoundError", async () => {
    const b = f.ctx.adminB;
    await notFound(updateProcess(b, A.process, { title: "Invadido" }));
    await notFound(deleteProcess(b, A.process));
    await notFound(addParty(b, A.process, { name: "Parte", role: "plaintiff" }));
    await notFound(addProcessEvent(b, A.process, { occurredAt: "2026-01-02", type: "note", title: "Evento" }));
    await notFound(updateOccurrence(b, A.occurrence, { title: "Invadida" }));
    await notFound(deleteOccurrence(b, A.occurrence));
    await notFound(updateContract(b, A.contract, { title: "Invadido", counterparty: "Fornecedor X", type: "services" }));
    await notFound(deleteContract(b, A.contract));
    await notFound(addObligation(b, A.contract, { description: "Obrigação invasora" }));
    await notFound(updateDocumentMetadata(b, A.document, { title: "Invadido" }));
    await notFound(addDocumentVersion(b, A.document, { file: { name: "v2.txt", bytes: utf8("nova versão") } }));
    await notFound(deleteDocument(b, A.document));
    await notFound(updateTask(b, A.task, { status: "done" }));
    await notFound(deleteTask(b, A.task));
    await notFound(setDeadlineStatus(b, A.deadline, "done"));
    await notFound(validateDeadline(b, A.suggestedDeadline, { decision: "validated" }));
    await notFound(reviewAnalysis(b, A.analysis, { decision: "dismissed" }));
    await notFound(applySuggestedTask(b, A.analysis, 0));
    await notFound(applySuggestedDeadline(b, A.analysis, 0));
    await notFound(resolveAlert(b, A.alert));
    await notFound(addComment(b, { type: "legal_process", id: A.process }, "Comentário invasor"));
    await notFound(deleteComment(b, A.comment));
    await notFound(linkOccurrenceToProcess(b, A.occurrence, B.process));
    await notFound(linkOccurrenceToProcess(b, B.occurrence, A.process));
    await notFound(requestAnalysis(b, { type: "summary", subjectType: "legal_process", subjectId: A.process }));
    await notFound(requestAnalysis(b, { type: "summary", subjectType: "document", subjectId: A.document }));
    await notFound(
      updateUser(b, f.ctx.lawyer.userId!, { name: "Invadido", role: "admin", unitId: null, isActive: false, teamIds: [] }),
    );
  });

  it("routines of A cannot be listed nor triggered by B", async () => {
    await ensureDefaultRoutines(f.orgA);
    const aRoutines = await listRoutines(f.ctx.admin);
    expect(aRoutines.length).toBeGreaterThan(0);
    const bRoutines = await listRoutines(f.ctx.adminB);
    const aIds = new Set(aRoutines.map((r) => r.id));
    expect(bRoutines.filter((r) => aIds.has(r.id))).toEqual([]);
    await notFound(runRoutineNow(f.ctx.adminB, aRoutines[0].id));
  });

  it("org A data is untouched", async () => {
    const [p] = await f.db.select().from(legalProcesses).where(eq(legalProcesses.id, A.process));
    expect(p.title).not.toBe("Invadido");
    expect(p.deletedAt).toBeNull();
    const [o] = await f.db.select().from(occurrences).where(eq(occurrences.id, A.occurrence));
    expect(o.deletedAt).toBeNull();
    expect(o.linkedProcessId).toBeNull();
    const [c] = await f.db.select().from(contracts).where(eq(contracts.id, A.contract));
    expect(c.deletedAt).toBeNull();
    const [d] = await f.db.select().from(documents).where(eq(documents.id, A.document));
    expect(d).toMatchObject({ deletedAt: null, currentVersionNumber: 1 });
    const [t] = await f.db.select().from(tasks).where(eq(tasks.id, A.task));
    expect(t.status).not.toBe("done");
    const [dl] = await f.db.select().from(deadlines).where(eq(deadlines.id, A.suggestedDeadline));
    expect(dl.validationStatus).toBe("pending_validation");
    const [an] = await f.db.select().from(aiAnalyses).where(eq(aiAnalyses.id, A.analysis));
    expect(an.reviewStatus).toBe("pending_review");
    const [al] = await f.db.select().from(alerts).where(eq(alerts.id, A.alert));
    expect(al.resolvedAt).toBeNull();
    const [cm] = await f.db.select().from(comments).where(eq(comments.id, A.comment));
    expect(cm.deletedAt).toBeNull();
    const bComments = await f.db.select().from(comments).where(eq(comments.organizationId, f.orgB));
    expect(bComments).toEqual([]);
  });
});

describe("org B cannot reference org A ids in its own inputs", () => {
  it("rejects A's unit, user and record ids on create", async () => {
    const b = f.ctx.adminB;
    const rejected = async (p: Promise<unknown>, label: string) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, label).toBeInstanceOf(AppError);
      expect(err instanceof ValidationError || err instanceof NotFoundError, label).toBe(true);
    };
    const proc = { title: "Processo B2", court: "TJ", area: "civil" as const, phase: "knowledge" as const };
    await rejected(createProcess(b, { ...proc, number: "B-2", unitId: f.unitSp }), "process.unitId");
    await rejected(createProcess(b, { ...proc, number: "B-3", responsibleId: f.ctx.lawyer.userId }), "process.responsibleId");
    await rejected(createProcess(b, { ...proc, number: "B-4", fromOccurrenceId: A.occurrence }), "process.fromOccurrenceId");

    const occ = { title: "Ocorrência B2", facts: "Fatos fictícios de B com detalhes.", category: "other" as const };
    await rejected(createOccurrence(b, { ...occ, unitId: f.unitSp }), "occurrence.unitId");
    await rejected(createOccurrence(b, { ...occ, responsibleId: f.ctx.lawyer.userId }), "occurrence.responsibleId");
    await rejected(createOccurrence(b, { ...occ, reportedById: f.ctx.analyst.userId }), "occurrence.reportedById");

    const ctr = { title: "Contrato B", counterparty: "Fornecedor", type: "services" as const };
    await rejected(createContract(b, { ...ctr, unitId: f.unitSp }), "contract.unitId");
    await rejected(createContract(b, { ...ctr, responsibleId: f.ctx.lawyer.userId }), "contract.responsibleId");
    await rejected(createContract(b, { ...ctr, linkedProcessId: A.process }), "contract.linkedProcessId");
    await rejected(createContract(b, { ...ctr, linkedOccurrenceId: A.occurrence }), "contract.linkedOccurrenceId");

    const file = { name: "b.txt", bytes: utf8("Documento de B") };
    await rejected(uploadDocument(b, { title: "Doc B", category: "other", processId: A.process, file }), "document.processId");
    await rejected(uploadDocument(b, { title: "Doc B", category: "other", occurrenceId: A.occurrence, file }), "document.occurrenceId");
    await rejected(uploadDocument(b, { title: "Doc B", category: "other", contractId: A.contract, file }), "document.contractId");

    await rejected(createTask(b, { title: "Tarefa B", processId: A.process }), "task.processId");
    await rejected(createTask(b, { title: "Tarefa B", assigneeId: f.ctx.lawyer.userId }), "task.assigneeId");
    await rejected(createTask(b, { title: "Tarefa B", unitId: f.unitSp }), "task.unitId");
    await rejected(createTask(b, { title: "Tarefa B", documentId: A.document }), "task.documentId");
    const dl = { title: "Prazo B", dueDate: daysFromToday(5), kind: "internal" as const };
    await rejected(createDeadline(b, { ...dl, contractId: A.contract }), "deadline.contractId");
    await rejected(createDeadline(b, { ...dl, responsibleId: f.ctx.lawyer.userId }), "deadline.responsibleId");
    await rejected(createDeadline(b, { ...dl, unitId: f.unitRe }), "deadline.unitId");
    await rejected(
      createSuggestedDeadline(b, { ...dl, sourceAnalysisId: A.analysis, sourceExcerpt: "trecho" }),
      "suggestedDeadline.sourceAnalysisId",
    );

    // Nothing was written for B with A's references.
    const bProcesses = await f.db.select().from(legalProcesses).where(eq(legalProcesses.organizationId, f.orgB));
    expect(bProcesses.map((p) => p.id)).toEqual([B.process]);
    const leaked = await f.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.organizationId, f.orgB)));
    expect(leaked).toEqual([]);
    const bDocs = await f.db.select().from(documents).where(eq(documents.organizationId, f.orgB));
    expect(bDocs).toEqual([]);
    const bDeadlines = await f.db.select().from(deadlines).where(inArray(deadlines.organizationId, [f.orgB]));
    expect(bDeadlines).toEqual([]);
  });

  it("process numbers are unique per organization only", async () => {
    // B created a process with the same number as A's in beforeAll (no cross-tenant conflict).
    const [pa] = await f.db.select().from(legalProcesses).where(eq(legalProcesses.id, A.process));
    const [pb] = await f.db.select().from(legalProcesses).where(eq(legalProcesses.id, B.process));
    expect(pa.number).toBe(pb.number);
  });
});
