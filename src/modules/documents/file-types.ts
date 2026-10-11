/**
 * Allowed upload formats (client-safe: used by the upload form pre-check and by
 * the server validation). The server never trusts the extension alone: the
 * content signature (magic bytes) must match it — see ./validation.ts.
 */

export type DetectedKind = "pdf" | "docx" | "png" | "jpeg" | "text";

export const EXTENSION_KIND: Readonly<Record<string, DetectedKind>> = {
  pdf: "pdf",
  docx: "docx",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  txt: "text",
  md: "text",
  csv: "text",
};

export const ALLOWED_EXTENSIONS = Object.keys(EXTENSION_KIND);

/** Value for `<input type="file" accept>`. */
export const UPLOAD_ACCEPT = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",");

/** Human-readable list for hints and error messages. */
export const ALLOWED_FORMATS_LABEL = "PDF, DOCX, PNG, JPG, TXT, MD ou CSV";

/** Lower-case extension of a file name without the dot ("" when there is none). */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isAllowedExtension(fileName: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXTENSION_KIND, extensionOf(fileName));
}

export function maxUploadBytes(maxUploadMb: number): number {
  return Math.floor(maxUploadMb * 1024 * 1024);
}
