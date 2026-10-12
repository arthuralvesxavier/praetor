/**
 * Server-render smoke test of /relatorios, /inteligencia-preventiva and
 * /preventivo (session mocked, real PGlite database) plus the export route
 * handler: catches runtime rendering errors and checks the mandatory labels
 * (RN-02 / RN-03 / RN-07, "Calculado a partir da carteira" vs "Sugestão
 * ilustrativa", demo documents, origin of preventive occurrences).
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
vi.mock("@/modules/contingency/service", async (importOriginal) =>
  // REPORTS_REAL_CONTINGENCY=1 runs the same assertions against the real contingency implementation.
  process.env.REPORTS_REAL_CONTINGENCY ? importOriginal() : (await import("./fake-contingency")).contingencyServiceMock(),
);

import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import type { StoredCaseBrief } from "@/domain/case-brief";
import { periodReferenceDate, previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { caseBriefs, legalProcesses, portfolioSnapshotItems, portfolioSnapshots, processParties } from "@/server/db/schema";
import { createOccurrenceFromSuggestion } from "@/modules/preventive-intel/service";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import RelatoriosPage from "@/app/(app)/relatorios/page";
import InteligenciaPreventivaPage from "@/app/(app)/inteligencia-preventiva/page";
import PreventivoPage from "@/app/(app)/preventivo/page";
import { GET as exportRoute } from "@/app/api/reports/[tipo]/route";

let f: Fixture;
const prev = previousPeriod(todayISO().slice(0, 7));

function html(el: unknown): string {
  return renderToString(el as ReactElement);
}

function props(params: Record<string, string> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(params) } as never;
}

async function page(component: (p: never) => Promise<unknown>, params: Record<string, string> = {}): Promise<string> {
  return html(await component(props(params)));
}

function brief(claims: string[]): StoredCaseBrief {
  return {
    headline: "x",
    identification: [],
    factsSummary: [],
    timeline: [],
    claims: claims.map((description) => ({ description, amountCents: null, provenance: "extracted", citations: [], note: null })),
    amounts: [],
    evidence: [],
    plaintiffArguments: [],
    defendantArguments: [],
    contradictions: [],
    missingDocuments: [],
    theses: [],
    risks: [],
    urgencies: [],
    nextSteps: [],
    possibleDeadlines: [],
    gaps: [],
    limitations: [],
    promptInjectionSuspected: false,
    systemNotices: [],
  };
}

beforeAll(async () => {
  f = await setupFixture("rrender");
  const base = { organizationId: f.orgA, area: "labor" as const, unitId: f.unitSp, companyId: f.companyA };
  const inserted = await f.db
    .insert(legalProcesses)
    .values([
      {
        ...base,
        number: "0000201-11.2025.5.10.0001",
        title: "Reclamação fictícia A",
        court: "TRT10",
        phase: "knowledge",
        processClass: "ATOrd",
        claimAmountCents: 5_000_000,
        lossProbability: "possible",
        riskPercentageBp: 5000,
      },
      {
        ...base,
        number: "0000202-11.2025.5.10.0001",
        title: "Reclamação fictícia B",
        court: "TRT10",
        phase: "enforcement",
        processClass: "ATOrd",
        claimAmountCents: 1_000_000,
        liquidatedAmountCents: 2_000_000,
        lossProbability: "probable",
        riskPercentageBp: 10000,
      },
      {
        ...base,
        number: "0000203-11.2025.5.10.0001",
        title: "Reclamação fictícia C",
        court: "TRT10",
        phase: "knowledge",
        processClass: "ATOrd",
        claimAmountCents: 700_000,
        needsVerification: true,
      },
    ])
    .returning({ id: legalProcesses.id });
  const [a, b] = inserted;
  await f.db.insert(processParties).values([
    { organizationId: f.orgA, processId: a.id, name: "Ana Reclamante", role: "plaintiff" },
    { organizationId: f.orgA, processId: b.id, name: "Ana Reclamante", role: "plaintiff" },
  ]);
  for (const p of [a, b]) {
    await f.db.insert(caseBriefs).values({
      organizationId: f.orgA,
      processId: p.id,
      version: 1,
      status: "ready_for_review",
      mode: "demo",
      provider: "simulated",
      model: "demo",
      promptVersion: "t",
      inputHash: `h-${p.id}`,
      content: brief(["Horas extras e reflexos", "Multa do art. 477"]),
    });
  }
  const [snap] = await f.db
    .insert(portfolioSnapshots)
    .values({
      organizationId: f.orgA,
      period: prev,
      referenceDate: periodReferenceDate(prev),
      status: "closed",
      metrics: {} as never,
      params: { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 1, confidenceThreshold: 85 },
      closedAt: new Date(),
    })
    .returning();
  await f.db.insert(portfolioSnapshotItems).values({
    organizationId: f.orgA,
    snapshotId: snap.id,
    processId: b.id,
    number: "0000202-11.2025.5.10.0001",
    court: "TRT10",
    phase: "enforcement",
    classification: "probable",
    percentageBp: 10000,
    liquidatedAmountCents: 1_800_000,
    exposureCents: 1_800_000,
    provisionCents: 1_800_000,
  });
});

afterAll(async () => f?.teardown());

describe("/relatorios", () => {
  it("renders every report type with export links, print button and reading rules", async () => {
    session.current = f.ctx.admin;
    for (const tipo of ["carteira", "exposicao", "provisao", "auditoria", "movimentacao", "responsaveis"]) {
      const out = await page(RelatoriosPage, { tipo });
      expect(out, tipo).toContain("Exportar CSV");
      expect(out, tipo).toContain(`/api/reports/${tipo}?formato=xlsx`);
      expect(out, tipo).toContain("Imprimir / salvar em PDF");
      expect(out, tipo).toContain("report-print");
    }
    const carteira = await page(RelatoriosPage, { tipo: "carteira" });
    expect(carteira).toContain("Valor da causa");
    expect(carteira).toContain("Valor liquidado");
    expect(carteira).toContain("Não apurado");
    expect(carteira).toContain("Há valores estimados (RN-07)");
    expect(carteira).toContain("Carteira completa da organização, incluindo processos sigilosos.");

    const audit = await page(RelatoriosPage, { tipo: "auditoria", competencia: prev });
    expect(audit).toContain("Carta de auditoria — relação de processos judiciais");
    expect(audit).toContain("Advogado(a) responsável");
    expect(audit).toContain("OAB nº");
    expect(audit).toContain("(fechada)");

    const provision = await page(RelatoriosPage, { tipo: "provisao" });
    expect(provision).toContain("fechada");
    expect(provision).toContain("Movimentação da provisão");
  });

  it("shows a pt-BR error for a competência that is not closed and scopes the lawyer", async () => {
    session.current = f.ctx.admin;
    const out = await page(RelatoriosPage, { tipo: "auditoria", competencia: "2001-01" });
    expect(out).toContain("não está fechada");
    expect(out).not.toContain("Exportar CSV");

    session.current = f.ctx.lawyerRe;
    const lawyer = await page(RelatoriosPage, { tipo: "carteira" });
    expect(lawyer).toContain("Nenhum processo na carteira com estes filtros");
    expect(lawyer).toContain("visíveis para o seu perfil");
  });
});

describe("/api/reports/[tipo]", () => {
  const call = (tipo: string, qs: string) =>
    exportRoute(new NextRequest(`http://localhost/api/reports/${tipo}?${qs}`), { params: Promise.resolve({ tipo }) } as never);

  it("streams the CSV with BOM and the right headers", async () => {
    session.current = f.ctx.executive;
    const res = await call("carteira", "formato=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("answers 400/401/403/404 without leaking data", async () => {
    session.current = f.ctx.admin;
    expect((await call("carteira", "formato=pdf")).status).toBe(400);
    expect((await call("inexistente", "formato=csv")).status).toBe(404);
    expect((await call("auditoria", "formato=csv&competencia=2001-01")).status).toBe(400);
    session.current = f.ctx.externalCounsel;
    expect((await call("carteira", "formato=csv")).status).toBe(403);
    session.current = null;
    expect((await call("carteira", "formato=csv")).status).toBe(401);
  });
});

describe("/inteligencia-preventiva and /preventivo", () => {
  it("separates computed indicators, demo-document claims and illustrative suggestions", async () => {
    session.current = f.ctx.admin;
    const out = await page(InteligenciaPreventivaPage);
    expect(out).toContain("Calculado a partir da carteira");
    expect(out).toContain("Pedidos recorrentes (a partir das análises preliminares — documentos de demonstração)");
    expect(out).toContain("Documentos fictícios de demonstração");
    expect(out).toContain("Sugestão ilustrativa — avaliar com a área responsável");
    expect(out).toContain("Criar ocorrência preventiva");
    expect(out).toContain("Criar plano de ação");
    expect(out).toContain("Horas extras / sobrejornada");
    expect(out).toContain("Ver nomes");

    session.current = f.ctx.executive;
    const exec = await page(InteligenciaPreventivaPage);
    expect(exec).not.toContain("Criar ocorrência preventiva");
    expect(exec).toContain("não cria ocorrências nem tarefas");
  });

  it("labels occurrences created from an indicator and links the two screens", async () => {
    session.current = f.ctx.admin;
    await createOccurrenceFromSuggestion(f.ctx.admin, "reclamantes-recorrentes");
    const list = await page(PreventivoPage);
    expect(list).toContain("Origem: inteligência preventiva");
    expect(list).toContain('href="/inteligencia-preventiva"');
    const filtered = await page(PreventivoPage, { origem: "inteligencia-preventiva" });
    expect(filtered).toContain("Mapeamento de reclamantes com mais de um processo");
    const intel = await page(InteligenciaPreventivaPage);
    expect(intel).toContain("Abrir ocorrência");
  });
});
