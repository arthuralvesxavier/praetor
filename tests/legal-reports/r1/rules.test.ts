/**
 * R1 (Relatório de Processo): regras do produto que bloqueiam ou protegem a emissão.
 * (1) item sem origem bloqueia a emissão; (2) lacuna é "[DADO NÃO LOCALIZADO]", nunca
 * zero nem vazio (texto do PDF via unpdf); (3) valor da causa e valor apurado nunca são
 * somados; (4) R1 aprovado não muda: só é substituído por nova versão, com PDF e hash
 * da anterior preservados.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIMULATED_RECORD_AMOUNT_LABELS, SIMULATED_RECORD_GAP_TEXTS, type StoredCaseBrief } from "@/domain/case-brief";
import { isValidCnj, normalizeCnj } from "@/domain/cnj";
import { GAP_MARKER, totalOf } from "@/domain/legal-reports";
import { formatMoneyCents, todayISO } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { requestCaseBrief, saveCaseBriefSection } from "@/modules/briefs/service";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import {
  buildProcessReportDraft,
  PROCESS_REPORT_SECTIONS,
  RISK_OPINION_FULL_TEXT_AT,
  RISK_OPINION_MAX_CHARS,
  recordTopicOf,
  riskOpinionText,
} from "@/modules/legal-reports/process-report";
import {
  approveLegalReport,
  generateProcessReport,
  getLegalReport,
  issueLegalReport,
  openLegalReportPdf,
} from "@/modules/legal-reports/service";
import { validateDraft } from "@/modules/legal-reports/validation";
import { gapEntries, type ItemView, type ReportView } from "@/modules/legal-reports/view";
import {
  caseBriefs,
  legalProcesses,
  legalReportSequences,
  legalReports,
  processInstances,
  processRiskAssessments,
} from "@/server/db/schema";
import { buildSimulatedCaseBrief } from "@/server/integrations/ai/case-brief/simulated";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { makeProcess, runJobs, setupFixture, type Fixture } from "../../helpers/fixtures";
import { pageTexts } from "../pdf-inspect";
import { buildR1World, officialValue, type R1World } from "./world";

let fx: Fixture;
let world: R1World;

beforeAll(async () => {
  fx = await setupFixture("r1rules");
  world = await buildR1World(fx);
}, 600_000);

afterAll(async () => {
  await fx?.teardown();
});

/** "85.432,10" (só os algarismos do valor: o símbolo pode vir com espaço inseparável). */
function digits(cents: number): string {
  return formatMoneyCents(cents, "").replace(/[^\d.,]/g, "");
}

function allItems(v: ReportView): ItemView[] {
  return [...v.sections.flatMap((s) => s.items), ...v.pendingItems];
}

async function generatedView(processId: string): Promise<ReportView> {
  const r = await generateProcessReport(fx.ctx.manager, { processId });
  return (await getLegalReport(fx.ctx.manager, r.id)).view;
}

async function reportCount(): Promise<number> {
  const [r] = await fx.db.select({ n: count() }).from(legalReports).where(eq(legalReports.organizationId, fx.orgA));
  return Number(r.n);
}

describe("R1: item sem origem bloqueia a emissão", () => {
  it("o rascunho real do R1 com um item sem origem não é emitido: nada gravado, número não consumido", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const draft = await buildProcessReportDraft(fx.ctx.manager, { processId: world.processId }, settings);
    expect(validateDraft(draft)).toEqual([]);
    // Todo item do rascunho tem origem declarada.
    expect(draft.items.every((i) => !!i.origin)).toBe(true);
    const before = await reportCount();
    const broken = { ...draft, items: draft.items.map((i, n) => (n === 3 ? { ...i, origin: undefined } : i)) };
    const issues = validateDraft(broken);
    expect(issues.map((i) => i.code)).toContain("missing_origin");
    await expect(issueLegalReport(fx.ctx.manager, broken, { settings })).rejects.toBeInstanceOf(ValidationError);
    await expect(issueLegalReport(fx.ctx.manager, broken, { settings })).rejects.toThrow(/sem origem/);
    expect(await reportCount()).toBe(before);
    const seq = await fx.db
      .select()
      .from(legalReportSequences)
      .where(and(eq(legalReportSequences.organizationId, fx.orgA), eq(legalReportSequences.type, "process_report")));
    expect(seq).toHaveLength(0);
  }, 120_000);
});

