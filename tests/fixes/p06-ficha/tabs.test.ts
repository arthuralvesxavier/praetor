/**
 * P0.6: six tabs on the process detail, every key of the previous layout opens the tab
 * that now holds its content (and the section to scroll to), header subtitle and the
 * cover helpers. Pure functions only.
 */
import { describe, expect, it } from "vitest";
import { firstSentence, missingCoverFields } from "@/modules/processes/cover";
import { processTabHref, RISK_SECTION_ID } from "@/modules/processes/decision-band";
import {
  LEGACY_PROCESS_TABS,
  PROCESS_TAB_KEYS,
  PROCESS_TAB_LABELS,
  processHeaderSubtitle,
  processTabUrl,
  resolveProcessTab,
} from "@/modules/processes/tabs";
import { eventsByInstance } from "@/modules/processes/timeline";
import { scrollActiveTabIntoView } from "@/modules/processes/components/active-tab-scroller";

const PID = "00000000-0000-4000-8000-0000000000aa";

describe("tabs", () => {
  it("six tabs, resumo first", () => {
    expect(PROCESS_TAB_KEYS).toEqual([
      "resumo",
      "partes-e-andamento",
      "valores-e-acordos",
      "prazos-e-audiencias",
      "documentos-e-analises",
      "historico",
    ]);
    for (const key of PROCESS_TAB_KEYS) expect(PROCESS_TAB_LABELS[key]).toBeTruthy();
    for (const label of Object.values(PROCESS_TAB_LABELS)) expect(label).not.toMatch(/—| – /);
  });

  it("every old key opens the tab that contains it", () => {
    const expected: Record<string, [string, string | null]> = {
      "visao-geral": ["resumo", null],
      partes: ["partes-e-andamento", "partes"],
      instancias: ["partes-e-andamento", "instancias"],
      movimentacoes: ["partes-e-andamento", "andamento"],
      valores: ["valores-e-acordos", null],
      acordos: ["valores-e-acordos", "acordos"],
      audiencias: ["prazos-e-audiencias", "audiencias"],
      "analise-preliminar": ["documentos-e-analises", "analise-preliminar"],
      documentos: ["documentos-e-analises", null],
      prazos: ["prazos-e-audiencias", null],
      emails: ["historico", "emails"],
      ia: ["documentos-e-analises", "analises-ia"],
      comentarios: ["historico", null],
      historico: ["historico", null],
    };
    expect(Object.keys(LEGACY_PROCESS_TABS).sort()).toEqual(Object.keys(expected).sort());
    for (const [old, [tab, section]] of Object.entries(expected)) {
      expect(resolveProcessTab(old)).toEqual({ tab, section, legacy: old !== "historico" });
    }
  });

  it("new keys win; absent, unknown and prototype keys open the summary", () => {
    for (const key of PROCESS_TAB_KEYS) expect(resolveProcessTab(key)).toEqual({ tab: key, section: null, legacy: false });
    for (const value of [undefined, null, "", "xyz", "constructor", "__proto__", "toString"]) {
      expect(resolveProcessTab(value)).toEqual({ tab: "resumo", section: null, legacy: false });
    }
    expect(resolveProcessTab(["audiencias", "valores"])).toMatchObject({ tab: "prazos-e-audiencias", section: "audiencias" });
  });

  it("links: the default tab has no query; sections become the hash", () => {
    expect(processTabUrl(PID, "resumo")).toBe(`/processos/${PID}`);
    expect(processTabUrl(PID, "historico", "emails")).toBe(`/processos/${PID}?aba=historico#emails`);
    expect(processTabHref(PID, "valores")).toBe(`/processos/${PID}?aba=valores-e-acordos`);
    expect(processTabHref(PID, "prazos")).toBe(`/processos/${PID}?aba=prazos-e-audiencias`);
    expect(processTabHref(PID, "audiencias")).toBe(`/processos/${PID}?aba=prazos-e-audiencias#audiencias`);
    expect(RISK_SECTION_ID).toBe("classificacao-risco");
  });
});

