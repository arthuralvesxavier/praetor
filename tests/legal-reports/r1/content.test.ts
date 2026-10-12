/**
 * R1 (Relatório de Processo): conteúdo e proveniência.
 * - a síntese usa o tribunal e o órgão da instância ATUAL (não os da origem);
 * - todo dado não localizado (item de lacuna, célula vazia de coluna de lacuna)
 *   consta das pendências, e a nota metodológica conta o mesmo número;
 * - as lacunas da análise preliminar (todas as seções) viram Lacuna;
 * - "sem registros encontrados" só em consulta vazia; o ponto de lacunas da síntese
 *   é inferência derivada dos itens de lacuna;
 * - CPF e CNPJ não entram no relatório;
 * - item do revisor creditado a quem o incluiu (histórico de revisões);
 * - cenários propostos só são gravados na emissão (nada fica se a emissão falha).
 */
import { and, count, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StoredCaseBrief } from "@/domain/case-brief";
import {
  CNPJ_OMITTED,
  CPF_OMITTED,
  containsPersonalId,
  countGapMarkers,
  GAP_MARKER,
  redactPersonalIds,
  type LegalReportDraft,
} from "@/domain/legal-reports";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { saveCaseBriefSection } from "@/modules/briefs/service";
import { buildProcessReportDraft, processReportFingerprint } from "@/modules/legal-reports/process-report";
import { generateProcessReport, getLegalReport, issueLegalReport, openLegalReportPdf } from "@/modules/legal-reports/service";
import { validateDraft } from "@/modules/legal-reports/validation";
import { gapEntries, itemNotes, type ItemView, type ReportView } from "@/modules/legal-reports/view";
import { auditLogs, caseBriefs, processEvents, processScenarios } from "@/server/db/schema";
import { ValidationError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../../helpers/fixtures";
import { pageTexts } from "../pdf-inspect";
import { buildR1World, type R1World } from "./world";

let fx: Fixture;
let world: R1World;
let view: ReportView;
let pdfText: string;

const CPF = "529.982.247-25";
const CNPJ = "11.222.333/0001-81";

async function scenarioCount(): Promise<number> {
  const [r] = await fx.db.select({ n: count() }).from(processScenarios).where(eq(processScenarios.processId, world.processId));
  return Number(r.n);
}

function allItems(v: ReportView): ItemView[] {
  return [...v.sections.flatMap((s) => s.items), ...v.pendingItems];
}

/** Marcadores exibidos no corpo: texto dos itens e células das tabelas (como na tela e no PDF). */
function displayedMarkers(item: ItemView): number {
  const data = item.data;
  if (!data) return countGapMarkers(item.displayText);
  const cells = data.kind === "row" ? [data.cells] : data.rows;
  let n = 0;
  for (const row of cells) {
    row.forEach((cell, i) => {
      const empty = cell === null || cell.trim() === "";
      const label = data.columns[i]?.nullLabel?.trim() || GAP_MARKER;
      if (empty && label === GAP_MARKER) n += 1;
      else if (!empty) n += countGapMarkers(cell);
    });
  }
  return n;
}

beforeAll(async () => {
  fx = await setupFixture("r1content");
  world = await buildR1World(fx, { approveBrief: false });
  // Movimentação com CPF e CNPJ no título (texto livre): nunca entram no relatório.
  await fx.db.insert(processEvents).values({
    organizationId: fx.orgA,
    processId: world.processId,
    occurredAt: "2026-09-25",
    type: "note",
    title: `Juntada de procuração outorgada por CPF ${CPF} e pela empresa CNPJ ${CNPJ}`,
    origin: "manual",
    instance: "second",
  });
  // Lacunas da análise preliminar em várias seções (a simulação só aponta as que o pacote de documentos não cobre):
  // documento (sem citação), cadastro (cita REG, não é repetida) e campo da identificação.
  const [b] = await fx.db.select({ content: caseBriefs.content }).from(caseBriefs).where(eq(caseBriefs.id, world.briefId));
  const content = b.content as StoredCaseBrief;
  content.gaps.push(
    { text: "Salário do reclamante não informado nos documentos (teste).", provenance: "missing", citations: [], note: null },
    { text: "Valor da causa não informado no cadastro (teste).", provenance: "missing", citations: [{ ref: "REG", page: null, excerpt: null }], note: null },
  );
  content.identification.push({
    key: "employment_role",
    label: "Função do reclamante (teste)",
    value: null,
    provenance: "missing",
    citations: [],
    note: "Não informada nos documentos.",
  });
  content.amounts.push({ label: "Valor do último salário (teste)", amountCents: null, provenance: "missing", citations: [], note: null });
  await fx.db.update(caseBriefs).set({ content }).where(eq(caseBriefs.id, world.briefId));
}, 600_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("R1: minimização e regras de lacuna (regras puras)", () => {
  it("CPF e CNPJ são omitidos de textos livres; número CNJ, valores e datas não são tocados", () => {
    expect(redactPersonalIds(`Autor CPF ${CPF}.`)).toBe(`Autor CPF ${CPF_OMITTED}.`);
    expect(redactPersonalIds("CPF: 52998224725")).toBe(`CPF: ${CPF_OMITTED}`);
    expect(redactPersonalIds(`Empresa ${CNPJ} ré`)).toBe(`Empresa ${CNPJ_OMITTED} ré`);
    expect(redactPersonalIds("documento 52998224725 anexado")).toBe(`documento ${CPF_OMITTED} anexado`);
    expect(redactPersonalIds("CNPJ/MF nº 11222333000181")).toBe(`CNPJ/MF nº ${CNPJ_OMITTED}`);
    for (const keep of [
      "Processo 0001234-56.2026.5.10.0001",
      "00012345620265100001",
      "Valor de R$ 1.234.567,89 em 31/03/2026",
      "protocolo 12345678901",
      "hash a52998224725b",
    ]) {
      expect(redactPersonalIds(keep)).toBe(keep);
    }
    expect(containsPersonalId(`trecho com ${CPF}`)).toBe(true);
    expect(containsPersonalId("trecho sem documento de pessoa")).toBe(false);
  });

  it("marcador de lacuna no texto sem a lacuna correspondente bloqueia a emissão; com a referência, passa", () => {
    const base: LegalReportDraft = {
      type: "process_report",
      title: "Teste",
      subtitle: null,
      scope: { processId: null },
      scopeLabel: "Teste",
      baseDate: "2026-10-12",
      isSample: false,
      generator: "process_report",
      generatorVersion: 1,
      sections: [{ key: "s", title: "Seção" }],
      methodology: [],
      items: [
        { key: "g", section: "s", content: "Fase processual", origin: "gap" },
        {
          key: "r",
          section: "s",
          content: `Processo na fase de ${GAP_MARKER}.`,
          origin: "record",
          recordSource: { table: "legal_processes", field: "phase", recordId: null, label: "Cadastro", recordedAt: "2026-10-12" },
        },
      ],
    };
    expect(validateDraft(base).map((i) => i.code)).toContain("undeclared_gap_marker");
    const ok = { ...base, items: base.items.map((i) => (i.key === "r" ? { ...i, gapRefs: ["g"] } : i)) };
    expect(validateDraft(ok)).toEqual([]);
    const badRef = { ...base, items: base.items.map((i) => (i.key === "r" ? { ...i, gapRefs: ["r"] } : i)) };
    expect(validateDraft(badRef).map((i) => i.code)).toContain("undeclared_gap_marker");
    const writtenCell = {
      ...base,
      items: [
        {
          key: "t",
          section: "s",
          content: "Tabela",
          origin: "record" as const,
          recordSource: { table: "legal_processes", field: "x", recordId: null, label: "Cadastro", recordedAt: "2026-10-12" },
          data: { kind: "table" as const, columns: [{ header: "A" }], rows: [[GAP_MARKER]], totals: null, note: null },
        },
      ],
    };
    expect(validateDraft(writtenCell).map((i) => i.code)).toContain("invalid_table");
  });
});

describe("R1: conteúdo e proveniência", () => {
  it("cenários propostos só são gravados na emissão: rascunho e emissão desfeita não gravam nada", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    expect(await scenarioCount()).toBe(0);
    const draft = await buildProcessReportDraft(fx.ctx.manager, { processId: world.processId }, settings);
    expect(validateDraft(draft)).toEqual([]);
    expect(typeof draft.onIssue).toBe("function");
    // Montar o rascunho não grava cenário.
    expect(await scenarioCount()).toBe(0);
    // Emissão recusada pela validação: nada gravado.
    const broken = { ...draft, items: draft.items.map((i, n) => (n === 0 ? { ...i, origin: undefined } : i)) };
    await expect(issueLegalReport(fx.ctx.manager, broken, { settings })).rejects.toBeInstanceOf(ValidationError);
    expect(await scenarioCount()).toBe(0);
    // Falha depois de gravar os cenários, dentro da transação: tudo é desfeito.
    const failing = {
      ...draft,
      onIssue: async (...args: Parameters<NonNullable<typeof draft.onIssue>>) => {
        await draft.onIssue!(...args);
        throw new Error("falha simulada na emissão");
      },
    };
    await expect(issueLegalReport(fx.ctx.manager, failing, { settings })).rejects.toThrow(/falha simulada/);
    expect(await scenarioCount()).toBe(0);

    // Emissão pedida por uma pessoa: os cenários (origem sistema) são gravados com o relatório; a auditoria diz quem pediu.
    const r = await generateProcessReport(fx.ctx.manager, { processId: world.processId });
    const scenarios = await fx.db.select().from(processScenarios).where(eq(processScenarios.processId, world.processId));
    expect(scenarios).toHaveLength(3);
    expect(scenarios.every((s) => s.origin === "system" && s.authorId === null)).toBe(true);
    const [audit] = await fx.db
      .select({ actorId: auditLogs.actorId, summary: auditLogs.summary })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, world.processId), eq(auditLogs.action, "process_scenario.propose")));
    expect(audit.actorId).toBe(fx.ctx.manager.userId);
    expect(audit.summary).toContain(`pedida por ${fx.ctx.manager.name}`);
    expect(audit.summary).toContain(r.reference);
    expect(audit.summary).not.toMatch(/pelo sistema/);
    // A impressão digital gravada já conta os cenários propostos: a rotina não vê "dado novo".
    const { view: v } = await getLegalReport(fx.ctx.manager, r.id);
    expect(v.parameters.dataFingerprint).toBe(await processReportFingerprint(fx.orgA, world.processId));
    view = v;
    pdfText = (await pageTexts((await openLegalReportPdf(fx.ctx.manager, r.id)).bytes)).join("\n");
  }, 180_000);

  it("síntese: instância atual com o tribunal e o órgão julgador da instância atual (não os da origem)", () => {
    const synthesis = view.sections.find((s) => s.key === "synthesis")!;
    const first = synthesis.items[0];
    expect(first.content).toContain("instância atual 2º grau (TRT10, 1ª Turma)");
    expect(first.content).not.toContain("Vara do Trabalho");
    expect(first.recordSource?.table).toBe("process_instances");
    // A capa mostra a mesma instância atual.
    const instances = view.sections[0].items.find((i) => i.data?.kind === "table" && i.data.columns[0].header === "Instância");
    expect(JSON.stringify(instances?.data)).toContain("1ª Turma");
  });

  it("todo dado não localizado consta das pendências (inclusive célula de tabela) e a nota metodológica conta o mesmo", () => {
    const entries = gapEntries(view);
    const texts = entries.map((e) => e.text);
    // A 2ª instância não tem cidade nem UF: a célula vazia é uma lacuna listada.
    expect(texts).toContain(`Cidade/UF (2º grau): ${GAP_MARKER}`);
    const cityEntry = entries.find((e) => e.text.startsWith("Cidade/UF (2º grau)"))!;
    expect(cityEntry.sectionTitle).toBe("Capa de identificação");
    // Contagem: a nota metodológica usa a mesma regra da lista.
    const methodology = view.parameters.methodology.join(" ");
    expect(methodology).toContain(`Lacunas: ${entries.length} dados não localizados`);
    // Todo marcador exibido no corpo está na lista (a síntese pode repetir o marcador de um dado já listado).
    const body = allItems(view);
    const repeated = body.filter((i) => i.section === "synthesis" && i.origin !== "gap").reduce((n, i) => n + countGapMarkers(i.content), 0);
    const shown = body.reduce((n, i) => n + displayedMarkers(i), 0);
    expect(shown - repeated).toBe(entries.length);
    // No PDF, a lista "Dados não localizados" traz a célula.
    const list = pdfText.slice(pdfText.lastIndexOf("DADOS NÃO LOCALIZADOS"));
    expect(list).toContain("Cidade/UF (2º grau)");
    for (const e of entries) expect(list).toContain(e.number);
  });

  it("lacunas da análise preliminar (de todas as seções) entram como Lacuna; as do cadastro não são repetidas", async () => {
    const [b] = await fx.db
      .select({ content: caseBriefs.content })
      .from(caseBriefs)
      .where(eq(caseBriefs.processId, world.processId))
      .orderBy(desc(caseBriefs.version))
      .limit(1);
    const content = b.content as StoredCaseBrief;
    const strip = (t: string) => t.replace(/\s+/g, " ").trim().replace(/[.;:,\s]+$/, "");
    const fromDocs = content.gaps.filter((g) => g.provenance === "missing" && !g.citations.some((c) => c.ref === "REG"));
    const fromRecord = content.gaps.filter((g) => g.provenance === "missing" && g.citations.some((c) => c.ref === "REG"));
    expect(fromDocs.length).toBeGreaterThan(0);
    const gapTexts = allItems(view)
      .filter((i) => i.origin === "gap")
      .map((i) => i.content);
    for (const g of fromDocs) {
      const expected = strip(g.text).slice(0, 60);
      expect(gapTexts.some((t) => t.includes(expected))).toBe(true);
    }
    for (const g of fromRecord) {
      expect(gapTexts.some((t) => t.includes(strip(g.text)))).toBe(false);
    }
    const identificationMissing = content.identification.filter((f) => f.provenance === "missing" && !f.citations.some((c) => c.ref === "REG"));
    expect(identificationMissing.length).toBeGreaterThan(0);
    for (const f of identificationMissing) {
      expect(gapTexts.some((t) => t.startsWith(`Identificação: ${f.label}`))).toBe(true);
    }
    expect(gapTexts).toContain("Identificação: Função do reclamante (teste): não informada nos documentos (apontado pela análise preliminar v1, simulação)");
    expect(gapTexts.some((t) => t.startsWith("Valores: Valor do último salário (teste): não localizado"))).toBe(true);
    expect(gapTexts.some((t) => t.includes("Valor da causa não informado no cadastro (teste)"))).toBe(false);
    // Todas as lacunas da análise aparecem nas pendências.
    const listed = gapEntries(view).map((e) => e.text);
    for (const g of fromDocs) expect(listed.some((t) => t.includes(strip(g.text).slice(0, 60)))).toBe(true);
    if (fromRecord.length) expect(view.parameters.methodology.join(" ")).toMatch(/lacunas? sobre o cadastro (não é repetida|não são repetidas)/);
  });

  it("notas de fonte: 'sem registros encontrados' só quando a consulta é vazia; ponto de lacunas da síntese é inferência", () => {
    for (const item of allItems(view)) {
      const notes = itemNotes(item).join(" ");
      if (notes.includes("sem registros encontrados")) expect(item.content).toMatch(/nenhum|nenhuma/i);
    }
    const pendingClaims = allItems(view).find((i) => i.section === "claims" && /aguarda/.test(i.content));
    if (pendingClaims) {
      expect(pendingClaims.recordSource?.dateBasis).not.toBe("query");
      expect(itemNotes(pendingClaims).join(" ")).not.toContain("sem registros encontrados");
    }
    const summary = view.sections.find((s) => s.key === "synthesis")!.items.find((i) => i.content.startsWith("Principais dados não localizados"));
    expect(summary).toBeTruthy();
    expect(summary!.origin).toBe("inference");
    expect(summary!.pendingReason).toBeNull();
    expect(summary!.derivedFromNumbers.length).toBeGreaterThan(0);
    const byNumber = new Map(allItems(view).map((i) => [i.number, i]));
    for (const n of summary!.derivedFromNumbers) expect(byNumber.get(n)?.origin).toBe("gap");
    expect(summary!.recordSource).toBeNull();
  });

  it("CPF e CNPJ de texto livre não entram no relatório (itens, tabelas e PDF)", () => {
    const stored = JSON.stringify(allItems(view).map((i) => [i.content, i.data, i.recordSource]));
    expect(stored).not.toContain(CPF);
    expect(stored).not.toContain(CNPJ);
    expect(stored).toContain(CPF_OMITTED);
    expect(stored).toContain(CNPJ_OMITTED);
    expect(pdfText).not.toContain(CPF);
    expect(pdfText).not.toContain(CNPJ);
  });

  it("item incluído na revisão é creditado a quem o incluiu, com a data dessa revisão", async () => {
    const load = async () => {
      const [b] = await fx.db
        .select({ content: caseBriefs.content, revision: caseBriefs.currentRevision })
        .from(caseBriefs)
        .where(eq(caseBriefs.id, world.briefId));
      return { content: b.content as StoredCaseBrief, revision: b.revision };
    };
    let b = await load();
    await saveCaseBriefSection(fx.ctx.lawyer, world.briefId, {
      section: "nextSteps",
      value: [
        { description: "Pedir à empresa os cartões de ponto do período (incluído pelo advogado, teste)", priority: "high", provenance: "reviewer", citations: [], note: null },
        ...b.content.nextSteps,
      ],
      baseRevision: b.revision,
    });
    b = await load();
    // Outra pessoa edita depois outra seção: o item do advogado continua creditado a ele.
    await saveCaseBriefSection(fx.ctx.manager, world.briefId, {
      section: "urgencies",
      value: [{ text: "Conferir a data da sessão de julgamento (incluído pela gestora, teste)", provenance: "reviewer", citations: [], note: null }, ...b.content.urgencies],
      baseRevision: b.revision,
    });
    const r = await generateProcessReport(fx.ctx.manager, { processId: world.processId });
    const { view: v } = await getLegalReport(fx.ctx.manager, r.id);
    const items = allItems(v);
    const step = items.find((i) => i.content.includes("cartões de ponto do período"));
    const urgency = items.find((i) => i.content.includes("data da sessão de julgamento"));
    expect(step?.origin).toBe("analysis");
    expect(step?.content).toContain(`por ${fx.ctx.lawyer.name}`);
    expect(step?.recordSource?.label).toContain(fx.ctx.lawyer.name);
    expect(step?.recordSource?.label).not.toContain(fx.ctx.manager.name);
    expect(urgency?.content).toContain(`por ${fx.ctx.manager.name}`);
    // Datas: a de cada revisão (a do advogado não é posterior à da gestora).
    expect(new Date(step!.recordSource!.recordedAt!).getTime()).toBeLessThanOrEqual(new Date(urgency!.recordSource!.recordedAt!).getTime());
  }, 180_000);
});
