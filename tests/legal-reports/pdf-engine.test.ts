import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_ITEM_ORIGIN_DESCRIPTIONS, REPORT_ITEM_ORIGIN_LABELS } from "@/domain/enums";
import { renderPdf, sanitizePdfText, type PdfDocumentSpec } from "@/server/pdf";
import { BRAND_ARCH_PATH, BRAND_SQUARE_PATH, transformSvgPath } from "@/server/pdf/brand";
import { PAGE } from "@/server/pdf/theme";
import { fontDictionaries, pageTexts } from "./pdf-inspect";

const legend = { title: "Legenda das origens", labels: REPORT_ITEM_ORIGIN_LABELS, descriptions: REPORT_ITEM_ORIGIN_DESCRIPTIONS };

function spec(overrides: Partial<PdfDocumentSpec> = {}): PdfDocumentSpec {
  const rows = Array.from({ length: 90 }, (_, i) => [`${String(i + 1).padStart(7, "0")}-00.2026.5.10.0000`, "TRT10", i % 4 ? "Não apurado" : "R$ 1.000,00"]);
  return {
    info: { title: "Teste \u2014 motor", createdAt: new Date("2026-10-12T12:00:00Z") },
    headerStripe: "CONFIDENCIAL · USO INTERNO",
    footer: { reference: "R1-2026-0001 · versão 1", baseDateLabel: "Data-base 12/10/2026", statement: "O conteúdo reflete o estado da base em 12/10/2026." },
    watermark: "PENDENTE DE REVISÃO",
    sealLegend: legend,
    blocks: [
      { type: "paragraph", style: "title", text: "Relatório \u2014 teste do motor" },
      { type: "heading", number: "1", text: "Itens" },
      { type: "item", seal: "record", number: "1.1", text: "Tribunal: TRT10.", notes: ["Cadastro do processo, campo Tribunal."] },
      { type: "item", seal: "gap", number: "1.2", text: "Cidade: [DADO NÃO LOCALIZADO]" },
      { type: "heading", number: "2", text: "Tabela longa" },
      {
        type: "table",
        caption: "Processos",
        seal: "record",
        columns: [{ header: "Nº do processo", weight: 2 }, { header: "Tribunal" }, { header: "Valor apurado", align: "right" }],
        rows,
        totals: ["Totais", "", "R$ 23.000,00"],
      },
    ],
    ...overrides,
  };
}

