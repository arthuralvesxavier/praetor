import { describe, expect, it } from "vitest";
import {
  cellDisplayText,
  GAP_MARKER,
  itemDisplayText,
  MONEY_QUANTITIES,
  totalOf,
  type LegalReportDraft,
  type ReportItemDraft,
} from "@/domain/legal-reports";
import { canApproveLegalReport, canGenerateLegalReport, canSupersedeLegalReport } from "@/modules/legal-reports/approvers";
import { excerptFoundIn, isRecordDate, placeItems, validateDraft } from "@/modules/legal-reports/validation";
import { buildReportView, recordDateNote, type StoredItem, type StoredReport } from "@/modules/legal-reports/view";

function draft(items: ReportItemDraft[]): LegalReportDraft {
  return {
    type: "process_report",
    title: "Relatório de teste",
    subtitle: null,
    scope: {},
    scopeLabel: "Teste",
    baseDate: "2026-10-12",
    isSample: false,
    generator: "test",
    generatorVersion: 1,
    sections: [{ key: "s1", title: "Seção" }],
    methodology: [],
    items,
  };
}

const record = (key: string, extra: Partial<ReportItemDraft> = {}): ReportItemDraft => ({
  key,
  section: "s1",
  content: `Item ${key}`,
  origin: "record",
  recordSource: {
    table: "legal_processes",
    field: "court",
    recordId: null,
    label: "Cadastro do processo, campo Tribunal",
    recordedAt: "2026-10-01T12:00:00.000Z",
  },
  ...extra,
});

const SHA = "a".repeat(64);

