import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyBucket } from "@/domain/contingency";
import type { BiFilters } from "@/modules/dashboard/bi-filters";
import { AlertGroupsCard, BriefsAwaitingCard, IntakeCard } from "@/modules/dashboard/components/follow-up-cards";
import { HowToRead } from "@/modules/dashboard/components/how-to-read";
import { MoreIndicators } from "@/modules/dashboard/components/more-indicators";
import { NetExposureCard } from "@/modules/dashboard/components/net-exposure-card";
import {
  DimensionPanel,
  ExposureByDimension,
  PortfolioKpis,
  PreviousClosingCard,
  RegistrationGaps,
  TopExposures,
} from "@/modules/dashboard/components/portfolio-panel";
import {
  bucketOf,
  dimensionGroups,
  exposureBasisCounts,
  liquidatedCoverage,
  netExposureSummary,
  provisionBasisOf,
  type PortfolioRowLike,
} from "@/modules/dashboard/portfolio";
import type { Dimension, FollowUpData, PortfolioData, PreviousClosing } from "@/modules/dashboard/portfolio-service";

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

/** A closed competência (2026-09) whose stored items are `closedRows` as they are now. */
function closing(closedRows: PortfolioRowLike[]): PreviousClosing {
  const totals = bucketOf(closedRows);
  return {
    period: "2026-09",
    referenceDate: "2026-09-30",
    closedAt: null,
    totals,
    exposureBasis: exposureBasisCounts(totals),
    provisionBasis: provisionBasisOf(closedRows),
  };
}

function dimension(key: Dimension["key"], keyOf: (r: PortfolioRowLike) => string | null): Dimension {
  const { top, others, missing } = dimensionGroups(rows, keyOf);
  return {
    key,
    rows: top.map((g) => ({ ...g, label: g.key, href: `/processos?tribunal=${g.key}` })),
    others,
    missing: missing ? { bucket: missing, href: `/processos?pendencia=${key}` } : null,
  };
}

