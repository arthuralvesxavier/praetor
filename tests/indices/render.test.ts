/**
 * Server-render smoke test of the P1.7 UI: original and updated value side by
 * side in the "Valores e risco" tab, the pure cells, the admin collection card
 * and the default-index settings card (session mocked, real PGlite, fake SGS).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => null),
  requireActionContext: vi.fn(async () => null),
  getCurrentUser: vi.fn(async () => null),
}));

import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { ProcessContingencyTab } from "@/modules/contingency/components/process-tabs";
import { ReviewActions, ReviewQueueTable, type QueueRow } from "@/modules/contingency/components/review-forms";
import { CorrectionIndexDialog } from "@/modules/indices/components/correction-index-dialog";
import { addValuation } from "@/modules/contingency/service";
import { DefaultCorrectionIndexCard } from "@/modules/indices/components/default-index-card";
import { IndexSeriesCard } from "@/modules/indices/components/index-series-card";
import { ValuationOriginalValue, ValuationUpdatedValue } from "@/modules/indices/components/valuation-values";
import { refreshIndexSeries, updateDefaultCorrectionIndex } from "@/modules/indices/service";
import type { ValuationUpdate } from "@/modules/indices/types";
import { addMonths, monthOfDate } from "@/modules/indices/math";
import { todayISO } from "@/lib/format";
import { systemContext } from "@/server/auth/context";
import { SgsError, type SgsClient, type SgsMonthlyPoint } from "@/server/integrations/bcb";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

let f: Fixture;
let processId: string;

function html(el: unknown): string {
  return renderToString(el as ReactElement);
}

/** Six months of a fictitious 0,50% rate ending in the last storable month (fake SGS, no network). */
const lastComplete = addMonths(monthOfDate(todayISO()), -1);
const months = [5, 4, 3, 2, 1, 0].map((n) => addMonths(lastComplete, -n));
const fake: SgsClient = {
  name: "fake",
  async fetchMonthly(sgsCode: number): Promise<SgsMonthlyPoint[]> {
    if (sgsCode === 7811) throw new SgsError("server_error", "O Banco Central está indisponível no momento (HTTP 503).", true, 503);
    return sgsCode === 433 ? months.map((month) => ({ month, rate: "0.50" })) : [];
  },
};

beforeAll(async () => {
  f = await setupFixture("idxr");
  await refreshIndexSeries(systemContext(f.orgA), { client: fake });
  processId = await makeProcess(f.ctx.manager);
  await updateDefaultCorrectionIndex(f.ctx.admin, "ipca");
  await addValuation(f.ctx.manager, {
    processId,
    kind: "liquidated",
    amountCents: 1_000_000,
    baseDate: `${addMonths(months[0], -1)}-20`,
    source: "manual",
  });
  await updateDefaultCorrectionIndex(f.ctx.admin, "none");
});

afterAll(async () => {
  await f?.teardown();
});

describe("valuations table", () => {
  it("shows the original value and the updated value side by side, labeled", async () => {
    const out = html(await ProcessContingencyTab({ ctx: f.ctx.lawyer, processId }));
    expect(out).toContain("Valor original");
    expect(out).toContain("Valor atualizado");
    expect(out).toMatch(/Valor original \(data-base \d{2}\/\d{2}\/\d{4}\)/);
    const [y, m] = lastComplete.split("-");
    expect(out).toContain(`Valor atualizado por IPCA até ${m}/${y}`);
    // 1.000.000 cents × 1,005^6 = 1.030.378 cents.
    expect(out).toContain("10.303,78");
    expect(out).toContain("não é gravado");
  });
});

describe("cells", () => {
  const base: Omit<ValuationUpdate, "updated" | "correctionIndex"> = {
    valuationId: "v",
    kind: "liquidated",
    status: "official",
    amountCents: 500_000,
    baseDate: "2024-03-15",
  };

  it("labels the original value with its base date", () => {
    const out = html(ValuationOriginalValue({ amountCents: 500_000, baseDate: "2024-03-15" }));
    expect(out).toContain("Valor original (data-base 15/03/2024)");
  });

  it('shows "sem índice informado", "sem atualização" and the missing months', () => {
    const noIndex = html(
      ValuationUpdatedValue({
        update: {
          ...base,
          correctionIndex: null,
          updated: { status: "no_index", cents: null, factor: null, monthsApplied: 0, firstMonth: null, throughMonth: null, missingMonths: [], pendingMonths: [] },
        },
      }),
    );
    expect(noIndex).toContain("Sem índice informado");
    const none = html(
      ValuationUpdatedValue({
        update: {
          ...base,
          correctionIndex: "none",
          updated: { status: "not_corrected", cents: 500_000, factor: 1, monthsApplied: 0, firstMonth: null, throughMonth: null, missingMonths: [], pendingMonths: [] },
        },
      }),
    );
    expect(none).toContain("Sem atualização (índice: nenhum)");
    // The index may come from the organization default: never claim that a person chose it.
    expect(none).not.toContain("escolhido");
    const gap = html(
      ValuationUpdatedValue({
        update: {
          ...base,
          correctionIndex: "inpc",
          updated: {
            status: "unavailable",
            cents: null,
            factor: null,
            monthsApplied: 0,
            firstMonth: null,
            throughMonth: null,
            missingMonths: ["2024-05", "2024-06"],
            pendingMonths: [],
          },
        },
      }),
    );
    expect(gap).toContain("INPC: atualização indisponível (faltam meses: 05/2024 a 06/2024)");
    const rejected = html(ValuationUpdatedValue({ update: { ...base, status: "rejected", correctionIndex: "ipca", updated: { status: "updated", cents: 1, factor: 1, monthsApplied: 1, firstMonth: "2024-04", throughMonth: "2024-04", missingMonths: [], pendingMonths: [] } } }));
    expect(rejected).toContain("Não se aplica (valor rejeitado)");
  });
});

