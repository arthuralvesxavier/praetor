/**
 * Integration of P1.7/P1.6/P1.8 in the contingency screens (session mocked, PGlite):
 * - "Trocar índice" is a movement of its own ("Troca de índice de atualização"), never an
 *   "Alteração de valor oficial" of zero, on screen data, CSV and XLSX; the value series shows the
 *   swapped value once, with the index change noted;
 * - the Valores tab offers "Informar/Trocar índice" only to who may use it;
 * - risk rows derived from the claims are attributed to the claims, never to an approved rule suggestion;
 * - net exposure = valor apurado vigente − linked guarantees with the deductions listed, and the
 *   estimate apart ("Estimado") when there is no apurado value;
 * - the admin cards of the indices are on /admin/configuracoes and /admin/integracoes.
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

import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import readXlsxFile from "read-excel-file/node";
import SettingsPage from "@/app/(app)/admin/configuracoes/page";
import IntegrationsPage from "@/app/(app)/admin/integracoes/page";
import { assessClaim, createClaim } from "@/modules/claims/service";
import { ProcessContingencyTab, ProcessValuesSummary } from "@/modules/contingency/components/process-tabs";
import { createGuarantee } from "@/modules/contingency/guarantee-service";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { addValuation } from "@/modules/contingency/service";
import { setValuationCorrectionIndex, updateDefaultCorrectionIndex } from "@/modules/indices/service";
import { exportReport, getMovementReport } from "@/modules/reports/service";
import { todayISO } from "@/lib/format";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
let swapped: string;
let derived: string;
let estimated: string;

const pause = () => new Promise((r) => setTimeout(r, 5));
const html = (el: unknown) => renderToString(el as ReactElement);
/** Visible text, entities decoded, non-breaking spaces as plain spaces. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ");
}

beforeAll(async () => {
  f = await setupFixture("idxint");
  await updateDefaultCorrectionIndex(f.ctx.admin, "ipca_e");

  // Official liquidated value whose index is swapped, plus a linked and a released guarantee.
  swapped = await makeProcess(f.ctx.manager, { title: "Processo da troca de índice (fictício)" });
  const v = await addValuation(f.ctx.manager, {
    processId: swapped,
    kind: "liquidated",
    amountCents: 450_000,
    baseDate: "2024-05-10",
    source: "manual",
  });
  await pause();
  await setValuationCorrectionIndex(f.ctx.manager, v.id, "inpc");
  await createGuarantee(f.ctx.manager, swapped, {
    kind: "judicial_deposit",
    amountCents: 100_000,
    status: "linked",
    depositedAt: "2024-06-01",
  } as never);
  await createGuarantee(f.ctx.manager, swapped, {
    kind: "judicial_deposit",
    amountCents: 70_000,
    status: "linked",
    depositedAt: "2024-07-01",
  } as never);

  // Risk derived from the claims.
  derived = await makeProcess(f.ctx.manager, { title: "Processo com risco derivado dos pedidos (fictício)" });
  const claim = await createClaim(f.ctx.lawyer, derived, {
    description: "Horas extras (fictício)",
    category: "overtime",
    claimedAmountCents: 2_000_000,
    amountBaseDate: "2026-01-10",
    correctionIndex: "ipca_e",
  });
  await assessClaim(f.ctx.lawyer, claim.id, {
    classification: "possible",
    percentage: null,
    opinion: "Parecer fictício do pedido.",
    effectiveFrom: todayISO(),
  });

  // No apurado value: valor da causa and an official classification only.
  estimated = await makeProcess(f.ctx.manager, { title: "Processo sem valor apurado (fictício)", claimAmountCents: 1_000_000 });
  await addRiskAssessment(f.ctx.manager, estimated, {
    classification: "probable",
    percentage: 80,
    opinion: "Parecer fictício.",
    effectiveFrom: todayISO(),
  });
  await updateDefaultCorrectionIndex(f.ctx.admin, "none");
});

afterAll(async () => {
  await f?.teardown();
});

describe("movement report after 'Trocar índice'", () => {
  it("lists the swap as an index change, never as a value change of zero", async () => {
    const today = todayISO();
    const r = await getMovementReport(f.ctx.manager, { from: today, to: today });
    const mine = r.events.filter((e) => e.processId === swapped);
    const values = mine.filter((e) => e.kind === "value_change");
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ previousCents: null, newCents: 450_000 });
    expect(mine.some((e) => e.kind === "value_change" && e.previousCents === e.newCents)).toBe(false);
    const swap = mine.find((e) => e.kind === "index_change")!;
    expect(swap).toMatchObject({ previousCents: null, newCents: null, valuationKind: "liquidated" });
    expect(text(swap.detail)).toContain("R$ 4.500,00 (data-base 10/05/2024)");
    expect(swap.detail).toContain("índice de IPCA-E para INPC");
    expect(swap.detail).toContain("valor e data-base mantidos");
    // The summary counts value changes only.
    expect(r.summary.valueChanges).toBe(r.events.filter((e) => e.kind === "value_change").length);
  });

  it("labels it 'Troca de índice de atualização' in the CSV and XLSX exports", async () => {
    const today = todayISO();
    const csv = new TextDecoder().decode((await exportReport(f.ctx.manager, "movimentacao", { from: today, to: today }, "csv")).body);
    const line = csv.split("\r\n").find((l) => l.includes("Troca de índice de atualização"));
    expect(line).toBeDefined();
    expect(line).toContain("índice de IPCA-E para INPC");
    expect(csv.split("\r\n").filter((l) => l.includes("Processo da troca de índice") && l.includes("Alteração de valor oficial"))).toHaveLength(1);

    const xlsx = await exportReport(f.ctx.manager, "movimentacao", { from: today, to: today }, "xlsx");
    const sheets = await readXlsxFile(Buffer.from(xlsx.body));
    const events = sheets.find((x) => x.sheet === "Movimentações")!;
    const rows = events.data.filter(
      (row) => row.some((c) => typeof c === "string" && c.includes("Processo da troca de índice")) && row[1] !== "Entrada na carteira",
    );
    expect(rows.map((row) => row[1]).sort()).toEqual(["Alteração de valor oficial", "Troca de índice de atualização"]);
    const swapRow = rows.find((row) => row[1] === "Troca de índice de atualização")!;
    // No previous/new amount: nothing about the value changed.
    expect(swapRow[7]).toBeNull();
    expect(swapRow[8]).toBeNull();
  });
});

describe("Valores e risco tab", () => {
  it("shows the swapped value once in the series, with the index change noted", async () => {
    const out = text(html(await ProcessContingencyTab({ ctx: f.ctx.manager, processId: swapped })));
    expect(out).toContain("Troca de índice de atualização: de IPCA-E para INPC");
    expect(out).toContain("com o mesmo valor e a mesma data-base");
    expect(out).not.toContain("sem variação");
  });

  it("offers 'Trocar índice' on the official value to approvers only", async () => {
    const manager = html(await ProcessContingencyTab({ ctx: f.ctx.manager, processId: swapped }));
    // One control: the official row (the superseded one is history).
    expect(manager.match(/aria-label="Trocar índice de atualização: /g)).toHaveLength(1);
    expect(text(manager)).toContain("Trocar índice");
    const lawyer = html(await ProcessContingencyTab({ ctx: f.ctx.lawyer, processId: swapped }));
    expect(lawyer).not.toContain("Trocar índice");
    expect(lawyer).not.toContain("Informar índice");
  });

  it("attributes risk rows derived from the claims to the claims, not to a rule suggestion", async () => {
    const out = text(html(await ProcessContingencyTab({ ctx: f.ctx.manager, processId: derived })));
    expect(out).toContain("Derivada dos pedidos (cálculo automático a partir das avaliações dos pedidos)");
    expect(out).not.toContain("Sugestão automática por regra");
    expect(out).not.toContain("aprovada por");
  });

  it("shows the net exposure on the apurado value with what was deducted", async () => {
    const out = text(html(await ProcessContingencyTab({ ctx: f.ctx.manager, processId: swapped })));
    expect(out).toContain("Exposição líquida");
    expect(out).toContain(
      "Valor apurado vigente R$ 4.500,00 (data-base 10/05/2024) − garantias vinculadas R$ 1.700,00 = R$ 2.800,00",
    );
    expect(out).toContain("O que foi abatido");
    expect(out).toContain("depósito em 01/06/2024");
    expect(out).toContain("depósito em 01/07/2024");
    expect(out).not.toContain("Exposição estimada");
    // Causa and apurado stay side by side, never summed.
    expect(out).toContain("nunca somadas.");
  });

  it("without an apurado value: 'Não apurado' and the estimate apart, labeled 'Estimado'", async () => {
    const out = text(html(await ProcessContingencyTab({ ctx: f.ctx.manager, processId: estimated })));
    expect(out).toContain("Exposição líquida Não apurado");
    expect(out).toContain("Exposição estimada");
    expect(out).toContain("Estimado");
    expect(out).toContain("Valor da causa R$ 10.000,00 × 80% = R$ 8.000,00");
    const card = text(html(await ProcessValuesSummary({ ctx: f.ctx.manager, processId: estimated })));
    expect(card).toContain("Não apurado");
    expect(card).toContain("Exposição estimada");
    expect(card).toContain("R$ 8.000,00");
    expect(card).toContain("nunca somadas.");
    expect(card).not.toMatch(/—|–/);
  });

  it("the overview card shows the net exposure and the deductions", async () => {
    const card = text(html(await ProcessValuesSummary({ ctx: f.ctx.executive, processId: swapped })));
    expect(card).toContain("Exposição líquida R$ 2.800,00");
    expect(card).toContain("depósito em 01/06/2024");
  });
});

describe("admin cards", () => {
  it("/admin/configuracoes shows the default index and /admin/integracoes the series collection", async () => {
    session.current = f.ctx.admin;
    const settings = text(html(await SettingsPage()));
    expect(settings).toContain("Índice de atualização dos valores");
    expect(settings).toContain("O padrão atual é Sem atualização");
    const integrations = text(html(await IntegrationsPage()));
    expect(integrations).toContain("Índices de correção: Banco Central (SGS)");
    expect(integrations).toContain("Atualizar agora");
  });
});
