import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addDaysISO, todayISO } from "@/lib/format";
import { upsertAlert } from "@/modules/alerts/service";
import { createHearing } from "@/modules/hearings/service";
import type { AuthContext } from "@/server/auth/context";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

/**
 * Server-render smoke tests of the /audiencias, /alertas and /prazos pages
 * (session mocked, real services and PGlite data). Async server components
 * are resolved before rendering because react-dom/server does not run them.
 */

vi.mock("server-only", () => ({}));
let currentCtx: AuthContext;
vi.mock("@/server/auth/session", () => ({
  requirePageContext: async () => currentCtx,
  requireActionContext: async () => currentCtx,
  getCurrentUser: async () => currentCtx,
}));

/** Replaces async function components by their output (recursively). */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    const out = await (el.type as (p: unknown) => Promise<ReactNode>)(el.props);
    return resolveTree(out);
  }
  const props = { ...el.props };
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (key === "children" || isValidElement(v) || Array.isArray(v)) props[key] = await resolveTree(v as ReactNode);
  }
  return { ...el, props } as ReactElement;
}

async function renderPage(
  page: (props: { params: Promise<object>; searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>,
  ctx: AuthContext,
  searchParams: Record<string, string> = {},
): Promise<string> {
  currentCtx = ctx;
  const tree = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree)));
}

let fx: Fixture;
const ids: Record<string, string> = {};
const today = todayISO();

beforeAll(async () => {
  fx = await setupFixture("hpages");
  ids.p = await makeProcess(fx.ctx.admin, { unitId: fx.unitSp, number: "3000003-33.2026.5.10.0003", title: "Processo de página (fictício)" });
  ids.h = (
    await createHearing(fx.ctx.admin, {
      processId: ids.p,
      kind: "conciliation",
      mode: "virtual",
      date: addDaysISO(today, 1),
      time: "16:20",
      responsibleId: fx.ctx.lawyer.userId,
    })
  ).id;
  await upsertAlert({
    organizationId: fx.orgA,
    type: "hearing_upcoming",
    severity: "critical",
    title: "Audiência amanhã (fictícia)",
    message: "Mensagem fictícia.",
    entityType: "hearing",
    entityId: ids.h,
    dedupeKey: `hearing_upcoming:${ids.h}`,
  });
  await upsertAlert({
    organizationId: fx.orgA,
    type: "process_needs_verification",
    severity: "info",
    title: "Processo para verificar (fictício)",
    message: "Mensagem fictícia.",
    entityType: "legal_process",
    entityId: ids.p,
    dedupeKey: `process_needs_verification:${ids.p}`,
  });
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("pages", () => {
  it("/audiencias renders the agenda grouped by day", async () => {
    const { default: Page } = await import("@/app/(app)/audiencias/page");
    const html = await renderPage(Page as never, fx.ctx.lawyer);
    expect(html).toContain("Audiências e pauta");
    expect(html).toContain("Amanhã");
    expect(html).toContain("3000003-33.2026.5.10.0003");
    expect(html).toContain("16:20");
    expect(html).toContain("Nova audiência");

    const filtered = await renderPage(Page as never, fx.ctx.lawyer, { periodo: "passadas" });
    expect(filtered).toContain("Nenhuma audiência encontrada com esses filtros");

    const reader = await renderPage(Page as never, fx.ctx.executive);
    expect(reader).not.toContain("Nova audiência");
    const other = await renderPage(Page as never, fx.ctx.lawyerRe);
    expect(other).not.toContain("3000003-33.2026.5.10.0003");
  });

  it("/alertas renders groups, area list and empty states", async () => {
    const { default: Page } = await import("@/app/(app)/alertas/page");
    const html = await renderPage(Page as never, fx.ctx.lawyer);
    expect(html).toContain("Alertas e pendências");
    expect(html).toContain("Audiências e pauta");
    expect(html).toContain("Verificações");
    expect(html).toContain(`/processos/${ids.p}?aba=audiencias`);
    expect(html).toContain("Resolver");

    const area = await renderPage(Page as never, fx.ctx.lawyer, { area: "audiencias" });
    expect(area).toContain("Audiência amanhã (fictícia)");
    expect(area).not.toContain("Processo para verificar (fictício)");

    const invalid = await renderPage(Page as never, fx.ctx.lawyer, { area: "constructor", tipo: "x", severidade: "y" });
    expect(invalid).toContain("Audiências e pauta");

    const resolved = await renderPage(Page as never, fx.ctx.lawyer, { situacao: "resolvidos" });
    expect(resolved).toContain("Nenhum alerta encontrado com esses filtros");

    const accountant = await renderPage(Page as never, fx.ctx.accountant);
    expect(accountant).not.toContain(">Resolver<");
    const adminB = await renderPage(Page as never, fx.ctx.adminB);
    expect(adminB).toContain("Nenhuma pendência em aberto");
  });

  it("/prazos calendar shows the hearing", async () => {
    const { default: Page } = await import("@/app/(app)/prazos/page");
    const month = addDaysISO(today, 1).slice(0, 7);
    const html = await renderPage(Page as never, fx.ctx.lawyer, { mes: month });
    expect(html).toContain("Audiência 16:20");
  });
});
