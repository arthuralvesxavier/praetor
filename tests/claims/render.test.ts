import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredCaseBrief } from "@/domain/case-brief";
import { ProcessClaimsPanel } from "@/modules/claims/components/process-claims-panel";
import { assessClaim, createClaim, getProcessClaims, overrideProcessRisk } from "@/modules/claims/service";
import { getDb } from "@/server/db/client";
import { caseBriefs } from "@/server/db/schema";
import { makeProcess, setupFixture, today, type Fixture } from "../helpers/fixtures";

/** Server-render smoke test of <ProcessClaimsPanel /> with real data (no browser). */

vi.mock("server-only", () => ({}));

let fx: Fixture;
let processId: string;

function brief(claims: StoredCaseBrief["claims"]): StoredCaseBrief {
  return {
    headline: "Resumo fictício.",
    identification: [],
    factsSummary: [],
    timeline: [],
    claims,
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

async function render(ctx: Fixture["ctx"][keyof Fixture["ctx"]]): Promise<string> {
  return renderToStaticMarkup((await ProcessClaimsPanel({ ctx, processId })) as ReactElement);
}

beforeAll(async () => {
  fx = await setupFixture("claimsrender");
  processId = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, title: "Processo de renderização de pedidos (fictício)" });
  const a = await createClaim(fx.ctx.lawyer, processId, {
    description: "Horas extras (fictício)",
    category: "overtime",
    claimedAmountCents: 4_000_000,
    amountBaseDate: "2026-01-10",
    correctionIndex: "ipca_e",
  });
  await createClaim(fx.ctx.lawyer, processId, { description: "Dano moral (fictício)", category: "moral_damages" });
  await assessClaim(fx.ctx.lawyer, a.id, {
    classification: "probable",
    percentage: null,
    opinion: "Parecer fictício de renderização.",
    effectiveFrom: today(),
  });
  await getDb()
    .insert(caseBriefs)
    .values({
      organizationId: fx.orgA,
      processId,
      version: 1,
      status: "ready_for_review",
      mode: "demo",
      provider: "simulated",
      model: "simulacao",
      promptVersion: "test",
      inputHash: "test",
      content: brief([
        { description: "Adicional de insalubridade", amountCents: 900_000, provenance: "extracted", citations: [{ ref: "D1", page: 2, excerpt: null }], note: null },
      ]),
    });
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("ProcessClaimsPanel", () => {
  it("renders claims, derived risk and actions for a lawyer", async () => {
    const html = await render(fx.ctx.lawyer);
    expect(html).toContain("Risco do processo pelos pedidos");
    expect(html).toContain("Horas extras (fictício)");
    expect(html).toContain("IPCA-E");
    expect(html).toContain("Incluir pedido");
    expect(html).toContain("Avaliar");
    expect(html).toContain("corresponde à derivada dos pedidos");
    expect(html).toContain("Provisão do processo");
    expect(html).toContain("ponderado pelos pedidos quantificados");
    expect(html).toContain("Sem avaliação de risco");
    expect(html).toContain("Trazer pedidos sugeridos");
    expect(html).toContain("conteúdo demonstrativo");
    expect(html).not.toMatch(/—| – /);
  });

  it("shows the manual classification and the review flag", async () => {
    await overrideProcessRisk(fx.ctx.manager, processId, {
      classification: "possible",
      percentage: null,
      justification: "Justificativa fictícia para a renderização.",
    });
    const html = await render(fx.ctx.lawyer);
    expect(html).toContain("Classificação definida manualmente");
    expect(html).toContain("Aplicar classificação derivada");
    expect(html).toContain("Manter manual com nova justificativa");
  });

  it("flags an unquantified assessed claim and the kept override after a claim change", async () => {
    const overview = await getProcessClaims(fx.ctx.lawyer, processId);
    const moral = overview.claims.find((c) => c.claimedAmountCents === null)!;
    await assessClaim(fx.ctx.lawyer, moral.id, {
      classification: "possible",
      percentage: null,
      opinion: "Parecer fictício sem valor.",
      effectiveFrom: today(),
    });
    const html = await render(fx.ctx.lawyer);
    expect(html).toContain("Classificação manual a rever");
    expect(html).toContain("Pedido avaliado sem valor");
    expect(html).toContain("não vale zero");
    expect(html).not.toMatch(/—| – /);
  });

  it("read-only and outsider profiles", async () => {
    const reader = await render(fx.ctx.executive);
    expect(reader).toContain("Horas extras (fictício)");
    expect(reader).not.toContain("Incluir pedido");
    expect(reader).not.toContain("Trazer pedidos sugeridos");

    const outsider = await render(fx.ctx.externalCounsel);
    expect(outsider).toContain("sem permissão");
    const otherOrg = await render(fx.ctx.adminB);
    expect(otherOrg).toContain("sem permissão");
  });
});
