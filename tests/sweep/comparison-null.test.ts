/**
 * "Nulo não é zero" in the comparisons with a previous competência: the provision report
 * (classification table and movement balances), the exposure report, their CSV/XLSX exports and
 * the totals of /contingencias/provisao. An amount that did not exist on one side (no valor
 * apurado, no estimate, no process) is written as text on screen and left empty in the exports,
 * and no increase or decrease is computed against it.
 */
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

import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExposureReportView, ProvisionReportView } from "@/modules/reports/components/report-views";
import { buildReportExport } from "@/modules/reports/export-builders";
import { getExposureReport, getProvisionReport } from "@/modules/reports/service";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import { buildComparisonScenario, type ComparisonScenario } from "./comparison-scenario";

const plain = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/ /g, " ");
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
    if (key === "children" || isValidElement(v) || Array.isArray(v)) props[key] = await resolveTree(v as ReactNode);
  }
  return { ...el, props } as ReactElement;
}

let f: Fixture;
let s: ComparisonScenario;

beforeAll(async () => {
  f = await setupFixture("comparacao");
  s = await buildComparisonScenario(f);
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

/** Exported cell values of the rows whose second (or first) cell is `label`. */
function exportRow(rows: { v: unknown }[][], label: string, col = 0): unknown[] {
  const r = rows.find((cells) => cells[col]?.v === label);
  if (!r) throw new Error(`linha ${label} ausente`);
  return r.map((c) => c.v);
}

describe("provision report against the previous closed competência", () => {
  it("carries the basis of both sides", async () => {
    const r = await getProvisionReport(f.ctx.admin);
    expect(r.snapshot?.period).toBe(s.last);
    expect(r.previous?.period).toBe(s.before);
    const possible = r.byClassification.find((c) => c.key === "possible")!;
    expect(possible.previous).toMatchObject({ processCount: 1, provisionCents: 0, basis: { official: 0, estimate: 1, none: 0 }, liquidatedCount: 0 });
    const unclassified = r.byClassification.find((c) => c.key === "unclassified")!;
    expect(unclassified.previous?.basis).toEqual({ official: 0, estimate: 0, none: 1 });
    expect(r.totals.previous).toMatchObject({ processCount: 4, basis: { official: 0, estimate: 3, none: 1 }, liquidatedCount: 1 });
    expect(r.totals.currentLiquidatedCount).toBe(3);
  });

  it("never prints R$ 0,00 for a provision that did not exist, and compares only calculated amounts", async () => {
    const html = plain(createElement(ProvisionReportView, { report: await getProvisionReport(f.ctx.admin) }));
    expect(html).not.toContain("R$ 0,00");

    // Possível: nothing apurado two months ago, only the estimate.
    const possible = visible(row(html, "Possível"));
    expect(possible).toContain("R$ 1.000,00"); // provision on the valor apurado now
    expect(possible).toContain("Não apurada R$ 3.000,00 estimada"); // previous column, no "R$ 0,00 +"
    expect(possible).toContain("sem base de comparação estimada: sem variação");
    expect(possible).not.toMatch(/aumento/);

    // Provável: the estimate is compared (both sides have one), the apurada is not.
    expect(visible(row(html, "Provável"))).toContain("Não apurada R$ 13.000,00 estimada sem base de comparação estimada: − R$ 3.000,00 (redução)");

    // Sem classificação: never calculated, on either side.
    const none = visible(row(html, "Sem classificação"));
    expect(none.match(/Não calculada/g)).toHaveLength(3);
    expect(none).toContain("sem base de comparação");

    // A class without processes says so.
    expect(visible(row(html, "Remota")).match(/Sem processos/g)).toHaveLength(4);

    // Total: the valor apurado of the unclassified process existed, the provision did not.
    const total = visible(row(html, "Total da organização"));
    expect(total).toContain("R$ 4.600,00");
    expect(total).toContain("Não calculada R$ 16.000,00 estimada sem base de comparação");

    // Opening balance of the movement table reads like the classification table.
    const opening = visible(row(html, "Saldo em"));
    expect(opening).toContain("Não calculada");
    expect(opening).toContain("R$ 16.000,00");
    expect(visible(html)).toMatch(/Saldo em \S+ de \d{4} Não se aplica R\$ 4\.600,00 R\$ 13\.000,00/);
  });

  it("leaves those amounts empty in the export (never 0)", async () => {
    const exp = buildReportExport(await getProvisionReport(f.ctx.admin));
    const [byClass, movement] = exp.sheets;
    // Classificação; %; Processos; Provisão; Estimada; Processos ant.; Provisão ant.; Estimada ant.
    expect(exportRow(byClass.rows, "Possível")).toEqual(["Possível", 5000, 2, 100_000, 300_000, 1, null, 300_000]);
    expect(exportRow(byClass.rows, "Provável")).toEqual(["Provável", 10000, 2, 360_000, 1_000_000, 2, null, 1_300_000]);
    expect(exportRow(byClass.rows, "Remota")).toEqual(["Remota", 0, 0, null, null, 0, null, null]);
    expect(exportRow(byClass.rows, "Sem classificação")).toEqual(["Sem classificação", null, 1, null, null, 1, null, null]);
    expect(exportRow(byClass.rows, "Total da organização")).toEqual(["Total da organização", null, 5, 460_000, 1_300_000, 4, null, 1_600_000]);
    expect(exportRow(movement.rows, "Saldo da competência anterior")).toEqual(["Saldo da competência anterior", null, null, 1_600_000]);
    expect(exportRow(movement.rows, "Saldo da competência")).toEqual(["Saldo da competência", null, 460_000, 1_300_000]);
  });
});

describe("exposure report against the previous closed competência", () => {
  it("does not compute a change against a value that was never apurado or a group without processes", async () => {
    const report = await getExposureReport(f.ctx.admin);
    expect(report.comparison?.period).toBe(s.last);
    const html = plain(createElement(ExposureReportView, { report }));
    // TRT2: nothing apurado last month (estimates only), apurado now.
    const trt2 = visible(row(html, "TRT2"));
    expect(trt2).toContain("antes não apurada sem base de comparação");
    expect(trt2).toContain("antes R$ 13.000,00 − R$ 10.000,00 (redução)"); // both sides estimated
    // TRT9: no process last month.
    const trt9 = visible(row(html, "TRT9"));
    expect(trt9).toContain("antes sem processos sem base de comparação");
    expect(trt9).not.toContain("não apurada");
    expect(trt9).not.toMatch(/aumento|redução/);
    // TRT3: apurado on both sides, compared.
    expect(visible(row(html, "TRT3"))).toContain("antes R$ 7.600,00 sem variação");
  });

  it("leaves the previous amount and the variation empty in the export", async () => {
    const rows = buildReportExport(await getExposureReport(f.ctx.admin)).sheets[0].rows;
    // …; Processos ant.; Exposição apurada ant.; Estimada ant.; Var. apurada; Var. estimada
    expect(exportRow(rows, "TRT2", 1).slice(-5)).toEqual([2, null, 1_300_000, null, -1_000_000]);
    expect(exportRow(rows, "TRT9", 1).slice(-5)).toEqual([0, null, null, null, null]);
    expect(exportRow(rows, "TRT3", 1).slice(-5)).toEqual([2, 760_000, null, 0, null]);
  });
});

describe("/contingencias/provisao against the previous competência", () => {
  it("shows no increase or decrease for a total that did not exist before", async () => {
    session.current = f.ctx.admin;
    const { default: ProvisionPage } = await import("@/app/(app)/contingencias/provisao/page");
    const tree = await ProvisionPage({ searchParams: Promise.resolve({ competencia: s.last }) });
    const html = renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree))).replace(/ /g, " ");
    const totals = visible(html.match(/<section aria-label="Totais da competência"[\s\S]*?<\/section>/)?.[0] ?? "");
    expect(totals).toContain("Provisão (valores apurados) R$ 4.600,00 sem base de comparação");
    expect(totals).toContain("Exposição apurada R$ 9.600,00 + R$ 5.600,00 (aumento)");
    expect(totals).toContain("Provisão estimada Estimativa R$ 13.000,00 − R$ 3.000,00 (redução)");
  }, 60_000);
});
