import { logger } from "@/server/lib/logger";

/**
 * Plain-text extraction from uploaded files (PDF, DOCX, text). Images are not
 * supported yet (OCR pending). The output is UNTRUSTED content: it is stored
 * for search/preview and sent to AI providers only as delimited data.
 *
 * Never logs the content or parser messages (which could quote it).
 */

export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;
const EXTRACTION_TIMEOUT_MS = 60_000;

export type ExtractionResult = {
  status: "succeeded" | "unsupported" | "failed";
  text?: string;
  pageCount?: number;
  /**
   * PDF only: offset in `text` where each page starts (index 0 = page 1).
   * Pages are normalized one by one and joined with PAGE_SEPARATOR, so the
   * offsets are exact positions in the stored text (see `pageForOffset`).
   */
  pageOffsets?: number[];
};

/** Separator between pages of a PDF in the extracted text. */
export const PAGE_SEPARATOR = "\n\n";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Normalizes whitespace and strips control characters; caps the length. */
export function normalizeExtractedText(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_EXTRACTED_TEXT_CHARS ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS) : text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("extraction_timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Joins already-normalized page texts with PAGE_SEPARATOR and records where
 * each page starts. Respects MAX_EXTRACTED_TEXT_CHARS: text beyond the cap is
 * cut and pages that would start after it get no offset.
 */
export function joinPages(pages: string[]): { text: string; pageOffsets: number[] } {
  let text = "";
  const pageOffsets: number[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (text.length >= MAX_EXTRACTED_TEXT_CHARS) break;
    pageOffsets.push(text.length);
    text += pages[i];
    if (i < pages.length - 1) text += PAGE_SEPARATOR;
  }
  if (text.length > MAX_EXTRACTED_TEXT_CHARS) text = text.slice(0, MAX_EXTRACTED_TEXT_CHARS);
  return { text, pageOffsets };
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  const { getDocumentProxy, extractText: extractPdfText } = await import("unpdf");
  // pdf.js may transfer (detach) the buffer it receives: give it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { totalPages, text } = await extractPdfText(pdf, { mergePages: false });
    // Normalize page by page, then join: offsets stay exact in the final text.
    const pages = text.map((page) => normalizeExtractedText(page));
    // No text layer (scanned document): needs OCR, which is not available yet.
    if (pages.every((p) => !p)) return { status: "unsupported", pageCount: totalPages };
    const joined = joinPages(pages);
    return { status: "succeeded", text: joined.text, pageCount: totalPages, pageOffsets: joined.pageOffsets };
  } finally {
    // Free pdf.js resources (method not present in the bundled typings).
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractionResult> {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return { status: "succeeded", text: normalizeExtractedText(result.value ?? "") };
}

function extractPlainText(bytes: Uint8Array): ExtractionResult {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  return { status: "succeeded", text: normalizeExtractedText(text) };
}

/**
 * Extracts text from a file whose MIME type was detected at upload time.
 * Never throws: parse errors become `failed`, other formats `unsupported`.
 */
export async function extractText(bytes: Uint8Array, mime: string): Promise<ExtractionResult> {
  const type = mime.split(";")[0].trim().toLowerCase();
  try {
    if (type === "application/pdf") return await withTimeout(extractPdf(bytes), EXTRACTION_TIMEOUT_MS);
    if (type === DOCX_MIME) return await withTimeout(extractDocx(bytes), EXTRACTION_TIMEOUT_MS);
    if (type === "text/plain" || type === "text/markdown" || type === "text/csv") return extractPlainText(bytes);
    // Images (PNG/JPEG): OCR pending.
    return { status: "unsupported" };
  } catch (err) {
    logger.warn("text_extraction_parse_failed", {
      mime: type,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { status: "failed" };
  }
}
