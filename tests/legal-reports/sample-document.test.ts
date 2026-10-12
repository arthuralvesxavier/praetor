import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAP_MARKER } from "@/domain/legal-reports";
import { parseMoneyToCents, todayISO } from "@/lib/format";
import { addValuation, proposeValuation } from "@/modules/contingency/service";
import { createGuarantee } from "@/modules/contingency/guarantee-service";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { getDocumentVersionPageText } from "@/modules/documents/service";
import { addProcessScenario } from "@/modules/legal-reports/scenarios";
import { approveLegalReport, generateEngineSample, getLegalReport, openLegalReportPdf } from "@/modules/legal-reports/service";
import type { AuthContext } from "@/server/auth/context";
import { documents } from "@/server/db/schema";
import { demoInfo, makeLaborProcess, uploadDemoPack } from "../briefs/helpers";
import { makeProcess, runJobs, setupFixture, type Fixture } from "../helpers/fixtures";
import { fontDictionaries, pageTexts } from "./pdf-inspect";

/**
 * "Documento de teste do motor" a partir de um processo com o pacote de
 * documentos fictícios da demonstração (petição, procuração, CTPS, holerites,
 * notificação, planilha de cálculos), valores, garantia, risco, cenários e uma
 * carteira com dezenas de processos (tabela de 2+ páginas).
 *
 * Com LEGAL_REPORT_SAMPLE_OUT=<pasta> grava amostra.pdf (pendente de revisão)
 * e amostra-aprovada.pdf para conferência visual (ex.: .data/legal-reports-sample).
 */
let fx: Fixture;
let manager: AuthContext;
let processId: string;

beforeAll(async () => {
  fx = await setupFixture("lrsample");
  manager = fx.ctx.manager;
  const info = demoInfo();
  processId = await makeLaborProcess(manager, info, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId });
  await uploadDemoPack(manager, processId, info, { variant: 0 });
  await runJobs();

  // Valores: apurado oficial, valores propostos lidos da planilha de cálculos (um com confiança baixa).
  await addValuation(manager, {
    processId,
    kind: "liquidated",
    amountCents: 3_456_789,
    baseDate: "2026-09-30",
    source: "manual",
    reason: "Cálculo de liquidação (fictício, teste do motor)",
  });
  const docs = await fx.db
    .select({ id: documents.id, title: documents.title, versionId: documents.currentVersionId })
    .from(documents)
    .where(eq(documents.processId, processId));
  const calc = docs.find((d) => /c[aá]lculo/i.test(d.title)) ?? docs[0];
  const page = await getDocumentVersionPageText(manager, calc.id, calc.versionId as string, 1);
  const money = page.text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => /R\$\s?[\d.]+,\d{2}/.test(l) && l.length >= 20 && l.length <= 200 && !/[\u2012-\u2015]/.test(l));
  for (const [i, line] of money.slice(0, 2).entries()) {
    const amount = parseMoneyToCents(/R\$\s?([\d.]+,\d{2})/.exec(line)?.[1] ?? "") ?? 0;
    await proposeValuation(manager, {
      processId,
      kind: "claim",
      amountCents: amount,
      baseDate: "2026-09-20",
      source: "document",
      documentId: calc.id,
      documentVersionId: calc.versionId,
      page: 1,
      excerpt: line,
      confidence: i === 0 ? 91 : 62,
      reason: "Leitura da planilha de cálculos (teste do motor)",
    });
  }
  await createGuarantee(manager, processId, {
    kind: "appeal_deposit",
    amountCents: 1_000_000,
    depositedAt: "2026-08-10",
    description: "Depósito recursal (fictício)",
  });
  await addRiskAssessment(manager, processId, {
    classification: "possible",
    opinion: "Parecer fictício para o teste do motor: há prova documental parcial das horas extras alegadas.",
    effectiveFrom: todayISO(),
  });
  await addProcessScenario(manager, processId, {
    description: "Condenação parcial nas horas extras, sem reflexos (cenário fictício).",
    probabilityBand: "moderate",
    percentMin: 45,
    percentMax: 55,
  });
  await addProcessScenario(manager, processId, {
    description: "Improcedência total (cenário fictício).",
    probabilityBand: "low",
    comment: "Cenário de teste.",
  });
  // Carteira com dezenas de processos para a tabela longa (cabeçalho repetido em 2+ páginas).
  for (let i = 0; i < 64; i += 1) {
    await makeProcess(manager, {
      court: i % 3 === 0 ? "TRT10" : "TJSP",
      claimAmountCents: i % 4 === 0 ? null : 1_000_000 + i * 12_345,
      unitId: fx.unitSp,
    });
  }
}, 600_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("documento de teste do motor (amostra visual)", () => {
  it("gera o PDF com capa, nota, todas as origens, pendências e tabela de 2+ páginas", async () => {
    const r = await generateEngineSample(manager, { processId });
    const { view } = await getLegalReport(manager, r.id);
    const pdf = await openLegalReportPdf(manager, r.id);
    const pages = await pageTexts(pdf.bytes);
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(pages.every((t) => t.includes("PENDENTE DE REVISÃO"))).toBe(true);
    const tablePages = pages.filter((t) => t.includes("Processos visíveis da carteira"));
    expect(tablePages.length).toBeGreaterThanOrEqual(2);
    for (const t of tablePages) expect(t).toContain("Nº do processo");
    const all = pages.join(" ");
    expect(all).toContain(GAP_MARKER);
    expect(all).toContain("LEGENDA DAS ORIGENS");
    expect(all).not.toMatch(/[\u2013\u2014]/);
    expect((await fontDictionaries(pdf.bytes)).every((f) => f.embedded)).toBe(true);
    // Valor proposto com confiança 62 fica em pendências; o de 91 é afirmado (fonte conferida).
    expect(view.pendingItems.some((i) => i.confidence === 62)).toBe(true);
    expect(view.sections.flatMap((s) => s.items).some((i) => i.confidence === 91)).toBe(true);

    await approveLegalReport(manager, r.id);
    const approved = await openLegalReportPdf(manager, r.id);
    const out = process.env.LEGAL_REPORT_SAMPLE_OUT;
    if (out) {
      const dir = path.resolve(out);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "amostra.pdf"), pdf.bytes);
      await writeFile(path.join(dir, "amostra-aprovada.pdf"), approved.bytes);
    }
  }, 180_000);
});