describe("R1: lacuna nunca vira zero nem vazio", () => {
  it("processo sem pedidos, sem valores, sem partes: lacunas literais no relatório e no PDF", async () => {
    const bare = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId });
    const r = await generateProcessReport(fx.ctx.manager, { processId: bare });
    const { view } = await getLegalReport(fx.ctx.manager, r.id);
    expect(view.parameters.layout).toBe("process_report");
    expect(view.sections.map((s) => s.title)).toEqual(PROCESS_REPORT_SECTIONS.map((s) => s.title));
    const all = [...view.sections.flatMap((s) => s.items), ...view.pendingItems];
    const gaps = all.filter((i) => i.origin === "gap");
    expect(gaps.length).toBeGreaterThanOrEqual(5);
    for (const g of gaps) {
      expect(g.content.trim().length).toBeGreaterThan(0);
      expect(g.displayText).toContain(GAP_MARKER);
      expect(g.data).toBeNull();
    }
    const labels = gaps.map((g) => g.displayText);
    expect(labels).toContain(`Quadro de pedidos do processo (nenhum pedido confirmado): ${GAP_MARKER}`);
    expect(labels).toContain(`Valor apurado vigente: ${GAP_MARKER}`);
    expect(labels).toContain(`Valor da causa: ${GAP_MARKER}`);
    expect(labels).toContain(`Partes do processo: ${GAP_MARKER}`);

    const text = (await pageTexts((await openLegalReportPdf(fx.ctx.manager, r.id)).bytes)).join(" ");
    expect(text).toContain(`Valor apurado vigente: ${GAP_MARKER}`);
    expect(text).toContain(`Quadro de pedidos do processo (nenhum pedido confirmado): ${GAP_MARKER}`);
    expect(text).toContain(`valor apurado ${GAP_MARKER}`);
    // Um valor ausente nunca aparece como zero.
    expect(text).not.toContain("R$ 0,00");
    expect(text).toContain("Exposição líquida: não calculada");
    // A lista de dados não localizados das pendências repete cada lacuna.
    expect(text).toContain("DADOS NÃO LOCALIZADOS");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  }, 120_000);
});

