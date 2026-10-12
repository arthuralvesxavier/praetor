/**
 * P0.6 final check, painel: comparisons outside the dashboard.
 * - "Maiores variações de provisão" (/contingencias/provisao) never mixes an estimate with a
 *   provision on the valor apurado: `SnapshotMovement` carries fromIsEstimate/toIsEstimate and a
 *   change of basis has no difference (`deltaCents: null`).
 * - /relatorios?tipo=exposicao with a comparison keeps six columns: the previous competência and the
 *   variation go under each amount (it used to be nine columns, wider than the card at 1440 px).
 * - Process links use the P0.6 tab keys.
 *
 * Data: the fictional portfolio of tests/sweep/comparison-scenario.ts (two closed competências).
 * With FINAL_PAINEL_SHOTS=1 the screens are also written as static HTML to .data/p06-shots/final-painel.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

import { todayISO } from "@/lib/format";
import { addValuation } from "@/modules/contingency/service";
import { generateSnapshot, getSnapshot } from "@/modules/contingency/snapshot-service";
import { ExposureReportView } from "@/modules/reports/components/report-views";
import { getExposureReport } from "@/modules/reports/service";
import { setupFixture, type Fixture } from "../../helpers/fixtures";
import { buildComparisonScenario, type ComparisonScenario } from "../../sweep/comparison-scenario";

const SHOTS = process.env.FINAL_PAINEL_SHOTS === "1";
const OUT = path.resolve(".data/p06-shots/final-painel");

type PageFn = (props: never) => Promise<ReactNode>;

const plain = (html: string) => html.replace(/ /g, " ");
const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Table row (`<tr>…</tr>`) whose first cell contains `label`. */
function row(html: string, label: string): string {
  return html.match(new RegExp(`<tr[^>]*><(?:td|th)[^>]*>(?:<[^>]+>)*${label}(?:(?!</tr>).)*</tr>`, "s"))?.[0] ?? "";
}

async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveTree(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  }
  const props = { ...el.props };
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (key === "children" || key === "aside" || isValidElement(v) || Array.isArray(v)) props[key] = await resolveTree(v as ReactNode);
  }
  return { ...el, props } as ReactElement;
}

async function renderPage(load: () => Promise<{ default: unknown }>, sp: Record<string, string>): Promise<string> {
  session.current = f.ctx.admin;
  const page = (await load()).default as PageFn;
  const tree = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(sp) } as never);
  return plain(renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree))));
}