describe("header subtitle (Autor × Empresa)", () => {
  const party = (name: string, role: string, isClient = false) => ({ name, role, isClient });

  it("first plaintiff × group company", () => {
    expect(
      processHeaderSubtitle({ parties: [party("Maria Fictícia", "plaintiff"), party("Ré Fictícia", "defendant")], companyName: "Empresa A" }),
    ).toBe("Maria Fictícia × Empresa A");
  });

  it("several plaintiffs, client defendant when there is no company, honest placeholders", () => {
    expect(
      processHeaderSubtitle({
        parties: [party("Ana", "plaintiff"), party("Bruno", "plaintiff"), party("Outra Ré", "defendant"), party("Cliente Ltda.", "defendant", true)],
        companyName: null,
      }),
    ).toBe("Ana e outros × Cliente Ltda.");
    expect(processHeaderSubtitle({ parties: [], companyName: null })).toBe("Autor não informado × Empresa não informada");
  });
});

describe("cover helpers", () => {
  const base = {
    court: "TRT10",
    courtDivision: "1ª Vara",
    city: "Palmas",
    processClass: "ATOrd",
    instance: "first" as const,
    companyId: "c",
    unitId: "u",
    responsibleId: "r",
    filedAt: "2026-01-10",
    claimAmountCents: 1_000_00,
  };

  it("lists only the empty fields (blank text is empty), in form order", () => {
    expect(missingCoverFields(base)).toEqual([]);
    expect(
      missingCoverFields({ ...base, courtDivision: "  ", city: null, instance: null, responsibleId: null, claimAmountCents: null }),
    ).toEqual(["courtDivision", "city", "instance", "responsible", "claim"]);
  });

  it("valor da causa zero is informed (null is not zero)", () => {
    expect(missingCoverFields({ ...base, claimAmountCents: 0 })).toEqual([]);
  });

  it("a valor da causa waiting in the review queue is not a registration gap", () => {
    expect(missingCoverFields({ ...base, claimAmountCents: null }, { claimPending: true })).toEqual([]);
    expect(missingCoverFields({ ...base, claimAmountCents: null }, { claimPending: false })).toEqual(["claim"]);
  });

  it("first sentence of the brief headline", () => {
    expect(firstSentence("Reclamação de horas extras. Pede R$ 1.000,00 e reflexos.")).toBe("Reclamação de horas extras.");
    expect(firstSentence("  Sem ponto final  ")).toBe("Sem ponto final");
    expect(firstSentence(null)).toBeNull();
    expect(firstSentence("x".repeat(300))?.length).toBeLessThanOrEqual(221);
  });
});

describe("unified timeline", () => {
  it("counts movements per instance in grau order, without instance last", () => {
    expect(
      eventsByInstance([{ instance: "second" }, { instance: null }, { instance: "first" }, { instance: "second" }]),
    ).toEqual([
      { instance: "first", count: 1 },
      { instance: "second", count: 2 },
      { instance: null, count: 1 },
    ]);
  });
});

describe("tab bar on a phone (ActiveTabScroller)", () => {
  type Rect = { left: number; right: number; width: number };
  const rect = (left: number, width: number): Rect => ({ left, right: left + width, width });
  function setup(tab: Rect, scrollWidth = 820) {
    const bar = { scrollWidth, clientWidth: 358, scrollLeft: 0, getBoundingClientRect: () => rect(16, 358) };
    const active = { closest: () => bar, getBoundingClientRect: () => tab };
    const root = { querySelector: (sel: string) => (sel === '[aria-current="page"]' ? active : null) };
    scrollActiveTabIntoView(root as unknown as HTMLElement);
    return bar;
  }

  it("centers an active tab that is off-screen, scrolling only the bar", () => {
    // "Histórico" at x = 700 (bar from 16 to 374): centered => 700 - 16 - (358 - 80) / 2.
    expect(setup(rect(700, 80)).scrollLeft).toBe(700 - 16 - (358 - 80) / 2);
  });

  it("does nothing when the active tab is visible or every tab fits", () => {
    expect(setup(rect(16, 70)).scrollLeft).toBe(0);
    expect(setup(rect(700, 80), 358).scrollLeft).toBe(0);
  });

  it("a partly hidden tab is brought fully into view", () => {
    expect(setup(rect(300, 150)).scrollLeft).toBeGreaterThan(0);
  });
});
