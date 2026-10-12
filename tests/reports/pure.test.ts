import { describe, expect, it } from "vitest";
import { emptyBucket } from "@/domain/contingency";
import {
  parsePreventiveOrigin,
  preventiveOriginMarker,
  isPreventiveIndicatorKey,
} from "@/modules/occurrences/preventive-origin";
import { aggregateClaims, classifyClaim } from "@/modules/preventive-intel/claims";
import { buildSuggestionFacts, keySlug } from "@/modules/preventive-intel/suggestions";
import { cell, csvMoney, csvPercent, csvValue, sheetToCsv, CSV_BOM } from "@/modules/reports/csv";
import { buildReportExport } from "@/modules/reports/export-builders";
import { addSnapshotPosition, BucketGroups, cityGroup, cnjKey, courtGroup } from "@/modules/reports/grouping";
import { reportFiltersFromParams } from "@/modules/reports/schemas";
import type { PortfolioReport } from "@/modules/reports/types";
import type { BriefClaim } from "@/domain/case-brief";

const claim = (description: string, provenance: BriefClaim["provenance"] = "extracted", amountCents: number | null = null): BriefClaim => ({
  description,
  amountCents,
  provenance,
  citations: [],
  note: null,
});

describe("CSV formatting (UTF-8 BOM, ';', decimal comma, empty nulls)", () => {
  it("formats money with decimal comma and no thousands separator", () => {
    expect(csvMoney(123456)).toBe("1234,56");
    expect(csvMoney(5)).toBe("0,05");
    expect(csvMoney(-150)).toBe("-1,50");
    expect(csvMoney(19_800_000)).toBe("198000,00");
  });

  it("formats percentages from basis points", () => {
    expect(csvPercent(5000)).toBe("50");
    expect(csvPercent(1250)).toBe("12,5");
    expect(csvPercent(0)).toBe("0");
    expect(csvPercent(10000)).toBe("100");
  });

  it("leaves null cells empty (RN-03) and never writes zero for unknown values", () => {
    expect(csvValue(cell.money(null))).toBe("");
    expect(csvValue(cell.int(null))).toBe("");
    expect(csvValue(cell.text(null))).toBe("");
    expect(csvValue(cell.date("2026-03-05"))).toBe("05/03/2026");
    expect(csvValue(cell.bool(true))).toBe("Sim");
  });

  it("quotes separators and neutralizes spreadsheet formulas", () => {
    expect(csvValue(cell.text("A; B"))).toBe('"A; B"');
    expect(csvValue(cell.text('Diz "olá"'))).toBe('"Diz ""olá"""');
    expect(csvValue(cell.text("=HYPERLINK(1)"))).toBe("'=HYPERLINK(1)");
  });

  it("writes a BOM, a header row, ';' separators and CRLF line breaks", () => {
    const csv = sheetToCsv({
      name: "x",
      columns: [{ header: "Processo" }, { header: "Valor liquidado (R$)" }],
      rows: [
        [cell.text("0000001-11.2026.5.10.0001"), cell.money(null)],
        [cell.text("0000002-11.2026.5.10.0001"), cell.money(250050)],
      ],
    });
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Processo;Valor liquidado (R$)");
    expect(lines[1]).toBe("0000001-11.2026.5.10.0001;");
    expect(lines[2]).toBe("0000002-11.2026.5.10.0001;2500,50");
  });
});

describe("grouping helpers", () => {
  it("groups city variants and court spellings", () => {
    expect(cityGroup("Palmas - TO").key).toBe(cityGroup("Palmas/TO").key);
    expect(cityGroup("Palmas (TO)").key).toBe(cityGroup("palmas").key);
    expect(cityGroup("Palmas - TO").label).toBe("Palmas");
    expect(cityGroup("Cejusc Digital").label).toBe("Cejusc Digital");
    expect(cityGroup(null).label).toBe("Cidade não informada");
    expect(courtGroup("TRT-10").key).toBe(courtGroup("trt 10").key);
  });

  it("counts unique CNJ numbers once (RN-01)", () => {
    expect(cnjKey("00000011120265100001")).toBe(cnjKey("0000001-11.2026.5.10.0001"));
    const g = new BucketGroups();
    const item = { liquidatedCents: null, linkedGuaranteesCents: 0, claimCents: 100, riskPercentageBp: null };
    g.add("a", "A", "0000001-11.2026.5.10.0001", item);
    g.add("a", "A", "00000011120265100001", item);
    const [row] = g.rows();
    expect(row.processCount).toBe(1);
    expect(row.bucket.count).toBe(2);
  });

  it("adds stored snapshot positions without recomputing them (RN-10)", () => {
    const b = addSnapshotPosition(emptyBucket(), {
      claimAmountCents: null,
      liquidatedAmountCents: 1000,
      guaranteesCents: 0,
      exposureCents: 777,
      exposureIsEstimate: false,
      provisionCents: 333,
      provisionIsEstimate: true,
    });
    expect(b.claimUnknown).toBe(1);
    expect(b.exposureCents).toBe(777);
    expect(b.provisionEstimateCents).toBe(333);
    expect(b.provisionCents).toBe(0);
  });

  it("reads report filters from URL params, dropping malformed values", () => {
    const f = reportFiltersFromParams({
      empresa: "not-a-uuid",
      unidade: "11111111-2222-3333-4444-555555555555",
      competencia: "2026-13",
      de: "2026-02-30",
      ate: "2026-03-01",
    });
    expect(f).toEqual({
      companyId: undefined,
      unitId: "11111111-2222-3333-4444-555555555555",
      period: undefined,
      from: undefined,
      to: "2026-03-01",
    });
  });
});

