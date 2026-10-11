/**
 * Row visibility inside one organization (src/server/auth/access.ts) as seen
 * through the module services: unit scoping, confidentiality, document
 * confidentiality levels, AI analyses limited by their sources, private
 * question/answer analyses, and alerts/comments/work items following the
 * record they reference.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "@/server/auth/context";
import { listAlerts, resolveAlert, upsertAlert } from "@/modules/alerts/service";
import { listEntityHistory } from "@/modules/admin/service";
import { applySuggestedDeadline, getAnalysis, listAnalyses, requestAnalysis } from "@/modules/analyses/service";
import { addComment, listComments } from "@/modules/comments/service";
import { getContract, listContracts } from "@/modules/contracts/service";
import { getDashboardData } from "@/modules/dashboard/service";
import {
  addDocumentVersion,
  getDocument,
  listDocuments,
  openDocumentVersion,
  updateDocumentMetadata,
} from "@/modules/documents/service";
import { getOccurrence, listOccurrences, updateOccurrence } from "@/modules/occurrences/service";
import { getProcess, listProcesses, updateProcess } from "@/modules/processes/service";
import {
  createSuggestedDeadline,
  createTask,
  getDeadline,
  getTask,
  listDeadlines,
  listTasks,
} from "@/modules/work/service";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
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
const ids: Record<string, string> = {};

async function sees(ctx: AuthContext, read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

beforeAll(async () => {
  f = await setupFixture("vis");
  const { admin, manager, lawyer, analyst, lawyerRe } = f.ctx;

  // Unit-scoped records.
  ids.processSp = await makeProcess(admin, { title: "Processo SP", unitId: f.unitSp });
  ids.processRe = await makeProcess(admin, { title: "Processo RE", unitId: f.unitRe });
  ids.processNoUnit = await makeProcess(admin, { title: "Processo sem unidade" });
  // RE process whose responsible is the SP lawyer.
  ids.processReOwnedBySp = await makeProcess(admin, { title: "Processo RE do advogado SP", unitId: f.unitRe, responsibleId: lawyer.userId });
  ids.occurrenceSp = await makeOccurrence(admin, { unitId: f.unitSp });
  ids.occurrenceRe = await makeOccurrence(admin, { unitId: f.unitRe });
  ids.contractSp = await makeContract(admin, { unitId: f.unitSp });
  ids.contractRe = await makeContract(admin, { unitId: f.unitRe });

  // Confidential process in SP, responsible = SP lawyer.
  ids.processConf = await makeProcess(manager, {
    title: "Processo confidencial",
    unitId: f.unitSp,
    responsibleId: lawyer.userId,
    isConfidential: true,
  });

  // Documents on a SP process whose responsible is the RE lawyer.
  ids.processDocs = await makeProcess(admin, { title: "Processo com documentos", unitId: f.unitSp, responsibleId: lawyerRe.userId });
  const restricted = await makeTextDocument(analyst, {
    processId: ids.processDocs,
    confidentiality: "restricted",
    title: "Parecer restrito",
    text: `Parecer interno restrito sobre o risco de multa contratual (texto fictício). Reunião sigilosa marcada para ${brDate(daysFromToday(12))}.`,
  });
  ids.docRestricted = restricted.documentId;
  ids.docRestrictedV1 = restricted.versionId;
  const confidentialDoc = await makeTextDocument(admin, {
    processId: ids.processDocs,
    confidentiality: "confidential",
    title: "Estratégia confidencial",
    text: "Estratégia de defesa confidencial (texto fictício).",
  });
  ids.docConfidential = confidentialDoc.documentId;
  const internalDoc = await makeTextDocument(admin, {
    processId: ids.processDocs,
    title: "Petição inicial",
    text: "Petição inicial com pedido de indenização (texto fictício).",
  });
  ids.docInternal = internalDoc.documentId;

  // Work items on the confidential process.
  ids.deadlineConf = await makeDeadline(manager, { processId: ids.processConf, title: "Prazo do processo confidencial" });
  ids.taskConfForAnalyst = await makeTask(manager, {
    processId: ids.processConf,
    assigneeId: analyst.userId,
    title: "Tarefa confidencial atribuída ao analista",
  });

  await runJobs();
});

afterAll(async () => f.teardown());

describe("unit scoping (lawyers and analysts)", () => {
  it("lawyers and analysts see records of their unit, unit-less ones and their own", async () => {
    const { lawyer, analyst, lawyerRe, analystRe } = f.ctx;
    const titles = async (ctx: AuthContext) =>
      (await listProcesses(ctx, { pageSize: 100 })).items.map((p) => p.title).sort();

    const spTitles = await titles(lawyer);
    expect(spTitles).toContain("Processo SP");
    expect(spTitles).toContain("Processo sem unidade");
    expect(spTitles).toContain("Processo RE do advogado SP");
    expect(spTitles).not.toContain("Processo RE");

    const analystTitles = await titles(analyst);
    expect(analystTitles).toContain("Processo SP");
    expect(analystTitles).not.toContain("Processo RE");
    expect(analystTitles).not.toContain("Processo RE do advogado SP");

    const reTitles = await titles(lawyerRe);
    expect(reTitles).toContain("Processo RE");
    expect(reTitles).toContain("Processo sem unidade");
    expect(reTitles).not.toContain("Processo SP");
    expect(reTitles).toContain("Processo com documentos"); // responsible

    expect(await sees(lawyer, () => getProcess(lawyer, ids.processRe))).toBe(false);
    expect(await sees(analystRe, () => getProcess(analystRe, ids.processSp))).toBe(false);
    expect(await sees(analystRe, () => getProcess(analystRe, ids.processRe))).toBe(true);
  });

  it("applies the same rule to occurrences and contracts", async () => {
    const { lawyer, analystRe } = f.ctx;
    expect(await sees(lawyer, () => getOccurrence(lawyer, ids.occurrenceSp))).toBe(true);
    expect(await sees(lawyer, () => getOccurrence(lawyer, ids.occurrenceRe))).toBe(false);
    expect(await sees(analystRe, () => getContract(analystRe, ids.contractRe))).toBe(true);
    expect(await sees(analystRe, () => getContract(analystRe, ids.contractSp))).toBe(false);
    const occIds = (await listOccurrences(lawyer, { pageSize: 100 })).items.map((o) => o.id);
    expect(occIds).toContain(ids.occurrenceSp);
    expect(occIds).not.toContain(ids.occurrenceRe);
    const ctrIds = (await listContracts(analystRe, { pageSize: 100 })).items.map((c) => c.id);
    expect(ctrIds).toEqual([ids.contractRe]);
  });

  it("a user cannot write to a record outside their scope", async () => {
    await expect(updateOccurrence(f.ctx.analyst, ids.occurrenceRe, { title: "Alteração indevida" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(updateProcess(f.ctx.lawyer, ids.processRe, { title: "Alteração indevida" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("confidential records", () => {
  it("a confidential process is visible only to admin, legal manager and the responsible person", async () => {
    const { admin, manager, lawyer, analyst, executive, lawyerRe } = f.ctx;
    expect(await sees(admin, () => getProcess(admin, ids.processConf))).toBe(true);
    expect(await sees(manager, () => getProcess(manager, ids.processConf))).toBe(true);
    expect(await sees(lawyer, () => getProcess(lawyer, ids.processConf))).toBe(true); // responsible
    expect(await sees(analyst, () => getProcess(analyst, ids.processConf))).toBe(false); // same unit, not responsible
    expect(await sees(executive, () => getProcess(executive, ids.processConf))).toBe(false);
    expect(await sees(lawyerRe, () => getProcess(lawyerRe, ids.processConf))).toBe(false);
    expect((await listProcesses(analyst, { pageSize: 100 })).items.map((p) => p.id)).not.toContain(ids.processConf);
    expect((await listProcesses(executive, { pageSize: 100 })).items.map((p) => p.id)).not.toContain(ids.processConf);
  });

  it("work items inherit the parent's visibility, but the assignee always sees their own item", async () => {
    const { lawyer, analyst, executive } = f.ctx;
    expect(await sees(lawyer, () => getDeadline(lawyer, ids.deadlineConf))).toBe(true);
    expect(await sees(analyst, () => getDeadline(analyst, ids.deadlineConf))).toBe(false);
    expect(await sees(executive, () => getDeadline(executive, ids.deadlineConf))).toBe(false);
    expect((await listDeadlines(analyst, { pageSize: 100 })).items.map((d) => d.id)).not.toContain(ids.deadlineConf);

    // The analyst is the assignee of a task on the confidential process: sees the task,
    // but the link to the confidential process carries no label.
    const task = await getTask(analyst, ids.taskConfForAnalyst);
    const link = task.links.find((l) => l.type === "legal_process");
    expect(link).toMatchObject({ id: ids.processConf, label: null, href: null });
    expect((await listTasks(executive, { pageSize: 100 })).items.map((t) => t.id)).not.toContain(ids.taskConfForAnalyst);
  });

  it("the executive sees non-confidential records of every unit but cannot write", async () => {
    const { executive } = f.ctx;
    const titles = (await listProcesses(executive, { pageSize: 100 })).items.map((p) => p.title);
    expect(titles).toEqual(expect.arrayContaining(["Processo SP", "Processo RE", "Processo sem unidade"]));
    expect(await sees(executive, () => getOccurrence(executive, ids.occurrenceRe))).toBe(true);
    expect(await sees(executive, () => getContract(executive, ids.contractSp))).toBe(true);
    await expect(updateProcess(executive, ids.processSp, { title: "Alterado" })).rejects.toBeInstanceOf(ForbiddenError);

    const dash = await getDashboardData(executive);
    const dashAdmin = await getDashboardData(f.ctx.admin);
    expect(dashAdmin.processes.total - dash.processes.total).toBe(1); // only the confidential one is hidden
  });
});

describe("document confidentiality levels", () => {
  it("restricted documents: uploader, responsible of the linked record, admin and legal manager only", async () => {
    const { admin, manager, lawyer, analyst, executive, lawyerRe } = f.ctx;
    const canSee = (ctx: AuthContext) => sees(ctx, () => getDocument(ctx, ids.docRestricted));
    expect(await canSee(analyst)).toBe(true); // uploader
    expect(await canSee(lawyerRe)).toBe(true); // responsible of the linked process
    expect(await canSee(admin)).toBe(true);
    expect(await canSee(manager)).toBe(true);
    expect(await canSee(lawyer)).toBe(false); // sees the process, but not restricted documents
    expect(await canSee(executive)).toBe(false);
    await expect(openDocumentVersion(lawyer, ids.docRestricted, ids.docRestrictedV1)).rejects.toBeInstanceOf(NotFoundError);
    const listed = (await listDocuments(lawyer, { processId: ids.processDocs })).items.map((d) => d.id).sort();
    expect(listed).toEqual([ids.docConfidential, ids.docInternal].sort());
  });

  it("confidential documents: lawyers yes, analysts and executives no", async () => {
    const { lawyer, analyst, executive } = f.ctx;
    expect(await sees(lawyer, () => getDocument(lawyer, ids.docConfidential))).toBe(true);
    expect(await sees(analyst, () => getDocument(analyst, ids.docConfidential))).toBe(false);
    expect(await sees(executive, () => getDocument(executive, ids.docConfidential))).toBe(false);
    expect(await sees(executive, () => getDocument(executive, ids.docInternal))).toBe(true);
  });
});

describe("AI analyses", () => {
  it("an analysis is hidden from users who cannot see one of its source documents", async () => {
    const { manager, lawyer, admin } = f.ctx;
    const { analysisId } = await requestAnalysis(manager, { type: "summary", subjectType: "legal_process", subjectId: ids.processDocs });
    await runJobs();
    ids.analysisWithRestricted = analysisId;
    const detail = await getAnalysis(manager, analysisId);
    expect(detail.status).toBe("succeeded");
    expect(detail.sources.some((s) => s.entityId === ids.docRestricted)).toBe(true);

    // The lawyer sees the process but not the restricted source document.
    expect(await sees(lawyer, () => getProcess(lawyer, ids.processDocs))).toBe(true);
    expect(await sees(lawyer, () => getAnalysis(lawyer, analysisId))).toBe(false);
    const listed = (await listAnalyses(lawyer, { subjectType: "legal_process", subjectId: ids.processDocs })).items;
    expect(listed.map((a) => a.id)).not.toContain(analysisId);
    expect(await sees(admin, () => getAnalysis(admin, analysisId))).toBe(true);

    // The same request by the lawyer only uses the sources the lawyer can see.
    const own = await requestAnalysis(lawyer, { type: "summary", subjectType: "legal_process", subjectId: ids.processDocs });
    expect(own.analysisId).not.toBe(analysisId);
    await runJobs();
    const ownDetail = await getAnalysis(lawyer, own.analysisId);
    expect(ownDetail.sources.some((s) => s.entityId === ids.docRestricted)).toBe(false);
    expect(ownDetail.sources.some((s) => s.entityId === ids.docConfidential)).toBe(true);
  });

  it("a deadline suggested from a restricted source does not leak the excerpt to who cannot see the analysis", async () => {
    const { manager, lawyer } = f.ctx;
    const detail = await getAnalysis(manager, ids.analysisWithRestricted);
    const restrictedRef = detail.sources.find((s) => s.entityId === ids.docRestricted)!.ref;
    const index = detail.result!.suggestedDeadlines.findIndex((d) => d.sourceRef === restrictedRef);
    expect(index).toBeGreaterThanOrEqual(0);
    const { deadlineId } = await applySuggestedDeadline(manager, ids.analysisWithRestricted, index);

    const asManager = await getDeadline(manager, deadlineId);
    expect(asManager.sourceExcerpt).toMatch(/sigilosa/);
    const asLawyer = await getDeadline(lawyer, deadlineId); // sees it through the linked process
    expect(asLawyer.sourceAnalysisVisible).toBe(false);
    expect(asLawyer.sourceExcerpt).toBeNull();
    expect(JSON.stringify(asLawyer)).not.toMatch(/sigilosa/);

    // Nor can the lawyer reuse that analysis as the source of a new suggestion.
    await expect(
      createSuggestedDeadline(lawyer, {
        title: "Prazo",
        dueDate: daysFromToday(3),
        kind: "internal",
        sourceAnalysisId: ids.analysisWithRestricted,
        sourceExcerpt: "trecho",
        processId: ids.processDocs,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("users cannot analyze or ask about documents they cannot see", async () => {
    const { lawyer } = f.ctx;
    await expect(
      requestAnalysis(lawyer, { type: "summary", subjectType: "document", subjectId: ids.docRestricted }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const { analysisId } = await requestAnalysis(lawyer, {
      type: "question_answer",
      subjectType: "organization",
      question: "Quando acontece a reunião sigilosa sobre a multa contratual?",
    });
    await runJobs();
    const qa = await getAnalysis(lawyer, analysisId);
    expect(qa.sources.map((s) => s.entityId)).not.toContain(ids.docRestricted);
    expect(JSON.stringify(qa.result)).not.toMatch(/sigilosa/);
  });

  it("question/answer analyses are private to the requester (even for admins)", async () => {
    const { lawyer, manager, admin } = f.ctx;
    const { analysisId } = await requestAnalysis(lawyer, {
      type: "question_answer",
      subjectType: "organization",
      question: "Existe algum pedido de indenização?",
    });
    await runJobs();
    expect(await sees(lawyer, () => getAnalysis(lawyer, analysisId))).toBe(true);
    expect(await sees(manager, () => getAnalysis(manager, analysisId))).toBe(false);
    expect(await sees(admin, () => getAnalysis(admin, analysisId))).toBe(false);
    expect((await listAnalyses(admin, { type: "question_answer" })).items.map((a) => a.id)).not.toContain(analysisId);

    // The same question from another user is a different (private) analysis.
    const other = await requestAnalysis(manager, {
      type: "question_answer",
      subjectType: "organization",
      question: "Existe algum pedido de indenização?",
    });
    expect(other.analysisId).not.toBe(analysisId);
    expect(other.reused).toBe(false);
  });
});

describe("writes cannot reach records outside the user's scope", () => {
  it("links to invisible records are rejected and confidentiality cannot be lifted by a lawyer", async () => {
    const { lawyer } = f.ctx;
    await expect(updateDocumentMetadata(lawyer, ids.docInternal, { processId: ids.processRe })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createTask(lawyer, { title: "Tarefa sobre parecer", documentId: ids.docRestricted })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createTask(lawyer, { title: "Tarefa em outra unidade", processId: ids.processRe })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      addDocumentVersion(lawyer, ids.docRestricted, { file: { name: "v2.txt", bytes: utf8("nova versão do parecer") } }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // The responsible lawyer may edit the confidential process, but not make it public.
    await updateProcess(lawyer, ids.processConf, { isConfidential: false, description: "Atualização do advogado" });
    const p = await getProcess(f.ctx.manager, ids.processConf);
    expect(p.isConfidential).toBe(true);
    expect(p.description).toBe("Atualização do advogado");
  });

  it("history and dashboard activity of a confidential process stay hidden", async () => {
    const { analyst, executive, lawyer } = f.ctx;
    const ref = { type: "legal_process" as const, id: ids.processConf };
    expect(await listEntityHistory(lawyer, ref)).not.toEqual([]);
    expect(await listEntityHistory(analyst, ref)).toEqual([]);
    expect(await listEntityHistory(executive, ref)).toEqual([]);
    const activity = (await getDashboardData(executive)).activity;
    expect(activity.filter((a) => a.entityHref?.includes(ids.processConf))).toEqual([]);
    expect(activity.filter((a) => /confidencial/i.test(a.summary))).toEqual([]);
  });
});

describe("alerts and comments follow the referenced record", () => {
  it("comments on a confidential process are only readable by who sees the process", async () => {
    const { manager, lawyer, analyst, executive } = f.ctx;
    await addComment(manager, { type: "legal_process", id: ids.processConf }, "Comentário sobre estratégia confidencial");
    expect(await listComments(lawyer, { type: "legal_process", id: ids.processConf })).toHaveLength(1);
    await expect(listComments(analyst, { type: "legal_process", id: ids.processConf })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listComments(executive, { type: "legal_process", id: ids.processConf })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      addComment(analyst, { type: "legal_process", id: ids.processConf }, "Tentativa de comentário"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("alerts about a confidential process are hidden and cannot be resolved by others", async () => {
    const { lawyer, lawyerRe, analyst, executive, manager } = f.ctx;
    await upsertAlert({
      organizationId: f.orgA,
      type: "risk_signal",
      severity: "warning",
      title: "Alerta do processo confidencial",
      message: "Mensagem de teste.",
      entityType: "legal_process",
      entityId: ids.processConf,
      dedupeKey: `test:${ids.processConf}`,
    });
    const titlesOf = async (ctx: AuthContext) => (await listAlerts(ctx, { openOnly: true, limit: 200 })).map((a) => a.title);
    expect(await titlesOf(lawyer)).toContain("Alerta do processo confidencial");
    expect(await titlesOf(manager)).toContain("Alerta do processo confidencial");
    expect(await titlesOf(analyst)).not.toContain("Alerta do processo confidencial");
    expect(await titlesOf(executive)).not.toContain("Alerta do processo confidencial");
    expect(await titlesOf(lawyerRe)).not.toContain("Alerta do processo confidencial");

    const alertId = (await listAlerts(lawyer, { limit: 200 })).find((a) => a.title === "Alerta do processo confidencial")!.id;
    await expect(resolveAlert(lawyerRe, alertId)).rejects.toBeInstanceOf(NotFoundError);
    await resolveAlert(lawyer, alertId);
    expect(await titlesOf(manager)).not.toContain("Alerta do processo confidencial");
  });
});
