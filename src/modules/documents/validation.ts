import { createHash } from "node:crypto";
import { ValidationError } from "@/server/lib/errors";
import { ALLOWED_FORMATS_LABEL, EXTENSION_KIND, extensionOf, type DetectedKind } from "./file-types";

/**
 * Upload validation (pure functions, unit-tested in tests/documents/validation.test.ts).
 *
 * The client-provided MIME type is ignored: the type is detected from the
 * content signature and must match the file extension. Anything outside the
 * allow-list (HTML, SVG, executables, plain ZIP, legacy .doc, ...) is rejected.
 */

export const MAX_FILE_NAME_LENGTH = 180;

export type ValidatedUpload = {
  /** Sanitized original name (metadata only — never used as a path). */
  fileName: string;
  extension: string;
  kind: DetectedKind;
  /** MIME type derived from the detected content. */
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

const KIND_MIME: Record<Exclude<DetectedKind, "text">, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpeg: "image/jpeg",
};

const TEXT_MIME: Record<string, string> = { txt: "text/plain", md: "text/markdown", csv: "text/csv" };

export function mimeTypeFor(kind: DetectedKind, extension: string): string {
  if (kind === "text") return TEXT_MIME[extension] ?? "text/plain";
  return KIND_MIME[kind];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// File name
// ---------------------------------------------------------------------------

// C0/C1 control characters, bidi overrides/isolates and zero-width characters.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const RESERVED_CHARS = /[<>:"|?*]/g;

/**
 * Strips any path, control/bidi characters and characters reserved by common
 * file systems; collapses whitespace and limits the length (keeping the extension).
 */
export function sanitizeFileName(name: string, maxLength = MAX_FILE_NAME_LENGTH): string {
  let base = String(name ?? "").split(/[/\\]/).pop() ?? "";
  base = base.normalize("NFC").replace(UNSAFE_CHARS, "").replace(RESERVED_CHARS, "_");
  base = base.replace(/\s+/g, " ").trim().replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");

  const ext = extensionOf(base);
  let stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  stem = stem.trim();
  if (!stem) stem = "documento";

  const suffix = ext ? `.${ext}` : "";
  const room = Math.max(1, maxLength - suffix.length);
  if (stem.length > room) stem = Array.from(stem).slice(0, room).join("").trimEnd();
  return `${stem}${suffix}`;
}

// ---------------------------------------------------------------------------
// Content signature detection
// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .doc/.xls

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const MAX_ZIP_ENTRIES = 20_000;

/**
 * Names of the entries in a ZIP central directory, or null when the archive
 * is malformed (or uses ZIP64/multi-disk, which DOCX files never need).
 */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (bytes.length < minEocd) return null;
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - minEocd - 0xffff);
  for (let i = bytes.length - minEocd; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const disk = view.getUint16(eocd + 4, true);
  const entries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || entries === 0xffff || cdOffset === 0xffffffff || entries > MAX_ZIP_ENTRIES) return null;
  if (cdOffset + cdSize > eocd) return null;

  const decoder = new TextDecoder("utf-8");
  const names: string[] = [];
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CDH_SIG) return null;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen > bytes.length) return null;
    names.push(decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function isDocx(bytes: Uint8Array): boolean {
  const names = zipEntryNames(bytes);
  if (!names) return false;
  const hasContentTypes = names.includes("[Content_Types].xml");
  const hasWord = names.some((n) => n.startsWith("word/"));
  // Macro projects are never expected in a .docx (that would be .docm).
  const hasMacros = names.some((n) => n.toLowerCase() === "word/vbaproject.bin");
  return hasContentTypes && hasWord && !hasMacros;
}

const MARKUP_PREFIX = /^(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]|<svg[\s>]|<\?xml|<iframe[\s>])/i;

/** Control bytes that do not occur in text files (everything below 0x20 except tab, LF, FF, CR, ESC; plus DEL). */
function isBinaryControl(b: number): boolean {
  return (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) || b === 0x7f;
}

/** Plain text: valid UTF-8, no NUL bytes, (almost) no control bytes and not HTML/SVG/XML markup. */
function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  const sample = bytes.subarray(0, 8192);
  let controls = 0;
  for (const b of sample) if (isBinaryControl(b)) controls++;
  if (controls > Math.max(1, sample.length * 0.01)) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 64);
  return !MARKUP_PREFIX.test(head);
}

/** Detects the content type from the file signature. Returns null for anything not allowed. */
export function detectFileType(bytes: Uint8Array): DetectedKind | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, PDF)) return "pdf";
  if (startsWith(bytes, PNG)) return "png";
  if (startsWith(bytes, JPEG)) return "jpeg";
  if (startsWith(bytes, ZIP_LOCAL)) return isDocx(bytes) ? "docx" : null;
  if (startsWith(bytes, OLE2)) return null;
  return isPlainText(bytes) ? "text" : null;
}

// ---------------------------------------------------------------------------
// Full validation
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new ValidationError(message, { file: [message] });
}

function formatLimit(maxBytes: number): string {
  const mb = maxBytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1).replace(".", ",")} MB`;
}

/**
 * Validates an uploaded file and returns its normalized metadata.
 * Throws `ValidationError` (field "file") with a pt-BR message otherwise.
 */
export function validateUploadFile(file: { name: string; bytes: Uint8Array }, opts: { maxBytes: number }): ValidatedUpload {
  if (!file || !(file.bytes instanceof Uint8Array)) fail("Selecione um arquivo.");
  const sizeBytes = file.bytes.byteLength;
  if (sizeBytes === 0) fail("O arquivo está vazio.");
  if (sizeBytes > opts.maxBytes) fail(`O arquivo excede o limite de ${formatLimit(opts.maxBytes)}.`);

  const fileName = sanitizeFileName(file.name ?? "");
  const extension = extensionOf(fileName);
  if (!extension) fail(`O arquivo precisa ter uma extensão permitida (${ALLOWED_FORMATS_LABEL}).`);
  if (extension === "doc") fail("Arquivos .doc (Word 97-2003) não são aceitos. Salve o documento como .docx ou PDF.");
  const expected = EXTENSION_KIND[extension];
  if (!expected) fail(`Formato .${extension} não permitido. Envie arquivos ${ALLOWED_FORMATS_LABEL}.`);

  const detected = detectFileType(file.bytes);
  if (!detected) fail(`O conteúdo do arquivo não é de um formato permitido (${ALLOWED_FORMATS_LABEL}).`);
  if (detected !== expected) fail(`O conteúdo do arquivo não corresponde à extensão .${extension}.`);

  return {
    fileName,
    extension,
    kind: detected,
    mimeType: mimeTypeFor(detected, extension),
    sizeBytes,
    sha256: sha256Hex(file.bytes),
  };
}