function shot(name: string, html: string) {
  if (!SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${name}.fragment.html`), html, "utf8");
}

/** The "Maiores variações de provisão" list of /contingencias/provisao. */
function largestChanges(html: string): string {
  return html.match(/Maiores variações de provisão<\/p>[\s\S]*?(?:<\/ul>|<\/p>)/)?.[0] ?? "";
}

let f: Fixture;
let s: ComparisonScenario;

beforeAll(async () => {
  f = await setupFixture("final-painel-comp");
  s = await buildComparisonScenario(f);
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

describe("/relatorios?tipo=exposicao with a comparison", () => {
  it("keeps six columns and puts the previous amount and the variation under each amount", async () => {
    const report = await getExposureReport(f.ctx.admin);
    expect(report.comparison?.period).toBe(s.last);
    const html = plain(renderToStaticMarkup(createElement(ExposureReportView, { report })));
    const heads = [...html.matchAll(/<thead[\s\S]*?<\/thead>/g)].map((m) => m[0]);
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head.match(/<th /g)).toHaveLength(6);
      expect(head.match(/antes e variação/g)).toHaveLength(3);
    }
    expect(html).not.toContain("Var. exposição");
    expect(html).not.toContain("Var. processos");

    // TRT2: nothing apurado last month (estimates only), apurado now; estimates compared on both sides.
    const trt2 = visible(row(html, "TRT2"));
    expect(trt2).toContain("antes não apurada sem base de comparação");
    expect(trt2).toContain("antes R$ 13.000,00 − R$ 10.000,00 (redução)");
    // TRT9: no process last month. The count is a value (antes 0, +1); the amounts have no basis.
    const trt9 = visible(row(html, "TRT9"));
    expect(trt9).toMatch(/^TRT9 1 antes 0 \+1/);
    expect(trt9).toContain("antes sem processos sem base de comparação");
    expect(trt9).not.toMatch(/aumento|redução/);
    // TRT3: apurado on both sides, compared.
    expect(visible(row(html, "TRT3"))).toContain("antes R$ 7.600,00 sem variação");
  });

  it("renders the page for the visual check", async () => {
    const html = await renderPage(() => import("@/app/(app)/relatorios/page"), { tipo: "exposicao" });
    shot("relatorio-exposicao-comparacao", html);
    expect(html).toContain("antes e variação");
    expect(visible(html)).not.toMatch(/[—–]/);
  }, 60_000);
});

describe("provision movement between competências", () => {
  it("flags the basis of each side and computes no difference across bases", async () => {
    const view = (await getSnapshot(f.ctx.admin, s.last))!;
    const q5 = view.movement?.provisionChanges.find((c) => c.processId === s.ids.Q5);
    // R$ 3.000,00 estimated (valor da causa) → R$ 3.600,00 on the valor apurado: a change of basis.
    expect(q5).toMatchObject({ fromCents: 300_000, fromIsEstimate: true, toCents: 360_000, toIsEstimate: false, deltaCents: null });
    const added = view.movement?.added.find((a) => a.processId === s.ids.Q3);
    expect(added).toMatchObject({ provisionCents: 100_000, provisionIsEstimate: false });
  });

  it("'Maiores variações de provisão' labels the change of basis instead of a plain difference", async () => {
    const html = await renderPage(() => import("@/app/(app)/contingencias/provisao/page"), { competencia: s.last });
    shot("provisao-movimentacao", html);
    const list = visible(largestChanges(html));
    expect(list).toContain("R$ 3.600,00 apurada antes R$ 3.000,00 estimada (mudança de base)");
    expect(list).not.toContain("R$ 600,00");
    // Entered the portfolio: the amount with its basis.
    expect(visible(html)).toMatch(/Entraram na carteira \S+ R\$ 1\.000,00 apurada/);
    expect(visible(html)).not.toMatch(/[—–]/);
  }, 60_000);

  it("orders by the difference on the same basis and by the larger amount for a change of basis", async () => {
    // This month: Q1 goes from the estimate (R$ 10.000,00) to the valor apurado (R$ 5.000,00);
    // Q3 stays on the valor apurado, R$ 1.000,00 → R$ 1.300,00 (possível, 50% of 260.000).
    await addValuation(f.ctx.manager, { processId: s.ids.Q3, kind: "liquidated", amountCents: 260_000, baseDate: todayISO() });
    await generateSnapshot(f.ctx.manager, s.current);
    const view = (await getSnapshot(f.ctx.admin, s.current))!;
    const changes = view.movement!.provisionChanges;
    expect(changes.map((c) => c.processId)).toEqual([s.ids.Q1, s.ids.Q3]);
    expect(changes[0]).toMatchObject({ fromCents: 1_000_000, fromIsEstimate: true, toCents: 500_000, toIsEstimate: false, deltaCents: null });
    expect(changes[1]).toMatchObject({ fromCents: 100_000, fromIsEstimate: false, toCents: 130_000, toIsEstimate: false, deltaCents: 30_000 });

    const html = await renderPage(() => import("@/app/(app)/contingencias/provisao/page"), { competencia: s.current });
    shot("provisao-movimentacao-atual", html);
    const list = visible(largestChanges(html));
    expect(list).toContain("R$ 5.000,00 apurada antes R$ 10.000,00 estimada (mudança de base)");
    expect(list).toContain("+ R$ 300,00 (aumento)");
    expect(list).not.toContain("R$ 5.000,00 (redução)");
  }, 60_000);
});

describe("process links of /contingencias/provisao", () => {
  it("open the 'Valores e acordos' tab (risk card for the processes without classification)", async () => {
    const html = await renderPage(() => import("@/app/(app)/contingencias/provisao/page"), { competencia: s.last });
    // Memória de cálculo and movement lists.
    expect(html).toContain(`href="/processos/${s.ids.Q5}?aba=valores-e-acordos"`);
    expect(html).toContain(`href="/processos/${s.ids.Q3}?aba=valores-e-acordos"`);
    // Closed with a justification: the unclassified process opens the risk classification card.
    expect(html).toContain(`href="/processos/${s.ids.Q4}?aba=valores-e-acordos#classificacao-risco"`);
    expect(html).not.toMatch(/\?aba=valores"/);
    expect(html).not.toMatch(/\?aba=valores#/);
  }, 60_000);
});