describe("R1: tribunal e vara / órgão julgador", () => {
  it("tribunal conhecido e vara ausente: o R1 marca a lacuna da vara; só então a lacuna da análise sobre o cadastro conta como repetida", async () => {
    // Sem instâncias registradas: tribunal TJSP no cadastro, sem vara.
    const pid = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 1_500_000 });
    const { briefId } = await requestCaseBrief(fx.ctx.lawyer, pid, { inline: true });
    await runJobs();
    // Entre as lacunas da análise que citam o cadastro (REG), ficam só a da vara e uma sobre dado que o R1 não lê.
    const [b] = await fx.db.select({ content: caseBriefs.content }).from(caseBriefs).where(eq(caseBriefs.id, briefId));
    const content = b.content as StoredCaseBrief;
    const division = content.identification.find((f) => f.key === "court_division");
    expect(division?.provenance).toBe("missing");
    expect(division?.citations.some((c) => c.ref === "REG")).toBe(true);
    const sections = content as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(sections)) {
      if (!Array.isArray(value)) continue;
      sections[key] = (value as { key?: string; provenance?: string; citations?: { ref: string }[] }[]).filter(
        (it) => !(it.provenance === "missing" && it.citations?.some((c) => c.ref === "REG")) || it.key === "court_division",
      );
    }
    content.gaps.push({
      text: "Telefone do preposto não informado no cadastro (teste).",
      provenance: "missing",
      citations: [{ ref: "REG", page: null, excerpt: null }],
      note: null,
    });
    await fx.db.update(caseBriefs).set({ content }).where(eq(caseBriefs.id, briefId));

    const first = await generatedView(pid);
    const gaps = allItems(first).filter((i) => i.origin === "gap");
    const cover = first.sections.find((s) => s.key === "identification")!;
    expect(cover.items.some((i) => i.content.startsWith("Autos:") && i.content.includes("TJSP"))).toBe(true);
    // Lacuna própria do R1 na capa (o tribunal consta; só a vara falta), listada nas pendências.
    expect(gaps.find((g) => g.content === "Vara / órgão julgador")?.section).toBe("identification");
    expect(gaps.some((g) => g.content === "Tribunal" || g.content === "Tribunal e órgão julgador")).toBe(false);
    expect(gapEntries(first).map((e) => e.text)).toContain(`Vara / órgão julgador: ${GAP_MARKER}`);
    // A síntese repete o marcador da vara que falta, ligado à lacuna da capa.
    const instancePoint = first.sections.find((s) => s.key === "synthesis")!.items[0];
    expect(instancePoint.content).toMatch(/^Fase e instância: .*\(TJSP, vara \/ órgão julgador \[DADO NÃO LOCALIZADO\]\)\.$/);
    expect(instancePoint.pendingReason).toBeNull();
    // A lacuna da vara apontada pela análise não é repetida (o R1 marca a dele); a que não corresponde a dado lido pelo R1 entra.
    expect(gaps.some((g) => g.content.startsWith("Identificação: Vara"))).toBe(false);
    expect(gaps.map((g) => g.content)).toContain("Telefone do preposto não informado no cadastro (teste) (apontado pela análise preliminar v1, simulação)");
    const methodology = first.parameters.methodology.join(" ");
    expect(methodology).toContain(
      "1 lacuna sobre o cadastro não é repetida, porque este relatório lê o cadastro na data-base e marca o mesmo dado como não localizado no item dele",
    );
    expect(methodology).not.toContain("não se aplica mais");

    // Vara registrada depois da análise: o R1 não tem mais a lacuna, e a da análise não conta como repetida (não se aplica mais).
    await fx.db.update(legalProcesses).set({ courtDivision: "2ª Vara Cível (teste)" }).where(eq(legalProcesses.id, pid));
    const second = await generatedView(pid);
    expect(allItems(second).some((i) => i.origin === "gap" && i.content.startsWith("Vara"))).toBe(false);
    expect(second.sections[0].items.some((i) => i.content.includes("TJSP, 2ª Vara Cível (teste)"))).toBe(true);
    expect(second.sections.find((s) => s.key === "synthesis")!.items[0].content).toContain("(TJSP, 2ª Vara Cível (teste)).");
    const methodology2 = second.parameters.methodology.join(" ");
    expect(methodology2).toContain("1 lacuna sobre o cadastro não se aplica mais, porque o dado consta da base na data-base");
    expect(methodology2).not.toContain("não é repetida");
  }, 180_000);

  it("instâncias registradas: tribunal e vara em colunas separadas; a vara que falta numa instância é lacuna própria", async () => {
    const pid = await makeProcess(fx.ctx.manager, {
      unitId: fx.unitSp,
      responsibleId: fx.ctx.lawyer.userId,
      instance: "second",
      courtDivision: "3ª Câmara de Direito Privado (teste)",
    });
    await fx.db.insert(processInstances).values({
      organizationId: fx.orgA,
      processId: pid,
      instance: "first",
      court: "TJSP",
      processClass: "Procedimento comum",
      phase: "knowledge",
      isCurrent: false,
      origin: "imported",
    });
    const view = await generatedView(pid);
    const table = view.sections[0].items.find((i) => i.data?.kind === "table" && i.data.columns[0].header === "Instância");
    const headers = table?.data?.kind === "table" ? table.data.columns.map((c) => c.header) : [];
    expect(headers).toEqual(["Instância", "Tribunal", "Vara / órgão julgador", "Cidade/UF", "Classe", "Situação"]);
    const entries = gapEntries(view).map((e) => e.text);
    expect(entries).toContain(`Vara / órgão julgador (1º grau): ${GAP_MARKER}`);
    expect(entries).not.toContain(`Vara / órgão julgador (2º grau): ${GAP_MARKER}`);
    expect(entries.some((t) => t.startsWith("Tribunal ("))).toBe(false);
    // A síntese usa a instância atual (com a vara registrada).
    expect(view.sections.find((s) => s.key === "synthesis")!.items[0].content).toContain(
      "instância atual 2º grau (TJSP, 3ª Câmara de Direito Privado (teste))",
    );
  }, 120_000);
});

