import { describe, expect, it } from "vitest";
import { pageForOffset } from "@/server/integrations/ai/case-brief/provider";
import {
  buildDemoCaseDocuments,
  describeDemoCase,
  DEMO_DOCUMENT_BANNER,
  toWinAnsi,
} from "@/modules/briefs/demo-documents";
import { extractText, joinPages, MAX_EXTRACTED_TEXT_CHARS, PAGE_SEPARATOR } from "@/server/integrations/text-extraction";
import { demoInfo } from "./helpers";

describe("page offsets", () => {
  it("joinPages records exact offsets of normalized pages", () => {
    const pages = ["Página um", "", "Página três\ncom duas linhas"];
    const { text, pageOffsets } = joinPages(pages);
    expect(text).toBe(pages.join(PAGE_SEPARATOR));
    expect(pageOffsets).toEqual([0, 11, 13]);
    pages.forEach((p, i) => expect(text.slice(pageOffsets[i], pageOffsets[i] + p.length)).toBe(p));
    expect(pageForOffset(pageOffsets, 0)).toBe(1);
    expect(pageForOffset(pageOffsets, 12)).toBe(2);
    expect(pageForOffset(pageOffsets, text.length - 1)).toBe(3);
    expect(pageForOffset(null, 5)).toBeNull();
  });

  it("caps the text and drops offsets of pages beyond the cap", () => {
    const big = "x".repeat(MAX_EXTRACTED_TEXT_CHARS - 5);
    const { text, pageOffsets } = joinPages([big, "segunda página longa", "terceira"]);
    expect(text.length).toBe(MAX_EXTRACTED_TEXT_CHARS);
    expect(pageOffsets).toEqual([0, big.length + PAGE_SEPARATOR.length]);
  });

  it("extracts demo PDFs page by page with exact offsets", async () => {
    const info = demoInfo();
    const [petition] = await buildDemoCaseDocuments(info, { variant: 0 });
    const result = await extractText(petition.bytes, "application/pdf");
    expect(result.status).toBe("succeeded");
    expect(result.pageCount).toBeGreaterThanOrEqual(3);
    expect(result.pageCount).toBeLessThanOrEqual(5);
    expect(result.pageOffsets).toHaveLength(result.pageCount!);
    const text = result.text!;
    const offsets = result.pageOffsets!;
    // Every page starts with the banner and the claims are on the last page.
    for (const start of offsets) expect(text.slice(start)).toMatch(/^DOCUMENTO FICTÍCIO — GERADO PARA DEMONSTRAÇÃO/);
    expect(pageForOffset(offsets, text.indexOf("DOS PEDIDOS"))).toBe(result.pageCount);
    expect(pageForOffset(offsets, text.indexOf("DOS FATOS"))).toBe(2);
    expect(pageForOffset(offsets, text.indexOf("Data de admissão"))).toBe(1);
  });
});

describe("demo documents", () => {
  it("builds a deterministic pack labeled as fictitious on every page", async () => {
    const info = demoInfo();
    const a = await buildDemoCaseDocuments(info, { variant: 1 });
    const b = await buildDemoCaseDocuments(info, { variant: 1 });
    expect(a.map((d) => d.title)).toEqual([
      "Petição inicial",
      "Procuração do reclamante",
      "Documentos do reclamante (CTPS e holerites)",
      "Notificação — audiência inicial",
      "Planilha de cálculos do reclamante",
    ]);
    a.forEach((d, i) => expect(Buffer.from(d.bytes).equals(Buffer.from(b[i].bytes))).toBe(true));
    for (const d of a) {
      expect(d.mimeType).toBe("application/pdf");
      expect(d.description).toContain("fictício");
      const r = await extractText(d.bytes, "application/pdf");
      const banners = r.text!.split(DEMO_DOCUMENT_BANNER).length - 1;
      // Header and footer on every page.
      expect(banners).toBe(r.pageCount! * 2);
      expect(r.text).not.toMatch(/\bart\.|\bartigo\b|súmula|sumula|jurisprud/i);
    }
  });

  it("claims add up to the valor da causa; variants differ as documented", async () => {
    const info = demoInfo({ claimAmountCents: 10_000_000 });
    const complete = describeDemoCase(info, { variant: 0 });
    expect(complete.claimAmounts.reduce((a, b) => a + b, 0)).toBe(10_000_000);
    expect(complete.petitionClaimCents).toBe(10_000_000);
    expect(complete.admission < complete.dismissal).toBe(true);
    expect(complete.includesCalculation).toBe(true);

    const inconsistent = describeDemoCase(info, { variant: 1 });
    expect(inconsistent.petitionClaimCents).not.toBe(10_000_000);
    expect(inconsistent.claimAmounts.reduce((a, b) => a + b, 0)).toBe(inconsistent.petitionClaimCents);
    expect(inconsistent.dismissal < inconsistent.admission).toBe(true);

    expect(describeDemoCase(info, { variant: 2 }).includesCalculation).toBe(false);
    expect((await buildDemoCaseDocuments(info, { variant: 3 })).map((d) => d.category)).not.toContain("calculation");
    // Hearing date derived from the filing date (fictitious document content).
    expect(complete.hearingDate > info.filedAt!).toBe(true);
  });

  it("chooses the variant from the CNJ when none is given and sanitizes text to WinAnsi", async () => {
    const info = demoInfo();
    expect(describeDemoCase(info).variant).toBe(describeDemoCase(info).variant);
    expect(toWinAnsi("Ação — R$ 1,00 → ok ✓")).toBe("Ação — R$ 1,00 ? ok ?");
    const docs = await buildDemoCaseDocuments({ ...info, plaintiff: "Zoë 🙂 Teste", city: null, state: null, filedAt: null });
    expect(docs.length).toBeGreaterThanOrEqual(4);
  });
});
