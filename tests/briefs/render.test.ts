/**
 * Server-render smoke test of the brief UI components (no browser): catches
 * runtime errors in rendering and checks the mandatory labels are present.
 * Server actions are mocked (they need a request context).
 */
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/briefs/actions", () => {
  const fn = async () => ({ ok: true });
  return {
    applyBriefDeadlineAction: fn,
    applyBriefNextStepAction: fn,
    approveCaseBriefAction: fn,
    proposeBriefAmountAction: fn,
    regenerateCaseBriefAction: fn,
    rejectCaseBriefAction: fn,
    requestCaseBriefAction: fn,
    saveBriefSectionAction: fn,
    loadBriefCitationPageAction: fn,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), redirect: () => {}, notFound: () => {} }));

import { CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_DISCLAIMER } from "@/domain/case-brief";
import { BriefReviewActions } from "@/modules/briefs/components/brief-actions";
import { BriefNotices } from "@/modules/briefs/components/brief-notices";
import { BriefSectionEditor } from "@/modules/briefs/components/brief-section-editor";
import { BriefView } from "@/modules/briefs/components/brief-view";
import { buildSimulatedCaseBrief } from "@/server/integrations/ai/case-brief/simulated";

const brief = buildSimulatedCaseBrief({
  record: {
    number: "0000123-45.2024.5.10.0801",
    title: "Autor x Empresa",
    court: "TRT10",
    courtDivision: null,
    city: "Palmas",
    state: "TO",
    area: "labor",
    phase: "enforcement",
    phaseDetail: null,
    instance: "first",
    processClass: null,
    claimAmountCents: 20_000_000,
    liquidatedAmountCents: null,
    filedAt: "2026-01-01",
    companyName: null,
    responsibleName: null,
    parties: [],
    instances: [],
    events: [],
    recordSourceLabel: "Planilha (dados fictícios)",
  },
  documents: [],
  today: "2026-10-11",
});

describe("brief UI components (server render)", () => {
  it("renders every section with provenance labels and separated risk groups", () => {
    const html = renderToString(
      h(BriefView, {
        briefId: "b",
        processId: "p",
        content: { ...brief, systemNotices: [CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_DISCLAIMER] },
        sourceLabels: {},
        abilities: { canOpenDocuments: true, applicable: true, canCreateDeadline: true, canCreateTask: true, canProposeAmount: true },
      }),
    );
    for (const label of ["Identificação", "Valores", "Possíveis prazos (conferir)", "Lacunas de informação"]) expect(html).toContain(label);
    expect(html).toContain("Calculado a partir da carteira");
    expect(html).toContain("Sugestão ilustrativa");
    expect(html).toContain("Não apurado");
    expect(html).toContain("Criar tarefa");
  });

  it("renders the editors, notices and review actions", () => {
    for (const section of ["headline", "identification", "amounts", "possibleDeadlines", "risks", "gaps"] as const) {
      const value = section === "headline" ? brief.headline : brief[section];
      const html = renderToString(h(BriefSectionEditor, { briefId: "b", processId: "p", section, label: "Seção", value: value as never, baseRevision: 1 }));
      expect(html).toContain("Salvar seção");
    }
    expect(renderToString(h(BriefNotices, { mode: "demo" }))).toContain("ANÁLISE DEMONSTRATIVA");
    const actions = renderToString(h(BriefReviewActions, { briefId: "b", processId: "p", canDecide: true, canRegenerate: true }));
    expect(actions).toContain("Aprovar");
    expect(actions).toContain("Rejeitar");
    expect(actions).toContain("Gerar nova versão");
  });
});