describe("R1: lacunas da análise preliminar sobre o cadastro (REG)", () => {
  /** Número no padrão CNJ com dígito verificador que não confere. */
  function invalidCnjNumber(sequence: number): string {
    for (let d = 0; d < 100; d += 1) {
      const n = `${String(sequence).padStart(7, "0")}-${String(d).padStart(2, "0")}.2026.8.26.0100`;
      if (normalizeCnj(n) && !isValidCnj(n)) return n;
    }
    throw new Error("sem número inválido");
  }
  const REG = [{ ref: "REG", page: null, excerpt: null }];
  /** Quantas lacunas da análise o R1 conta como marcadas no item do próprio dado. */
  const markedCount = (v: ReportView) =>
    Number(/(\d+) lacunas? sobre o cadastro não (?:é|são) repetidas?, porque este relatório lê/.exec(v.parameters.methodology.join(" "))?.[1] ?? 0);

  it("só a chave da identificação ou a frase fixa inteira liga a lacuna a um dado do cadastro; palavra-chave não basta", () => {
    for (const text of [
      "Data de admissão do reclamante não informada no cadastro.",
      "Data de ajuizamento e data de admissão do reclamante não informadas no cadastro.",
      "Endereço da parte autora não informado no cadastro.",
      "CPF das partes não informado no cadastro.",
      "Detalhe da fase (data da sentença) não informado no cadastro.",
      "Tribunal de origem do recurso não informado.",
      "Classe do recurso interposto não informada no cadastro.",
      "Valor da causa atualizado não informado no cadastro.",
    ]) {
      expect(recordTopicOf({ text }), text).toBeNull();
    }
    for (const [key, text] of Object.entries(SIMULATED_RECORD_GAP_TEXTS)) {
      expect(recordTopicOf({ text })).toBe(key);
      // Diferença só de maiúsculas, espaços e ponto final.
      expect(recordTopicOf({ text: `  ${text.toLocaleUpperCase("pt-BR").replace(/\.$/, "")} ` })).toBe(key);
    }
    for (const [key, label] of Object.entries(SIMULATED_RECORD_AMOUNT_LABELS)) expect(recordTopicOf({ label })).toBe(key);
    expect(recordTopicOf({ label: "Valor da causa atualizado" })).toBeNull();
    expect(recordTopicOf({ key: "court_division", label: "Vara / órgão julgador" })).toBe("court_division");
    expect(recordTopicOf({ key: "plaintiffs", label: "Autor(es)" })).toBe("plaintiffs");
    // Chave que o R1 não lê (área) ou fora do contrato: nenhum dado.
    expect(recordTopicOf({ key: "legal_area", label: "Área" })).toBeNull();
    expect(recordTopicOf({ key: "admission_date", label: "Data de ajuizamento" })).toBeNull();
  });

  it("toda lacuna sobre o cadastro da análise simulada é reconhecida (frases fixas compartilhadas com o provedor)", () => {
    const brief = buildSimulatedCaseBrief({
      record: {
        number: invalidCnjNumber(9_900_001),
        title: "Processo de teste (fictício)",
        court: "TJSP",
        courtDivision: null,
        city: null,
        state: null,
        area: "civil",
        phase: "knowledge",
        phaseDetail: null,
        instance: null,
        processClass: null,
        claimAmountCents: null,
        liquidatedAmountCents: null,
        filedAt: null,
        companyName: null,
        responsibleName: null,
        parties: [],
        instances: [],
        events: [],
        recordSourceLabel: "Cadastro de teste (fictício)",
      },
      documents: [],
      today: todayISO(),
    });
    const items = [...brief.identification, ...brief.amounts, ...brief.gaps].filter(
      (i) => i.provenance === "missing" && i.citations.some((c) => c.ref === "REG"),
    );
    expect(items.length).toBeGreaterThanOrEqual(15);
    for (const item of items) expect(recordTopicOf(item), JSON.stringify(item)).not.toBeNull();
  });

  it("lacuna sobre o cadastro editada pelo revisor entra sempre como Lacuna, creditada a quem a editou", async () => {
    const pid = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 1_500_000 });
    const { briefId } = await requestCaseBrief(fx.ctx.lawyer, pid, { inline: true });
    await runJobs();
    const before = await generatedView(pid);
    expect(allItems(before).some((i) => i.origin === "gap" && i.content.includes("data de admissão"))).toBe(false);

    // O advogado edita, no editor da análise, a lacuna simulada sobre a data de ajuizamento (que cita o cadastro).
    const [b] = await fx.db
      .select({ content: caseBriefs.content, revision: caseBriefs.currentRevision })
      .from(caseBriefs)
      .where(eq(caseBriefs.id, briefId));
    const content = b.content as StoredCaseBrief;
    const original = content.gaps.find((g) => g.text === SIMULATED_RECORD_GAP_TEXTS.filed_at);
    expect(original?.citations.some((c) => c.ref === "REG")).toBe(true);
    const edited = "Data de ajuizamento e data de admissão do reclamante não informadas no cadastro.";
    await saveCaseBriefSection(fx.ctx.lawyer, briefId, {
      section: "gaps",
      value: content.gaps.map((g) => (g === original ? { ...g, text: edited } : g)),
      baseRevision: b.revision,
    });
    const [b2] = await fx.db.select({ content: caseBriefs.content }).from(caseBriefs).where(eq(caseBriefs.id, briefId));
    const saved = (b2.content as StoredCaseBrief).gaps.find((g) => g.text === edited);
    expect(saved?.provenance).toBe("reviewer");
    expect(saved?.citations.some((c) => c.ref === "REG")).toBe(true);

    const after = await generatedView(pid);
    const reviewerGap = allItems(after).find(
      (i) => i.origin === "gap" && i.content.startsWith("Data de ajuizamento e data de admissão do reclamante"),
    );
    expect(reviewerGap?.content).toBe(
      `Data de ajuizamento e data de admissão do reclamante não informadas no cadastro (incluída ou editada na revisão da análise preliminar v1, simulação, por ${fx.ctx.lawyer.name})`,
    );
    expect(gapEntries(after).some((e) => e.text.includes("data de admissão do reclamante"))).toBe(true);
    // Não é contada como repetida (a contagem cai em 1) e a metodologia diz que ela entrou pela revisão.
    expect(markedCount(after)).toBe(markedCount(before) - 1);
    expect(after.parameters.methodology.join(" ")).toContain(
      "das que entram, 1 foi incluída ou editada na revisão (lacuna do revisor entra sempre",
    );

    // Data de ajuizamento registrada depois: a lacuna do revisor continua (trata também de outro dado); só a da
    // identificação (chave filed_at) deixa de se aplicar.
    await fx.db.update(legalProcesses).set({ filedAt: "2026-01-10" }).where(eq(legalProcesses.id, pid));
    const filled = await generatedView(pid);
    expect(
      allItems(filled).some((i) => i.origin === "gap" && i.content.startsWith("Data de ajuizamento e data de admissão do reclamante")),
    ).toBe(true);
    expect(filled.parameters.methodology.join(" ")).toContain("1 lacuna sobre o cadastro não se aplica mais, porque o dado consta da base");
    expect(markedCount(filled)).toBe(markedCount(after) - 1);
  }, 180_000);

  it("lacuna em texto livre que só menciona um dado lido pelo R1 entra como Lacuna; dígito verificador: problema apontado, não dado não localizado", async () => {
    const number = invalidCnjNumber(9_900_002);
    // Sem partes: o R1 marca "Partes do processo"; a lacuna sobre a data de admissão do reclamante não é sobre as partes.
    const pid = await makeProcess(fx.ctx.manager, { number, unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 1_500_000 });
    const { briefId } = await requestCaseBrief(fx.ctx.lawyer, pid, { inline: true });
    await runJobs();
    const [b] = await fx.db.select({ content: caseBriefs.content }).from(caseBriefs).where(eq(caseBriefs.id, briefId));
    const content = b.content as StoredCaseBrief;
    expect(content.gaps.some((g) => g.text === SIMULATED_RECORD_GAP_TEXTS.process_number)).toBe(true);
    content.gaps.push(
      { text: "Data de admissão do reclamante não informada no cadastro.", provenance: "missing", citations: REG, note: null },
      { text: "Detalhe da fase (data da sentença) não informado no cadastro.", provenance: "missing", citations: REG, note: null },
    );
    await fx.db.update(caseBriefs).set({ content }).where(eq(caseBriefs.id, briefId));

    const v = await generatedView(pid);
    const gaps = allItems(v)
      .filter((i) => i.origin === "gap")
      .map((i) => i.content);
    expect(gaps).toContain("Partes do processo");
    expect(gaps).toContain("Data de admissão do reclamante não informada no cadastro (apontado pela análise preliminar v1, simulação)");
    expect(gaps).toContain("Detalhe da fase (data da sentença) não informado no cadastro (apontado pela análise preliminar v1, simulação)");
    // Dígito verificador: o R1 aponta o problema nos pontos de atenção, e a metodologia diz isso (não "não localizado").
    const attention = v.sections.find((s) => s.key === "attention")!.items.map((i) => i.content);
    expect(attention.some((t) => t.startsWith("O número do processo no cadastro não passa na validação do dígito verificador"))).toBe(true);
    expect(v.parameters.methodology.join(" ")).toContain(
      "1 lacuna sobre o dígito verificador do número do processo não é repetida, porque este relatório confere o número na data-base e aponta o mesmo problema nos pontos de atenção (seção 8)",
    );
    expect(gaps.some((t) => t.includes("dígito verificador"))).toBe(false);
  }, 180_000);
});