describe("review queue and index change (P1.7)", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const update: ValuationUpdate = {
    valuationId: id,
    kind: "liquidated",
    status: "proposed",
    amountCents: 500_000,
    baseDate: "2024-03-15",
    correctionIndex: "selic",
    updated: {
      status: "updated",
      cents: 512_345,
      factor: 1.02469,
      monthsApplied: 2,
      firstMonth: "2024-04",
      throughMonth: "2024-05",
      missingMonths: [],
      pendingMonths: [],
    },
  };
  const row: QueueRow = {
    id,
    href: `/contingencias/revisao?item=${id}`,
    selected: false,
    processNumber: "0000001-00.2024.8.26.0100",
    processTitle: "Processo fictício de teste",
    kindLabel: "Valor liquidado",
    amount: "R$ 5.000,00",
    currentOfficial: null,
    baseDate: "15/03/2024",
    sourceLabel: "Planilha",
    isSimulation: false,
    confidence: 95,
    bulkEligible: true,
    documentLabel: null,
    correctionIndex: "selic",
    update,
  };

  it("shows the index and the updated value of each proposal and pins the index shown", () => {
    const out = html(createElement(ReviewQueueTable, { rows: [row], canApprove: true, threshold: 85 }));
    expect(out).toContain("Índice e valor atualizado");
    expect(out).toContain("Índice: Selic (acumulada no mês)");
    expect(out).toContain("5.123,45");
    expect(out).toContain("Valor atualizado por Selic (acumulada no mês) até 05/2024");
    expect(out).toContain(`name="expectedCorrectionIndex:${id}" value="selic"`);

    const legacy = html(
      createElement(ReviewQueueTable, { rows: [{ ...row, correctionIndex: null, update: undefined }], canApprove: true, threshold: 85 }),
    );
    expect(legacy).toContain("Índice: sem índice informado");
    expect(legacy).toContain(`name="expectedCorrectionIndex:${id}" value=""`);

    const form = html(createElement(ReviewActions, { id, amountInput: "5.000,00", correctionIndex: "selic" }));
    expect(form).toContain('name="expectedCorrectionIndex" value="selic"');
    expect(form).toContain("Selic (acumulada no mês)");
    expect(form).toContain("somente quem confere valores troca o índice");
    // Without the index the form does not pin anything (other callers).
    expect(html(createElement(ReviewActions, { id, amountInput: "5.000,00" }))).not.toContain("expectedCorrectionIndex");
  });

  it('labels the control "Trocar índice" or "Informar índice"', () => {
    const replace = html(
      createElement(CorrectionIndexDialog, { valuationId: id, current: "ipca", valueLabel: "Valor liquidado de R$ 5.000,00", mode: "new_record" }),
    );
    expect(replace).toContain("Trocar índice");
    const inform = html(
      createElement(CorrectionIndexDialog, { valuationId: id, current: null, valueLabel: "Valor liquidado de R$ 5.000,00", mode: "in_place" }),
    );
    expect(inform).toContain("Informar índice");
  });
});

describe("admin cards", () => {
  it("shows each series with its SGS code, months stored and the last failure", async () => {
    const out = html(await IndexSeriesCard({ ctx: f.ctx.admin }));
    expect(out).toContain("Índices de correção: Banco Central (SGS)");
    expect(out).toContain("10764");
    expect(out).toContain("433");
    expect(out).toContain("Em dia");
    expect(out).toContain("Falha na última coleta");
    expect(out).toContain("HTTP 503");
    expect(out).toContain("Atualizar agora");
    expect(out).toContain("Nenhuma taxa é digitada à mão");
    expect(out).toContain("a Selic acumulada de um mês só é gravada a partir do dia 10 do mês seguinte");
    expect(await IndexSeriesCard({ ctx: f.ctx.lawyer })).toBeNull();
  });

  it("shows the default index setting to admins only", async () => {
    const out = html(await DefaultCorrectionIndexCard({ ctx: f.ctx.admin }));
    expect(out).toContain("Índice de atualização dos novos valores");
    expect(out).toContain("IPCA-E");
    expect(out).toContain("escolha do índice adequado a cada caso é do advogado");
    // Default still "none": the consequence is spelled out before values are registered.
    expect(out).toContain("O padrão atual é Sem atualização");
    // The advice matches what the product does: an approver changes the index with a new record.
    expect(out).toContain("somente quem confere valores troca o índice");
    expect(out).not.toContain("registre um novo valor");
    expect(await DefaultCorrectionIndexCard({ ctx: f.ctx.lawyer })).toBeNull();
  });
});
