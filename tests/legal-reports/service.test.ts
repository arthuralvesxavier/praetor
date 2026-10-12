import { and, count, eq, sql } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAP_MARKER, type LegalReportDraft, type ReportItemDraft } from "@/domain/legal-reports";
import { todayISO } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { getPositionAt } from "@/modules/contingency/service";
import { getDocumentVersionPageText, uploadDocument } from "@/modules/documents/service";
import { ENGINE_SAMPLE_GENERATOR, quotableSentences } from "@/modules/legal-reports/sample";
import { addProcessScenario } from "@/modules/legal-reports/scenarios";
import {
  approveLegalReport,
  generateEngineSample,
  getLegalReport,
  issueLegalReport,
  listLegalReports,
  openLegalReportPdf,
  regenerateLegalReport,
} from "@/modules/legal-reports/service";
import { updateLegalReportSettings } from "@/modules/legal-reports/settings-service";
import type { AuthContext } from "@/server/auth/context";
import {
  auditLogs,
  documentVersions,
  legalProcesses,
  legalReportItems,
  legalReportSequences,
  legalReports,
  processScenarios,
} from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { demoInfo, makeLaborProcess, uploadDemoPack } from "../briefs/helpers";
import { makeProcess, runJobs, setupFixture, type Fixture } from "../helpers/fixtures";
import { fontDictionaries, pageTexts } from "./pdf-inspect";

let fx: Fixture;
let processId: string;
let processNumber: string;
let manager: AuthContext;
let lawyer: AuthContext;
let docs: { documentId: string; versionId: string; title: string }[];
let sensitiveDoc: { documentId: string; versionId: string };

async function textPdf(pages: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdf.addPage([595, 842]);
    page.drawText(text, { x: 50, y: 780, size: 11, font });
  }
  return pdf.save();
}

async function versionSha(versionId: string): Promise<string> {
  const [v] = await fx.db.select({ sha: documentVersions.sha256 }).from(documentVersions).where(eq(documentVersions.id, versionId));
  return v.sha;
}

async function sentenceOf(ctx: AuthContext, doc: { documentId: string; versionId: string }, page: number): Promise<string> {
  const p = await getDocumentVersionPageText(ctx, doc.documentId, doc.versionId, page);
  const s = quotableSentences(p.text)[0];
  if (!s) throw new Error("sem frase citável");
  return s;
}

function baseDraft(items: ReportItemDraft[], overrides: Partial<LegalReportDraft> = {}): LegalReportDraft {
  return {
    type: "process_report",
    title: "Relatório de teste do serviço",
    subtitle: null,
    scope: { processId },
    scopeLabel: "Processo de teste",
    baseDate: "2026-10-12",
    isSample: false,
    generator: "test",
    generatorVersion: 1,
    sections: [{ key: "s1", title: "Seção de teste" }],
    methodology: ["Teste."],
    items,
    ...overrides,
  };
}

const recordItem = (key: string): ReportItemDraft => ({
  key,
  section: "s1",
  content: `Tribunal: TRT10 (${key}).`,
  origin: "record",
  recordSource: {
    table: "legal_processes",
    field: "court",
    recordId: null,
    label: "Cadastro do processo, campo Tribunal",
    recordedAt: "2026-10-01T12:00:00.000Z",
  },
});

