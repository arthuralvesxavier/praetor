/**
 * Pure helpers for the app shell navigation (client-safe, unit-tested in
 * tests/shell/nav-utils.test.ts).
 */

/** Minimal shape of a navigation group (matches `NavGroup` from `@/lib/nav`). */
export type NavGroupLike<I extends { permissions: readonly string[] }> = {
  label: string | null;
  items: readonly I[];
};

/**
 * Keeps the items the user may open (ANY of the item's permissions) and drops
 * groups left empty. Hiding a link is not authorization — every page still
 * calls requirePageContext(permission).
 */
export function filterNavGroups<I extends { permissions: readonly string[] }>(
  groups: readonly NavGroupLike<I>[],
  has: (permission: I["permissions"][number]) => boolean,
): { label: string | null; items: I[] }[] {
  return groups
    .map((group) => ({ label: group.label, items: group.items.filter((item) => item.permissions.some((p) => has(p))) }))
    .filter((group) => group.items.length > 0);
}

function normalizePath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? "";
  if (clean.length > 1 && clean.endsWith("/")) return clean.replace(/\/+$/, "") || "/";
  return clean || "/";
}

/** True when `pathname` is `href` itself or one of its sub-routes ("/processos/123" is under "/processos"). */
export function matchesNavHref(pathname: string, href: string): boolean {
  const path = normalizePath(pathname);
  const target = normalizePath(href);
  if (target === "/") return path === "/";
  return path === target || path.startsWith(`${target}/`);
}

/**
 * The nav href that should be highlighted for `pathname`: the LONGEST href that
 * matches, so a nested entry ("/admin/auditoria") wins over its parent
 * ("/admin") when both are in the menu. Null when nothing matches.
 */
export function activeNavHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (!matchesNavHref(pathname, href)) continue;
    if (best === null || normalizePath(href).length > normalizePath(best).length) best = href;
  }
  return best;
}
