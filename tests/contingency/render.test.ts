/**
 * Server-render smoke test of the contingency screens: pages, process tabs and
 * the CSV route handler are rendered to HTML (session mocked) against a real
 * PGlite database, to catch runtime rendering errors and check the mandatory
 * labels (RN-02, RN-03, RN-07, simulation labeling).
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

import { eq } from "drizzle-orm";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { previousPeriod } from "@/domain/contingency";
import { addDaysISO, todayISO } from "@/lib/format";
import { ProcessContingencyTab, ProcessSettlementsTab, ProcessValuesSummary } from "@/modules/contingency/components/process-tabs";
import { addValuation, proposeValuation } from "@/modules/contingency/service";
import { createGuarantee } from "@/modules/contingency/guarantee-service";
import { addRiskAssessment, suggestRiskAssessment } from "@/modules/contingency/risk-service";
import { createSettlement, setSettlementStatus } from "@/modules/contingency/settlement-service";
import { closeSnapshot, generateSnapshot } from "@/modules/contingency/snapshot-service";
import { periodOf } from "@/modules/contingency/rules";
import { documentVersions, documents, legalProcesses } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import ContingenciesPage from "@/app/(app)/contingencias/page";
import ReviewQueuePage from "@/app/(app)/contingencias/revisao/page";
import ProvisionPage from "@/app/(app)/contingencias/provisao/page";
import SettlementsPage from "@/app/(app)/acordos/page";
import { GET as csvRoute } from "@/app/api/contingency/snapshots/[period]/csv/route";

let f: Fixture;
let processId: string;
let confidentialId: string;
let proposedId: string;
const today = todayISO();
const d = (n: number) => addDaysISO(today, n);
const current = periodOf(today);
const previous = previousPeriod(current);

function html(el: unknown): string {
  return renderToString(el as ReactElement);
}

function sp(params: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(params) };
}

beforeAll(async () => {
  f = await setupFixture("render");
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      number: "0000101-11.2026.5.10.0001",
      title: "Reclamação trabalhista fictícia — render",
      court: "TRT-10",
      area: "labor",
      phase: "enforcement",
      instance: "first",
      claimAmountCents: 9_000_000,
      companyId: f.companyA,
    })
    .returning();
  processId = p.id;
  const [c] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      number: "0000102-11.2026.5.10.0001",
      title: "Processo sigiloso fictício",
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      isConfidential: true,
      claimAmountCents: 100_000,
      lossProbability: "possible",
    })
    .returning();
  confidentialId = c.id;

  const text = "Capa fictícia.\fPlanilha de cálculo: total líquido devido R$ 120.000,00 (DOCUMENTO FICTÍCIO).";
  const [doc] = await f.db
    .insert(documents)
    .values({ organizationId: f.orgA, title: "Cálculo de liquidação (fictício)", category: "other", processId })
    .returning();
  const [v] = await f.db
    .insert(documentVersions)
    .values({
      organizationId: f.orgA,
      documentId: doc.id,
      versionNumber: 1,
      fileName: "calculo.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "x",
      storageKey: "k",
      extractionStatus: "succeeded",
      extractedText: text,
      pageOffsets: [0, text.indexOf("Planilha")],
      pageCount: 2,
    })
    .returning();
  await f.db.update(documents).set({ currentVersionId: v.id, currentVersionNumber: 1 }).where(eq(documents.id, doc.id));

  await addRiskAssessment(f.ctx.manager, processId, {
    classification: "probable",
    opinion: "Execução em curso; condenação definida (fictício).",
    effectiveFrom: `${previous}-01`,
  });
  await addValuation(f.ctx.manager, { processId, kind: "liquidated", amountCents: 10_000_000, baseDate: `${previous}-02` });
  await createGuarantee(f.ctx.manager, processId, { kind: "judicial_deposit", amountCents: 1_000_000, depositedAt: `${previous}-03` });
  proposedId = (
    await proposeValuation(f.ctx.admin, {
      processId,
      kind: "liquidated",
      amountCents: 12_000_000,
      baseDate: d(-1),
      source: "simulation",
      documentId: doc.id,
      page: 2,
      excerpt: "total líquido devido R$ 120.000,00",
      confidence: 93,
    })
  ).id;
  await suggestRiskAssessment(f.ctx.lawyer, confidentialId).catch(() => undefined); // lawyer cannot see it: ignored
  // P1.9 close gate: the confidential process also needs an OFFICIAL classification in force on the
  // reference date (the "possível" typed on its record does not count).
  await addRiskAssessment(f.ctx.manager, confidentialId, {
    classification: "possible",
    opinion: "Parecer fictício: pedido controvertido, prova dividida.",
    effectiveFrom: `${previous}-01`,
  });
  const s = await createSettlement(f.ctx.manager, { processId, status: "signed", totalAmountCents: 300_000, installmentsCount: 3, firstDueDate: d(2) });
  await setSettlementStatus(f.ctx.manager, s.id, { status: "homologated" });
  await generateSnapshot(f.ctx.manager, previous);
  const closed = await closeSnapshot(f.ctx.manager, previous);
  if (closed.override) throw new Error("expected a close without reservation (every process classified)");
  await generateSnapshot(f.ctx.manager, current);
});

afterAll(async () => {
  await f?.teardown();
});

describe("process tabs", () => {
  it("renders the values tab with RN-02/RN-03 labels, history, guarantees and risk", async () => {
    const out = html(await ProcessContingencyTab({ ctx: f.ctx.manager, processId }));
    expect(out).toContain("Valor da causa (declarado)");
    expect(out).toContain("nunca somadas.");
    expect(out).not.toMatch(/\b(RN|RF|TE)-\d/);
    expect(out).toContain("Histórico de valores");
    expect(out).toContain("Extração simulada (demonstração)");
    expect(out).toContain("Garantias e deduções");
    expect(out).toContain("Sugerir classificação (regra)");
    expect(out).toContain("aguardando conferência");
  });

  it("shows the access notice or nothing when the user cannot see the process", async () => {
    const out = html(await ProcessContingencyTab({ ctx: f.ctx.accountant, processId: confidentialId }));
    expect(out).toContain("Sem acesso a valores e risco");
    expect(await ProcessValuesSummary({ ctx: f.ctx.adminB, processId })).toBeNull();
  });

  it("renders the settlements tab and the overview card", async () => {
    const out = html(await ProcessSettlementsTab({ ctx: f.ctx.lawyer, processId }));
    expect(out).toContain("Homologado");
    expect(out).toContain("Parcelas do acordo");
    const card = html(await ProcessValuesSummary({ ctx: f.ctx.executive, processId }));
    expect(card).toContain("Valores e provisão");
    const estimate = html(await ProcessValuesSummary({ ctx: f.ctx.manager, processId: confidentialId }));
    expect(estimate).toContain("Não apurado");
    expect(estimate).toContain("Estimativa");
  });
});

describe("pages", () => {
  it("/contingencias", async () => {
    session.current = f.ctx.accountant;
    const out = html(await ContingenciesPage(sp()));
    expect(out).toContain("Valores declarados × apurados");
    expect(out).toContain("Provisão por classificação de risco");
    const filtered = html(await ContingenciesPage(sp({ tribunal: "TRT-10", fase: "enforcement" })));
    expect(filtered).toContain("Por tribunal");
  });

  it("/contingencias/revisao with a selected item shows the page text with the highlight", async () => {
    session.current = f.ctx.accountant;
    const out = html(await ReviewQueuePage(sp({ item: proposedId })));
    expect(out).toContain("Conferência de valores");
    expect(out).toContain("<mark");
    expect(out).toContain("total líquido devido R$ 120.000,00");
    expect(out).toContain("Extração simulada (demonstração)");
    expect(out).toContain("Aprovar e oficializar");
    session.current = f.ctx.lawyer;
    const lawyer = html(await ReviewQueuePage(sp({ confianca: "alta" })));
    expect(lawyer).toContain("somente perfis com permissão de conferência");
  });

  it("/contingencias/provisao shows closed and preview competências", async () => {
    session.current = f.ctx.accountant;
    const closed = html(await ProvisionPage(sp({ competencia: previous })));
    expect(closed).toContain("Competência fechada");
    expect(closed).toContain("Memória de cálculo");
    expect(closed).toContain("sigiloso(s) não listado(s)");
    const preview = html(await ProvisionPage(sp()));
    expect(preview).toContain("Fechar competência");
    expect(preview).toContain("Movimentação do período");
    const none = html(await ProvisionPage(sp({ competencia: "2020-01" })));
    expect(none).toContain("ainda não calculada");
  });

  it("/acordos", async () => {
    session.current = f.ctx.manager;
    const out = html(await SettlementsPage(sp()));
    expect(out).toContain("Próximas parcelas");
    expect(out).toContain("0000101-11.2026.5.10.0001");
    const filtered = html(await SettlementsPage(sp({ status: "breached" })));
    expect(filtered).toContain("Nenhum acordo com esses filtros");
  });
});

describe("CSV route", () => {
  it("returns the CSV for an authorized user and 401/404 otherwise", async () => {
    session.current = f.ctx.accountant;
    const res = await csvRoute({} as never, { params: Promise.resolve({ period: previous }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("Memória de cálculo");
    expect(body).not.toContain("0000102-11.2026.5.10.0001");

    session.current = null;
    expect((await csvRoute({} as never, { params: Promise.resolve({ period: previous }) })).status).toBe(401);
    session.current = f.ctx.accountant;
    expect((await csvRoute({} as never, { params: Promise.resolve({ period: "2020-01" }) })).status).toBe(404);
    expect((await csvRoute({} as never, { params: Promise.resolve({ period: "abc" }) })).status).toBe(400);
  });
});
