/**
 * "Nulo não é zero" on the screens reviewed in the text sweep: a group where nothing
 * was calculated reads "Não apurada", "Não calculada", "Sem estimativa" or "Não
 * informado" (muted), never R$ 0,00; a zero is shown only when it was calculated.
 * Covers the domain counters, the report tables, the dashboard provision card, the
 * contract renewal history and `/contingencias` (rendered with PGlite data).
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
import {
  addProvisionBasis,
  addToBucket,
  emptyBasisCounts,
  emptyBucket,
  exposureBasisCounts,
  provisionBasisForClass,
  type ExposureInput,
  type MoneyBucket,
} from "@/domain/contingency";
import { ContractLifecycleCard } from "@/modules/contracts/components/lifecycle-card";
import type { BiFilters } from "@/modules/dashboard/bi-filters";
import { PortfolioKpis } from "@/modules/dashboard/components/portfolio-panel";
import { liquidatedCoverage, netExposureSummary } from "@/modules/dashboard/portfolio";
import type { PortfolioData } from "@/modules/dashboard/portfolio-service";
import { ExposureReportView, PortfolioReportView, ProvisionReportView } from "@/modules/reports/components/report-views";
import type { ExposureReport, PortfolioReport, ProvisionReport } from "@/modules/reports/types";
import { legalProcesses } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";

const plain = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/ /g, " ");
const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** Table row (`<tr>…</tr>`) whose first cell contains `label`. */
function row(html: string, label: string): string {
  return html.match(new RegExp(`<tr[^>]*><(?:td|th)[^>]*>(?:<[^>]+>)*${label}(?:(?!</tr>).)*</tr>`, "s"))?.[0] ?? "";
}

const possibleNoClaim: ExposureInput = { liquidatedCents: null, linkedGuaranteesCents: 0, claimCents: null, riskPercentageBp: 5_000 };
const possibleWithClaim: ExposureInput = { liquidatedCents: null, linkedGuaranteesCents: 0, claimCents: 1_000_000, riskPercentageBp: 5_000 };
const unclassifiedApurado: ExposureInput = { liquidatedCents: 400_000, linkedGuaranteesCents: 0, claimCents: null, riskPercentageBp: null };

function bucketOf(items: ExposureInput[]): MoneyBucket {
  return items.reduce((b, i) => addToBucket(b, i), emptyBucket());
}

describe("basis counters (domain)", () => {
  it("split the exposure of a bucket into apurada, estimated and without basis", () => {
    const b = bucketOf([possibleNoClaim, possibleWithClaim, unclassifiedApurado]);
    expect(exposureBasisCounts(b)).toEqual({ official: 1, estimate: 1, none: 1 });
    expect(exposureBasisCounts(emptyBucket())).toEqual({ official: 0, estimate: 0, none: 0 });
  });

  it("count provisions per process: an unclassified process never has one", () => {
    const counts = [possibleNoClaim, possibleWithClaim, unclassifiedApurado].reduce((c, i) => addProvisionBasis(c, i), emptyBasisCounts());
    expect(counts).toEqual({ official: 0, estimate: 1, none: 2 });
    expect(provisionBasisForClass(bucketOf([unclassifiedApurado]), false)).toEqual({ official: 0, estimate: 0, none: 1 });
    expect(provisionBasisForClass(bucketOf([possibleNoClaim, possibleWithClaim]), true)).toEqual({ official: 0, estimate: 1, none: 1 });
  });
});

const ctxBase = {
  scope: { orgWide: true, includesConfidential: false, label: "Carteira da organização (fictícia).", totalLabel: "Total" },
  generatedAt: new Date("2026-10-12T12:00:00Z"),
  organizationName: "Organização Fictícia S.A.",
  filterSummary: "Todas as empresas",
};