describe("R1: parecer da classificação de risco (item de Análise)", () => {
  it("o parecer entra inteiro, sem corte no meio de frase; a síntese remete à seção 6", async () => {
    const pid = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 3_000_000 });
    const sentences = Array.from(
      { length: 9 },
      (_, i) => `Fundamento ${i + 1} do parecer fictício: a prova documental do processo de teste indica o ponto ${i + 1}, nos termos do art. 818 da CLT e da fl. 12.`,
    );
    const opinion = sentences.join(" ");
    expect(opinion.length).toBeGreaterThan(1000);
    await addRiskAssessment(fx.ctx.manager, pid, { classification: "possible", opinion, effectiveFrom: todayISO() });
    const view = await generatedView(pid);
    const risk = view.sections.find((s) => s.key === "guarantees")!.items.find((i) => i.content.startsWith("Classificação de risco vigente"));
    expect(risk?.origin).toBe("analysis");
    expect(risk!.content).toContain(`Parecer: ${opinion}`);
    expect(risk!.content.endsWith(sentences[8])).toBe(true);
    expect(risk!.content).not.toContain("…");
    expect(risk!.content).not.toContain(RISK_OPINION_FULL_TEXT_AT);
    const synthesis = view.sections.find((s) => s.key === "synthesis")!.items.find((i) => i.content.startsWith("Classificação de risco vigente"));
    expect(synthesis!.content).toMatch(/\(parecer na seção 6\)\.$/);
    expect(synthesis!.content).not.toContain("Fundamento 1");
  }, 120_000);

  it("parecer muito longo: resumido só em fim de frase, com o aviso de onde está o texto completo", async () => {
    const sentence = (i: number) => `Fundamento ${i} do parecer fictício: a prova do processo de teste indica o ponto ${i}, nos termos do art. 818 da CLT.`;
    const long = Array.from({ length: 40 }, (_, i) => sentence(i + 1)).join(" ");
    expect(long.length).toBeGreaterThan(RISK_OPINION_MAX_CHARS);
    const r = riskOpinionText(long);
    expect(r.shortened).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(RISK_OPINION_MAX_CHARS);
    expect(long.startsWith(r.text)).toBe(true);
    // Termina numa frase inteira (nunca no ponto de "art."), e o que vem depois começa uma frase nova.
    expect(r.text.endsWith("da CLT.")).toBe(true);
    expect(long.slice(r.text.length)).toMatch(/^ Fundamento \d+ /);
    // Sem fim de frase dentro do limite (uma frase só): vai inteiro, nunca cortado no meio.
    const oneSentence = `Parecer fictício ${"com fundamento extenso ".repeat(160)}sem ponto final`;
    expect(riskOpinionText(oneSentence)).toEqual({ text: oneSentence.replace(/\s+/g, " ").trim(), shortened: false });
    expect(riskOpinionText("Parecer curto. Segunda frase.")).toEqual({ text: "Parecer curto. Segunda frase.", shortened: false });

    // No R1: parecer acima do limite (aprovação com nota chega a 4.000 caracteres), resumido com o aviso explícito.
    const pid = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 3_000_000 });
    await fx.db.insert(processRiskAssessments).values({
      organizationId: fx.orgA,
      processId: pid,
      classification: "probable",
      percentageBp: 10_000,
      opinion: long,
      effectiveFrom: todayISO(),
      status: "official",
      origin: "manual",
      assessedById: fx.ctx.manager.userId,
      reviewedById: fx.ctx.manager.userId,
      reviewedAt: new Date(),
    });
    const view = await generatedView(pid);
    const risk = view.sections.find((s) => s.key === "guarantees")!.items.find((i) => i.content.startsWith("Classificação de risco vigente"));
    expect(risk?.origin).toBe("analysis");
    expect(risk!.content).toContain(`Parecer (resumido neste relatório, até o fim de uma frase): ${r.text} ${RISK_OPINION_FULL_TEXT_AT}`);
    expect(risk!.content).not.toContain("…");
  }, 120_000);
});

