/**
 * THE main product flow, end to end through the real services and the job
 * queue (demo AI provider, PGlite, temporary storage):
 *
 * analyst registers an occurrence → uploads a document linked to it → the
 * worker extracts the text and produces the automatic summary → a lawyer asks
 * for a risk-signals analysis → result with sources, limitations, validation
 * points and the demo notice → identical request is reused → lawyer reviews
 * it → applies a suggested task and a suggested deadline → the deadline only
 * counts after human validation → a new document version makes the analyses
 * stale (visible on the dashboard) → the occurrence becomes a lawsuit → every
 * step is in the audit log.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { DEMO_MODE_NOTICE } from "@/domain/analysis";
import {
  applySuggestedDeadline,
  applySuggestedTask,
  getAnalysis,
  listAnalyses,
  requestAnalysis,
  reviewAnalysis,
} from "@/modules/analyses/service";
import { getDashboardData } from "@/modules/dashboard/service";
import { addDocumentVersion, getDocument } from "@/modules/documents/service";
import { createOccurrence, getActionPlanProgress, getOccurrence } from "@/modules/occurrences/service";
import { createProcess, getProcess } from "@/modules/processes/service";
import {
  createTask,
  getDeadline,
  getTask,
  getWorkSummary,
  listDeadlines,
  validateDeadline,
} from "@/modules/work/service";
import { aiAnalyses, aiAnalysisSources, auditLogs, documentVersions } from "@/server/db/schema";
import { ConflictError } from "@/server/lib/errors";
import { brDate, daysFromToday, makeTextDocument, runJobs, setupFixture, utf8, type Fixture } from "../helpers/fixtures";

let f: Fixture;
const ids: Record<string, string> = {};
const DUE = daysFromToday(5);

const DOCUMENT_TEXT = [
  "Notificação extrajudicial recebida em nome da empresa (documento fictício para testes).",
  "O remetente alega descumprimento do contrato de fornecimento e pede indenização de R$ 50.000,00.",
  `O prazo para resposta à notificação termina em ${brDate(DUE)}.`,
  "Responsável pelo contrato: não informado",
].join("\n");

beforeAll(async () => {
  f = await setupFixture("flow");
});

afterAll(async () => f.teardown());

async function auditActions(): Promise<string[]> {
  const rows = await f.db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.organizationId, f.orgA));
  return rows.map((r) => r.action);
}

describe("integrated flow: occurrence → document → AI → work items → process", () => {
  it("1. the analyst registers an occurrence", async () => {
    const { analyst, lawyer } = f.ctx;
    const { id } = await createOccurrence(analyst, {
      title: "Notificação de fornecedor sobre descumprimento contratual",
      facts: "Fornecedor enviou notificação extrajudicial alegando atraso nos pagamentos (fatos fictícios).",
      category: "contractual",
      riskLevel: "high",
      unitId: f.unitSp,
      responsibleId: lawyer.userId,
    });
    ids.occurrence = id;
    const occ = await getOccurrence(lawyer, id);
    expect(occ).toMatchObject({ status: "open", riskLevel: "high", unitId: f.unitSp, responsibleId: lawyer.userId });
  });

  it("2. the analyst uploads a .txt document linked to it", async () => {
    const { documentId, versionId } = await makeTextDocument(f.ctx.analyst, {
      occurrenceId: ids.occurrence,
      title: "Notificação extrajudicial do fornecedor",
      category: "correspondence",
      fileName: "notificacao.txt",
      text: DOCUMENT_TEXT,
    });
    ids.document = documentId;
    ids.v1 = versionId;
    const doc = await getDocument(f.ctx.lawyer, documentId);
    expect(doc.versions[0]).toMatchObject({ extractionStatus: "pending", versionNumber: 1 });
    expect(doc.links).toEqual([expect.objectContaining({ type: "occurrence", id: ids.occurrence })]);
  });

  it("3. the worker extracts the text and creates the automatic summary", async () => {
    expect(await runJobs()).toBeGreaterThanOrEqual(2); // extraction + auto summary
    const doc = await getDocument(f.ctx.lawyer, ids.document);
    expect(doc.versions[0].extractionStatus).toBe("succeeded");

    const auto = await listAnalyses(f.ctx.lawyer, { subjectType: "document", subjectId: ids.document });
    expect(auto.items).toHaveLength(1);
    expect(auto.items[0]).toMatchObject({ type: "summary", trigger: "document_uploaded", status: "succeeded", mode: "demo" });
    ids.autoSummary = auto.items[0].id;
  });

  it("4. a lawyer requests a risk-signals analysis and the worker runs it", async () => {
    const req = await requestAnalysis(f.ctx.lawyer, { type: "risk_signals", subjectType: "occurrence", subjectId: ids.occurrence });
    expect(req.reused).toBe(false);
    ids.analysis = req.analysisId;
    expect((await getAnalysis(f.ctx.lawyer, req.analysisId)).status).toBe("queued");

    await runJobs();
    const a = await getAnalysis(f.ctx.lawyer, req.analysisId);
    expect(a.status).toBe("succeeded");
    expect(a.mode).toBe("demo");
    expect(a.result).not.toBeNull();
    const result = a.result!;
    expect(result.limitations.length).toBeGreaterThan(0);
    expect(result.validationPoints.length).toBeGreaterThan(0);
    expect(result.systemNotices).toContain(DEMO_MODE_NOTICE);
    expect(result.findings.some((x) => x.kind === "risk_signal")).toBe(true);
    for (const finding of result.findings) expect(finding.sourceRefs.length).toBeGreaterThan(0);

    // Sources: the occurrence record and the document version (with its content hash).
    const docSource = a.sources.find((s) => s.sourceType === "document_version");
    expect(docSource).toMatchObject({ entityId: ids.document, versionId: ids.v1, versionNumber: 1 });
    expect(a.sources.some((s) => s.sourceType === "occurrence" && s.entityId === ids.occurrence)).toBe(true);
    const stored = await f.db
      .select()
      .from(aiAnalysisSources)
      .where(and(eq(aiAnalysisSources.analysisId, a.id), eq(aiAnalysisSources.sourceType, "document_version")));
    expect(stored).toHaveLength(1);
    expect(stored[0].versionId).toBe(ids.v1);
    expect(stored[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("5. an identical request reuses the existing result", async () => {
    const again = await requestAnalysis(f.ctx.lawyer, { type: "risk_signals", subjectType: "occurrence", subjectId: ids.occurrence });
    expect(again).toEqual({ analysisId: ids.analysis, reused: true });
    const count = await f.db
      .select({ id: aiAnalyses.id })
      .from(aiAnalyses)
      .where(and(eq(aiAnalyses.subjectId, ids.occurrence), eq(aiAnalyses.type, "risk_signals")));
    expect(count).toHaveLength(1);
  });

  it("6. the lawyer reviews the analysis", async () => {
    await reviewAnalysis(f.ctx.lawyer, ids.analysis, { decision: "reviewed", note: "Conferido com a notificação original." });
    const a = await getAnalysis(f.ctx.lawyer, ids.analysis);
    expect(a.reviewStatus).toBe("reviewed");
    expect(a.reviewedByName).toBe(f.ctx.lawyer.name);
  });

  it("7. the lawyer applies a suggested task and a suggested deadline", async () => {
    const { lawyer } = f.ctx;
    const a = await getAnalysis(lawyer, ids.analysis);
    const suggestedTasks = a.result!.suggestedTasks;
    if (suggestedTasks.length > 0) {
      ids.task = (await applySuggestedTask(lawyer, ids.analysis, 0)).taskId;
      const task = await getTask(lawyer, ids.task);
      expect(task).toMatchObject({ origin: "ai_suggested", kind: "action_plan", occurrenceId: ids.occurrence, sourceAnalysisId: ids.analysis });
      await expect(applySuggestedTask(lawyer, ids.analysis, 0)).rejects.toBeInstanceOf(ConflictError);
    } else {
      ids.task = (
        await createTask(lawyer, { title: "Responder à notificação do fornecedor", kind: "action_plan", occurrenceId: ids.occurrence })
      ).id;
    }
    const progress = await getActionPlanProgress(lawyer, ids.occurrence);
    expect(progress?.total).toBe(1);

    const index = a.result!.suggestedDeadlines.findIndex((d) => d.date === DUE);
    expect(index).toBeGreaterThanOrEqual(0);
    ids.deadline = (await applySuggestedDeadline(lawyer, ids.analysis, index)).deadlineId;
    await expect(applySuggestedDeadline(lawyer, ids.analysis, index)).rejects.toBeInstanceOf(ConflictError);

    const after = await getAnalysis(lawyer, ids.analysis);
    expect(after.appliedDeadlineIndexes).toContain(index);
  });

  it("8. the suggested deadline awaits validation and is NOT counted", async () => {
    const { lawyer, manager } = f.ctx;
    const d = await getDeadline(lawyer, ids.deadline);
    expect(d).toMatchObject({
      origin: "ai_suggested",
      validationStatus: "pending_validation",
      status: "open",
      dueDate: DUE,
      occurrenceId: ids.occurrence,
      countsAsDeadline: false,
      isPendingValidation: true,
    });
    expect(d.sourceExcerpt).toContain(brDate(DUE));

    const summary = await getWorkSummary(lawyer);
    expect(summary).toMatchObject({ pendingValidation: 1, upcomingDeadlines: 0, overdueDeadlines: 0, openDeadlines: 0 });
    for (const situation of ["upcoming", "open", "overdue"] as const) {
      const listed = await listDeadlines(lawyer, { situation });
      expect(listed.items.map((x) => x.id), situation).not.toContain(ids.deadline);
    }
    const dash = await getDashboardData(manager);
    expect(dash.deadlines).toMatchObject({ upcoming: 0, overdue: 0, pendingValidation: 1 });
    expect(dash.deadlines.next.map((x) => x.id)).not.toContain(ids.deadline);
  });

  it("9. after the lawyer validates it, the deadline counts", async () => {
    const { lawyer, manager } = f.ctx;
    await validateDeadline(lawyer, ids.deadline, { decision: "validated", note: "Data conferida na notificação." });
    const d = await getDeadline(lawyer, ids.deadline);
    expect(d).toMatchObject({ validationStatus: "validated", countsAsDeadline: true, isPendingValidation: false });
    expect(d.validatedByName).toBe(lawyer.name);
    await expect(validateDeadline(lawyer, ids.deadline, { decision: "validated" })).rejects.toBeInstanceOf(ConflictError);

    const summary = await getWorkSummary(lawyer);
    expect(summary).toMatchObject({ pendingValidation: 0, upcomingDeadlines: 1, openDeadlines: 1, overdueDeadlines: 0 });
    expect((await listDeadlines(lawyer, { situation: "upcoming" })).items.map((x) => x.id)).toContain(ids.deadline);
    expect((await listDeadlines(lawyer, { situation: "open" })).items.map((x) => x.id)).toContain(ids.deadline);

    const dash = await getDashboardData(manager);
    expect(dash.deadlines).toMatchObject({ upcoming: 1, overdue: 0, pendingValidation: 0 });
    const next = dash.deadlines.next.find((x) => x.id === ids.deadline);
    expect(next).toMatchObject({ origin: "ai_suggested", validationStatus: "validated", dueDate: DUE });
    expect(next?.linked).toMatchObject({ type: "occurrence" });
    expect(dash.analyses.stale).toBe(0);
  });

  it("10. a new document version makes the analyses stale, and the dashboard shows it", async () => {
    const { analyst, lawyer, manager } = f.ctx;
    const { versionId, versionNumber } = await addDocumentVersion(analyst, ids.document, {
      changeNote: "Notificação complementar",
      file: { name: "notificacao-v2.txt", bytes: utf8(`${DOCUMENT_TEXT}\nComplemento: o fornecedor aceita negociar.`) },
    });
    ids.v2 = versionId;
    expect(versionNumber).toBe(2);
    await runJobs();

    const [v2] = await f.db.select().from(documentVersions).where(eq(documentVersions.id, versionId));
    expect(v2.extractionStatus).toBe("succeeded");

    const a = await getAnalysis(lawyer, ids.analysis);
    expect(a.isStale).toBe(true);
    expect(a.staleReason).toMatch(/Nova versão do documento/);
    const autoV1 = await getAnalysis(lawyer, ids.autoSummary);
    expect(autoV1.isStale).toBe(true);

    const staleList = await listAnalyses(manager, { staleOnly: true, pageSize: 100 });
    expect(staleList.items.map((x) => x.id)).toEqual(expect.arrayContaining([ids.analysis, ids.autoSummary]));
    const dash = await getDashboardData(manager);
    expect(dash.analyses.stale).toBe(staleList.total);
    expect(dash.analyses.stale).toBeGreaterThanOrEqual(2);

    // A stale result is no longer reused: a new request creates a fresh analysis over v2.
    const fresh = await requestAnalysis(lawyer, { type: "risk_signals", subjectType: "occurrence", subjectId: ids.occurrence });
    expect(fresh.reused).toBe(false);
    await runJobs();
    const freshDetail = await getAnalysis(lawyer, fresh.analysisId);
    expect(freshDetail.status).toBe("succeeded");
    expect(freshDetail.sources.find((s) => s.sourceType === "document_version")?.versionId).toBe(ids.v2);
  });

  it("11. the occurrence becomes a lawsuit (process created from it)", async () => {
    const { lawyer } = f.ctx;
    const { id, occurrenceLinkError } = await createProcess(lawyer, {
      number: "0012345-67.2026.8.26.0100",
      title: "Ação de cobrança do fornecedor (fictícia)",
      court: "TJSP",
      area: "civil",
      phase: "knowledge",
      unitId: f.unitSp,
      responsibleId: lawyer.userId,
      fromOccurrenceId: ids.occurrence,
    });
    expect(occurrenceLinkError).toBeNull();
    ids.process = id;
    const occ = await getOccurrence(lawyer, ids.occurrence);
    expect(occ.status).toBe("converted_to_process");
    expect(occ.linkedProcess).toMatchObject({ id, visible: true, number: "0012345-67.2026.8.26.0100" });
    const p = await getProcess(lawyer, id);
    expect(p).toMatchObject({ dataOrigin: "manual", isConfidential: false });

    const dash = await getDashboardData(f.ctx.manager);
    expect(dash.occurrences.convertedToProcess).toBe(1);
    expect(dash.processes.total).toBe(1);
  });

  it("12. every step is in the audit log, without document contents", async () => {
    const actions = await auditActions();
    for (const expected of [
      "occurrence.create",
      "document.upload",
      "analysis.request",
      "analysis.completed",
      "analysis.review",
      "analysis.apply_deadline",
      "deadline.suggest",
      "deadline.validate",
      "task.create",
      "document.version_add",
      "legal_process.create",
      "occurrence.link_process",
    ]) {
      expect(actions, expected).toContain(expected);
    }
    if ((await getTask(f.ctx.lawyer, ids.task)).origin === "ai_suggested") expect(actions).toContain("analysis.apply_task");

    const actors = await f.db
      .select({ action: auditLogs.action, actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, f.orgA),
          inArray(auditLogs.action, ["occurrence.create", "document.upload", "analysis.review", "deadline.validate"]),
        ),
      );
    const actorOf = Object.fromEntries(actors.map((r) => [r.action, r.actorId]));
    expect(actorOf["occurrence.create"]).toBe(f.ctx.analyst.userId);
    expect(actorOf["document.upload"]).toBe(f.ctx.analyst.userId);
    expect(actorOf["analysis.review"]).toBe(f.ctx.lawyer.userId);
    expect(actorOf["deadline.validate"]).toBe(f.ctx.lawyer.userId);

    const all = await f.db.select().from(auditLogs);
    for (const row of all) {
      const serialized = JSON.stringify([row.summary, row.changes, row.metadata]);
      expect(serialized).not.toContain("pede indenização de R$ 50.000,00");
      expect(serialized).not.toContain("o fornecedor aceita negociar");
    }
  });
});
