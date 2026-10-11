import { parseMoneyToCents } from "./format";

/**
 * Safe FormData readers for server actions (client-safe module, no server imports).
 *
 *   const input = {
 *     title: str(fd, "title"),              // string | undefined (trimmed, "" -> undefined)
 *     notes: strOrNull(fd, "notes"),        // string | null
 *     urgent: bool(fd, "urgent"),           // checkbox -> boolean
 *     tags: strings(fd, "tags"),            // multi-select / repeated fields
 *     amountCents: moneyCents(fd, "amount") // "1.234,56" -> 123456 | null
 *   };
 *
 * The service validates the object with zod. `int()` and `moneyCents()` return
 * NaN for unparseable input on purpose, so zod reports a field error instead of
 * the value being silently dropped.
 */

/** Trimmed string; empty or missing -> undefined. Files are ignored. */
export function str(fd: FormData, key: string): string | undefined {
  const v = fd.get(key);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Trimmed string; empty or missing -> null (use for nullable columns in updates). */
export function strOrNull(fd: FormData, key: string): string | null {
  return str(fd, key) ?? null;
}

/** Checkbox / switch: "on", "true", "1", "sim" -> true; anything else (or missing) -> false. */
export function bool(fd: FormData, key: string): boolean {
  const v = fd.get(key);
  if (typeof v !== "string") return false;
  return ["on", "true", "1", "sim"].includes(v.trim().toLowerCase());
}

/** All non-empty trimmed string values for a key (multi-select, repeated inputs). */
export function strings(fd: FormData, key: string): string[] {
  return fd
    .getAll(key)
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** Integer; empty or missing -> undefined; invalid -> NaN (so zod flags it). */
export function int(fd: FormData, key: string): number | undefined {
  const v = str(fd, key);
  if (v === undefined) return undefined;
  return /^-?\d+$/.test(v) ? Number.parseInt(v, 10) : Number.NaN;
}

/** Money typed in pt-BR ("1.234,56", "R$ 1.234,56", "1234.56") -> integer cents; empty -> null; invalid -> NaN. */
export function moneyCents(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (v === undefined) return null;
  return parseMoneyToCents(v) ?? Number.NaN;
}

/** Textarea with one item per line -> trimmed, non-empty lines. */
export function lines(fd: FormData, key: string): string[] {
  const v = fd.get(key);
  if (typeof v !== "string") return [];
  return v
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Uploaded file for a key, or undefined when missing/empty. */
export function file(fd: FormData, key: string): File | undefined {
  const v = fd.get(key);
  return v instanceof File && v.size > 0 ? v : undefined;
}

/**
 * Client-safe structural twin of `ActionResult` (`@/server/lib/errors`):
 * every `ActionResult<T>` is assignable to `FormState`. Use it in client
 * components, which must not import from `@/server/*`.
 */
export type FormState =
  | { ok: true; data?: unknown; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined> };

/** First error message for a field, if any: `error={fieldError(state, "title")}`. */
export function fieldError(state: FormState | null | undefined, field: string): string | undefined {
  if (!state || state.ok) return undefined;
  return state.fieldErrors?.[field]?.[0];
}

/** All error messages for a field. */
export function fieldErrors(state: FormState | null | undefined, field: string): string[] | undefined {
  if (!state || state.ok) return undefined;
  const errs = state.fieldErrors?.[field];
  return errs && errs.length > 0 ? errs : undefined;
}