describe("R1: parecer resumido nunca termina numa abreviação", () => {
  it("Cia., Exmo., Ilmo., S.A., Ltda. e Dra. não encerram a frase: o resumo termina na frase anterior, inteira", () => {
    const filler = Array.from({ length: 12 }, (_, i) => `Fundamento ${i + 1} do parecer de teste.`).join(" ");
    const tails = [
      "A reclamada, Cia. Brasileira de Teste, alegou o pagamento em dia.",
      "Encaminhado ao Exmo. Sr. Diretor de Teste para ciência e providências cabíveis.",
      "Ouvido o Ilmo. Sr. Gerente de Teste, o pagamento foi confirmado.",
      "A reclamada, Comércio de Teste S.A. Filial Sul, alegou o pagamento em dia.",
      "A reclamada, Teste Ltda. Filial Sul, alegou o pagamento em dia.",
      "Conforme a Dra. Maria de Teste, o pagamento ocorreu em dia.",
    ];
    for (const tail of tails) {
      const text = `${filler} ${tail} Outra frase final de teste.`;
      // Limite logo depois da abreviação e antes do fim da frase em que ela está.
      const max = filler.length + 1 + 40;
      expect(tail.length).toBeGreaterThan(41);
      const r = riskOpinionText(text, max);
      expect(r, tail).toEqual({ text: filler, shortened: true });
    }
  });
});