describe("emissão: origem obrigatória", () => {
  it("item sem origem é ERRO que bloqueia a emissão (não aviso)", () => {
    const issues = validateDraft(draft([record("a"), { key: "b", section: "s1", content: "Afirmação sem origem" }]));
    expect(issues.map((i) => i.code)).toContain("missing_origin");
    expect(issues.find((i) => i.code === "missing_origin")?.itemKey).toBe("b");
  });

  it("origem nula ou vazia também bloqueia", () => {
    const nullOrigin = validateDraft(draft([{ key: "x", section: "s1", content: "x", origin: null }]));
    const emptyOrigin = validateDraft(draft([{ key: "y", section: "s1", content: "y", origin: "" as never }]));
    expect(nullOrigin.map((i) => i.code)).toEqual(["missing_origin"]);
    expect(emptyOrigin.map((i) => i.code)).toEqual(["missing_origin"]);
  });

  it("documentado exige documento, versão, página e trecho; cadastro exige tabela e campo; inferência exige base", () => {
    const issues = validateDraft(
      draft([
        { key: "d", section: "s1", content: "doc", origin: "documented", documentId: "x", page: 2 },
        { key: "r", section: "s1", content: "rec", origin: "record" },
        { key: "i", section: "s1", content: "inf", origin: "inference", derivedFrom: [] },
        { key: "j", section: "s1", content: "inf2", origin: "inference", derivedFrom: ["nao-existe"] },
      ]),
    ).map((i) => i.code);
    expect(issues).toEqual(
      expect.arrayContaining(["documented_incomplete", "record_without_source", "inference_without_basis", "inference_unknown_ref"]),
    );
  });

  it("documentado sem o hash da versão lida é ERRO (o verificador sempre compara o hash)", () => {
    const doc = (extra: Partial<ReportItemDraft>): ReportItemDraft => ({
      key: "d",
      section: "s1",
      content: "doc",
      origin: "documented",
      documentId: "x",
      documentVersionId: "v",
      page: 1,
      excerpt: "Trecho literal suficiente.",
      ...extra,
    });
    expect(validateDraft(draft([doc({})])).map((i) => i.code)).toEqual(["documented_without_hash"]);
    expect(validateDraft(draft([doc({ documentSha256: "abc" })])).map((i) => i.code)).toEqual(["documented_without_hash"]);
    expect(validateDraft(draft([doc({ documentSha256: SHA })]))).toEqual([]);
  });

  it("cadastro e análise sem a data do registro são ERRO (não há texto genérico de data ausente)", () => {
    const noDate = record("r", {
      recordSource: { table: "legal_processes", field: "court", recordId: null, label: "Cadastro", recordedAt: null },
    });
    const badDate = record("b", {
      recordSource: { table: "legal_processes", field: "court", recordId: null, label: "Cadastro", recordedAt: "ontem" },
    });
    const analysis: ReportItemDraft = {
      key: "a",
      section: "s1",
      content: "Parecer",
      origin: "analysis",
      recordSource: { table: "process_risk_assessments", field: "opinion", recordId: null, label: "Parecer", recordedAt: null },
    };
    const badBasis = record("c", {
      recordSource: {
        table: "legal_processes",
        field: "court",
        recordId: null,
        label: "Cadastro",
        recordedAt: "2026-10-01",
        dateBasis: "whenever" as never,
      },
    });
    const issues = validateDraft(draft([noDate, badDate, analysis, badBasis]));
    expect(issues.map((i) => [i.code, i.itemKey])).toEqual([
      ["source_without_date", "r"],
      ["source_without_date", "b"],
      ["source_without_date", "a"],
      ["source_without_date", "c"],
    ]);
    const dated = record("ok", {
      recordSource: {
        table: "process_guarantees",
        field: "amount_cents",
        recordId: null,
        label: "Garantias",
        recordedAt: "2026-10-12",
        dateBasis: "query",
      },
    });
    expect(validateDraft(draft([dated]))).toEqual([]);
  });

  it("data do registro inexistente no calendário (2026-02-30) é ERRO; datas reais, com ou sem hora, passam", () => {
    const at = (key: string, recordedAt: string) =>
      record(key, { recordSource: { table: "legal_processes", field: "court", recordId: null, label: "Cadastro", recordedAt } });
    const issues = validateDraft(
      draft([
        at("feb30", "2026-02-30"),
        at("feb29", "2026-02-29"),
        at("apr31", "2026-04-31T10:00:00.000Z"),
        at("month13", "2026-13-01"),
        at("day00", "2026-10-00"),
      ]),
    );
    expect(issues.map((i) => [i.code, i.itemKey])).toEqual([
      ["source_without_date", "feb30"],
      ["source_without_date", "feb29"],
      ["source_without_date", "apr31"],
      ["source_without_date", "month13"],
      ["source_without_date", "day00"],
    ]);
    expect(isRecordDate("2026-02-30")).toBe(false);
    expect(isRecordDate("2028-02-29")).toBe(true);
    expect(isRecordDate("2026-12-31T23:59:59.000Z")).toBe(true);
    expect(isRecordDate("2026-10-01T25:00:00.000Z")).toBe(false);
  });

  it("data do registro: só ISO estrito, sem texto depois da data ou da hora", () => {
    for (const ok of [
      "2026-02-28",
      "2026-02-28T10:00",
      "2026-02-28T10:00:59",
      "2026-02-28T10:00:59.123Z",
      "2026-02-28T23:59:59.123456Z",
      "2026-02-28T10:00:00-03:00",
      "2026-02-28T10:00:00+05:30",
    ]) {
      expect(isRecordDate(ok), ok).toBe(true);
    }
    for (const bad of [
      "2026-02-28 junk",
      "2026-02-28\n",
      "2026-02-28 ",
      " 2026-02-28",
      "2026-02-28T",
      "2026-02-28T10",
      "2026-02-28T10:00:00.000Zjunk",
      "2026-02-28T24:00:00Z",
      "2026-02-28T10:60:00Z",
      "2026-02-28T10:00:60Z",
      "2026-02-28T10:00:00+24:00",
      "2026-02-28 10:00:00",
      "2026-02-28T10:00:00.Z",
    ]) {
      expect(isRecordDate(bad), JSON.stringify(bad)).toBe(false);
    }
    const at = (key: string, recordedAt: string) =>
      record(key, { recordSource: { table: "legal_processes", field: "court", recordId: null, label: "Cadastro", recordedAt } });
    expect(validateDraft(draft([at("junk", "2026-02-28 junk")])).map((i) => [i.code, i.itemKey])).toEqual([["source_without_date", "junk"]]);
  });

  it("datas reais de registro passam na validação do rascunho", () => {
    const at = (key: string, recordedAt: string) =>
      record(key, { recordSource: { table: "legal_processes", field: "court", recordId: null, label: "Cadastro", recordedAt } });
    expect(validateDraft(draft([at("leap", "2028-02-29"), at("ts", "2026-01-31T12:00:00.000Z")]))).toEqual([]);
  });

  it("data-base inexistente no calendário bloqueia a emissão", () => {
    expect(validateDraft({ ...draft([record("a")]), baseDate: "2026-02-30" }).map((i) => i.code)).toEqual(["invalid_base_date"]);
    expect(validateDraft({ ...draft([record("a")]), baseDate: "2026-02-28" })).toEqual([]);
  });

  it("nota de data: registro, registro mais recente ou consulta; relatório antigo sem data diz só que o gerador não informou", () => {
    expect(recordDateNote({ recordedAt: "2026-10-01" })).toBe(", registro de 01/10/2026");
    expect(recordDateNote({ recordedAt: "2026-10-01", dateBasis: "latest" })).toBe(", registro mais recente de 01/10/2026");
    expect(recordDateNote({ recordedAt: "2026-10-12", dateBasis: "query" })).toBe(", consulta de 12/10/2026 sem registros encontrados");
    // Timestamp em UTC exibido no fuso da aplicação (23h30 de 01/10 em São Paulo).
    expect(recordDateNote({ recordedAt: "2026-10-02T02:30:00.000Z" })).toBe(", registro de 01/10/2026");
    expect(recordDateNote({ recordedAt: null })).toBe(", data do registro não informada pelo gerador");
    expect(recordDateNote({ recordedAt: null })).not.toContain("não guardada pelo cadastro");
  });

  it("rascunho completo não tem problemas", () => {
    expect(validateDraft(draft([record("a"), { key: "g", section: "s1", content: "Cidade", origin: "gap" }]))).toEqual([]);
  });

  it("inferências em ciclo bloqueiam", () => {
    const issues = validateDraft(
      draft([
        { key: "a", section: "s1", content: "a", origin: "inference", derivedFrom: ["b"] },
        { key: "b", section: "s1", content: "b", origin: "inference", derivedFrom: ["a"] },
      ]),
    );
    expect(issues.map((i) => i.code)).toContain("inference_cycle");
  });
});

