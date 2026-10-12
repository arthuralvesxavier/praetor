import { describe, expect, it } from "vitest";
import { activeNavHref, filterNavGroups, matchesNavHref } from "@/components/layout/nav-utils";
import { alertsBellLabel, formatBadgeCount } from "@/components/layout/shell-format";
import type { Role } from "@/domain/enums";
import { NAV_GROUPS } from "@/lib/nav";
import { can } from "@/server/auth/permissions";

function navFor(role: Role) {
  return filterNavGroups(NAV_GROUPS, (p) => can({ role, kind: "user" }, p));
}

function hrefsFor(role: Role): string[] {
  return navFor(role).flatMap((g) => g.items.map((i) => i.href));
}

describe("matchesNavHref", () => {
  it("matches the route itself and its sub-routes only", () => {
    expect(matchesNavHref("/processos", "/processos")).toBe(true);
    expect(matchesNavHref("/processos/123", "/processos")).toBe(true);
    expect(matchesNavHref("/processos/123/editar", "/processos")).toBe(true);
    expect(matchesNavHref("/processosx", "/processos")).toBe(false);
    expect(matchesNavHref("/proc", "/processos")).toBe(false);
  });

  it("ignores trailing slashes, query strings and hashes", () => {
    expect(matchesNavHref("/processos/", "/processos")).toBe(true);
    expect(matchesNavHref("/processos?status=active", "/processos")).toBe(true);
    expect(matchesNavHref("/alertas#lista", "/alertas")).toBe(true);
    expect(matchesNavHref("/processos", "/processos/")).toBe(true);
  });

  it("treats the root as an exact match", () => {
    expect(matchesNavHref("/", "/")).toBe(true);
    expect(matchesNavHref("/dashboard", "/")).toBe(false);
  });
});

describe("activeNavHref (longest match wins)", () => {
  const hrefs = ["/admin", "/admin/auditoria", "/processos", "/dashboard"];

  it("picks the most specific matching entry", () => {
    expect(activeNavHref("/admin/auditoria", hrefs)).toBe("/admin/auditoria");
    expect(activeNavHref("/admin/auditoria/123", hrefs)).toBe("/admin/auditoria");
    expect(activeNavHref("/admin/usuarios", hrefs)).toBe("/admin");
    expect(activeNavHref("/processos/abc", hrefs)).toBe("/processos");
  });

  it("does not depend on the order of the list", () => {
    expect(activeNavHref("/admin/auditoria", [...hrefs].reverse())).toBe("/admin/auditoria");
  });

  it("returns null when nothing matches", () => {
    expect(activeNavHref("/busca", hrefs)).toBeNull();
    expect(activeNavHref("/", hrefs)).toBeNull();
  });

  it("highlights exactly one entry for every real route of the menu", () => {
    const all = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(all).size).toBe(all.length);
    for (const href of all) {
      expect(activeNavHref(`${href}/qualquer-coisa`, all)).toBe(href);
    }
  });
});

describe("filterNavGroups with the real menu and role permissions", () => {
  it("shows everything to the admin, grouped with section titles", () => {
    const groups = navFor("admin");
    expect(groups.map((g) => g.label)).toEqual(NAV_GROUPS.map((g) => g.label));
    expect(groups.flatMap((g) => g.items)).toHaveLength(NAV_GROUPS.flatMap((g) => g.items).length);
  });

  it("hides groups left without items (accountant has no 'Operação' item)", () => {
    const groups = navFor("accountant");
    const labels = groups.map((g) => g.label);
    expect(labels).not.toContain("Operação");
    expect(labels).toContain("Contingências");
    const hrefs = hrefsFor("accountant");
    expect(hrefs).toEqual(expect.arrayContaining(["/contingencias", "/acordos", "/relatorios", "/processos"]));
    expect(hrefs).not.toContain("/admin");
    expect(hrefs).not.toContain("/emails");
    expect(hrefs).not.toContain("/entrada");
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });

  it("limits the external counsel to their working screens", () => {
    const hrefs = hrefsFor("external_counsel");
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/processos",
        "/analises-preliminares",
        "/prazos",
        "/contingencias",
        "/emails",
        "/documentos",
      ]),
    );
    for (const hidden of [
      "/relatorios",
      "/importacoes",
      "/distribuicao",
      "/admin",
      "/contratos",
      "/preventivo",
      "/ia",
    ]) {
      expect(hrefs).not.toContain(hidden);
    }
  });

  it("shows an item when the user has ANY of its permissions", () => {
    // /entrada requires intake:manage OR distribution:manage; analysts only have intake:manage.
    expect(hrefsFor("analyst")).toContain("/entrada");
    expect(hrefsFor("executive")).not.toContain("/entrada");
    // /admin: audit:read alone is enough (auditor).
    expect(hrefsFor("auditor")).toContain("/admin");
    expect(hrefsFor("lawyer")).not.toContain("/admin");
  });

  it("keeps item order and never mutates the source groups", () => {
    const before = JSON.stringify(NAV_GROUPS.map((g) => g.items.map((i) => i.href)));
    const groups = filterNavGroups(NAV_GROUPS, () => false);
    expect(groups).toEqual([]);
    expect(JSON.stringify(NAV_GROUPS.map((g) => g.items.map((i) => i.href)))).toBe(before);
    const exec = navFor("executive").flatMap((g) => g.items.map((i) => i.href));
    const order = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)).filter((h) => exec.includes(h));
    expect(exec).toEqual(order);
  });
});

describe("header text helpers", () => {
  it("formats the bell badge count", () => {
    expect(formatBadgeCount(0)).toBe("0");
    expect(formatBadgeCount(7)).toBe("7");
    expect(formatBadgeCount(99)).toBe("99");
    expect(formatBadgeCount(100)).toBe("99+");
    expect(formatBadgeCount(Number.NaN)).toBe("0");
  });

  it("describes open and critical alerts in pt-BR (not by color alone)", () => {
    expect(alertsBellLabel({ total: 0, critical: 0 })).toBe("Alertas e pendências: nenhum alerta aberto");
    expect(alertsBellLabel({ total: 1, critical: 0 })).toBe("Alertas e pendências: 1 aberto");
    expect(alertsBellLabel({ total: 5, critical: 1 })).toBe("Alertas e pendências: 5 abertos, 1 crítico");
    expect(alertsBellLabel({ total: 1200, critical: 3 })).toBe("Alertas e pendências: 1.200 abertos, 3 críticos");
  });
});
