import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { caseBriefSchema, CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_DISCLAIMER } from "@/domain/case-brief";
import {
  applyBriefDeadline,
  applyBriefNextStep,
  approveCaseBrief,
  getBriefCitationPage,
  getCaseBrief,
  getCaseBriefEmailDigest,
  getLatestCaseBriefSummary,
  listCaseBriefs,
  proposeBriefAmount,
  regenerateCaseBrief,
  rejectCaseBrief,
  requestCaseBrief,
  saveCaseBriefRevision,
  saveCaseBriefSection,
} from "@/modules/briefs/service";
import { uploadDocument } from "@/modules/documents/service";
import { alerts, auditLogs, caseBriefRevisions, caseBriefSources, caseBriefs, deadlines, tasks } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { runJobs, setupFixture, utf8, type Fixture } from "../helpers/fixtures";
import { demoInfo, insertIntake, makeLaborProcess, uploadDemoPack } from "./helpers";

const proposeValuation = vi.hoisted(() => vi.fn(async () => ({ id: "00000000-0000-4000-8000-0000000000aa" })));
vi.mock("@/modules/contingency/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/contingency/service")>();
  return { ...original, proposeValuation };
});

let fx: Fixture;

beforeAll(async () => {
  fx = await setupFixture("briefs");
});
afterAll(async () => {
  await fx?.teardown();
});

async function readyBrief(variant = 1) {
  const { admin, lawyer } = fx.ctx;
  const info = demoInfo();
  const processId = await makeLaborProcess(admin, info, { unitId: fx.unitSp, responsibleId: lawyer.userId });
  await uploadDemoPack(admin, processId, info, { variant });
  await runJobs();
  const { briefId, status } = await requestCaseBrief(lawyer, processId, { inline: true });
  return { info, processId, briefId, status };
}

