import { describe, expect, it } from "vitest";
import { extractText, MAX_EXTRACTED_TEXT_CHARS, normalizeExtractedText } from "@/server/integrations/text-extraction";
import { buildDocx, buildPdf, PNG_BYTES, utf8 } from "./fixtures";

describe("extractText", () => {
  it("extracts text from PDF", async () => {
    const result = await extractText(buildPdf("Contrato de locacao comercial"), "application/pdf");
    expect(result.status).toBe("succeeded");
    expect(result.text).toContain("Contrato de locacao comercial");
    expect(result.pageCount).toBe(1);
  });

  it("extracts text from DOCX", async () => {
    const result = await extractText(
      buildDocx("Cláusula primeira\nCláusula segunda"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(result.status).toBe("succeeded");
    expect(result.text).toContain("Cláusula primeira");
    expect(result.text).toContain("Cláusula segunda");
  });

  it("extracts plain text, markdown and CSV", async () => {
    expect(await extractText(utf8("﻿olá   mundo\r\n\r\n\r\n\r\nfim"), "text/plain")).toEqual({
      status: "succeeded",
      text: "olá mundo\n\nfim",
    });
    expect((await extractText(utf8("# T"), "text/markdown")).status).toBe("succeeded");
    expect((await extractText(utf8("a;b"), "text/csv; charset=utf-8")).text).toBe("a;b");
  });

  it("marks images as unsupported (OCR pending) and corrupt files as failed", async () => {
    expect((await extractText(PNG_BYTES, "image/png")).status).toBe("unsupported");
    expect((await extractText(utf8("%PDF-1.4 lixo"), "application/pdf")).status).toMatch(/failed|unsupported/);
    expect((await extractText(utf8("PK not a zip"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).status).toBe(
      "failed",
    );
  });
});

describe("normalizeExtractedText", () => {
  it("removes control characters and caps the length", () => {
    expect(normalizeExtractedText("a\u0000b\u0007c\t\td")).toBe("abc d");
    expect(normalizeExtractedText("x".repeat(MAX_EXTRACTED_TEXT_CHARS + 10)).length).toBe(MAX_EXTRACTED_TEXT_CHARS);
  });
});