describe("export builders", () => {
  it("leaves the liquidated sum empty when every process of a group is 'não apurado'", () => {
    const bucket = { ...emptyBucket(), count: 2, claimCents: 1000, liquidatedUnknown: 2 };
    const report: PortfolioReport = {
      type: "carteira",
      scope: { orgWide: true, includesConfidential: true, label: "x", totalLabel: "Total" },
      generatedAt: new Date("2026-10-11T12:00:00Z"),
      organizationName: "Org",
      filterSummary: "Sem filtros",
      byCompany: [{ key: "c", label: "Empresa X", processCount: 2, bucket }],
      byUnit: [],
      byClassification: [],
      totals: { key: "total", label: "Total", processCount: 2, bucket },
      hasEstimates: false,
    };
    const exp = buildReportExport(report);
    const csv = sheetToCsv(exp.sheets[exp.csvSheet]);
    const row = csv.split("\r\n").find((l) => l.startsWith("Empresa;Empresa X"))!;
    const cols = row.split(";");
    // Agrupamento;Grupo;Processos;Causa;Sem causa;Liquidado;Não apurado;...
    expect(cols[3]).toBe("10,00");
    expect(cols[5]).toBe("");
    expect(cols[6]).toBe("2");
  });
});

describe("preventive origin marker", () => {
  it("round-trips the indicator key and line", () => {
    expect(isPreventiveIndicatorKey("conciliacao:trt-10")).toBe(true);
    expect(isPreventiveIndicatorKey("../x")).toBe(false);
    const facts = buildSuggestionFacts(
      { key: "jornada", title: "T", trigger: "Horas extras em 3 processos.", basis: "b", measure: "m", planItems: [] },
      { today: "2026-10-11", filterSummary: "Sem filtros" },
    );
    expect(facts).toContain(preventiveOriginMarker("jornada"));
    expect(parsePreventiveOrigin(facts)).toEqual({ key: "jornada", indicator: "Horas extras em 3 processos." });
    expect(parsePreventiveOrigin("Fatos comuns sem marcador.")).toBeNull();
    expect(keySlug("TRT-10ª Região")).toBe("trt-10-regiao");
  });
});

describe("claim categorization (extracted only, sensitive data excluded — PD-06)", () => {
  it("classifies claims and excludes health / union claims", () => {
    expect(classifyClaim("Pagamento de horas extras e reflexos")).toEqual({ kind: "category", key: "horas_extras" });
    expect(classifyClaim("Multa do art. 477 da CLT")).toEqual({ kind: "category", key: "verbas_rescisorias" });
    expect(classifyClaim("Indenização por doença ocupacional")).toEqual({ kind: "sensitive" });
    expect(classifyClaim("Devolução de contribuição sindical")).toEqual({ kind: "sensitive" });
    expect(classifyClaim("Pedido genérico qualquer")).toEqual({ kind: "uncategorized" });
  });

  it("aggregates per process and ignores non-extracted items", () => {
    const r = aggregateClaims([
      { processId: "p1", claims: [claim("Horas extras", "extracted", 1000), claim("Horas extras 50%", "extracted", 500), claim("Dano moral", "illustrative")] },
      { processId: "p2", claims: [claim("Sobrejornada"), claim("Acidente de trabalho"), claim("Algo sem categoria")] },
      { processId: "p3", claims: null },
    ]);
    expect(r.briefsConsidered).toBe(3);
    const he = r.rows.find((x) => x.key === "horas_extras")!;
    expect(he.processCount).toBe(2);
    expect(he.withAmount).toBe(2);
    expect(he.amountCents).toBe(1500);
    expect(he.share).toBeCloseTo(2 / 3);
    expect(r.rows.some((x) => x.key === "dano_moral")).toBe(false);
    expect(r.ignoredNotExtracted).toBe(1);
    expect(r.excludedSensitive).toBe(1);
    expect(r.uncategorized).toBe(1);
  });
});
