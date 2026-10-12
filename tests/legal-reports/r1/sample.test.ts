import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAP_MARKER } from "@/domain/legal-reports";
import { approveLegalReport, currentProcessReport, getLegalReport, openLegalReportPdf } from "@/modules/legal-reports/service";
import { runJobs, setupFixture, type Fixture } from "../../helpers/fixtures";
import { fontDictionaries, pageTexts } from "../pdf-inspect";
import { buildR1World, type R1World } from "./world";

/**
 * Amostra visual do R1 (Relatório de Processo) com dados fictícios completos.
 * Com LEGAL_REPORT_SAMPLE_OUT=<pasta> grava R1-exemplo.pdf (pendente de revisão)
 * e R1-exemplo-aprovado.pdf (ex.: .data/legal-reports-sample).
 */
let fx: Fixture;
let world: R1World;

beforeAll(async () => {
  fx = await setupFixture("r1sample");
  world = await buildR1World(fx, { approveBrief: true });
  await runJobs();
}, 600_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("R1: amostra completa", () => {
  it("gera o R1 automaticamente na aprovação da análise preliminar, com todas as seções", async () => {
    const current = await currentProcessReport(fx.orgA, world.processId);
    expect(current?.status).toBe("pending_review");
    const { view } = await getLegalReport(fx.ctx.manager, current!.id);
    expect(view.reference).toMatch(/^R1-\d{4}-0001$/);
    expect(view.parameters.layout).toBe("process_report");
    expect(view.sections.map((s) => s.number)).toEqual(["1", "3", "4", "5", "6", "7", "8"]);
    const pdf = await openLegalReportPdf(fx.ctx.manager, current!.id);
    const pages = await pageTexts(pdf.bytes);
    const all = pages.join(" ");
    for (const title of [
      "Capa de identificação",
      "Nota metodológica",
      "Síntese executiva",
      "Linha do tempo",
      "Quadro de pedidos e valores",
      "Garantias e exposição líquida",
      "Matriz de cenários",
      "Pontos de atenção e próximos atos",
      "Auditoria de fontes",
      "Pendências do relatório",
    ]) {
      expect(all).toContain(title);
    }
    expect(all).toContain("Os cenários são estimativas condicionais à data-base deste relatório e não constituem prognóstico de resultado.");
    expect(all).toContain(GAP_MARKER);
    expect(all).not.toMatch(/[\u2013\u2014]/);
    expect((await fontDictionaries(pdf.bytes)).every((f) => f.embedded)).toBe(true);
    for (const [i, text] of pages.entries()) {
      expect(text).toContain(`Página ${i + 1} de ${pages.length}`);
      expect(text).toContain("O conteúdo reflete o estado da base em");
    }

    await approveLegalReport(fx.ctx.lawyer, current!.id);
    const approved = await openLegalReportPdf(fx.ctx.manager, current!.id);
    const out = process.env.LEGAL_REPORT_SAMPLE_OUT;
    if (out) {
      const dir = path.resolve(out);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "R1-exemplo.pdf"), pdf.bytes);
      await writeFile(path.join(dir, "R1-exemplo-aprovado.pdf"), approved.bytes);
      await writeFile(path.join(dir, "R1-exemplo.txt"), pages.map((t, i) => `--- página ${i + 1} ---\n${t}`).join("\n\n"));
    }
  }, 300_000);
});
