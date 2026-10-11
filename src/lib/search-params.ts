/**
 * URL search-param helpers for list pages (client-safe).
 *
 *   export default async function Page(props: PageProps<"/processos">) {
 *     const sp = await props.searchParams;
 *     const q = param(sp, "q");
 *     const status = enumParam(sp, "status", PROCESS_STATUSES);
 *     const page = pageParam(sp);              // reads "pagina", >= 1
 *     const href = buildHref("/processos", sp, { status: "active", pagina: null });
 *   }
 */

export type SearchParams = Record<string, string | string[] | undefined>;

export const PAGE_PARAM = "pagina";

/** First non-empty trimmed value of a param, or undefined. */
export function param(sp: SearchParams | null | undefined, key: string): string | undefined {
  const raw = sp?.[key];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** All non-empty values of a repeated param. */
export function paramList(sp: SearchParams | null | undefined, key: string): string[] {
  const raw = sp?.[key];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.map((v) => v.trim()).filter((v) => v !== "");
}

/** Param restricted to an allowed list (e.g. enum ids); anything else -> undefined. */
export function enumParam<const T extends readonly string[]>(
  sp: SearchParams | null | undefined,
  key: string,
  allowed: T,
): T[number] | undefined {
  const v = param(sp, key);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}

/** Boolean flag param such as `vencendo=1` / `desatualizadas=1`. */
export function flagParam(sp: SearchParams | null | undefined, key: string): boolean {
  const v = param(sp, key);
  return v === "1" || v === "true" || v === "sim";
}

/** Current page from "pagina" (defaults to 1, never below 1, capped to avoid absurd offsets). */
export function pageParam(sp: SearchParams | null | undefined): number {
  const v = param(sp, PAGE_PARAM);
  if (!v || !/^\d+$/.test(v)) return 1;
  return Math.min(10_000, Math.max(1, Number.parseInt(v, 10)));
}

/** UUID-shaped param (for ids such as `responsavel`, `unidade`); anything else -> undefined. */
export function idParam(sp: SearchParams | null | undefined, key: string): string | undefined {
  const v = param(sp, key);
  return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : undefined;
}

/**
 * Builds `base?…` keeping the current params and applying overrides.
 * An override of `null`/`undefined`/"" removes the param. Empty current values are dropped.
 */
export function buildHref(
  base: string,
  sp: SearchParams | null | undefined,
  overrides: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const usp = new URLSearchParams();
  for (const [key, raw] of Object.entries(sp ?? {})) {
    if (key in overrides) continue;
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    for (const v of values) if (v !== "") usp.append(key, v);
  }
  for (const [key, v] of Object.entries(overrides)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    usp.set(key, v === true ? "1" : String(v));
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** True when any of the given params has a value (e.g. to show "Limpar filtros"). */
export function hasAnyParam(sp: SearchParams | null | undefined, keys: readonly string[]): boolean {
  return keys.some((k) => param(sp, k) !== undefined);
}