describe("lacuna", () => {
  it("é exibida literalmente como [DADO NÃO LOCALIZADO], nunca como zero ou vazio", () => {
    expect(GAP_MARKER).toBe("[DADO NÃO LOCALIZADO]");
    const text = itemDisplayText({ origin: "gap", content: "Valor apurado" });
    expect(text).toBe("Valor apurado: [DADO NÃO LOCALIZADO]");
    expect(text).not.toMatch(/R\$|\b0\b/);
    expect(itemDisplayText({ origin: "gap", content: "   " })).toBe(GAP_MARKER);
    // Mesmo se o gerador puser algo no texto, o rótulo nunca vira valor zero.
    expect(itemDisplayText({ origin: "gap", content: "Valor da causa:" })).toBe("Valor da causa: [DADO NÃO LOCALIZADO]");
  });

  it("célula nula de tabela nunca vira 0 nem vazio", () => {
    expect(cellDisplayText(null, {})).toBe(GAP_MARKER);
    expect(cellDisplayText("", {})).toBe(GAP_MARKER);
    expect(cellDisplayText(null, { nullLabel: "Não apurado" })).toBe("Não apurado");
    expect(cellDisplayText(null, { nullLabel: "  " })).toBe(GAP_MARKER);
  });

  it("lacuna não carrega valor nem trecho", () => {
    const issues = validateDraft(draft([{ key: "g", section: "s1", content: "x", origin: "gap", excerpt: "algo" }]));
    expect(issues.map((i) => i.code)).toEqual(["gap_with_value"]);
  });
});

describe("totais: valor da causa e valor apurado nunca são somados", () => {
  it("totalOf soma só a grandeza pedida e conta nulos como desconhecidos", () => {
    const t = totalOf(
      [
        { quantity: "claim", cents: 1000 },
        { quantity: "claim", cents: null },
        { quantity: "claim", cents: 500 },
      ],
      "claim",
    );
    expect(t).toEqual({ quantity: "claim", cents: 1500, counted: 2, unknown: 1 });
  });

  it("misturar grandezas é recusado em qualquer combinação", () => {
    for (const a of MONEY_QUANTITIES) {
      for (const b of MONEY_QUANTITIES) {
        if (a === b) continue;
        expect(() => totalOf([{ quantity: a, cents: 1 }, { quantity: b, cents: 1 }], a)).toThrow(/Grandezas diferentes/);
      }
    }
    expect(() => totalOf([{ quantity: "liquidated", cents: 100 }], "claim")).toThrow();
    expect(() => totalOf([{ quantity: "claim", cents: 100 }], "liquidated")).toThrow();
  });
});