describe("motor de PDF", () => {
  it("embute as fontes (Inter e Cormorant Garamond) e não usa fontes padrão do PDF", async () => {
    const { bytes } = await renderPdf(spec());
    const fonts = await fontDictionaries(bytes);
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) {
      expect(f.embedded, `fonte ${f.name} não embutida`).toBe(true);
      expect(f.subtype).toBe("/Type0");
    }
    const names = fonts.map((f) => f.name).join(" ");
    expect(names).toMatch(/Inter-Regular/);
    expect(names).toMatch(/Inter-SemiBold/);
    expect(names).toMatch(/CormorantGaramond-SemiBold/);
    expect(names).not.toMatch(/Helvetica|Times|Courier/);
  });

  it("marca d'água em todas as páginas antes da aprovação, rodapé Página X de Y e nenhum travessão", async () => {
    const { bytes, pageCount } = await renderPdf(spec());
    expect(pageCount).toBeGreaterThanOrEqual(3);
    const pages = await pageTexts(bytes);
    expect(pages).toHaveLength(pageCount);
    pages.forEach((text, i) => {
      expect(text).toContain("PENDENTE DE REVISÃO");
      expect(text).toContain(`Página ${i + 1} de ${pageCount}`);
      expect(text).toContain("O conteúdo reflete o estado da base em 12/10/2026.");
      expect(text).toContain("CONFIDENCIAL · USO INTERNO");
      expect(text).not.toMatch(/[\u2013\u2014]/);
    });
  });

  it("sem marca d'água quando aprovado", async () => {
    const pages = await pageTexts((await renderPdf(spec({ watermark: null }))).bytes);
    for (const text of pages) expect(text).not.toContain("PENDENTE DE REVISÃO");
  });

  it("tabela longa repete o cabeçalho em toda página e marca a continuação", async () => {
    const { bytes } = await renderPdf(spec());
    const pages = await pageTexts(bytes);
    const tablePages = pages.filter((t) => /0000\d{3}-00\.2026/.test(t));
    expect(tablePages.length).toBeGreaterThanOrEqual(2);
    for (const t of tablePages) {
      expect(t).toContain("Nº do processo");
      expect(t).toContain("Valor apurado");
    }
    expect(tablePages.slice(1).every((t) => t.includes("(continuação)"))).toBe(true);
    // Todas as linhas aparecem uma única vez (nenhuma linha partida ou perdida).
    const all = pages.join(" ");
    for (let i = 1; i <= 90; i += 1) {
      const n = `${String(i).padStart(7, "0")}-00.2026.5.10.0000`;
      expect(all.split(n).length - 1).toBe(1);
    }
  });

  it("legenda dos selos aparece uma vez, na primeira página com selo", async () => {
    const pages = await pageTexts((await renderPdf(spec())).bytes);
    const withLegend = pages.map((t, i) => (t.includes("LEGENDA DAS ORIGENS") ? i : -1)).filter((i) => i >= 0);
    expect(withLegend).toHaveLength(1);
    expect(pages[withLegend[0]]).toContain("DOCUMENTADO");
    expect(pages[withLegend[0]]).toContain("LACUNA");
  });

  it("título nunca fica órfão no fim da página: vai junto com o bloco seguinte", async () => {
    const usable = PAGE.contentTop - PAGE.contentBottom;
    const { bytes } = await renderPdf(
      spec({
        sealLegend: undefined,
        blocks: [
          { type: "spacer", height: usable - 40 },
          { type: "heading", number: "9", text: "Título de teste da quebra" },
          { type: "paragraph", text: "Primeira linha do bloco seguinte ao título. ".repeat(10) },
        ],
      }),
    );
    const pages = await pageTexts(bytes);
    expect(pages[0]).not.toContain("Título de teste da quebra");
    expect(pages[1]).toContain("Título de teste da quebra");
    expect(pages[1]).toContain("Primeira linha do bloco seguinte");
  });

  it("quebra linhas sem hifenizar e sem perder palavras", async () => {
    const words = Array.from({ length: 400 }, (_, i) => `palavra${i}`).join(" ");
    const pages = await pageTexts((await renderPdf(spec({ sealLegend: undefined, blocks: [{ type: "paragraph", text: words }] }))).bytes);
    const all = pages.join(" ");
    for (const i of [0, 57, 199, 399]) expect(all).toContain(`palavra${i}`);
    expect(all).not.toMatch(/palavra\d+-\s/);
  });

  it("sanitiza travessões e meias-riscas", () => {
    expect(sanitizePdfText("Execução \u2014 arquivado")).toBe("Execução, arquivado");
    expect(sanitizePdfText("2019\u20132020")).toBe("2019-2020");
    expect(sanitizePdfText("a\u00adb")).toBe("ab");
    expect(sanitizePdfText("a\u00adb \u2014 c", { keepDashes: true })).toBe("ab \u2014 c");
  });

  it("trecho citado \u00e9 literal (travess\u00e3o da fonte preservado); o texto do relat\u00f3rio continua sem travess\u00e3o", async () => {
    const pages = await pageTexts(
      (
        await renderPdf(
          spec({
            blocks: [
              {
                type: "item",
                seal: "documented",
                number: "1.1",
                text: "Trecho \u2014 da peti\u00e7\u00e3o.",
                quote: "O reclamante \u2014 admitido em 2019 \u2014 pede horas extras.",
              },
            ],
          }),
        )
      ).bytes,
    );
    const all = pages.join(" ");
    expect(all).toContain("O reclamante \u2014 admitido em 2019 \u2014 pede horas extras.");
    expect(all).toContain("Trecho, da peti\u00e7\u00e3o.");
  });

  it("usa exatamente os caminhos da marca (arco e quadrado de logo.tsx)", () => {
    const logo = readFileSync(path.resolve(process.cwd(), "src/components/brand/logo.tsx"), "utf8");
    expect(logo).toContain(`const ARCH = "${BRAND_ARCH_PATH}"`);
    expect(logo).toContain(`const SQUARE = "${BRAND_SQUARE_PATH}"`);
    expect(transformSvgPath("M0 0H10V10Z", { sx: 2, sy: -1, tx: 5, ty: 3 })).toBe("M5 3H25V-7Z");
  });
});
