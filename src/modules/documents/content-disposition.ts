/**
 * `Content-Disposition: attachment` header for downloads: an ASCII fallback in
 * `filename` plus the exact UTF-8 name in `filename*` (RFC 6266 / RFC 5987).
 */

/** ASCII-only fallback for the legacy `filename` parameter (no quotes, backslashes or control chars). */
export function asciiFileName(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._ ()-]/g, "_")
    .replace(/_+/g, "_")
    .trim();
  return ascii || "documento";
}

/** RFC 5987 percent-encoding for `filename*`. */
export function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function attachmentDisposition(fileName: string): string {
  return `attachment; filename="${asciiFileName(fileName)}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}
