import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ShellData } from "@/components/layout/shell-data";
import { simulationItems } from "@/components/layout/shell-format";
import type { Role } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";

/**
 * App shell (src/app/(app)/layout.tsx) rendered with react-dom/server, with a
 * mocked session and mocked shell data: one-line demo banner, a single
 * "Simulações" badge instead of one badge per simulation, and the bell without
 * a separate "N críticos" pill (the critical count lives in its panel).
 *
 * Radix portals render nothing on the server, so the popover panels are
 * rendered on their own (AlertsPanel, SimulationsPanel, DemoInfoPanel).
 *
 * Set SHELL_PREVIEW_DIR to also write the markup for a visual check with the
 * compiled CSS (screenshots in .data/p06-shots/shell/).
 */

const state: { ctx: AuthContext | null; shell: ShellData | null } = { ctx: null, shell: null };

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: async () => state.ctx,
  requireActionContext: async () => state.ctx,
  getCurrentUser: async () => state.ctx,
}));
vi.mock("@/components/layout/shell-data", () => ({ loadShellData: async () => state.shell }));
vi.mock("@/app/(app)/actions", () => ({ signOutAction: async () => {} }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/dashboard",
}));

const { default: AppLayout } = await import("@/app/(app)/layout");
const { AlertsPanel, SimulationsPanel } = await import("@/components/layout/header-indicators");
const { DemoInfoPanel } = await import("@/components/layout/demo-banner");
const { HEADER_POPOVER_BOX } = await import("@/components/layout/header-popover");

const DASHES = /[—–]/;

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function textOf(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function ctxFor(role: Role, isDemoOrganization: boolean): AuthContext {
  return {
    kind: "user",
    userId: "00000000-0000-0000-0000-000000000001",
    organizationId: "00000000-0000-0000-0000-0000000000aa",
    role,
    unitId: null,
    lawFirmId: null,
    name: role === "accountant" ? "Clara Contadora" : "Ana Lima",
    email: "pessoa@exemplo.test",
    isDemoOrganization,
  };
}

function shellData(overrides: Partial<ShellData> = {}): ShellData {
  return {
    organizationName: "Grupo Aurora (fictício)",
    unitName: "São Paulo",
    lawFirmName: null,
    alerts: { total: 12, critical: 3 },
    aiMode: "demo",
    caseBriefMode: "demo",
    emailMode: "simulated",
    ...overrides,
  };
}

/** Body of a page, so the screenshot shows the header in context. */
function samplePage(): ReactNode {
  return createElement(
    "div",
    { className: "space-y-4" },
    createElement("h1", { className: "text-2xl font-semibold tracking-tight text-slate-900" }, "Painel executivo"),
    createElement(
      "p",
      { className: "text-sm text-muted-foreground" },
      "Conteúdo da página (ilustrativo, renderizado só para conferir o cabeçalho).",
    ),
    createElement(
      "div",
      { className: "grid gap-4 sm:grid-cols-3" },
      ...["Audiências", "Prazos fatais", "Valores pendentes de conferência"].map((t) =>
        createElement("div", { key: t, className: "h-28 rounded-lg border border-border bg-surface p-4 text-sm font-medium" }, t),
      ),
    ),
  );
}

async function renderShell(ctx: AuthContext, shell: ShellData): Promise<string> {
  state.ctx = ctx;
  state.shell = shell;
  return renderToStaticMarkup((await AppLayout({ children: samplePage() })) as ReactElement);
}

/** Header markup only (between <header and </header>). */
function headerOf(html: string): string {
  return html.slice(html.indexOf("<header"), html.indexOf("</header>"));
}

const panel = (node: ReactElement) =>
  renderToStaticMarkup(createElement("div", { className: HEADER_POPOVER_BOX }, node));

const out: Record<string, string> = {};

afterAll(() => {
  const dir = process.env.SHELL_PREVIEW_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const [name, html] of Object.entries(out)) writeFileSync(path.join(dir, `${name}.fragment.html`), html, "utf8");
});

