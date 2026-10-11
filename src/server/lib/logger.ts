import { env } from "@/server/env";

/**
 * Minimal structured logger (JSON lines to stdout/stderr).
 *
 * Rules: never log document contents, extracted text, AI prompts/answers,
 * passwords, tokens or personal data. Keys listed in REDACT are replaced
 * automatically as a safety net — callers should still only log ids.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const REDACT = new Set([
  "password",
  "passwordHash",
  "token",
  "sessionToken",
  "apiKey",
  "authorization",
  "cookie",
  "extractedText",
  "content",
  "text",
  "prompt",
  "body",
  "facts",
  "question",
  "answer",
  "documentNumber",
]);

/** PostgreSQL SQLSTATE of a driver error, or of the cause of a DrizzleQueryError. */
function dbErrorCode(error: Error): string | null {
  for (let e: unknown = error, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * Database errors embed the failed SQL and its bound parameters (titles, facts,
 * extracted text…) in `message`, so only their name and SQLSTATE are logged.
 */
function isDatabaseError(error: Error): boolean {
  return error.name === "DrizzleQueryError" || (dbErrorCode(error) !== null && "severity" in error);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (value instanceof Error) {
    if (isDatabaseError(value)) return { name: value.name, code: dbErrorCode(value), message: "[consulta ao banco omitida]" };
    return { name: value.name, message: value.message.slice(0, 500) };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT.has(k) ? "[redacted]" : sanitize(v, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  let min: Level = "info";
  try {
    min = env().LOG_LEVEL;
  } catch {
    /* env not valid yet */
  }
  if (LEVELS[level] < LEVELS[min]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(sanitize(fields ?? {}) as object) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