describe("pendências", () => {
  const verdicts = new Map([
    ["doc-ok", { confirmed: true, reason: null }],
    ["doc-bad", { confirmed: false, reason: "Trecho não encontrado na página 2." }],
  ]);
  const items: ReportItemDraft[] = [
    record("high", { confidence: 90 }),
    record("low", { confidence: 69 }),
    record("edge", { confidence: 70 }),
    { key: "doc-ok", section: "s1", content: "d", origin: "documented", documentId: "a", documentVersionId: "b", page: 1, excerpt: "x" },
    { key: "doc-bad", section: "s1", content: "d", origin: "documented", documentId: "a", documentVersionId: "b", page: 2, excerpt: "y" },
    { key: "inf-bad", section: "s1", content: "i", origin: "inference", derivedFrom: ["doc-bad"] },
    { key: "inf-chain", section: "s1", content: "i", origin: "inference", derivedFrom: ["inf-bad"] },
    { key: "inf-ok", section: "s1", content: "i", origin: "inference", derivedFrom: ["high", "doc-ok"] },
  ];
  const reasons = placeItems(items, { threshold: 70, sourceVerdicts: verdicts });

  it("abaixo do limite de confiança vai para pendências; no limite é afirmado", () => {
    expect(reasons.get("high")).toBeNull();
    expect(reasons.get("low")).toMatch(/Confiança 69 abaixo do limite de 70/);
    expect(reasons.get("edge")).toBeNull();
  });

  it("fonte não confirmada nunca é base: o item e as inferências que dependem dele não são afirmados", () => {
    expect(reasons.get("doc-ok")).toBeNull();
    expect(reasons.get("doc-bad")).toMatch(/Fonte não confirmada/);
    expect(reasons.get("inf-bad")).toMatch(/Baseada em item não afirmado/);
    expect(reasons.get("inf-chain")).toMatch(/Baseada em item não afirmado/);
    expect(reasons.get("inf-ok")).toBeNull();
  });

  it("inferência cujas bases são todas lacunas não é afirmada; com uma base afirmada, é", () => {
    const r = placeItems(
      [
        { key: "g1", section: "s1", content: "Valor apurado", origin: "gap" },
        { key: "g2", section: "s1", content: "Garantias", origin: "gap" },
        record("rec"),
        { key: "only-gaps", section: "s1", content: "i", origin: "inference", derivedFrom: ["g1", "g2"] },
        { key: "mixed", section: "s1", content: "i", origin: "inference", derivedFrom: ["g1", "rec"] },
        { key: "chain", section: "s1", content: "i", origin: "inference", derivedFrom: ["only-gaps"] },
      ],
      { threshold: 70, sourceVerdicts: new Map() },
    );
    expect(r.get("only-gaps")).toMatch(/todos os itens dos quais deriva são lacunas/);
    expect(r.get("mixed")).toBeNull();
    expect(r.get("chain")).toMatch(/Baseada em item não afirmado/);
  });

  it("documentado sem resultado de conferência também fica pendente", () => {
    const r = placeItems([{ key: "z", section: "s1", content: "d", origin: "documented" }], { threshold: 0, sourceVerdicts: new Map() });
    expect(r.get("z")).toMatch(/conferência não realizada/);
  });

  it("a visão numera os itens afirmados por seção e as pendências como P1, P2…", () => {
    const report: StoredReport = {
      id: "r",
      type: "process_report",
      reference: "R1-2026-0001",
      version: 1,
      title: "t",
      isSample: false,
      status: "pending_review",
      scope: {},
      processId: null,
      baseDate: "2026-10-12",
      parameters: {
        generator: "test",
        generatorVersion: 1,
        confidenceThreshold: 70,
        bands: {
          very_high: { min: 80, max: 100 },
          high: { min: 60, max: 80 },
          moderate: { min: 40, max: 60 },
          low: { min: 20, max: 40 },
          very_low: { min: 0, max: 20 },
        },
        legalBasisText: "x",
        subtitle: null,
        sections: [{ key: "s1", title: "Seção" }],
        methodology: [],
        scopeLabel: "x",
      },
      supersedesId: null,
      generatedAt: new Date(),
      generatedById: null,
      approvedById: null,
      approvedAt: null,
      pdfSha256: null,
      pdfSizeBytes: null,
    };
    const base = (id: string, position: number, pendingReason: string | null, derivedFrom: string[] | null = null): StoredItem => ({
      id,
      section: "s1",
      position,
      content: id,
      origin: derivedFrom ? "inference" : "record",
      documentId: null,
      documentVersionId: null,
      page: null,
      excerpt: null,
      recordSource: null,
      derivedFrom,
      confidence: null,
      simulated: false,
      pendingReason,
      data: null,
    });
    const view = buildReportView(report, [base("a", 1, null), base("b", 2, "x"), base("c", 3, null, ["a"])], [], {
      generatedByName: null,
      approvedByName: null,
      approvedByRole: null,
      supersededById: null,
    });
    expect(view.sections[0].items.map((i) => i.number)).toEqual(["2.1", "2.2"]);
    expect(view.pendingItems.map((i) => i.number)).toEqual(["P1"]);
    expect(view.sections[0].items[1].derivedFromNumbers).toEqual(["2.1"]);
  });
});