describe("report tables", () => {
  it("exposure: a group without valor apurado reads 'Não apurada' (never R$ 0,00 + não calculável)", () => {
    // "Conhecimento": one estimated process and one without any basis.
    const bucket = bucketOf([possibleWithClaim, possibleNoClaim]);
    const r = { key: "knowledge", label: "Conhecimento", processCount: 2, bucket, previous: null };
    const report: ExposureReport = {
      ...ctxBase,
      type: "exposicao",
      comparison: null,
      comparisonNote: "Sem comparação (fictício).",
      dimensions: [{ key: "phase", label: "Fase", rows: [r] }],
      totals: { ...r, key: "total", label: "Total" },
      hasEstimates: true,
    };
    const line = visible(row(plain(createElement(ExposureReportView, { report })), "Conhecimento"));
    expect(line).toContain("Não apurado"); // valor liquidado
    expect(line).toContain("Não apurada"); // exposição apurada
    expect(line).toContain("R$ 5.000,00"); // exposição estimada (causa × 50%)
    expect(line).toContain("1 sem base de cálculo");
    expect(line).not.toContain("R$ 0,00");
    expect(line).not.toContain("calculáve");
  });

  it("portfolio: the unclassified group reads 'Não calculada' and 'Sem estimativa', never R$ 0,00", () => {
    const unclassified = bucketOf([{ ...possibleNoClaim, riskPercentageBp: null }]);
    const possible = bucketOf([possibleWithClaim]);
    const totals = bucketOf([{ ...possibleNoClaim, riskPercentageBp: null }, possibleWithClaim]);
    const report: PortfolioReport = {
      ...ctxBase,
      type: "carteira",
      byCompany: [],
      byUnit: [],
      byClassification: [
        { key: "possible", label: "Possível", processCount: 1, bucket: possible, provisionBasis: { official: 0, estimate: 1, none: 0 } },
        { key: "unclassified", label: "Sem classificação", processCount: 1, bucket: unclassified, provisionBasis: { official: 0, estimate: 0, none: 1 } },
      ],
      totals: { key: "total", label: "Total", processCount: 2, bucket: totals, provisionBasis: { official: 0, estimate: 1, none: 1 } },
      hasEstimates: true,
    };
    const html = plain(createElement(PortfolioReportView, { report }));
    const none = visible(row(html, "Sem classificação"));
    expect(none).toContain("Não informado");
    expect(none).toContain("Não apurada");
    expect(none).toContain("Não calculada");
    expect(none).toContain("Sem estimativa");
    expect(none).not.toContain("R$ 0,00");
    const possibleLine = visible(row(html, "Possível"));
    expect(possibleLine).toContain("Não apurada"); // provision on the valor apurado
    expect(possibleLine).toContain("R$ 5.000,00"); // estimated provision
  });

  it("provision: the unclassified class reads 'Não calculada' in both columns", () => {
    const report: ProvisionReport = {
      ...ctxBase,
      type: "provisao",
      closedPeriods: ["2026-09"],
      snapshot: {
        id: "s1",
        period: "2026-09",
        referenceDate: "2026-09-30",
        status: "closed",
        closedAt: new Date("2026-10-02T15:00:00Z"),
        closedByName: "Clara Contadora",
        params: { riskPercentages: { probable: 100, possible: 50, remote: 0 }, rulesVersion: 2, confidenceThreshold: 80 },
      },
      previous: null,
      byClassification: [
        {
          key: "unclassified",
          label: "Sem classificação",
          percentageBp: null,
          processCount: 1,
          current: { provisionCents: 0, provisionEstimateCents: 0 },
          currentBasis: { official: 0, estimate: 0, none: 1 },
          previous: null,
        },
      ],
      totals: {
        key: "unclassified",
        label: "Total",
        percentageBp: null,
        processCount: 1,
        current: { provisionCents: 0, provisionEstimateCents: 0 },
        currentBasis: { official: 0, estimate: 0, none: 1 },
        previous: null,
      },
      movement: null,
      items: [],
      hasEstimates: false,
    };
    const html = plain(createElement(ProvisionReportView, { report }));
    const line = visible(row(html, "Sem classificação"));
    expect(line.match(/Não calculada/g)).toHaveLength(2);
    expect(line).not.toContain("R$ 0,00");
    const total = visible(row(html, "Total"));
    expect(total).toContain("Não apurada");
    expect(total).toContain("Sem estimativa");
    expect(total).not.toContain("R$ 0,00");
  });
});