describe("app shell header", () => {
  it("shows the demo banner in one short line with a 'Saiba mais' trigger", async () => {
    const html = await renderShell(ctxFor("admin", true), shellData());
    out["shell-admin"] = html;
    const banner = html.slice(html.indexOf('role="note"'), html.indexOf("<header"));
    expect(textOf(`<div ${banner}`)).toContain(
      "Ambiente de demonstração: dados fictícios. Análise preliminar e e-mails são simulados.",
    );
    expect(banner).toContain("Saiba mais");
    expect(banner).toContain('aria-haspopup="dialog"');
    // The old two-sentence warning is now in the "Saiba mais" panel.
    expect(banner).not.toContain("Não insira informações reais");
  });

  it("replaces the AI mode and e-mail badges with one 'Simulações' badge", async () => {
    const header = headerOf(await renderShell(ctxFor("admin", true), shellData()));
    const text = textOf(header);
    expect(text).toContain("Simulações");
    expect(text.match(/Simulações/g)).toHaveLength(1);
    expect(text).not.toContain("Modo demonstrativo");
    expect(text).not.toContain("E-mail simulado");
    expect(header).not.toContain('href="/emails"');
    expect(header).not.toContain('href="/ia"');
  });

  it("keeps the bell count and moves the critical count into the bell panel", async () => {
    const header = headerOf(await renderShell(ctxFor("admin", true), shellData()));
    expect(header).toContain('aria-label="Alertas e pendências: 12 abertos, 3 críticos"');
    expect(textOf(header)).toContain("12");
    // No separate "N críticos" pill or link in the header.
    expect(textOf(header)).not.toMatch(/críticos?/);
    expect(header).not.toContain("severidade=critical");
  });

  it("shows no banner outside demo organizations, but still labels the simulations", async () => {
    const html = await renderShell(ctxFor("lawyer", false), shellData({ alerts: { total: 0, critical: 0 } }));
    out["shell-lawyer-nondemo"] = html;
    expect(html).not.toContain("Ambiente de demonstração");
    expect(textOf(headerOf(html))).toContain("Simulações");
    expect(headerOf(html)).toContain('aria-label="Alertas e pendências: nenhum alerta aberto"');
  });

  it("hides the badge when nothing is simulated", async () => {
    const html = await renderShell(
      ctxFor("admin", false),
      shellData({ aiMode: "live", caseBriefMode: "live", emailMode: "live" }),
    );
    expect(textOf(headerOf(html))).not.toContain("Simulações");
  });

  it("renders for a profile without e-mail, analysis or brief access", async () => {
    const html = await renderShell(ctxFor("accountant", true), shellData({ alerts: { total: 2, critical: 0 } }));
    out["shell-accountant"] = html;
    expect(textOf(headerOf(html))).toContain("Simulações");
  });

  it("uses no em dash or spaced en dash in the rendered shell", async () => {
    for (const role of ["admin", "accountant", "external_counsel"] as const) {
      const html = await renderShell(ctxFor(role, true), shellData());
      expect(textOf(html)).not.toMatch(DASHES);
      expect(html).not.toMatch(/aria-label="[^"]*[—–]/);
    }
  });
});

describe("header panels", () => {
  it("lists the simulations with links only where the profile can go", () => {
    const allowedFor = (role: Role) => (p: Parameters<typeof can>[1]) => can({ role, kind: "user" }, p);
    const modes = { aiMode: "demo", caseBriefMode: "demo", emailMode: "simulated" } as const;

    const admin = panel(createElement(SimulationsPanel, { items: simulationItems(modes, allowedFor("admin")) }));
    out["panel-simulations-admin"] = admin;
    const adminText = textOf(admin);
    for (const t of ["Simulações neste ambiente", "Análise preliminar simulada", "E-mails simulados"]) {
      expect(adminText).toContain(t);
    }
    expect(admin).toContain('href="/ia"');
    expect(admin).toContain('href="/emails"');
    expect(admin).toContain('href="/analises-preliminares"');

    const accountant = panel(createElement(SimulationsPanel, { items: simulationItems(modes, allowedFor("accountant")) }));
    out["panel-simulations-accountant"] = accountant;
    expect(textOf(accountant)).toContain("E-mails simulados");
    expect(accountant).not.toContain("href=");
    for (const html of [admin, accountant]) expect(textOf(html)).not.toMatch(DASHES);
  });

  it("shows the critical count inside the bell panel", () => {
    const critical = panel(createElement(AlertsPanel, { counts: { total: 1200, critical: 3 } }));
    out["panel-alerts-critical"] = critical;
    expect(textOf(critical)).toMatch(/Críticos 3/);
    expect(textOf(critical)).toMatch(/Abertos 1\.200/);
    expect(critical).toContain('href="/alertas?severidade=critical"');
    expect(critical).toContain('href="/alertas"');

    const calm = panel(createElement(AlertsPanel, { counts: { total: 1, critical: 0 } }));
    out["panel-alerts-calm"] = calm;
    expect(textOf(calm)).toContain("Nenhum alerta crítico.");
    expect(textOf(calm)).toMatch(/Aberto 1/);
    expect(calm).not.toContain("severidade=critical");

    const empty = panel(createElement(AlertsPanel, { counts: { total: 0, critical: 0 } }));
    out["panel-alerts-empty"] = empty;
    expect(textOf(empty)).toContain("Nenhum alerta aberto.");
    for (const html of [critical, calm, empty]) expect(textOf(html)).not.toMatch(DASHES);
  });

  it("explains the demo environment in the 'Saiba mais' panel", () => {
    const html = panel(createElement(DemoInfoPanel));
    out["panel-demo-info"] = html;
    const text = textOf(html);
    expect(text).toContain("fictícios");
    expect(text).toContain("Não insira informações reais ou confidenciais.");
    expect(html).toContain('href="/#como-funciona"');
    expect(text).not.toMatch(DASHES);
  });
});
