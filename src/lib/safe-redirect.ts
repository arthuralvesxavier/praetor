/**
 * Validates a post-login "next" path so it can only point inside this app
 * (prevents open redirects). Returns null when unsafe or absent.
 *
 *   safeNextPath("/processos?status=active") -> "/processos?status=active"
 *   safeNextPath("//evil.com") / "https://evil.com" / "/\\evil.com" -> null
 */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 1000) return null;
  if (!v.startsWith("/") || v.startsWith("//")) return null;
  // Backslashes are normalized to "/" by browsers ("/\evil.com" -> "//evil.com"); control chars can smuggle schemes.
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return null;
  if (v === "/login" || v.startsWith("/login?") || v.startsWith("/login/")) return null;
  return v;
}