const data: PortfolioData = {
  activeProcesses: 2,
  totals: bucketOf(rows),
  netExposure: netExposureSummary(rows, [{ kind: "judicial_deposit", count: 1, amountCents: 100_000 }]),
  coverage: liquidatedCoverage(bucketOf(rows)),
  registrationGaps: [
    { field: "instance", count: 1, href: "/processos?pendencia=instancia" },
    { field: "city", count: 1, href: "/processos?pendencia=cidade" },
  ],
  byClassification: [
    { key: "remote", bucket: emptyBucket() },
    { key: "possible", bucket: bucketOf([rows[0]]) },
    { key: "probable", bucket: bucketOf([rows[1]]) },
    { key: "unclassified", bucket: emptyBucket() },
  ],
  dimensions: {
    court: dimension("court", (r) => r.court),
    instance: dimension("instance", (r) => r.instance),
    phase: dimension("phase", (r) => r.phase),
    city: dimension("city", (r) => r.city),
    company: dimension("company", (r) => r.companyId),
    unit: dimension("unit", (r) => r.unitId),
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
/** Same, with the non-breaking spaces of the pt-BR money formats as plain spaces. */
const plain = (el: Parameters<typeof renderToStaticMarkup>[0]) => html(el).replace(/ /g, " ");

/** Visible end-of-row texts and accessible names (aria-label = tooltip) of a BarChart's rows. */
function barRows(out: string): { aria: string[]; text: string[] } {
  const aria = [...out.matchAll(/<a [^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
  const values = [...out.matchAll(/<span class="text-right text-sm font-medium[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
  return { aria, text: values };
}

/** Value column header of a BarChart: the unit of every value of the chart. */
function valueHeader(out: string): string | undefined {
  return out.match(/<div class="grid [^"]*border-b[^"]*"><span class="truncate">[^<]*<\/span><span aria-hidden="true"><\/span><span class="text-right">([^<]*)<\/span>/)?.[1];
}

function courtDimension(source: PortfolioRowLike[]): Dimension {
  const { top, others, missing } = dimensionGroups(source, (r) => r.court);
  return {
    key: "court",
    rows: top.map((g) => ({ ...g, label: g.key, href: `/processos?tribunal=${g.key}` })),
    others,
    missing: missing ? { bucket: missing, href: "/processos?pendencia=tribunal" } : null,
  };
}

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

  it("show apurado-based amounts only with the coverage statement, linking to the review queue", () => {
    const out = html(createElement(PortfolioKpis, { data, filters }));
    expect(out).toContain("Cobertura do valor apurado");
    expect(out).toContain("Valor apurado em 1 de 2 processos (50%)");
    expect(out).toContain('href="/contingencias/revisao"');
    expect(out).toContain("Ver 1 processo não apurado");
    // Valor liquidado and provisão oficial each carry the coverage (the net exposure is its own card).
    expect(out.match(/Apurado em 1 de 2 processos \(50%\)/g)).toHaveLength(2);
    expect(out).not.toContain("Exposição líquida");
    expect(out).not.toContain("Nenhum dos");
    // Per classification: "apurados/processos"; a classification without apurado shows no official R$ 0.
    expect(out).toContain("Apur./proc.");
    expect(out).toMatch(/0\/1<\/td><td[^>]*><span class="text-muted-foreground" title="Sem valor apurado">/);

    // Nothing assessed: "Sem valor apurado" replaces the official R$ 0 figures.
    const unassessed = rows.map((r) => ({ ...r, liquidatedCents: null }));
    const totals = bucketOf(unassessed);
    const none = html(
      createElement(PortfolioKpis, { data: { ...data, totals, coverage: liquidatedCoverage(totals) }, filters }),
    );
    expect(none).toContain("Valor apurado em 0 de 2 processos (0%)");
    expect(none.match(/Sem valor apurado/g)?.length).toBeGreaterThanOrEqual(3);
    expect(none).toContain("Nenhum dos 2 processos tem valor apurado");
    expect(none).toContain("Ver 2 processos não apurados");
  });

  it("render the comparison card with and without a previous closing", () => {
    expect(html(createElement(PreviousClosingCard, { data, closingsHref: null }))).toContain("Sem fechamento anterior");
    const withPrev = html(
      createElement(PreviousClosingCard, {
        data: { ...data, previous: closing([rows[0]]) },
        closingsHref: "/contingencias/provisao",
      }),
    );
    expect(withPrev).toContain("setembro de 2026");
    expect(withPrev).toContain("Aumento");
    // Coverage of the official figures now and at the closing (read from the stored items).
    expect(withPrev).toContain("Apurado em 1 de 2 agora · 0 de 1 no fechamento");
  });

  it("render dimension charts (exposure or count fallback) and the top exposures", () => {
    const chart = html(createElement(DimensionPanel, { dimension: data.dimensions.court }));
    expect(chart).toContain("Exposição apurada");
    expect(chart).toContain("/processos?tribunal=TRT10");
    const noExposure: Dimension = {
      key: "court",
      rows: [
        {
          key: "TRT22",
          label: "TRT22",
          bucket: { ...emptyBucket(), count: 3 },
          href: "/processos?tribunal=TRT22",
          provisionBasis: { official: 0, estimate: 0, none: 3 },
        },
      ],
      others: null,
      missing: null,
    };
    expect(html(createElement(DimensionPanel, { dimension: noExposure }))).toContain(
      "as barras mostram a quantidade",
    );
    // Null keys are not categories: they are counted in the note with a link to complete the record.
    const byInstance = html(
      createElement(DimensionPanel, { dimension: data.dimensions.instance }),
    );
    expect(byInstance).not.toContain("Não informado");
    expect(byInstance).toContain("1 processo sem instância informada fica fora deste gráfico");
    expect(byInstance).toContain("/processos?pendencia=instance");
    expect(chart).toContain("Exposição apurada calculada sobre o valor apurado em 1 de 2 processos (50%)");
    const top = html(createElement(TopExposures, { items: data.top }));
    expect(top).toContain("Não apurado");
    expect(top).toContain("/processos/b?aba=valores-e-acordos");
  });

  it("never draw não apurado as an official R$ 0 in the dimension charts (RN-03)", () => {
    // TRT22 has a valor apurado; TRT10 has none (only an estimate); TRT1 has no basis at all.
    const mixed: PortfolioRowLike[] = [
      { ...rows[0], processId: "a", number: "1", court: "TRT10", liquidatedCents: null },
      { ...rows[1], processId: "b", number: "2", court: "TRT22", liquidatedCents: 5_000_000, guaranteesCents: 0 },
      { ...rows[0], processId: "c", number: "3", court: "TRT1", liquidatedCents: null, percentageBp: null, classification: null },
    ];
    const chart = plain(createElement(DimensionPanel, { dimension: courtDimension(mixed) }));
    const { aria, text } = barRows(chart);
    // One unit for the whole chart (largest bar: R$ 50 mil), shown in the value column header.
    expect(valueHeader(chart)).toBe("R$ mil");
    expect(text).toContain("50,0"); // apurado row: official value, no "est. 0"
    expect(text).toContain("não apurado · est. 5,0");
    expect(text).toContain("não apurado · sem base de cálculo");
    expect(text.some((t) => /^0(,0+)?\b/.test(t))).toBe(false);
    expect(text.some((t) => /R\$|\bmil\b|\bmi\b/.test(t))).toBe(false);
    expect(chart).not.toContain("0,0 · est.");
    expect(chart).not.toContain("Exposição apurada: R$ 0");
    expect(chart).not.toContain("est. 0,0");
    expect(aria).toContain("TRT10 (1): Exposição apurada: não apurado · Exposição estimada: R$ 5.000,00");
    expect(aria).toContain("TRT22 (1): Exposição apurada: R$ 50.000,00 (apurado em 1 de 1)");
    expect(aria).toContain("TRT1 (1): Exposição apurada: não apurado · 1 processo sem base de cálculo");
    // The tooltip carries the same text as the accessible name (exact amounts).
    expect(chart).toContain('data-tip-value="Exposição apurada: não apurado · Exposição estimada: R$ 5.000,00"');
    expect(chart).toContain("Exposição apurada calculada sobre o valor apurado em 1 de 3 processos (33%)");
    expect(chart).toContain("“Não apurado”: nenhum processo da linha tem valor apurado (não é zero)");
    expect(chart).toContain('aria-label="Legenda"');
    // Table view: no official R$ 0,00 for the não apurado rows, no estimated R$ 0,00 without basis.
    const tr = (court: string) => chart.match(new RegExp(`<tr[^>]*><th[^>]*>${court}</th>(?:(?!</tr>).)*</tr>`, "s"))?.[0] ?? "";
    expect(tr("TRT10")).toContain("Não apurado");
    expect(tr("TRT10")).not.toContain("R$ 0,00");
    expect(tr("TRT1")).toContain("Sem base de cálculo");
    expect(tr("TRT1")).not.toContain("R$ 0,00");

    // No valor apurado anywhere in the chart: estimate only, no official series or legend.
    const none = plain(
      createElement(DimensionPanel, {
        dimension: courtDimension(mixed.map((r) => ({ ...r, liquidatedCents: null }))),
      }),
    );
    const onlyEstimate = barRows(none);
    expect(none).not.toContain("Exposição apurada:");
    expect(none).not.toContain('aria-label="Legenda"');
    expect(none).not.toContain("Exposição apurada calculada");
    expect(none).toContain("Estimativa: nenhum processo deste gráfico tem valor apurado");
    expect(valueHeader(none)).toBe("R$ mil");
    expect(onlyEstimate.text).toContain("est. 20,0");
    expect(onlyEstimate.text).toContain("est. 5,0");
    expect(onlyEstimate.text).toContain("sem base de cálculo");
    expect(onlyEstimate.aria).toContain("TRT10 (1): Exposição estimada: R$ 5.000,00");
    expect(onlyEstimate.text.some((t) => /(^|\s)0,0\b/.test(t))).toBe(false);
  });

  it("compare with the closing only when both sides have a valor apurado", () => {
    const unassessed = rows.map((r) => ({ ...r, liquidatedCents: null }));
    const withClosing = (current: PortfolioRowLike[], closed: PortfolioRowLike[]) => {
      const totals = bucketOf(current);
      return plain(
        createElement(PreviousClosingCard, {
          data: {
            ...data,
            totals,
            coverage: liquidatedCoverage(totals),
            previous: closing(closed),
          },
          closingsHref: null,
        }),
      );
    };
    const figure = (out: string, label: string) =>
      out.match(new RegExp(`<p[^>]*>${label}</p>(?:(?!<p class="text-xs font-medium text-muted-foreground">).)*`, "s"))?.[0] ?? "";

    // Apurado now, nothing apurado at the closing: no "No fechamento: R$ 0", no "+100%".
    const gained = withClosing(rows, unassessed);
    const gainedExposure = figure(gained, "Exposição apurada");
    expect(gainedExposure).toContain("Sem base de comparação: sem valor apurado no fechamento");
    expect(gainedExposure).toContain("No fechamento: sem valor apurado");
    expect(gainedExposure).not.toContain("Aumento");
    expect(gainedExposure).not.toContain("R$ 0");
    expect(figure(gained, "Provisão apurada")).toContain("Sem base de comparação");
    expect(gainedExposure).toContain("Apurado em 1 de 2 agora · 0 de 2 no fechamento");

    // Nothing apurado now, apurado at the closing: current "Sem valor apurado", no "Redução (−100%)".
    const lost = figure(withClosing(unassessed, rows), "Exposição apurada");
    expect(lost).toContain("Sem valor apurado");
    expect(lost).toContain("Sem base de comparação: sem valor apurado agora");
    expect(lost).toContain("No fechamento: R$ 7 mil");
    expect(lost).not.toContain("Redução");
    expect(lost).not.toContain("−100");

    // Both sides apurado: the regular delta; neither side: "Sem valor apurado" without comparison.
    expect(figure(withClosing(rows, rows), "Exposição apurada")).toContain("Sem variação");
    const neither = figure(withClosing(unassessed, unassessed), "Exposição apurada");
    expect(neither).toContain("Sem valor apurado");
    expect(neither).not.toContain("Sem base de comparação");
    expect(neither).not.toContain("No fechamento");
  });

  it("render the registration gaps with counts and links to the filtered portfolio", () => {
    const out = html(createElement(RegistrationGaps, { gaps: data.registrationGaps }));
    expect(out).toContain("Pendências de cadastro");
    expect(out).toContain("Sem instância informada");
    expect(out).toContain("Sem cidade informada");
    expect(out).toContain('href="/processos?pendencia=instancia"');
    // Label in name (WCAG 2.5.3): the accessible name is the visible text, "Completar cadastro" included.
    expect(out).not.toContain("aria-label=");
    expect(out).toMatch(
      /<a [^>]*href="\/processos\?pendencia=instancia"[^>]*>(?:(?!<\/a>)[\s\S])*Sem instância informada(?:(?!<\/a>)[\s\S])*Completar cadastro/,
    );
    expect(html(createElement(RegistrationGaps, { gaps: [] }))).toBe("");
    expect(
      html(createElement(RegistrationGaps, { gaps: data.registrationGaps, description: "Fora das tabelas acima." })),
    ).toContain("Fora das tabelas acima.");
  });

  it("make the coverage statement look like a link (persistent underline, link color)", () => {
    const out = html(createElement(PortfolioKpis, { data, filters }));
    const link = out.match(/<a [^>]*href="\/contingencias\/revisao"[^>]*>Valor apurado em/)?.[0] ?? "";
    expect(link).toMatch(/class="[^"]*\bunderline\b/);
    expect(link).toMatch(/class="[^"]*\btext-primary-700\b/);
  });

  it("render the follow-up cards in every state", () => {
    const followUp: FollowUpData = {
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
          readyForReview: 1,
          inReview: 0,
          items: [{ id: "x", processId: "p", processNumber: "0000003-00.2026.5.10.0001", status: "ready_for_review", mode: "demo", generatedAt: null }],
        },
      },
    };
    expect(html(createElement(IntakeCard, { data: followUp, canOpenIntake: true }))).toContain("indisponível");
    // Each intake figure opens /entrada with its own status (exact count); "Em processamento" has no list.
    const intake = html(
      createElement(IntakeCard, {
        data: { ...followUp, intake: { status: "ok", data: { received: 1, inProgress: 2, notified: 3, inReview: 4, approved: 5, failed: 0 } } },
        canOpenIntake: true,
      }),
    );
    for (const status of ["received", "notified", "in_review", "approved", "failed"]) {
      expect(intake).toContain(`href="/entrada?status=${status}"`);
    }
    expect(intake).not.toContain("/analises-preliminares");
    expect(intake).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*Em processamento/);
    const noLinks = html(
      createElement(IntakeCard, {
        data: { ...followUp, intake: { status: "ok", data: { received: 1, inProgress: 2, notified: 3, inReview: 4, approved: 5, failed: 0 } } },
        canOpenIntake: false,
      }),
    );
    expect(noLinks).not.toContain("/entrada");
    expect(html(createElement(AlertGroupsCard, { data: followUp }))).toContain("/alertas?tipo=hearing_upcoming&amp;situacao=abertos");
    const briefs = html(createElement(BriefsAwaitingCard, { data: followUp }));
    expect(briefs).toContain("Simulação");
    expect(briefs).toContain("/analises-preliminares/x");
    // The total is split by status, each part linking to the list of that status.
    expect(briefs).toContain('href="/analises-preliminares?status=ready_for_review"');
    expect(briefs).toContain('href="/analises-preliminares?status=in_review"');
    expect(briefs).toContain("Pronta para revisão: 1");
    expect(briefs).toContain("Em revisão (editada): 0");
    expect(html(createElement(BriefsAwaitingCard, { data: { ...followUp, briefs: { status: "forbidden" } } }))).toBe("");
  });
});