describe("generation", () => {
  it("generates inline from the record and every document with text, with notices, revision 1, sources and alert", async () => {
    const { briefId, status, processId } = await readyBrief(1);
    expect(status).toBe("ready_for_review");

    const detail = await getCaseBrief(fx.ctx.lawyer, briefId);
    expect(detail.version).toBe(1);
    expect(detail.mode).toBe("demo");
    expect(detail.currentRevision).toBe(1);
    expect(detail.content?.systemNotices).toEqual([CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_DISCLAIMER]);
    const content = { ...detail.content!, systemNotices: undefined };
    expect(caseBriefSchema.safeParse(content).success).toBe(true);
    expect(detail.sources.map((s) => s.ref)).toEqual(["REG", "D1", "D2", "D3", "D4", "D5"]);
    expect(detail.sources.find((s) => s.ref === "D1")?.pageCount).toBeGreaterThanOrEqual(3);

    // Citations only point to sources, pages within range; extracted items carry page + excerpt.
    const refs = new Map(detail.sources.map((s) => [s.ref, s.pageCount ?? 1]));
    for (const key of Object.keys(content) as (keyof typeof content)[]) {
      const value = content[key];
      if (!Array.isArray(value)) continue;
      for (const item of value as { provenance?: string; citations?: { ref: string; page: number | null; excerpt: string | null }[] }[]) {
        if (!item.citations) continue;
        expect(item.provenance).not.toBe("reviewer");
        for (const c of item.citations) {
          expect(refs.has(c.ref)).toBe(true);
          if (c.ref !== "REG") expect(c.page).toBeGreaterThanOrEqual(1);
          if (c.ref !== "REG") expect(c.page).toBeLessThanOrEqual(refs.get(c.ref)!);
        }
        if (item.provenance === "extracted") {
          expect(item.citations.some((c) => c.ref !== "REG" && c.page !== null && !!c.excerpt)).toBe(true);
        }
      }
    }
    // Contradictions of the inconsistent variant were detected.
    expect(content.contradictions.length).toBeGreaterThanOrEqual(3);

    const [alert] = await fx.db.select().from(alerts).where(eq(alerts.dedupeKey, `brief_review:${briefId}`));
    expect(alert?.type).toBe("brief_pending_review");
    expect(alert?.title).toContain("[Simulação]");
    expect(alert?.resolvedAt).toBeNull();

    const audits = await fx.db.select().from(auditLogs).where(eq(auditLogs.entityId, briefId));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["case_brief.request", "case_brief.generate"]));
    // Audit never carries content.
    expect(JSON.stringify(audits)).not.toContain("horas extras");

    const summary = await getLatestCaseBriefSummary(fx.ctx.lawyer, processId);
    expect(summary?.id).toBe(briefId);
    expect(summary?.headline).toBeTruthy();
    const digest = await getCaseBriefEmailDigest(fx.ctx.lawyer, briefId);
    expect(digest.isDemo).toBe(true);
    expect(digest.missingDocumentsCount).toBeGreaterThan(0);
  });

  it("enqueues a job when not inline and the queue generates it; a running request is reused", async () => {
    const { admin, lawyer } = fx.ctx;
    const info = demoInfo();
    const processId = await makeLaborProcess(admin, info, { unitId: fx.unitSp });
    await uploadDemoPack(admin, processId, info, { variant: 0 });
    // Extraction still pending: the job extracts before generating.
    const first = await requestCaseBrief(lawyer, processId);
    expect(first.status).toBe("generating");
    const again = await requestCaseBrief(lawyer, processId);
    expect(again.briefId).toBe(first.briefId);
    await runJobs();
    const detail = await getCaseBrief(lawyer, first.briefId);
    expect(detail.status).toBe("ready_for_review");
    expect(detail.sources.filter((s) => s.sourceType === "document_version")).toHaveLength(5);
    expect(detail.content?.claims.length).toBeGreaterThan(0);

    // Regeneration creates version 2.
    const regen = await regenerateCaseBrief(lawyer, first.briefId);
    expect(regen.briefId).not.toBe(first.briefId);
    await runJobs();
    const v2 = await getCaseBrief(lawyer, regen.briefId);
    expect(v2.version).toBe(2);
    expect(v2.otherVersions.map((o) => o.version)).toEqual([2, 1]);
  });

  it("replaces a generation that never finished instead of blocking new requests", async () => {
    const { admin, lawyer } = fx.ctx;
    const processId = await makeLaborProcess(admin, demoInfo(), { unitId: fx.unitSp });
    const stuck = await requestCaseBrief(lawyer, processId);
    await fx.db
      .update(caseBriefs)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) })
      .where(eq(caseBriefs.id, stuck.briefId));
    const fresh = await requestCaseBrief(lawyer, processId, { inline: true });
    expect(fresh.briefId).not.toBe(stuck.briefId);
    expect(fresh.status).toBe("ready_for_review");
    const [old] = await fx.db.select().from(caseBriefs).where(eq(caseBriefs.id, stuck.briefId));
    expect(old.status).toBe("failed");
    // The queued job of the old brief is a no-op now.
    await runJobs();
    expect((await getCaseBrief(lawyer, stuck.briefId)).status).toBe("failed");
  });

  it("works with the record only when there are no documents", async () => {
    const { admin, lawyer } = fx.ctx;
    const processId = await makeLaborProcess(admin, demoInfo({ claimAmountCents: null }), { unitId: fx.unitSp });
    const { briefId, status } = await requestCaseBrief(lawyer, processId, { inline: true });
    expect(status).toBe("ready_for_review");
    const detail = await getCaseBrief(lawyer, briefId);
    expect(detail.sources.map((s) => s.ref)).toEqual(["REG"]);
    expect(detail.content?.limitations.join(" ")).toContain("Nenhum documento");
    expect(detail.content?.gaps.some((g) => g.text.includes("Valor da causa"))).toBe(true);
  });

  it("marks briefs stale when a new document of the process gets its text", async () => {
    const { briefId, processId } = await readyBrief(0);
    await uploadDocument(fx.ctx.admin, {
      title: "Cartões de ponto",
      category: "evidence",
      processId,
      file: { name: "ponto.txt", bytes: utf8("Cartões de ponto do período (fictício).") },
    });
    await runJobs();
    const detail = await getCaseBrief(fx.ctx.lawyer, briefId);
    expect(detail.isStale).toBe(true);
    expect(detail.staleReason).toContain("Cartões de ponto");
  });
});

