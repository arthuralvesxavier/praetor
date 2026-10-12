/**
 * P0.2 outside the dashboard: `/processos` (summary strip) and `/contingencias`
 * (KPIs and breakdown tables) never show "não apurado" as R$ 0 and never draw an
 * empty field as a "Não informada" category — it becomes a registration gap that
 * links to `/processos?pendencia=<campo>`. Pages rendered on the server (session
 * mocked, real services and PGlite data).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContingenciesPage from "@/app/(app)/contingencias/page";
import ProcessesPage from "@/app/(app)/processos/page";
import { legalProcesses } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let f: Fixture;

/** Replaces async function components by their output (react-dom/server does not run them). */
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

/** Rendered page, with the non-breaking spaces of the pt-BR money formats as plain spaces. */
async function render(page: (props: never) => Promise<ReactNode>, searchParams: Record<string, string> = {}): Promise<string> {
  session.current = f.ctx.admin;
  const tree = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree))).replace(/ /g, " ");
}

const section = (out: string, label: string) =>
  out.match(new RegExp(`<section aria-label(?:ledby)?="${label}"[^>]*>(?:(?!</section>).)*</section>`, "s"))?.[0] ?? "";

beforeAll(async () => {
  f = await setupFixture("p02pages");
  const base = { organizationId: f.orgA, area: "labor" as const, phase: "knowledge" as const, lossProbability: "possible" as const };
  await f.db.insert(legalProcesses).values([
    // Complete record, valor apurado.
    {
      ...base,
      number: "0000201-11.2026.5.10.0001",
      title: "Processo fictício com valor apurado",
      court: "TRT-10",
      instance: "first",
      companyId: f.companyA,
      claimAmountCents: 5_000_000,
      liquidatedAmountCents: 3_000_000,
    },
    // Complete record, não apurado.
    {
      ...base,
      number: "0000202-11.2026.5.10.0001",
      title: "Processo fictício não apurado",
      court: "TRT-10",
      instance: "first",
      companyId: f.companyA,
      claimAmountCents: 2_000_000,
      liquidatedAmountCents: null,
    },
    // Without instance and company, não apurado.
    {
      ...base,
      number: "0000203-11.2026.5.22.0001",
      title: "Processo fictício sem instância nem empresa",
      court: "TRT-22",
      instance: null,
      companyId: null,
      claimAmountCents: 1_000_000,
      liquidatedAmountCents: null,
    },
  ]);
});

afterAll(async () => {
  await f?.teardown();
});

describe("/processos summary strip", () => {
  it("reads 'Sem valor apurado' (not R$ 0,00) when no process of the view has a valor apurado", async () => {
    const totals = section(await render(ProcessesPage, { liquidado: "sem" }), "Totais do recorte filtrado");
    // Label owned by the processes page ("Valor apurado (soma)"; formerly "Valor liquidado / apurado (soma)").
    expect(totals).toMatch(/Valor (liquidado \/ )?apurado \(soma\)/);
    expect(totals).toContain("Sem valor apurado");
    expect(totals).toContain("Valor apurado em 0 de 2 processos (0%); 2 não apurados não entram como zero.");
    expect(totals).not.toContain("R$ 0,00");
    expect(totals).toContain("R$ 30.000,00"); // the claim sum is informed and stays a figure
  });

  it("shows the sum with its coverage when some process is apurado", async () => {
    const totals = section(await render(ProcessesPage), "Totais do recorte filtrado");
    expect(totals).toContain("R$ 30.000,00"); // only the apurado process: null is never added as zero
    expect(totals).toContain("Valor apurado em 1 de 3 processos (33%); 2 não apurados não entram como zero.");
    expect(totals).not.toContain("Sem valor apurado");
  });
});

describe("/contingencias", () => {
  it("keeps empty fields out of the breakdowns and lists them as registration gaps", async () => {
    const out = await render(ContingenciesPage);
    expect(out).not.toContain("Não informada");
    expect(out).not.toContain("Sem empresa informada");
    expect(out).toContain("Pendências de cadastro");
    expect(out).toContain('href="/processos?pendencia=instancia"');
    expect(out).toContain('href="/processos?pendencia=empresa"');
    expect(out).not.toContain("pendencia=tribunal"); // every court is informed
    // Official figures carry their coverage.
    expect(out).toContain("Valor apurado em 1 de 3 processos (33%).");
    expect(out).toContain('href="/processos?liquidado=sem"');
  });

  it("reads 'Sem valor apurado'/'Não apurado' instead of R$ 0 when nothing is assessed, keeping the filters in the gap links", async () => {
    const out = await render(ContingenciesPage, { tribunal: "TRT-22" });
    expect(out).toContain("Valor apurado em 0 de 1 processo (0%).");
    expect(out.match(/Sem valor apurado/g)?.length).toBe(3); // valor liquidado, exposição oficial, provisão
    const values = section(out, "valores-titulo");
    expect(values).not.toContain("R$ 0,00");
    // The breakdown rows show "Não apurada" with the estimate (no "+": there is no official amount to add to).
    expect(out).toMatch(/Não apurada<\/span><span class="block text-xs text-amber-800">R\$ 5\.000,00 estimada/);
    expect(out).toContain('href="/processos?tribunal=TRT-22&amp;pendencia=instancia"');
    expect(out).toContain('href="/processos?tribunal=TRT-22&amp;pendencia=empresa"');
  });
});