describe("exposure by dimension (P0.3: one block with a dimension selector)", () => {
  /** Tabs of the selector: [label, aria-selected]. */
  const tabs = (out: string) =>
    [...out.matchAll(/<button [^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
  /** Inactive tab panels are rendered empty (only the selected dimension is drawn). */
  const emptyPanels = (out: string) => out.match(/<div [^>]*role="tabpanel"[^>]*><\/div>/g) ?? [];

  it("replace the six charts with one tablist, tribunal selected by default", () => {
    const out = plain(createElement(ExposureByDimension, { dimensions: data.dimensions }));
    expect(out).toContain("Exposição e processos por dimensão");
    expect(out).toMatch(/role="tablist"[^>]*aria-labelledby="[^"]+"/);
    expect(out).toContain("Agrupar por");
    expect(tabs(out)).toEqual([
      ["Tribunal", "true"],
      ["Instância", "false"],
      ["Fase", "false"],
      ["Cidade", "false"],
      ["Empresa", "false"],
      ["Unidade", "false"],
    ]);
    // Only the selected dimension is rendered: one chart, one "Ver dados em tabela".
    expect(out.match(/Ver dados em tabela/g)).toHaveLength(1);
    expect(out.match(/role="tabpanel"/g)).toHaveLength(6);
    expect(emptyPanels(out)).toHaveLength(5);
    expect(out).toContain("Exposição e processos por tribunal");
    const { aria, text } = barRows(out);
    expect(aria).toEqual(["TRT10 (2): Exposição apurada: R$ 7.000,00 (apurado em 1 de 2) · Exposição estimada: R$ 5.000,00"]);
    // Apurado and estimado stay separate (never R$ 12 mil); one unit for the chart, in its header.
    expect(text).toEqual(["7,00 · est. 5,00"]);
    expect(valueHeader(out)).toBe("R$ mil");
    expect(out).not.toContain("12,00");
    expect(out).toContain('href="/processos?tribunal=TRT10"');
    // Default dimension: nothing to carry in the filter form.
    expect(out).not.toContain('name="dimensao"');
  });

  it("render the rows, table and notes of the dimension selected in the URL", () => {
    const out = plain(
      createElement(ExposureByDimension, { dimensions: data.dimensions, initial: "city", filterFormId: "filtros-painel" }),
    );
    expect(tabs(out).find(([, selected]) => selected === "true")).toEqual(["Cidade", "true"]);
    expect(out).toContain("Exposição e processos por cidade"); // table caption
    expect(out).toContain("As 10 cidades com maior exposição");
    const { aria, text } = barRows(out);
    // Palmas has no valor apurado: estimate only, no official series and no TRT rows.
    expect(aria).toEqual(["Palmas (1): Exposição estimada: R$ 5.000,00"]);
    expect(text).toEqual(["est. 5,00"]);
    expect(out).not.toContain("TRT10 (2)");
    expect(out).toMatch(/<th scope="col"[^>]*>Cidade<\/th>/);
    expect(out).toContain("1 processo sem cidade informada fica fora deste gráfico");
    // The selection is submitted with the filter form (survives a filter change).
    expect(out).toContain('<input type="hidden" form="filtros-painel" name="dimensao" value="cidade"/>');

    // Every dimension renders its own rows when selected.
    const expected: Record<Dimension["key"], string[]> = {
      court: ["TRT10 (2)"],
      instance: ["first (1)"],
      phase: ["knowledge (1)", "enforcement (1)"],
      city: ["Palmas (1)"],
      company: [],
      unit: [],
    };
    for (const key of Object.keys(expected) as Dimension["key"][]) {
      const view = plain(createElement(ExposureByDimension, { dimensions: data.dimensions, initial: key }));
      const labels = barRows(view).aria.map((a) => a.slice(0, a.indexOf(":")));
      expect(labels.sort()).toEqual([...expected[key]].sort());
    }
    // A dimension nobody has informed: no bars, no "Não informado" category, a link to complete the records.
    const company = plain(createElement(ExposureByDimension, { dimensions: data.dimensions, initial: "company" }));
    expect(company).toContain("Nenhum processo da carteira, nos filtros selecionados, tem este campo informado.");
    expect(company).toContain("2 processos sem empresa do grupo ficam fora deste gráfico");
    expect(company).not.toContain("as barras mostram a quantidade");
  });

  it("use one unit per chart, chosen from the largest bar (no R$ 1,3 mi next to R$ 571 mil)", () => {
    const big: PortfolioRowLike[] = [
      { ...rows[1], processId: "x", number: "10", court: "TJSP", liquidatedCents: 130_000_000, guaranteesCents: 0 },
      { ...rows[1], processId: "y", number: "11", court: "TRT2", liquidatedCents: 57_100_000, guaranteesCents: 0 },
      { ...rows[1], processId: "z", number: "12", court: "TRT15", liquidatedCents: 300_000, guaranteesCents: 0 },
    ];
    const out = plain(createElement(DimensionPanel, { dimension: courtDimension(big) }));
    expect(valueHeader(out)).toBe("R$ milhões");
    const { text } = barRows(out);
    expect(text).toEqual(["1,30", "0,57", "&lt; 0,01"]); // R$ 3 mil: never a misleading "0,00"
    expect(out).toContain("Barras em R$ milhões");
    expect(out).not.toMatch(/R\$ 1,3 mi|R\$ 571 mil/);
  });
});

describe("net exposure card (P1.8)", () => {
  it("shows apurado − guarantees with the coverage and the deductions, and the estimate apart", () => {
    const out = plain(createElement(NetExposureCard, { summary: data.netExposure }));
    expect(out).toContain("Exposição líquida da carteira");
    // 800 mil − 100 mil = 700 mil; never added to the claim value (R$ 30 mil) nor to the estimate (R$ 5 mil).
    expect(out).toContain("R$ 7.000,00");
    expect(out).toMatch(/Valor apurado vigente <span[^>]*>R\$ 8\.000,00<\/span> − garantias vinculadas abatidas <span[^>]*>R\$ 1\.000,00<\/span>/);
    expect(out).toContain("Calculada sobre o valor apurado em 1 de 2 processos (50%)");
    expect(out).toContain("Exposição estimada");
    expect(out).toContain("Estimado");
    expect(out).toContain("R$ 5.000,00");
    expect(out).not.toContain("R$ 12.000,00");
    // Expandable detail (native details, closed by default): by guarantee kind and processes with the largest deductions.
    expect(out).toMatch(/<details class="group[^"]*">/);
    expect(out).not.toMatch(/<details[^>]* open/);
    expect(out).toContain("O que foi abatido");
    expect(out).toContain("Depósito judicial");
    expect(out).toContain('href="/processos/b?aba=valores-e-acordos"');
    expect(out).not.toContain("—");
  });

  it("reads Não apurado without any valor apurado (never R$ 0) and keeps the estimate", () => {
    const unassessed = rows.map((r) => ({ ...r, liquidatedCents: null }));
    const out = plain(createElement(NetExposureCard, { summary: netExposureSummary(unassessed, []) }));
    expect(out).toContain("Não apurado");
    expect(out).toContain("Nenhum dos 2 processos tem valor apurado");
    expect(out).not.toContain("O que foi abatido");
    expect(out).not.toMatch(/Exposição líquida da carteira<\/h3><p[^>]*>R\$ 0,00/);
    expect(out).toContain("Estimado");
  });

  it("explains guarantees above the valor apurado (exposure stays at zero, never negative)", () => {
    const over = [{ ...rows[1], guaranteesCents: 900_000 }];
    const out = plain(createElement(NetExposureCard, { summary: netExposureSummary(over, [{ kind: "seizure", count: 2, amountCents: 900_000 }]) }));
    expect(out).toContain("o excedente de R$ 1.000,00 não é abatido de outros processos");
    expect(out).toContain("Penhora / bloqueio");
  });
});

describe("page chrome", () => {
  it("collapses 'Mais indicadores' by default and opens it on request", () => {
    const closed = html(createElement(MoreIndicators, { description: "Descrição" }, createElement("p", null, "conteúdo")));
    expect(closed).toMatch(/^<details id="mais-indicadores"[^>]*>/);
    expect(closed).not.toMatch(/^<details[^>]* open/);
    expect(closed).toContain("<h2");
    expect(closed).toContain("Mais indicadores");
    const open = html(createElement(MoreIndicators, { description: "Descrição", defaultOpen: true }));
    expect(open).toMatch(/^<details[^>]* open=""/);
  });

  it("renders 'Como ler este painel' as a help button that opens a popover", () => {
    const out = html(createElement(HowToRead, { upcomingDays: 15, contractDays: 30 }));
    expect(out).toMatch(/<button[^>]*aria-label="Como ler este painel"/);
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain("—");
  });
});
