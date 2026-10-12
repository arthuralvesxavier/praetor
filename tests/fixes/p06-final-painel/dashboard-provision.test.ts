/**
 * P0.6 final check, painel: the provision on the valor apurado of the dashboard is decided by the
 * PROVISION basis, never by the valor apurado coverage (a process with a valor apurado but no risk
 * classification has no provision), and the comparison with the previous closing is made only when
 * both sides have the amount on the same basis (same rule as `variationOf` in the reports).
 *
 * Reviewer's scenario (fictional, amounts in cents):
 *   P1 TRT7  provável, valor da causa 100.000, no valor apurado (estimated provision R$ 1.000), filed this month
 *   P2 TRT8  no classification, valor apurado 400.000 (no provision), filed this month
 *   P3 TRT5  provável, valor apurado 300.000 in the last closed competência (provision R$ 3.000), closed since
 *
 * With FINAL_PAINEL_SHOTS=1 the dashboard is also written as static HTML to .data/p06-shots/final-painel.
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

import { eq } from "drizzle-orm";
import { emptyBasisCounts, emptyBucket, previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import type { BiFilters } from "@/modules/dashboard/bi-filters";
import { NetExposureCard } from "@/modules/dashboard/components/net-exposure-card";
import { DimensionPanel, PortfolioKpis, PreviousClosingCard, TopExposures } from "@/modules/dashboard/components/portfolio-panel";
import {
  bucketOf,
  dimensionGroups,
  exposureBasisCounts,
  liquidatedCoverage,
  netExposureSummary,
  provisionBasisOf,
  type PortfolioRowLike,
} from "@/modules/dashboard/portfolio";
import { getPortfolioPanel, type Dimension, type PortfolioData, type PreviousClosing } from "@/modules/dashboard/portfolio-service";
import { periodOf } from "@/modules/contingency/rules";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { addValuation } from "@/modules/contingency/service";
import { closeSnapshot, generateSnapshot } from "@/modules/contingency/snapshot-service";
import { legalProcesses } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../../helpers/fixtures";

const SHOTS = process.env.FINAL_PAINEL_SHOTS === "1";
const OUT = path.resolve(".data/p06-shots/final-painel");
const ALL: BiFilters = { period: "12m", unitId: null, area: null, responsibleId: null, companyId: null };

const plain = (html: string) => html.replace(/ /g, " ");
const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => plain(renderToStaticMarkup(el));

/** Text of one DeltaFigure of the comparison card (from its label to the next figure). */
function figure(out: string, label: string): string {
  const start = out.indexOf(`>${label}</p>`);
  if (start < 0) return "";
  const rest = out.slice(start);
  const next = rest.slice(1).search(/<div class="min-w-0 rounded-md border/);
  return visible(next < 0 ? rest : rest.slice(0, next + 1));
}

/** Table row whose first cell is `label` (dimension table). */
function tableRow(out: string, label: string): string {
  return visible(out.match(new RegExp(`<tr[^>]*><th[^>]*>${label}</th>(?:(?!</tr>).)*</tr>`, "s"))?.[0] ?? "");
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

let f: Fixture;
const ids: Record<string, string> = {};
let last = "";

beforeAll(async () => {
  f = await setupFixture("final-painel");
  const today = todayISO();
  const current = periodOf(today);
  last = previousPeriod(current);
  const m = f.ctx.manager;
  let seq = 0;
  const proc = async (key: string, court: string, filedAt: string) => {
    seq += 1;
    const [p] = await f.db
      .insert(legalProcesses)
      .values({
        organizationId: f.orgA,
        number: `${String(4_200_000 + seq * 11).padStart(7, "0")}-55.2025.5.07.0001`,
        title: `Reclamação trabalhista ${key} (fictícia, painel)`,
        court,
        area: "labor",
        phase: "knowledge",
        instance: "first",
        city: "Fortaleza",
        companyId: f.companyA,
        unitId: f.unitSp,
        filedAt,
      })
      .returning();
    ids[key] = p.id;
  };
  const opinion = "Parecer fictício para o teste do painel.";

  // Last competência: only P3, provável with a valor apurado (provision R$ 3.000 on the valor apurado).
  await proc("P3", "TRT5", `${last}-01`);
  await addValuation(m, { processId: ids.P3, kind: "liquidated", amountCents: 300_000, baseDate: `${last}-02` });
  await addRiskAssessment(m, ids.P3, { classification: "probable", opinion, effectiveFrom: `${last}-01` });
  await generateSnapshot(m, last);
  await closeSnapshot(m, last);
  await f.db.update(legalProcesses).set({ status: "closed", closedAt: today }).where(eq(legalProcesses.id, ids.P3));

  // This month: P1 provável without valor apurado (estimate), P2 with valor apurado and no classification.
  await proc("P1", "TRT7", `${current}-01`);
  await addValuation(m, { processId: ids.P1, kind: "claim", amountCents: 100_000, baseDate: `${current}-01` });
  await addRiskAssessment(m, ids.P1, { classification: "probable", opinion, effectiveFrom: `${current}-01` });
  await proc("P2", "TRT8", `${current}-01`);
  await addValuation(m, { processId: ids.P2, kind: "liquidated", amountCents: 400_000, baseDate: `${current}-01` });
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

async function panel(): Promise<PortfolioData> {
  const r = await getPortfolioPanel(f.ctx.admin, ALL);
  if (r.status !== "ok") throw new Error(`painel indisponível: ${r.status}`);
  return r.data;
}

describe("dashboard provision on the valor apurado (reviewer's scenario)", () => {
  it("reads the stored basis of the previous closing in SQL", async () => {
    const d = await panel();
    expect(d.coverage).toMatchObject({ assessed: 1, total: 2 });
    expect(d.previous?.period).toBe(last);
    expect(d.previous?.totals).toMatchObject({ count: 1, provisionCents: 300_000, exposureCents: 300_000, exposureEstimateCents: 0 });
    expect(d.previous?.exposureBasis).toEqual({ official: 1, estimate: 0, none: 0 });
    expect(d.previous?.provisionBasis).toEqual({ official: 1, estimate: 0, none: 0 });
    // Current: no provision on the valor apurado anywhere (P2 has no classification).
    const unclassified = d.byClassification.find((c) => c.key === "unclassified");
    expect(unclassified?.provisionBasis).toEqual({ official: 0, estimate: 0, none: 1 });
    expect(d.totals.provisionCents).toBe(0);
  });

  it("KPI 'Provisão > Apurada' reads 'Não calculada', never R$ 0", async () => {
    const out = html(createElement(PortfolioKpis, { data: await panel(), filters: ALL }));
    const card = visible(out.match(/<section aria-label="Provisão"[\s\S]*?<\/section>/)?.[0] ?? "");
    expect(card).toContain("Apurada Não calculada Apurado em 1 de 2 processos (50%) 1 processo apurado sem classificação de risco");
    expect(card).toContain("Estimada Estimativa R$ 1 mil");
    expect(card).not.toMatch(/Apurada R\$/);
    expect(card).not.toContain("R$ 0");
  });

  it("the comparison card compares only amounts that exist on both sides", async () => {
    const out = html(createElement(PreviousClosingCard, { data: await panel(), closingsHref: null }));
    const provision = figure(out, "Provisão apurada");
    expect(provision).toContain("Provisão apurada Não calculada");
    expect(provision).toContain("Sem base de comparação: provisão não calculada agora");
    expect(provision).toContain("No fechamento: R$ 3 mil");
    expect(provision).not.toMatch(/Redução|Aumento|−100|R\$ 0/);

    const estimate = figure(out, "Exposição estimada");
    expect(estimate).toContain("Exposição estimada R$ 1 mil");
    expect(estimate).toContain("Sem base de comparação: sem estimativa no fechamento");
    expect(estimate).toContain("No fechamento: sem estimativa");
    expect(estimate).not.toMatch(/Aumento|R\$ 0/);

    // Valor apurado on both sides: the regular delta.
    const exposure = figure(out, "Exposição apurada");
    expect(exposure).toContain("Aumento de +R$ 1 mil (+33,3%)");
    expect(exposure).toContain("No fechamento: R$ 3 mil");
  });

  it("the per-dimension provision column uses the provision basis", async () => {
    const d = await panel();
    const out = html(createElement(DimensionPanel, { dimension: d.dimensions.court }));
    const trt8 = tableRow(out, "TRT8");
    expect(trt8).toContain("R$ 4.000,00"); // valor liquidado and exposição apurada
    expect(trt8).toMatch(/Não calculada$/); // provisão apurada: valor apurado without classification
    const trt7 = tableRow(out, "TRT7");
    expect(trt7).toMatch(/Sem valor apurado$/);
    expect(out).not.toContain("R$ 0,00");
  });

  it("links the largest exposures and deductions to the 'Valores e acordos' tab", async () => {
    const d = await panel();
    const top = html(createElement(TopExposures, { items: d.top }));
    expect(top).toContain(`href="/processos/${ids.P2}?aba=valores-e-acordos"`);
    expect(top).not.toMatch(/\?aba=valores"/);
    const rows: PortfolioRowLike[] = [
      { ...baseRow, processId: "g", number: "1", liquidatedCents: 500_000, guaranteesCents: 100_000 },
    ];
    const card = html(createElement(NetExposureCard, { summary: netExposureSummary(rows, [{ kind: "judicial_deposit", count: 1, amountCents: 100_000 }]) }));
    expect(card).toContain('href="/processos/g?aba=valores-e-acordos"');
  });

  it.runIf(SHOTS)("writes the dashboard of the scenario as static HTML", async () => {
    session.current = f.ctx.admin;
    const { default: DashboardPage } = await import("@/app/(app)/dashboard/page");
    const tree = await (DashboardPage as unknown as (p: unknown) => Promise<ReactNode>)({
      params: Promise.resolve({}),
      searchParams: Promise.resolve({}),
    });
    const out = renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree)));
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "dashboard-provisao.fragment.html"), out, "utf8");
    expect(out).toContain("Não calculada");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Pure renders: the other combinations of the comparison card and the dimension table
// ---------------------------------------------------------------------------

const baseRow: PortfolioRowLike = {
  processId: "p",
  number: "0",
  companyId: null,
  unitId: null,
  court: "TRT10",
  instance: "first",
  phase: "knowledge",
  city: "Palmas",
  classification: "probable",
  percentageBp: 10_000,
  claimCents: 100_000,
  liquidatedCents: null,
  guaranteesCents: 0,
};

function closing(rows: PortfolioRowLike[]): PreviousClosing {
  const totals = bucketOf(rows);
  return {
    period: "2026-09",
    referenceDate: "2026-09-30",
    closedAt: null,
    totals,
    exposureBasis: exposureBasisCounts(totals),
    provisionBasis: provisionBasisOf(rows),
  };
}

function dataOf(rows: PortfolioRowLike[], previous: PreviousClosing | null): PortfolioData {
  const totals = bucketOf(rows);
  const keys = ["remote", "possible", "probable", "unclassified"] as const;
  const court = dimensionGroups(rows, (r) => r.court);
  const dimension: Dimension = {
    key: "court",
    rows: court.top.map((g) => ({ ...g, label: g.key, href: `/processos?tribunal=${g.key}` })),
    others: court.others,
    missing: null,
  };
  return {
    activeProcesses: rows.length,
    totals,
    netExposure: netExposureSummary(rows, []),
    coverage: liquidatedCoverage(totals),
    registrationGaps: [],
    byClassification: keys.map((key) => {
      const own = rows.filter((r) => (r.classification ?? "unclassified") === key);
      return { key, bucket: own.length ? bucketOf(own) : emptyBucket(), provisionBasis: own.length ? provisionBasisOf(own) : emptyBasisCounts() };
    }),
    dimensions: { court: dimension, instance: dimension, phase: dimension, city: dimension, company: dimension, unit: dimension },
    top: [],
    previous,
  };
}

describe("comparison card: every side without a basis", () => {
  const apuradoUnclassified: PortfolioRowLike = { ...baseRow, processId: "u", number: "2", classification: null, percentageBp: null, liquidatedCents: 400_000 };
  const apuradoProbable: PortfolioRowLike = { ...baseRow, processId: "a", number: "3", liquidatedCents: 300_000 };
  const estimateOnly: PortfolioRowLike = { ...baseRow, processId: "e", number: "1" };

  it("provision calculated now, not calculated at the closing (valor apurado without classification there)", () => {
    const out = html(createElement(PreviousClosingCard, { data: dataOf([apuradoProbable], closing([apuradoUnclassified])), closingsHref: null }));
    const provision = figure(out, "Provisão apurada");
    expect(provision).toContain("Provisão apurada R$ 3 mil");
    expect(provision).toContain("Sem base de comparação: provisão não calculada no fechamento");
    expect(provision).toContain("No fechamento: provisão não calculada");
    expect(provision).not.toMatch(/Aumento|\+100|R\$ 0/);
  });

  it("no valor apurado on a side reads 'Sem valor apurado' for the provision", () => {
    const out = html(createElement(PreviousClosingCard, { data: dataOf([estimateOnly], closing([apuradoProbable])), closingsHref: null }));
    const provision = figure(out, "Provisão apurada");
    expect(provision).toContain("Provisão apurada Sem valor apurado");
    expect(provision).toContain("Sem base de comparação: sem valor apurado agora");
    expect(provision).toContain("No fechamento: R$ 3 mil");
    // Estimate now and no estimate at the closing: no "Aumento" against a R$ 0 that was never estimated.
    const estimate = figure(out, "Exposição estimada");
    expect(estimate).toContain("Sem base de comparação: sem estimativa no fechamento");
    expect(estimate).not.toContain("Aumento");
  });

  it("estimate on both sides is compared; neither side shows no comparison line", () => {
    const both = figure(
      html(createElement(PreviousClosingCard, { data: dataOf([estimateOnly], closing([{ ...estimateOnly, claimCents: 50_000 }])), closingsHref: null })),
      "Exposição estimada",
    );
    expect(both).toContain("Aumento de +R$ 500 (+100%)");
    const neither = figure(
      html(createElement(PreviousClosingCard, { data: dataOf([apuradoProbable], closing([apuradoProbable])), closingsHref: null })),
      "Exposição estimada",
    );
    expect(neither).toContain("Exposição estimada Sem estimativa");
    expect(neither).not.toContain("Sem base de comparação");
    expect(neither).not.toContain("No fechamento");
  });

  it("a group mixing classified and unclassified valor apurado sums only the calculated provision", () => {
    const out = html(
      createElement(DimensionPanel, {
        dimension: dataOf([apuradoProbable, { ...apuradoUnclassified, court: "TRT10" }], null).dimensions.court,
      }),
    );
    expect(tableRow(out, "TRT10")).toMatch(/R\$ 3\.000,00 \(1 não calculada\)$/);
  });
});
