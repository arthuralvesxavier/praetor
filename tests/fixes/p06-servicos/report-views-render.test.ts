/**
 * P0.6 (reports, movement): the "index_change" movement is shown with a neutral
 * badge and counted apart from the value changes ("Trocas de índice"); the report
 * views show empty values as muted text (never a dash) and carry no internal rule
 * codes. With P06_SHOTS=1 the rendered views are also written to
 * .data/p06-shots/servicos (screenshots of the visual check).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyBucket } from "@/domain/contingency";
import { AuditLetterView, ExposureReportView, MovementReportView, ProvisionReportView } from "@/modules/reports/components/report-views";
import type { AuditLetterReport, ExposureReport, MovementEvent, MovementReport, ProvisionReport } from "@/modules/reports/types";

const ctxBase = {
  scope: { orgWide: true, includesConfidential: false, label: "Carteira da organização (fictícia).", totalLabel: "Total" },
  generatedAt: new Date("2026-10-12T12:00:00Z"),
  organizationName: "Organização Fictícia S.A.",
  filterSummary: "Todas as empresas",
};

const blankEvent = {
  closureReason: null,
  valuationKind: null,
  previousCents: null,
  newCents: null,
  isEstimate: false,
} satisfies Partial<MovementEvent>;

function movement(overrides: Partial<MovementReport["summary"]> = {}): MovementReport {
  const events: MovementEvent[] = [
    {
      ...blankEvent,
      date: "2026-10-09",
      kind: "index_change",
      processId: "00000000-0000-4000-8000-000000000001",
      number: "0001234-56.2025.5.10.0001",
      title: "MARIA FICTÍCIA x EMPRESA MODELO TESTE LTDA",
      detail: "Valor liquidado / apurado de R$ 45.000,00 (data-base 31/07/2026) · índice de IPCA-E para Selic · valor e data-base mantidos",
      valuationKind: "liquidated",
    },
    {
      ...blankEvent,
      date: "2026-10-08",
      kind: "value_change",
      processId: "00000000-0000-4000-8000-000000000002",
      number: "0002345-67.2025.5.10.0002",
      title: "JOÃO FICTÍCIO x EMPRESA MODELO TESTE LTDA",
      detail: "Valor liquidado / apurado · Lançamento manual · primeiro valor oficial",
      valuationKind: "liquidated",
      newCents: 3_200_000,
    },
    {
      ...blankEvent,
      date: "2026-10-07",
      kind: "value_change",
      processId: "00000000-0000-4000-8000-000000000003",
      number: "0003456-78.2025.5.10.0003",
      title: "ANA FICTÍCIA x EMPRESA MODELO TESTE LTDA",
      detail: "Valor da causa · Planilha",
      valuationKind: "claim",
      previousCents: 1_000_000,
      newCents: 1_250_000,
    },
    {
      ...blankEvent,
      date: "2026-10-05",
      kind: "added",
      processId: "00000000-0000-4000-8000-000000000004",
      number: "0004567-89.2026.5.10.0004",
      title: "PEDRO FICTÍCIO x EMPRESA MODELO TESTE LTDA",
      detail: "Cadastro manual",
    },
    {
      ...blankEvent,
      date: "2026-10-03",
      kind: "closed",
      processId: "00000000-0000-4000-8000-000000000005",
      number: "0005678-90.2024.5.10.0005",
      title: "LUCIA FICTÍCIA x EMPRESA MODELO TESTE LTDA",
      detail: "Pago / extinto",
      closureReason: "paid_extinct",
    },
    {
      ...blankEvent,
      date: "2026-10-02",
      kind: "phase_change",
      processId: "00000000-0000-4000-8000-000000000006",
      number: "0006789-01.2024.5.10.0006",
      title: "CARLOS FICTÍCIO x EMPRESA MODELO TESTE LTDA",
      detail: "Conhecimento → Liquidação",
    },
  ];
  return {
    ...ctxBase,
    type: "movimentacao",
    from: "2026-10-01",
    to: "2026-10-12",
    summary: {
      added: 1,
      closed: 1,
      closedByReason: [{ reason: "paid_extinct", label: "Pago / extinto", count: 1 }],
      valueChanges: 2,
      phaseChanges: 1,
      statusChanges: 0,
      ...overrides,
    },
    events,
    pendingProposedValuations: 3,
    truncated: false,
  };
}

function exposure(): ExposureReport {
  const bucket = { ...emptyBucket(), count: 2, claimCents: 5_000_000, liquidatedCents: 1_000_000, liquidatedUnknown: 1, exposureCents: 800_000, exposureEstimateCents: 0 };
  const rows = [
    { key: "TRT10", label: "TRT10", processCount: 2, bucket, previous: null },
    { key: "TRT18", label: "TRT18", processCount: 1, bucket: { ...bucket, count: 1 }, previous: { processCount: 1, exposureCents: 500_000, exposureEstimateCents: 0, exposureUnknown: 0 } },
  ];
  return {
    ...ctxBase,
    type: "exposicao",
    comparison: { id: "s1", period: "2026-09", referenceDate: "2026-09-30", status: "closed" },
    comparisonNote: null,
    dimensions: [{ key: "court", label: "Tribunal", rows }],
    totals: { key: "total", label: "Total", processCount: 3, bucket, previous: null },
    hasEstimates: false,
  };
}

function provision(): ProvisionReport {
  const amounts = { provisionCents: 800_000, provisionEstimateCents: 0 };
  return {
    ...ctxBase,
    type: "provisao",
    closedPeriods: ["2026-09", "2026-08"],
    snapshot: {
      id: "s1",
      period: "2026-09",
      referenceDate: "2026-09-30",
      status: "closed",
      closedAt: new Date("2026-10-02T15:00:00Z"),
      closedByName: "Clara Contadora",
      params: { riskPercentages: { probable: 100, possible: 50, remote: 0 }, rulesVersion: 2, confidenceThreshold: 80 },
    },
    previous: { id: "s0", period: "2026-08", referenceDate: "2026-08-31", status: "closed" },
    byClassification: [
      { key: "probable", label: "Provável", percentageBp: 10_000, processCount: 1, current: amounts, previous: { ...amounts, processCount: 1 } },
      { key: "unclassified", label: "Sem classificação", percentageBp: null, processCount: 1, current: { provisionCents: 0, provisionEstimateCents: 0 }, previous: null },
    ],
    totals: { key: "unclassified", label: "Total", percentageBp: null, processCount: 2, current: amounts, previous: { ...amounts, processCount: 1 } },
    movement: {
      opening: amounts,
      rows: [{ kind: "unchanged", processCount: 1, provisionCents: 0, provisionEstimateCents: 0 }],
      closing: amounts,
    },
    items: [],
    hasEstimates: false,
  };
}

function auditLetter(): AuditLetterReport {
  return {
    ...ctxBase,
    type: "auditoria",
    baseDate: "2026-09-30",
    source: "current",
    snapshot: null,
    closedPeriods: [],
    rows: [
      {
        processId: "00000000-0000-4000-8000-000000000010",
        number: "0007890-12.2025.5.10.0007",
        title: "BEATRIZ FICTÍCIA x EMPRESA MODELO TESTE LTDA",
        court: null,
        courtDivision: null,
        instance: null,
        phase: null,
        classification: null,
        percentageBp: null,
        claimCents: null,
        liquidatedCents: null,
        guaranteesCents: 0,
        exposureCents: null,
        exposureIsEstimate: false,
        provisionCents: null,
        provisionIsEstimate: false,
        caveats: [],
      },
    ],
    totals: {
      processCount: 1,
      claimCents: 0,
      claimUnknown: 1,
      liquidatedCents: 0,
      liquidatedUnknown: 1,
      provisionCents: 0,
      provisionEstimateCents: 0,
      unclassified: 1,
      byClassification: { probable: 0, possible: 0, remote: 0, unclassified: 1 },
    },
    generalCaveats: ["Valores sem data-base informada foram listados como não apurados."],
    hasEstimates: false,
  } as AuditLetterReport;
}

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("movement report view", () => {
  it("shows the index swap with a neutral badge and counts it apart from value changes", () => {
    const out = html(createElement(MovementReportView, { report: movement(), page: 1, sp: {} }));
    // Classes of the badge that wraps each movement label.
    const badgeClasses = (label: string) => out.match(new RegExp(`<span class="([^"]*)"><span class="truncate">${label}</span>`))?.[1];
    expect(badgeClasses("Troca de índice de atualização")).toBeDefined();
    // Same tone as the "closed" (neutral) badge; not the warning tone of phase changes nor the primary one of value changes.
    expect(badgeClasses("Troca de índice de atualização")).toBe(badgeClasses("Encerramento"));
    expect(badgeClasses("Troca de índice de atualização")).not.toBe(badgeClasses("Mudança de fase"));
    expect(badgeClasses("Troca de índice de atualização")).not.toBe(badgeClasses("Alteração de valor oficial"));

    expect(out).toContain("Trocas de índice: 1 (sem mudança de valor)");
    expect(out).toContain("Alterações de valor oficial");
    // The service count wins over the listed events (the list may be cut).
    expect(html(createElement(MovementReportView, { report: movement({ indexChanges: 12 }), page: 1, sp: {} }))).toContain("Trocas de índice: 12");
    // Without swaps the original hint stays.
    const noSwap = { ...movement(), events: movement().events.filter((e) => e.kind !== "index_change") };
    expect(html(createElement(MovementReportView, { report: noSwap, page: 1, sp: {} }))).toContain("Valores oficializados no período");
  });

  it("shows values that do not apply as muted text, never a dash, and no rule codes", () => {
    const out = html(createElement(MovementReportView, { report: movement(), page: 1, sp: {} }));
    // Em dash, or a spaced en dash (a page range such as "1–6" is fine).
    expect(out).not.toMatch(/—| – /);
    expect(out).not.toMatch(/\b(RN|RF|TE)-\d/);
    expect(out).toContain('<span class="text-muted-foreground">Não se aplica</span>');
    expect(out).toContain('<span class="text-muted-foreground">Sem valor anterior</span>');
  });
});

describe("other report views", () => {
  it("exposure, provision and audit letter: no dash placeholders and no rule codes", () => {
    for (const el of [
      createElement(ExposureReportView, { report: exposure() }),
      createElement(ProvisionReportView, { report: provision() }),
      createElement(AuditLetterView, { report: auditLetter() }),
    ]) {
      const out = html(el);
      expect(out).not.toMatch(/—| – /);
      expect(out).not.toMatch(/\b(RN|RF|TE)-\d/);
    }
    const letter = html(createElement(AuditLetterView, { report: auditLetter() }));
    expect(letter).toContain("Carta de auditoria: relação de processos judiciais");
    expect(letter).toContain('<span class="text-muted-foreground">Não informado</span>');
    expect(letter).toContain("Sem ressalvas");
    expect(letter).toContain("Sem garantias");
    // Null is not zero in the summary either.
    expect(letter).toContain('<dd class="font-medium text-muted-foreground">Não informado</dd>');
    expect(letter).toContain('<dd class="font-medium text-muted-foreground">Não apurado</dd>');
    expect(letter).toContain('<dd class="font-medium text-muted-foreground">Não calculada</dd>');
    expect(letter).not.toContain("R$ 0,00");
    expect(html(createElement(ExposureReportView, { report: exposure() }))).toContain("Sem comparação");
    expect(html(createElement(ProvisionReportView, { report: provision() }))).toContain("Competência setembro de 2026 fechada");
  });
});

// ---------------------------------------------------------------------------
// Static HTML for the screenshots (P06_SHOTS=1)
// ---------------------------------------------------------------------------

/** Same structure and classes as `src/app/(app)/layout.tsx` (sidebar w-64 from lg, main max-w-7xl). */
function page(body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="app.css"><style>:root{--font-inter:"Inter";}</style></head>
<body class="min-h-dvh bg-canvas font-sans text-foreground antialiased"><div class="flex min-h-dvh flex-col"><div class="flex flex-1">
<aside class="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex"></aside>
<div class="flex min-w-0 flex-1 flex-col">
<header class="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/95 px-3 sm:gap-3 sm:px-6"></header>
<main id="conteudo" class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">${body}</main>
</div></div></div></body></html>`;
}

describe.runIf(process.env.P06_SHOTS === "1")("screenshots", () => {
  it("writes the rendered views", () => {
    const dir = path.resolve(".data/p06-shots/servicos");
    mkdirSync(dir, { recursive: true });
    const views: [string, ReactElement][] = [
      ["movimentacao", createElement(MovementReportView, { report: movement(), page: 1, sp: {} })],
      ["exposicao", createElement(ExposureReportView, { report: exposure() })],
      ["provisao", createElement(ProvisionReportView, { report: provision() })],
      ["carta-auditoria", createElement(AuditLetterView, { report: auditLetter() })],
    ];
    for (const [name, el] of views) writeFileSync(path.join(dir, `${name}.html`), page(html(el)), "utf8");
  });
});