beforeAll(async () => {
  fx = await setupFixture("legalrep");
  manager = fx.ctx.manager;
  lawyer = fx.ctx.lawyer;
  const info = demoInfo();
  processId = await makeLaborProcess(manager, info, { unitId: fx.unitSp, responsibleId: lawyer.userId });
  processNumber = info.number;
  docs = await uploadDemoPack(manager, processId, info, { variant: 0, only: [0, 1] });
  const sensitive = await uploadDocument(manager, {
    title: "Atestado médico (fictício)",
    category: "sensitive_health",
    processId,
    file: {
      name: "atestado.pdf",
      bytes: await textPdf([
        "Atestado medico ficticio emitido para o teste do relatorio juridico do motor de PDF.",
        "Segunda pagina do atestado ficticio usada somente em testes automatizados.",
      ]),
    },
  });
  sensitiveDoc = sensitive;
  await runJobs();
  await addProcessScenario(manager, processId, {
    description: "Condenação parcial nas horas extras (cenário de teste).",
    probabilityBand: "moderate",
  });
}, 240_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("documento de teste do motor", () => {
  let reportId: string;

  it("gera relatório pendente de revisão com itens de todas as origens, lacuna e pendências", async () => {
    const r = await generateEngineSample(manager, { processId });
    reportId = r.id;
    // Documento de teste: série própria, sem consumir a numeração oficial do R1.
    expect(r.reference).toMatch(/^TESTE-R1-\d{4}-0001$/);
    expect(r.version).toBe(1);
    const { view, permissions } = await getLegalReport(manager, r.id);
    expect(view.status).toBe("pending_review");
    expect(view.isSample).toBe(true);
    expect(permissions.canApprove).toBe(true);
    const all = [...view.sections.flatMap((s) => s.items), ...view.pendingItems];
    const origins = new Set(all.map((i) => i.origin));
    for (const o of ["documented", "record", "inference", "analysis", "gap"]) expect(origins.has(o as never)).toBe(true);
    const gap = all.find((i) => i.origin === "gap");
    expect(gap?.displayText).toContain(GAP_MARKER);
    // Controles: trecho ausente da página (Não confirmado) e confiança 50 (abaixo do limite 70).
    expect(view.pendingItems.some((i) => i.origin === "documented" && i.pendingReason?.startsWith("Fonte não confirmada"))).toBe(true);
    expect(view.pendingItems.some((i) => i.pendingReason?.includes("Confiança 50 abaixo do limite de 70"))).toBe(true);
    expect(view.sources.some((s) => !s.confirmed && s.notConfirmedReason?.startsWith("Trecho não encontrado"))).toBe(true);
    expect(view.sources.some((s) => s.confirmed && s.reference.startsWith("D"))).toBe(true);
    // Tabela longa de teste com totais separados (causa e apurado nunca somados).
    const table = all.find((i) => i.data?.kind === "table" && i.section === "pagination");
    expect(table?.data?.columns.map((c) => c.header)).toEqual(
      expect.arrayContaining(["Valor da causa", "Valor apurado"]),
    );
  });

  it("o PDF armazenado tem fontes embutidas, marca d'água em todas as páginas e confere com o hash; download auditado", async () => {
    const file = await openLegalReportPdf(manager, reportId);
    const { view } = await getLegalReport(manager, reportId);
    expect(file.sha256).toBe(view.pdfSha256);
    expect(file.fileName).toBe(`${view.reference}-v1.pdf`);
    const pages = await pageTexts(file.bytes);
    expect(pages.length).toBeGreaterThanOrEqual(4);
    for (const [i, text] of pages.entries()) {
      expect(text).toContain("PENDENTE DE REVISÃO");
      expect(text).toContain(`Página ${i + 1} de ${pages.length}`);
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
    const joined = pages.join(" ");
    expect(joined).toContain(GAP_MARKER);
    expect(joined).toContain("Pendências do relatório");
    expect(joined).toContain("Não confirmado");
    const fonts = await fontDictionaries(file.bytes);
    expect(fonts.every((f) => f.embedded)).toBe(true);
    const [audits] = await fx.db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, reportId), eq(auditLogs.action, "legal_report.download")));
    expect(audits.n).toBe(1);
    const [gen] = await fx.db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, reportId), eq(auditLogs.action, "legal_report.generate")));
    expect(gen.n).toBe(1);
  });

  it("o documento de teste só aparece para quem gerou e para quem vê toda a carteira", async () => {
    await expect(getLegalReport(lawyer, reportId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLegalReport(fx.ctx.executive, reportId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLegalReport(fx.ctx.admin, reportId)).resolves.toBeTruthy();
    // Número informado sem pontuação também localiza o processo (só entre os visíveis).
    await expect(generateEngineSample(fx.ctx.lawyerRe, { processNumber: processNumber.replace(/[^0-9]/g, "") })).rejects.toBeInstanceOf(ValidationError);
    const mine = await generateEngineSample(lawyer, { processNumber: processNumber.replace(/[^0-9]/g, "") });
    await expect(getLegalReport(lawyer, mine.id)).resolves.toBeTruthy();
    await expect(getLegalReport(fx.ctx.executive, mine.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("aprovação: só os papéis do tipo; depois disso o relatório é imutável", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const plain = await issueLegalReport(manager, baseDraft([recordItem("ap")]), { settings });
    // Os documentos de teste gerados antes não consumiram a numeração oficial do R1.
    expect(plain.reference).toMatch(/^R1-\d{4}-0001$/);
    const id = plain.id;
    await expect(approveLegalReport(fx.ctx.executive, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveLegalReport(fx.ctx.accountant, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveLegalReport(fx.ctx.lawyerRe, id)).rejects.toBeInstanceOf(NotFoundError);
    const before = await getLegalReport(lawyer, id);
    expect(before.permissions.canApprove).toBe(true); // advogado responsável pelo processo (R1)
    await approveLegalReport(lawyer, id);
    const { view } = await getLegalReport(manager, id);
    expect(view.status).toBe("approved");
    expect(view.approvedByName).toBe(lawyer.name);
    expect(view.pdfSha256).not.toBe(before.view.pdfSha256);
    const pages = await pageTexts((await openLegalReportPdf(manager, id)).bytes);
    for (const text of pages) expect(text).not.toContain("PENDENTE DE REVISÃO");
    expect(pages[0]).toContain("APROVADO");
    expect(pages[0]).toContain(lawyer.name);

    await expect(approveLegalReport(manager, id)).rejects.toBeInstanceOf(ConflictError);
    // O banco recusa qualquer alteração de conteúdo, itens ou exclusão.
    await expect(fx.db.execute(sql`update legal_reports set title = 'alterado' where id = ${id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`update legal_reports set status = 'pending_review' where id = ${id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`update legal_reports set pdf_sha256 = 'x' where id = ${id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`update legal_report_items set content = 'x' where report_id = ${id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`delete from legal_reports where id = ${id}`)).rejects.toThrow();
    const [row] = await fx.db.select({ title: legalReports.title }).from(legalReports).where(eq(legalReports.id, id));
    expect(row.title).not.toBe("alterado");
    // Conteúdo de relatório ainda pendente também não muda (só a situação e o PDF).
    await expect(fx.db.execute(sql`update legal_reports set title = 'alterado' where id = ${reportId}`)).rejects.toThrow();
  });

  it("nova versão: mesma referência, versão 2; a anterior fica substituída com PDF e hash preservados", async () => {
    await approveLegalReport(manager, reportId);
    const old = await getLegalReport(manager, reportId);
    const next = await regenerateLegalReport(manager, reportId);
    expect(next.reference).toBe(old.view.reference);
    expect(next.version).toBe(2);
    const after = await getLegalReport(manager, reportId);
    expect(after.view.status).toBe("superseded");
    expect(after.view.pdfSha256).toBe(old.view.pdfSha256);
    expect(after.view.approvedByName).toBe(manager.name);
    expect(after.view.supersededById).toBe(next.id);
    const preserved = await openLegalReportPdf(manager, reportId);
    expect(preserved.sha256).toBe(old.view.pdfSha256);
    await expect(regenerateLegalReport(manager, reportId)).rejects.toBeInstanceOf(ConflictError);
    await expect(approveLegalReport(manager, reportId)).rejects.toBeInstanceOf(ConflictError);
    const fresh = await getLegalReport(manager, next.id);
    expect(fresh.view.status).toBe("pending_review");
    expect(fresh.versions.map((v) => v.version)).toEqual([2, 1]);
  });
});

describe("emissão", () => {
  it("item sem origem bloqueia a emissão: nada é gravado e o número não é consumido", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const before = await fx.db.select({ n: count() }).from(legalReports);
    const draft = baseDraft([recordItem("a"), { key: "b", section: "s1", content: "Afirmação sem origem." }], {
      type: "responsibility_report",
      scope: {},
    });
    await expect(issueLegalReport(manager, draft, { settings })).rejects.toBeInstanceOf(ValidationError);
    const after = await fx.db.select({ n: count() }).from(legalReports);
    expect(after[0].n).toBe(before[0].n);
    const seq = await fx.db
      .select()
      .from(legalReportSequences)
      .where(and(eq(legalReportSequences.organizationId, fx.orgA), eq(legalReportSequences.type, "responsibility_report")));
    expect(seq).toHaveLength(0);
    const ok = await issueLegalReport(manager, baseDraft([recordItem("a")], { type: "responsibility_report", scope: {} }), { settings });
    expect(ok.reference).toMatch(/^R4-\d{4}-0001$/);
  });

  it("referências sequenciais por ano e tipo, sem repetição sob concorrência", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        issueLegalReport(manager, baseDraft([recordItem(`c${i}`)], { type: "portfolio_report", scope: {} }), { settings }),
      ),
    );
    const refs = results.map((r) => r.reference).sort();
    expect(new Set(refs).size).toBe(6);
    const year = refs[0].slice(3, 7);
    expect(refs).toEqual([1, 2, 3, 4, 5, 6].map((n) => `R3-${year}-000${n}`));
    // Outra organização tem a própria sequência.
    const b = await loadOrganization(fx.orgB);
    const other = await issueLegalReport(fx.ctx.adminB, baseDraft([recordItem("b")], { type: "portfolio_report", scope: {} }), {
      settings: b.settings,
    });
    expect(other.reference).toBe(`R3-${year}-0001`);
  });

  it("fonte não confirmada nunca é base: item e inferência derivada vão para pendências", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const doc = docs[0];
    const sentence = await sentenceOf(manager, doc, 1);
    const sha = await versionSha(doc.versionId);
    const draft = baseDraft([
      { key: "ok", section: "s1", content: "Trecho confirmado.", origin: "documented", documentId: doc.documentId, documentVersionId: doc.versionId, page: 1, excerpt: sentence, documentSha256: sha },
      { key: "bad", section: "s1", content: "Trecho em página errada.", origin: "documented", documentId: doc.documentId, documentVersionId: doc.versionId, page: 2, excerpt: "Frase que não existe em nenhuma página deste documento de teste.", documentSha256: sha },
      { key: "hash", section: "s1", content: "Hash divergente.", origin: "documented", documentId: doc.documentId, documentVersionId: doc.versionId, page: 1, excerpt: sentence, documentSha256: "0".repeat(64) },
      { key: "page", section: "s1", content: "Página inexistente.", origin: "documented", documentId: doc.documentId, documentVersionId: doc.versionId, page: 999, excerpt: sentence, documentSha256: sha },
      { key: "inf", section: "s1", content: "Conclusão a partir do trecho errado.", origin: "inference", derivedFrom: ["bad"] },
      { key: "inf-ok", section: "s1", content: "Conclusão a partir do trecho confirmado.", origin: "inference", derivedFrom: ["ok"] },
    ]);
    const r = await issueLegalReport(manager, draft, { settings });
    const { view } = await getLegalReport(manager, r.id);
    const stated = view.sections[0].items.map((i) => i.content);
    expect(stated).toEqual(["Trecho confirmado.", "Conclusão a partir do trecho confirmado."]);
    const pending = new Map(view.pendingItems.map((i) => [i.content, i.pendingReason]));
    expect(pending.get("Trecho em página errada.")).toMatch(/Trecho não encontrado na página 2/);
    expect(pending.get("Hash divergente.")).toMatch(/hash diferente/);
    expect(pending.get("Página inexistente.")).toMatch(/Página 999 inexistente/);
    expect(pending.get("Conclusão a partir do trecho errado.")).toMatch(/Baseada em item não afirmado/);
    expect(view.sources.filter((s) => !s.confirmed)).toHaveLength(3);
    expect(view.sources.filter((s) => s.confirmed && s.reference.startsWith("D"))).toHaveLength(1);
  });

  it("documento sensível é só referenciado (sem trecho gravado) e o relatório some para quem não vê o documento", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const page = await getDocumentVersionPageText(manager, sensitiveDoc.documentId, sensitiveDoc.versionId, 1);
    const excerpt = page.text.replace(/\s+/g, " ").trim().slice(0, 60);
    const r = await issueLegalReport(
      manager,
      baseDraft([
        {
          key: "s",
          section: "s1",
          content: "Há atestado médico vinculado ao processo.",
          origin: "documented",
          documentId: sensitiveDoc.documentId,
          documentVersionId: sensitiveDoc.versionId,
          page: 1,
          excerpt,
          documentSha256: await versionSha(sensitiveDoc.versionId),
        },
      ]),
      { settings },
    );
    const [item] = await fx.db.select().from(legalReportItems).where(eq(legalReportItems.reportId, r.id));
    expect(item.excerpt).toBeNull();
    expect(item.pendingReason).toBeNull();
    const { view } = await getLegalReport(manager, r.id);
    expect(view.sources[0].sensitive).toBe(true);
    expect(view.sources[0].confirmed).toBe(true);
    const pdfText = (await pageTexts((await openLegalReportPdf(manager, r.id)).bytes)).join(" ");
    expect(pdfText).toContain("Documento sensível: apenas referenciado");
    expect(pdfText).not.toContain(excerpt.slice(0, 30));
    // Diretoria vê a carteira não sigilosa, mas não o documento de saúde: não vê o relatório.
    await expect(getLegalReport(fx.ctx.executive, r.id)).rejects.toBeInstanceOf(NotFoundError);
    const list = await listLegalReports(fx.ctx.executive, { pageSize: 100 });
    expect(list.items.some((i) => i.id === r.id)).toBe(false);
    // O advogado responsável vê (regra 12).
    await expect(getLegalReport(lawyer, r.id)).resolves.toBeTruthy();
  });

  it("documentado sem hash ou cadastro sem data bloqueiam a emissão (nada gravado)", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const doc = docs[0];
    const sentence = await sentenceOf(manager, doc, 1);
    const before = await fx.db.select({ n: count() }).from(legalReports);
    const noHash = baseDraft([
      { key: "d", section: "s1", content: "Sem hash.", origin: "documented", documentId: doc.documentId, documentVersionId: doc.versionId, page: 1, excerpt: sentence },
    ]);
    await expect(issueLegalReport(manager, noHash, { settings })).rejects.toThrow(/hash/);
    const noDate = baseDraft([
      {
        key: "r",
        section: "s1",
        content: "Tribunal: TRT10.",
        origin: "record",
        recordSource: { table: "legal_processes", field: "court", recordId: null, label: "Cadastro", recordedAt: null },
      },
    ]);
    await expect(issueLegalReport(manager, noDate, { settings })).rejects.toBeInstanceOf(ValidationError);
    const after = await fx.db.select({ n: count() }).from(legalReports);
    expect(after[0].n).toBe(before[0].n);
  });

  it("isolamento: outra organização não vê nem baixa o relatório", async () => {
    const list = await listLegalReports(manager, { pageSize: 100 });
    const id = list.items[0].id;
    await expect(getLegalReport(fx.ctx.adminB, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openLegalReportPdf(fx.ctx.adminB, id)).rejects.toBeInstanceOf(NotFoundError);
    // Escritório externo: só relatórios de processos do próprio escritório (nenhum aqui).
    expect((await listLegalReports(fx.ctx.externalCounsel)).items).toEqual([]);
    await expect(getLegalReport(fx.ctx.externalCounsel, id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("geração: perfis de leitura não geram nem substituem versões", () => {
  it("diretoria, auditoria e analista não geram documento de teste nem relatório (nenhum número consumido)", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const before = await fx.db.select().from(legalReportSequences).where(eq(legalReportSequences.organizationId, fx.orgA));
    for (const ctx of [fx.ctx.auditor, fx.ctx.executive, fx.ctx.analyst]) {
      await expect(generateEngineSample(ctx, { processId })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(issueLegalReport(ctx, baseDraft([recordItem("ro")]), { settings })).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Contabilidade gera R2, mas não R1 nem R3.
    await expect(issueLegalReport(fx.ctx.accountant, baseDraft([recordItem("acc")]), { settings })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      issueLegalReport(fx.ctx.accountant, baseDraft([recordItem("acc3")], { type: "portfolio_report", scope: {} }), { settings }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const after = await fx.db.select().from(legalReportSequences).where(eq(legalReportSequences.organizationId, fx.orgA));
    expect(after).toEqual(before);
  });

  it("a auditoria não substitui a versão aprovada (que continua vigente); o gestor pode", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const r = await issueLegalReport(manager, baseDraft([recordItem("sup")], { generator: ENGINE_SAMPLE_GENERATOR }), { settings });
    await approveLegalReport(manager, r.id);
    for (const ctx of [fx.ctx.auditor, fx.ctx.executive]) {
      const seen = await getLegalReport(ctx, r.id);
      expect(seen.permissions.canRegenerate).toBe(false);
      await expect(regenerateLegalReport(ctx, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const [row] = await fx.db.select({ status: legalReports.status }).from(legalReports).where(eq(legalReports.id, r.id));
    expect(row.status).toBe("approved");
    const asManager = await getLegalReport(manager, r.id);
    expect(asManager.permissions.canRegenerate).toBe(true);
  });
});

describe("documento de teste: valores iguais à posição do sistema e fontes datadas", () => {
  it("valor apurado só no cadastro (sem histórico) aparece como na posição; toda fonte de cadastro tem data; a lista da carteira aponta para a lista", async () => {
    const pid = await makeProcess(manager, { unitId: fx.unitSp, responsibleId: lawyer.userId, claimAmountCents: 5_000_000 });
    await fx.db.update(legalProcesses).set({ liquidatedAmountCents: 1_234_567 }).where(eq(legalProcesses.id, pid));
    const position = await getPositionAt(manager, pid, todayISO());
    expect(position.liquidatedCents).toBe(1_234_567);

    const r = await generateEngineSample(manager, { processId: pid });
    const { view } = await getLegalReport(manager, r.id);
    const all = [...view.sections.flatMap((s) => s.items), ...view.pendingItems];
    const liquidated = all.find((i) => i.section === "values" && i.content.startsWith("Valor apurado (liquidado) vigente"));
    expect(liquidated?.origin).toBe("record");
    expect(liquidated?.content).toMatch(/12\.345,67/);
    expect(liquidated?.recordSource?.field).toBe("liquidated_amount_cents");
    const exposure = all.find((i) => i.section === "values" && i.content.startsWith("Exposição líquida"));
    expect(exposure?.content).toMatch(/^Exposição líquida calculada: .*12\.345,67/);
    expect(exposure?.pendingReason).toBeNull();

    for (const item of all.filter((i) => i.origin === "record" || i.origin === "analysis")) {
      expect(item.recordSource?.recordedAt, item.content).toBeTruthy();
    }
    const portfolio = view.sources.find((s) => s.source.includes("Cadastro dos processos visíveis ao perfil"));
    expect(portfolio?.url).toBe("/processos");
    const text = (await pageTexts((await openLegalReportPdf(manager, r.id)).bytes)).join(" ");
    expect(text).not.toContain("não guardada pelo cadastro");
    expect(text).toContain("registro mais recente de");
  });
});

describe("cenários e parâmetros", () => {
  it("cenário: percentual dentro da faixa e registros somente de inclusão", async () => {
    await expect(
      addProcessScenario(manager, processId, { description: "Fora da faixa", probabilityBand: "high", percentMin: 10, percentMax: 20 }),
    ).rejects.toBeInstanceOf(ValidationError);
    const { id } = await addProcessScenario(manager, processId, {
      description: "Improcedência total (teste)",
      probabilityBand: "low",
      percentMin: 25,
      percentMax: 35,
    });
    const [row] = await fx.db.select().from(processScenarios).where(eq(processScenarios.id, id));
    expect(row.origin).toBe("manual");
    expect(row.authorId).toBe(manager.userId);
    await expect(fx.db.execute(sql`update process_scenarios set percent_max = 40 where id = ${id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`delete from process_scenarios where id = ${id}`)).rejects.toThrow();
  });

  it("parâmetros: faixas sobrepostas são recusadas; os salvos entram no próximo relatório", async () => {
    const bands = {
      very_high: { min: 85, max: 100 },
      high: { min: 65, max: 85 },
      moderate: { min: 40, max: 65 },
      low: { min: 15, max: 40 },
      very_low: { min: 0, max: 15 },
    };
    await expect(
      updateLegalReportSettings(fx.ctx.admin, {
        confidenceThreshold: 70,
        bands: { ...bands, high: { min: 60, max: 90 } },
        legalBasisText: "Base legal de teste com tamanho suficiente",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateLegalReportSettings(manager, { confidenceThreshold: 70, bands, legalBasisText: "Base legal de teste" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await updateLegalReportSettings(fx.ctx.admin, { confidenceThreshold: 80, bands, legalBasisText: "Base legal de teste \u2014 revisada" });
    const { settings } = await loadOrganization(fx.orgA);
    expect(settings.legalReports.legalBasisText).toBe("Base legal de teste, revisada");
    const r = await issueLegalReport(manager, baseDraft([recordItem("p")], { type: "portfolio_report", scope: {} }), { settings });
    const { view } = await getLegalReport(manager, r.id);
    expect(view.parameters.confidenceThreshold).toBe(80);
    expect(view.parameters.bands.very_high.min).toBe(85);
  });
});