describe("R1: valor da causa e valor apurado nunca são somados", () => {
  it("itens, tabelas e PDF trazem os dois valores separados e nenhum total que os combine", async () => {
    const claim = await officialValue(fx, world.processId, "claim");
    const liquidated = await officialValue(fx, world.processId, "liquidated");
    const sum = digits(claim + liquidated);
    const r = await generateProcessReport(fx.ctx.manager, { processId: world.processId });
    const { view } = await getLegalReport(fx.ctx.manager, r.id);
    const all = [...view.sections.flatMap((s) => s.items), ...view.pendingItems];
    const synthesis = all.find((i) => i.section === "synthesis" && i.content.startsWith("Valores vigentes"));
    expect(synthesis?.content).toContain(digits(claim));
    expect(synthesis?.content).toContain(digits(liquidated));
    expect(synthesis?.content).toContain("não são somadas");
    for (const item of all) {
      expect(item.content).not.toContain(sum);
      if (item.data?.kind === "table") {
        // Nenhuma tabela do R1 tem linha de totais misturando grandezas.
        expect(item.data.totals).toBeNull();
        expect(JSON.stringify(item.data)).not.toContain(sum);
      }
    }
    const claimsTable = all.find((i) => i.section === "claims" && i.data?.kind === "table");
    const headers = claimsTable?.data?.kind === "table" ? claimsTable.data.columns.map((c) => c.header) : [];
    expect(headers).toEqual(expect.arrayContaining(["Valor pleiteado (original)", "Valor apurado"]));
    const text = (await pageTexts((await openLegalReportPdf(fx.ctx.manager, r.id)).bytes)).join(" ");
    expect(text).not.toContain(sum);
    const flat = text.replace(/\u00a0/g, " ");
    expect(flat).toContain(`Valor da causa: R$ ${digits(claim)}`);
    expect(flat).toContain(`Valor apurado vigente: R$ ${digits(liquidated)}`);
    // A regra de domínio recusa somar grandezas diferentes.
    expect(() =>
      totalOf(
        [
          { quantity: "claim", cents: claim },
          { quantity: "liquidated", cents: liquidated },
        ],
        "claim",
      ),
    ).toThrow(/Grandezas diferentes/);
  }, 120_000);
});