describe("permissions and visibility", () => {
  it("requires brief:review (or intake:manage with an intake of the process) to request; brief:read to list", async () => {
    const { admin, analyst, accountant, executive } = fx.ctx;
    const info = demoInfo();
    const processId = await makeLaborProcess(admin, info, { unitId: fx.unitSp });
    // Analyst has intake:manage: only from the intake of the process (intake page), never directly.
    await expect(requestCaseBrief(analyst, processId, { inline: true })).rejects.toBeInstanceOf(ForbiddenError);
    const intakeId = await insertIntake(fx.orgA, processId);
    const r = await requestCaseBrief(analyst, processId, { intakeId, inline: true });
    expect(r.status).toBe("ready_for_review");
    await expect(requestCaseBrief(executive, processId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listCaseBriefs(accountant, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getLatestCaseBriefSummary(accountant, processId)).toBeNull();
    // Analyst can read but not review.
    await expect(approveCaseBrief(analyst, r.briefId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides a brief whose source is a confidential document from the analyst, not from the lawyer", async () => {
    const { admin, analyst, lawyer } = fx.ctx;
    const info = demoInfo();
    const processId = await makeLaborProcess(admin, info, { unitId: fx.unitSp });
    await uploadDemoPack(admin, processId, info, { variant: 0, only: [0] });
    await uploadDemoPack(admin, processId, info, { variant: 0, only: [1], confidentiality: "confidential" });
    await runJobs();

    const { briefId } = await requestCaseBrief(admin, processId, { inline: true });
    await expect(getCaseBrief(analyst, briefId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listCaseBriefs(analyst, { processId })).items.map((i) => i.id)).not.toContain(briefId);
    expect((await getCaseBrief(lawyer, briefId)).id).toBe(briefId);

    // A brief requested by the analyst (from the intake) only uses what the analyst can see, so it is visible to them.
    const intakeId = await insertIntake(fx.orgA, processId);
    const own = await requestCaseBrief(analyst, processId, { intakeId, inline: true });
    const detail = await getCaseBrief(analyst, own.briefId);
    expect(detail.sources.filter((s) => s.sourceType === "document_version")).toHaveLength(1);
  });

  it("external counsel sees briefs of processes of their law firm only", async () => {
    const { admin, externalCounsel } = fx.ctx;
    const firmInfo = demoInfo();
    const firmProcess = await makeLaborProcess(admin, firmInfo, { lawFirmId: fx.lawFirmA });
    await uploadDemoPack(admin, firmProcess, firmInfo, { variant: 2 });
    const otherProcess = await makeLaborProcess(admin, demoInfo(), { unitId: fx.unitSp });
    await runJobs();
    const firmBrief = await requestCaseBrief(admin, firmProcess, { inline: true });
    const otherBrief = await requestCaseBrief(admin, otherProcess, { inline: true });

    expect((await getCaseBrief(externalCounsel, firmBrief.briefId)).id).toBe(firmBrief.briefId);
    await expect(getCaseBrief(externalCounsel, otherBrief.briefId)).rejects.toBeInstanceOf(NotFoundError);
    const listed = (await listCaseBriefs(externalCounsel, { pageSize: 100 })).items.map((i) => i.id);
    expect(listed).toContain(firmBrief.briefId);
    expect(listed).not.toContain(otherBrief.briefId);
    // The counsel may review (brief:review) the firm's brief.
    await approveCaseBrief(externalCounsel, firmBrief.briefId);
  });

  it("isolates organizations", async () => {
    const { briefId, processId } = await readyBrief(3);
    const { adminB } = fx.ctx;
    await expect(getCaseBrief(adminB, briefId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requestCaseBrief(adminB, processId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listCaseBriefs(adminB, {})).total).toBe(0);
    await expect(approveCaseBrief(adminB, briefId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getBriefCitationPage(adminB, { briefId, ref: "D1", page: 1 })).rejects.toBeInstanceOf(NotFoundError);
    expect(await getLatestCaseBriefSummary(adminB, processId)).toBeNull();
  });
});

describe("review flow", () => {
  it("saves revisions with reviewer provenance, detects concurrent edits, approves and resolves the alert", async () => {
    const { briefId } = await readyBrief(0);
    const { lawyer } = fx.ctx;
    const before = await getCaseBrief(lawyer, briefId);
    const facts = before.content!.factsSummary;

    // Unchanged section: no new revision.
    const same = await saveCaseBriefSection(lawyer, briefId, { section: "factsSummary", value: facts, baseRevision: 1 });
    expect(same.changed).toBe(false);

    // Edit one item, remove the last one, add a new one (client tries to claim "extracted").
    const edited = [
      { ...facts[0], text: `${facts[0].text} (conferido)` },
      ...facts.slice(1, -1),
      { text: "Fato incluído pelo advogado.", provenance: "extracted", citations: [{ ref: "D9", page: 1, excerpt: "x" }], note: null },
    ];
    const r = await saveCaseBriefSection(lawyer, briefId, {
      section: "factsSummary",
      value: edited,
      baseRevision: 1,
      changeNote: "Ajuste dos fatos",
    });
    expect(r).toEqual({ revision: 2, changed: true });

    const after = await getCaseBrief(lawyer, briefId);
    expect(after.status).toBe("in_review");
    expect(after.currentRevision).toBe(2);
    expect(after.lastEditedByName).toBe(lawyer.name);
    const newFacts = after.content!.factsSummary;
    expect(newFacts[0].provenance).toBe("reviewer");
    expect(newFacts[1].provenance).toBe("extracted");
    const added = newFacts[newFacts.length - 1];
    expect(added.provenance).toBe("reviewer");
    expect(added.citations).toEqual([]); // D9 is not a source
    expect(after.content!.systemNotices).toEqual(before.content!.systemNotices);
    expect(after.revisions.map((x) => x.revision)).toEqual([2, 1]);
    const [original] = await fx.db.select().from(caseBriefs).where(eq(caseBriefs.id, briefId));
    expect(original.originalContent?.factsSummary).toEqual(facts);

    // Stale base revision.
    await expect(
      saveCaseBriefSection(lawyer, briefId, { section: "headline", value: "Novo resumo", baseRevision: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Full-content save validates the contract.
    await expect(saveCaseBriefRevision(lawyer, briefId, { content: { headline: 1 }, baseRevision: 2 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const full = { ...after.content!, systemNotices: undefined };
    const r3 = await saveCaseBriefRevision(lawyer, briefId, { content: { ...full, headline: "Resumo revisado" }, baseRevision: 2 });
    expect(r3.revision).toBe(3);

    await approveCaseBrief(lawyer, briefId, { note: "Conferido com os autos." });
    const approved = await getCaseBrief(lawyer, briefId);
    expect(approved.status).toBe("approved");
    expect(approved.approvedByName).toBe(lawyer.name);
    const [alert] = await fx.db.select().from(alerts).where(eq(alerts.dedupeKey, `brief_review:${briefId}`));
    expect(alert.resolvedAt).not.toBeNull();
    // Approved briefs are no longer editable.
    await expect(
      saveCaseBriefSection(lawyer, briefId, { section: "headline", value: "x", baseRevision: 3 }),
    ).rejects.toBeInstanceOf(ConflictError);
    const revisions = await fx.db.select().from(caseBriefRevisions).where(eq(caseBriefRevisions.briefId, briefId));
    expect(revisions).toHaveLength(3);
    const edits = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, briefId), eq(auditLogs.action, "case_brief.edit")));
    expect(JSON.stringify(edits)).not.toContain("conferido");
  });

  it("rejection requires a reason", async () => {
    const { briefId } = await readyBrief(2);
    await expect(rejectCaseBrief(fx.ctx.lawyer, briefId, { reason: "" })).rejects.toBeInstanceOf(ValidationError);
    await rejectCaseBrief(fx.ctx.lawyer, briefId, { reason: "Documentos de outro processo." });
    const d = await getCaseBrief(fx.ctx.lawyer, briefId);
    expect(d.status).toBe("rejected");
    expect(d.rejectionReason).toBe("Documentos de outro processo.");
  });
});

describe("applying suggestions", () => {
  it("creates deadlines pending validation only for literal dates, tasks from next steps and proposed values", async () => {
    const { briefId, processId } = await readyBrief(1);
    const { lawyer } = fx.ctx;
    const detail = await getCaseBrief(lawyer, briefId);
    const content = detail.content!;

    const dated = content.possibleDeadlines.findIndex((d) => d.date !== null);
    const undated = content.possibleDeadlines.findIndex((d) => d.date === null);
    expect(dated).toBeGreaterThanOrEqual(0);
    expect(undated).toBeGreaterThanOrEqual(0);

    const { deadlineId } = await applyBriefDeadline(lawyer, briefId, dated);
    const [deadline] = await fx.db.select().from(deadlines).where(eq(deadlines.id, deadlineId));
    expect(deadline.validationStatus).toBe("pending_validation");
    expect(deadline.origin).toBe("ai_suggested");
    expect(deadline.processId).toBe(processId);
    expect(deadline.dueDate).toBe(content.possibleDeadlines[dated].date);
    expect(deadline.description).toContain("SIMULAÇÃO");
    expect(deadline.sourceExcerpt).toBeTruthy();
    await expect(applyBriefDeadline(lawyer, briefId, dated)).rejects.toBeInstanceOf(ConflictError);
    await expect(applyBriefDeadline(lawyer, briefId, undated)).rejects.toBeInstanceOf(ValidationError);

    const { taskId } = await applyBriefNextStep(lawyer, briefId, 0);
    const [task] = await fx.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task.origin).toBe("ai_suggested");
    expect(task.processId).toBe(processId);
    expect(task.description).toContain("SIMULAÇÃO");

    const amountIndex = content.amounts.findIndex((a) => a.label.startsWith("Valor da causa segundo"));
    await proposeBriefAmount(lawyer, briefId, amountIndex);
    expect(proposeValuation).toHaveBeenCalledTimes(1);
    const [, input] = proposeValuation.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({
      processId,
      kind: "claim",
      amountCents: content.amounts[amountIndex].amountCents,
      source: "simulation",
      briefId,
      page: 4,
    });
    expect(input.confidence).toBeGreaterThanOrEqual(70);
    expect(input.confidence).toBeLessThanOrEqual(95);
    // Record-only amounts cannot be sent.
    const recordIndex = content.amounts.findIndex((a) => a.provenance === "record" || a.provenance === "missing");
    await expect(proposeBriefAmount(lawyer, briefId, recordIndex)).rejects.toBeInstanceOf(ValidationError);
    // Without contingency:write.
    await expect(proposeBriefAmount(fx.ctx.analyst, briefId, amountIndex)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("citation viewer", () => {
  it("returns the text of the cited page with the document access check", async () => {
    const { briefId } = await readyBrief(0);
    const page = await getBriefCitationPage(fx.ctx.lawyer, { briefId, ref: "D1", page: 4 });
    expect(page.page).toBe(4);
    expect(page.text).toContain("DOS PEDIDOS");
    expect(page.text).not.toContain("DOS FATOS");
    await expect(getBriefCitationPage(fx.ctx.lawyer, { briefId, ref: "D1", page: 99 })).rejects.toBeInstanceOf(ValidationError);
    await expect(getBriefCitationPage(fx.ctx.lawyer, { briefId, ref: "D42", page: 1 })).rejects.toBeInstanceOf(NotFoundError);
    const sources = await fx.db.select().from(caseBriefSources).where(eq(caseBriefSources.briefId, briefId));
    expect(sources.some((s) => s.contentHash === "pending")).toBe(false);
  });
});