describe("dashboard provision card", () => {
  it("shows 'Não calculada' / 'Sem estimativa' instead of R$ 0 for groups without basis", () => {
    const filters: BiFilters = { period: "12m", unitId: null, area: null, responsibleId: null, companyId: null };
    const unclassified = bucketOf([unclassifiedApurado]);
    const probable = bucketOf([{ ...unclassifiedApurado, riskPercentageBp: 10_000 }]);
    const totals = bucketOf([unclassifiedApurado, { ...unclassifiedApurado, riskPercentageBp: 10_000 }]);
    const data: PortfolioData = {
      activeProcesses: 2,
      totals,
      netExposure: netExposureSummary([], []),
      coverage: liquidatedCoverage(totals),
      registrationGaps: [],
      byClassification: [
        { key: "remote", bucket: emptyBucket(), provisionBasis: emptyBasisCounts() },
        { key: "possible", bucket: emptyBucket(), provisionBasis: emptyBasisCounts() },
        { key: "probable", bucket: probable, provisionBasis: { official: 1, estimate: 0, none: 0 } },
        { key: "unclassified", bucket: unclassified, provisionBasis: { official: 0, estimate: 0, none: 1 } },
      ],
      dimensions: {} as PortfolioData["dimensions"],
      top: [],
      previous: null,
    };
    const html = plain(createElement(PortfolioKpis, { data, filters }));
    const split = html.match(/<table class="w-full text-left text-xs">[\s\S]*?<\/table>/)?.[0] ?? "";
    const none = visible(row(split, "Não classificada"));
    expect(none).toContain("1/1");
    expect(none.match(/Não calculada/g)).toHaveLength(2);
    expect(none).not.toMatch(/R\$/);
    expect(visible(row(split, "Provável"))).toContain("Sem estimativa");
    // The "Estimada" figure of the card: nothing was estimated.
    const card = html.match(/<section aria-label="Provisão"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(visible(card)).toContain("Estimada Estimativa Sem estimativa");
  });
});

describe("contract renewal history", () => {
  it("writes 'indeterminado' for a missing end date, never 'Não informado'", () => {
    const html = plain(
      createElement(ContractLifecycleCard, {
        events: [
          {
            id: "e1",
            kind: "renewal",
            createdAt: new Date("2026-10-01T12:00:00Z"),
            actorName: "Ana Admin",
            previousEndDate: null,
            newEndDate: "2027-10-01",
            terminationDate: null,
            note: null,
            document: null,
          },
        ],
      }),
    );
    expect(visible(html)).toContain("Término: indeterminado → 01/10/2027");
    expect(html).not.toContain("Não informado");
  });
});

// ---------------------------------------------------------------------------
// /contingencias with PGlite data
// ---------------------------------------------------------------------------

let f: Fixture;

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

describe("/contingencias", () => {
  beforeAll(async () => {
    f = await setupFixture("nullzero");
    const base = { organizationId: f.orgA, area: "labor" as const, phase: "knowledge" as const, court: "TRT-10", instance: "first" as const, companyId: f.companyA };
    await f.db.insert(legalProcesses).values([
      // Classified, valor da causa only: estimated provision.
      { ...base, number: "0000301-11.2026.5.10.0001", title: "Processo fictício estimado", lossProbability: "possible", claimAmountCents: 2_000_000 },
      // No classification and no valor da causa: nothing can be calculated.
      { ...base, number: "0000302-11.2026.5.10.0001", title: "Processo fictício sem base", lossProbability: null, claimAmountCents: null },
    ]);
  });

  afterAll(async () => {
    await f?.teardown();
  });

  it("never prints R$ 0,00 for the unclassified row without valor da causa", async () => {
    session.current = f.ctx.admin;
    const tree = await ContingenciesPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree))).replace(/ /g, " ");
    const table = html.match(/<table[^>]*aria-label="Provisão por classificação"[\s\S]*?<\/table>/)?.[0] ?? "";
    const none = visible(row(table, "Não classificado"));
    expect(none).toContain("Não informado");
    expect(none).toContain("Não apurado");
    expect(none.match(/Não calculada/g)).toHaveLength(2);
    expect(none).not.toContain("R$");
    expect(visible(row(table, "Remota"))).toContain("Nenhum processo nesta classificação");
    const possible = visible(row(table, "Possível"));
    expect(possible).toContain("Não apurada");
    expect(possible).toContain("R$ 10.000,00");
    // Breakdown by phase: the group has no valor apurado and one process without basis.
    expect(visible(html)).toContain("Não apurada R$ 10.000,00 estimada 1 sem base de cálculo");
    expect(table).not.toContain("R$ 0,00");
  });
});