describe("R1: aprovado é imutável; só nova versão", () => {
  it("aprovação pelo advogado responsável; nova versão substitui sem tocar no PDF e no hash da aprovada", async () => {
    const first = await generateProcessReport(fx.ctx.manager, { processId: world.processId });
    // O R1 do processo já existia (teste anterior): gerar de novo cria a versão seguinte da mesma referência.
    expect(first.version).toBeGreaterThanOrEqual(2);
    // O R1 cita o atestado (documento de saúde): a contabilidade nem vê o relatório; não aprova.
    await expect(approveLegalReport(fx.ctx.accountant, first.id)).rejects.toBeInstanceOf(NotFoundError);
    await approveLegalReport(fx.ctx.lawyer, first.id);
    const approved = await getLegalReport(fx.ctx.manager, first.id);
    expect(approved.view.status).toBe("approved");
    const approvedPdf = await openLegalReportPdf(fx.ctx.manager, first.id);
    expect(approvedPdf.sha256).toBe(approved.view.pdfSha256);
    const pages = await pageTexts(approvedPdf.bytes);
    expect(pages[0]).toContain(`Revisado por`.toLocaleUpperCase("pt-BR"));
    expect(pages[0]).toContain(fx.ctx.lawyer.name);
    for (const t of pages) expect(t).not.toContain("PENDENTE DE REVISÃO");

    // O banco recusa qualquer mudança de conteúdo do aprovado.
    await expect(fx.db.execute(sql`update legal_reports set title = 'x' where id = ${first.id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`update legal_reports set pdf_sha256 = 'x' where id = ${first.id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`update legal_report_items set content = 'x' where report_id = ${first.id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`delete from legal_reports where id = ${first.id}`)).rejects.toThrow();
    await expect(approveLegalReport(fx.ctx.manager, first.id)).rejects.toBeInstanceOf(ConflictError);

    // Advogado que deixou de ser o responsável: não vê mais o atestado citado, então nem enxerga este R1 (não gera versão nova).
    await fx.db.update(legalProcesses).set({ responsibleId: fx.ctx.manager.userId }).where(eq(legalProcesses.id, world.processId));
    await expect(generateProcessReport(fx.ctx.lawyer, { processId: world.processId })).rejects.toBeInstanceOf(ConflictError);
    await fx.db.update(legalProcesses).set({ responsibleId: fx.ctx.lawyer.userId }).where(eq(legalProcesses.id, world.processId));
    // O advogado responsável (que pode aprovar o R1) gera a nova versão.
    const next = await generateProcessReport(fx.ctx.lawyer, { processId: world.processId });
    expect(next.reference).toBe(first.reference);
    expect(next.version).toBe(first.version + 1);
    const old = await getLegalReport(fx.ctx.manager, first.id);
    expect(old.view.status).toBe("superseded");
    expect(old.view.supersededById).toBe(next.id);
    expect(old.view.pdfSha256).toBe(approved.view.pdfSha256);
    expect(old.view.approvedByName).toBe(fx.ctx.lawyer.name);
    const preserved = await openLegalReportPdf(fx.ctx.manager, first.id);
    expect(preserved.sha256).toBe(approved.view.pdfSha256);
    const fresh = await getLegalReport(fx.ctx.manager, next.id);
    expect(fresh.view.status).toBe("pending_review");
    expect(fresh.versions.map((v) => v.version)).toContain(first.version);
  }, 180_000);

  it("R1 aprovado sem documento sensível: advogado que não é o responsável gera R1, mas não substitui a versão aprovada", async () => {
    const pid = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.manager.userId, claimAmountCents: 2_000_000 });
    const r = await generateProcessReport(fx.ctx.manager, { processId: pid });
    await approveLegalReport(fx.ctx.manager, r.id);
    await expect(generateProcessReport(fx.ctx.lawyer, { processId: pid })).rejects.toBeInstanceOf(ForbiddenError);
    const [row] = await fx.db.select({ status: legalReports.status }).from(legalReports).where(eq(legalReports.id, r.id));
    expect(row.status).toBe("approved");
    // Responsável pelo processo: pode aprovar, então gera a nova versão.
    await fx.db.update(legalProcesses).set({ responsibleId: fx.ctx.lawyer.userId }).where(eq(legalProcesses.id, pid));
    const next = await generateProcessReport(fx.ctx.lawyer, { processId: pid });
    expect(next.version).toBe(2);
    expect(next.reference).toBe(r.reference);
  }, 120_000);

  it("contabilidade e diretoria não geram R1", async () => {
    await expect(generateProcessReport(fx.ctx.accountant, { processId: world.processId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(generateProcessReport(fx.ctx.executive, { processId: world.processId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(generateProcessReport(fx.ctx.auditor, { processId: world.processId })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