describe("conferência literal do trecho", () => {
  it("tolera espaços e quebras de linha, mas não muda palavras", () => {
    const page = "O reclamante foi admitido em\n03/03/2019   na função de auxiliar.";
    expect(excerptFoundIn(page, "admitido em 03/03/2019 na função")).toBe(true);
    expect(excerptFoundIn(page, "admitido em 04/03/2019 na função")).toBe(false);
    expect(excerptFoundIn(page, "curto")).toBe(false);
  });
});

describe("aprovadores por tipo", () => {
  const u = (role: Parameters<typeof canApproveLegalReport>[0]["role"], userId = "u1") => ({ kind: "user" as const, userId, role });
  it("R1 e R4: gestor jurídico ou o advogado responsável do escopo; admin sempre", () => {
    for (const type of ["process_report", "responsibility_report"] as const) {
      expect(canApproveLegalReport(u("legal_manager"), { type, scopeResponsibleId: null })).toBe(true);
      expect(canApproveLegalReport(u("admin"), { type, scopeResponsibleId: null })).toBe(true);
      expect(canApproveLegalReport(u("lawyer", "resp"), { type, scopeResponsibleId: "resp" })).toBe(true);
      expect(canApproveLegalReport(u("lawyer", "outro"), { type, scopeResponsibleId: "resp" })).toBe(false);
      expect(canApproveLegalReport(u("accountant"), { type, scopeResponsibleId: null })).toBe(false);
    }
  });
  it("R2: gestor jurídico ou contabilidade; R3: só gestor jurídico", () => {
    expect(canApproveLegalReport(u("accountant"), { type: "provision_report", scopeResponsibleId: null })).toBe(true);
    expect(canApproveLegalReport(u("lawyer"), { type: "provision_report", scopeResponsibleId: "u1" })).toBe(false);
    expect(canApproveLegalReport(u("legal_manager"), { type: "portfolio_report", scopeResponsibleId: null })).toBe(true);
    expect(canApproveLegalReport(u("accountant"), { type: "portfolio_report", scopeResponsibleId: null })).toBe(false);
    expect(canApproveLegalReport(u("executive"), { type: "portfolio_report", scopeResponsibleId: null })).toBe(false);
  });
  it("gerar: só report:generate e o papel do tipo; perfis de leitura nunca geram", () => {
    for (const role of ["executive", "auditor", "analyst"] as const) {
      for (const type of ["process_report", "provision_report", "portfolio_report", "responsibility_report"] as const) {
        expect(canGenerateLegalReport(u(role), type)).toBe(false);
      }
    }
    expect(canGenerateLegalReport(u("lawyer"), "process_report")).toBe(true);
    expect(canGenerateLegalReport(u("lawyer"), "portfolio_report")).toBe(false);
    expect(canGenerateLegalReport(u("accountant"), "provision_report")).toBe(true);
    expect(canGenerateLegalReport(u("accountant"), "process_report")).toBe(false);
    expect(canGenerateLegalReport(u("legal_manager"), "portfolio_report")).toBe(true);
    expect(canGenerateLegalReport(u("external_counsel"), "process_report")).toBe(false);
    expect(canGenerateLegalReport({ kind: "system", userId: null, role: "admin" }, "portfolio_report")).toBe(true);
  });

  it("substituir versão aprovada: só quem poderia aprová-la; pendente: quem gera o tipo", () => {
    const approved = { type: "process_report" as const, status: "approved" as const, scopeResponsibleId: "resp" };
    const pending = { ...approved, status: "pending_review" as const };
    expect(canSupersedeLegalReport(u("lawyer", "outro"), approved)).toBe(false);
    expect(canSupersedeLegalReport(u("lawyer", "outro"), pending)).toBe(true);
    expect(canSupersedeLegalReport(u("lawyer", "resp"), approved)).toBe(true);
    expect(canSupersedeLegalReport(u("legal_manager"), approved)).toBe(true);
    expect(canSupersedeLegalReport(u("auditor"), pending)).toBe(false);
    expect(canSupersedeLegalReport(u("executive"), approved)).toBe(false);
    expect(canSupersedeLegalReport({ kind: "system", userId: null, role: "admin" }, approved)).toBe(false);
    expect(canSupersedeLegalReport(u("legal_manager"), { ...approved, status: "superseded" })).toBe(false);
  });

  it("o sistema nunca aprova", () => {
    expect(canApproveLegalReport({ kind: "system", userId: null, role: "admin" }, { type: "process_report", scopeResponsibleId: null })).toBe(false);
  });
});
