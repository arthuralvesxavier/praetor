import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyBucket } from "@/domain/contingency";
import type { BiFilters } from "@/modules/dashboard/bi-filters";
import {
  AlertGroupsCard,
  BriefsAwaitingCard,
  IntakeCard,
  UpcomingHearingsCard,
} from "@/modules/dashboard/components/follow-up-cards";
import { DimensionChart, PortfolioKpis, PreviousClosingCard, TopExposures } from "@/modules/dashboard/components/portfolio-panel";
import { bucketOf, groupRows, rankGroups, type PortfolioRowLike } from "@/modules/dashboard/portfolio";
import type { Dimension, FollowUpData, PortfolioData } from "@/modules/dashboard/portfolio-service";

/** Server-render smoke tests of the panel components (no browser available in CI). */

const filters: BiFilters = { period: "12m", unitId: null, area: null, responsibleId: null, companyId: null };

const rows: PortfolioRowLike[] = [
  {
    processId: "a",
    number: "0000001-00.2026.5.10.0001",
    companyId: null,
    unitId: null,
    court: "TRT10",
    instance: "first",
    phase: "knowledge",
    city: "Palmas",
    classification: "possible",
    percentageBp: 5_000,
    claimCents: 1_000_000,
    liquidatedCents: null,
    guaranteesCents: 0,
  },
  {
    processId: "b",
    number: "0000002-00.2026.5.10.0001",
    companyId: null,
    unitId: null,
    court: "TRT10",
    instance: null,
    phase: "enforcement",
    city: null,
    classification: "probable",
    percentageBp: 10_000,
    claimCents: 2_000_000,
    liquidatedCents: 800_000,
    guaranteesCents: 100_000,
  },
];

function dimension(keyOf: (r: PortfolioRowLike) => string | null): Dimension {
  const ranked = rankGroups(groupRows(rows, keyOf));
  return {
    key: "court",
    rows: ranked.top.map((g) => ({ key: g.key, label: g.key ?? "Não informado", bucket: g.bucket, href: g.key ? `/processos?tribunal=${g.key}` : null })),
    others: ranked.others,
  };
}

const data: PortfolioData = {
  activeProcesses: 2,
  totals: bucketOf(rows),
  byClassification: [
    { key: "remote", bucket: emptyBucket() },
    { key: "possible", bucket: bucketOf([rows[0]]) },
    { key: "probable", bucket: bucketOf([rows[1]]) },
    { key: "unclassified", bucket: emptyBucket() },
  ],
  dimensions: {
    court: dimension((r) => r.court),
    instance: dimension((r) => r.instance),
    phase: dimension((r) => r.phase),
    city: dimension((r) => r.city),
    company: dimension((r) => r.companyId),
    unit: dimension((r) => r.unitId),
  },
  top: [
    {
      processId: "b",
      number: "0000002-00.2026.5.10.0001",
      title: "Processo fictício",
      court: "TRT10",
      instance: null,
      phase: "enforcement",
      classification: "probable",
      claimCents: 2_000_000,
      liquidatedCents: 800_000,
      exposureCents: 700_000,
      exposureIsEstimate: false,
    },
    {
      processId: "a",
      number: "0000001-00.2026.5.10.0001",
      title: "Outro processo fictício",
      court: "TRT10",
      instance: "first",
      phase: "knowledge",
      classification: "possible",
      claimCents: 1_000_000,
      liquidatedCents: null,
      exposureCents: 500_000,
      exposureIsEstimate: true,
    },
  ],
  previous: null,
};

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("portfolio panel components", () => {
  it("render the KPIs with claim and liquidated values side by side, never summed", () => {
    const out = html(createElement(PortfolioKpis, { data, filters }));
    expect(out).toContain("Processos na carteira ativa");
    expect(out).toContain("Valor da causa");
    expect(out).toContain("Valor liquidado");
    expect(out).toContain("nunca são somados");
    expect(out).toContain("1 não apurado");
    expect(out).toContain("Estimativa");
    expect(out).toContain("/processos?liquidado=sem");
    // R$ 30.000,00 (claim) and R$ 8.000,00 (liquidated) appear separately; R$ 38.000,00 never does.
    expect(out).not.toMatch(/38\.000,00/);
  });

  it("render the comparison card with and without a previous closing", () => {
    expect(html(createElement(PreviousClosingCard, { data, closingsHref: null }))).toContain("Sem fechamento anterior");
    const withPrev = html(
      createElement(PreviousClosingCard, {
        data: { ...data, previous: { period: "2026-09", referenceDate: "2026-09-30", closedAt: null, totals: bucketOf([rows[0]]) } },
        closingsHref: "/contingencias/provisao",
      }),
    );
    expect(withPrev).toContain("setembro de 2026");
    expect(withPrev).toContain("Aumento");
  });

  it("render dimension charts (exposure or count fallback) and the top exposures", () => {
    const chart = html(createElement(DimensionChart, { title: "Por tribunal", dimensionLabel: "Tribunal", dimension: data.dimensions.court }));
    expect(chart).toContain("Exposição oficial");
    expect(chart).toContain("/processos?tribunal=TRT10");
    const noExposure: Dimension = {
      key: "court",
      rows: [{ key: "TRT22", label: "TRT22", bucket: { ...emptyBucket(), count: 3 }, href: null }],
      others: null,
    };
    expect(html(createElement(DimensionChart, { title: "Por tribunal", dimensionLabel: "Tribunal", dimension: noExposure }))).toContain(
      "as barras mostram a quantidade",
    );
    const top = html(createElement(TopExposures, { items: data.top }));
    expect(top).toContain("Não apurado");
    expect(top).toContain("/processos/b?aba=valores");
  });

  it("render the follow-up cards in every state", () => {
    const followUp: FollowUpData = {
      upcomingHearingDays: 10,
      hearings: { status: "ok", data: [] },
      intake: { status: "error" },
      alerts: {
        total: 1,
        critical: 1,
        groups: [
          {
            key: "hearings",
            label: "Audiências",
            total: 1,
            critical: 1,
            types: [{ type: "hearing_upcoming", label: "Audiência próxima", count: 1, critical: 1 }],
          },
        ],
      },
      briefs: {
        status: "ok",
        data: {
          total: 1,
          items: [{ id: "x", processId: "p", processNumber: "0000003-00.2026.5.10.0001", status: "ready_for_review", mode: "demo", generatedAt: null }],
        },
      },
    };
    expect(html(createElement(UpcomingHearingsCard, { data: followUp }))).toContain("Nenhuma audiência designada");
    expect(html(createElement(IntakeCard, { data: followUp, canOpenIntake: true, canOpenBriefs: true }))).toContain("indisponível");
    expect(html(createElement(AlertGroupsCard, { data: followUp }))).toContain("/alertas?tipo=hearing_upcoming&amp;situacao=abertos");
    const briefs = html(createElement(BriefsAwaitingCard, { data: followUp }));
    expect(briefs).toContain("Simulação");
    expect(briefs).toContain("/analises-preliminares/x");
    expect(html(createElement(BriefsAwaitingCard, { data: { ...followUp, briefs: { status: "forbidden" } } }))).toBe("");
  });
});
