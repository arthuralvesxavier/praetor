import { describe, expect, it } from "vitest";
import { emptyBucket } from "@/domain/contingency";
import {
  DEFAULT_DIMENSION,
  DIMENSION_PARAMS,
  dimensionChartModel,
  parseChartDimension,
} from "@/modules/dashboard/dimension-chart";
import { bucketOf, DIMENSIONS, dimensionGroups, type PortfolioRowLike } from "@/modules/dashboard/portfolio";
import type { Dimension } from "@/modules/dashboard/portfolio-service";

/** Pure view model of the unified "Exposição e processos por dimensão" chart (P0.3). */

/** pt-BR money formats use a non-breaking space after "R$". */
const plain = (s: string) => s.replace(/\u00a0/g, " ");

const base: PortfolioRowLike = {
  processId: "p",
  number: "n",
  companyId: null,
  unitId: null,
  court: "TRT10",
  instance: "first",
  phase: "knowledge",
  city: "Palmas",
  classification: "possible",
  percentageBp: 5_000,
  claimCents: 1_000_000,
  liquidatedCents: null,
  guaranteesCents: 0,
};

const portfolio: PortfolioRowLike[] = [
  // Apurado R$ 1,3 mi (TJSP, 2º grau, execução, São Paulo).
  { ...base, processId: "a", number: "1", court: "TJSP", instance: "second", phase: "enforcement", city: "São Paulo", liquidatedCents: 130_000_000 },
  // Apurado R$ 571 mil (TRT2, 1º grau, liquidação, São Paulo).
  { ...base, processId: "b", number: "2", court: "TRT2", instance: "first", phase: "liquidation", city: "São Paulo", liquidatedCents: 57_100_000 },
  // Não apurado: estimate R$ 5 mil (TRT10, 1º grau, conhecimento, Palmas).
  { ...base, processId: "c", number: "3" },
];

function dimensionOf(key: Dimension["key"], keyOf: (r: PortfolioRowLike) => string | null): Dimension {
  const { top, others, missing } = dimensionGroups(portfolio, keyOf);
  return {
    key,
    rows: top.map((g) => ({ ...g, label: g.key, href: `/processos?${DIMENSION_PARAMS[key]}=${g.key}` })),
    others,
    missing: missing ? { bucket: missing, href: `/processos?pendencia=${DIMENSION_PARAMS[key]}` } : null,
  };
}

const dimensions: Record<Dimension["key"], Dimension> = {
  court: dimensionOf("court", (r) => r.court),
  instance: dimensionOf("instance", (r) => r.instance),
  phase: dimensionOf("phase", (r) => r.phase),
  city: dimensionOf("city", (r) => r.city),
  company: dimensionOf("company", (r) => r.companyId),
  unit: dimensionOf("unit", (r) => r.unitId),
};

describe("chart dimension URL param (?dimensao=)", () => {
  it("reads the pt-BR slugs and falls back to tribunal", () => {
    expect(DEFAULT_DIMENSION).toBe("court");
    expect(parseChartDimension({})).toBe("court");
    expect(parseChartDimension(null)).toBe("court");
    expect(parseChartDimension({ dimensao: "cidade" })).toBe("city");
    expect(parseChartDimension({ dimensao: ["fase", "cidade"] })).toBe("phase");
    expect(parseChartDimension({ dimensao: "city" })).toBe("court"); // English ids are not URL values
    expect(parseChartDimension({ dimensao: "x" })).toBe("court");
    // Same slugs as /processos?pendencia= and one per dimension.
    expect(DIMENSIONS.map((k) => DIMENSION_PARAMS[k])).toEqual(["tribunal", "instancia", "fase", "cidade", "empresa", "unidade"]);
    for (const k of DIMENSIONS) expect(parseChartDimension({ dimensao: DIMENSION_PARAMS[k] })).toBe(k);
  });
});

describe("dimension chart model", () => {
  it("switching dimension yields that dimension's rows (and only informed values)", () => {
    const keys = (k: Dimension["key"]) => dimensionChartModel(dimensions[k]).rows.map((r) => r.key);
    expect(keys("court")).toEqual(["TJSP", "TRT2", "TRT10"]);
    expect(keys("instance")).toEqual(["second", "first"]);
    expect(keys("phase")).toEqual(["enforcement", "liquidation", "knowledge"]);
    expect(keys("city")).toEqual(["São Paulo", "Palmas"]);
    // Nobody has an empresa/unidade: no "Não informado" category, no bars.
    expect(keys("company")).toEqual([]);
    expect(keys("unit")).toEqual([]);
    const city = dimensionChartModel(dimensions.city);
    expect(city.rows[0]).toMatchObject({ label: "São Paulo (2)", href: "/processos?cidade=São Paulo" });
  });

  it("writes every bar label in one unit chosen from the largest bar", () => {
    const court = dimensionChartModel(dimensions.court);
    expect(court.kind).toBe("exposure");
    expect(court.unitLabel).toBe("R$ milhões");
    expect(court.scale).toMatchObject({ unit: "million", fractionDigits: 2 });
    expect(court.rows.map((r) => r.valueText)).toEqual(["1,30", "0,57", "não apurado · est. 0,01"]);
    // No compact unit inside the labels (the unit is in the header); exact amounts in the tooltip.
    for (const r of court.rows) expect(r.valueText).not.toMatch(/R\$|\bmil\b|\bmi\b/);
    expect(plain(court.rows[0].tip)).toBe("Exposição apurada: R$ 1.300.000,00 (apurado em 1 de 1)");

    // Another dimension, another dataset: its own unit (Palmas alone is R$ 5 mil, estimate only).
    const palmas = dimensionChartModel({ rows: dimensions.city.rows.filter((r) => r.key === "Palmas") });
    expect(palmas.unitLabel).toBe("R$ mil");
    expect(palmas.rows.map((r) => r.valueText)).toEqual(["est. 5,00"]);
  });

  it("keeps apurado (official) and estimado as separate series, never summed", () => {
    const mixed = [portfolio[0], { ...portfolio[2], court: "TJSP" }];
    const bucket = bucketOf(mixed);
    const model = dimensionChartModel({ rows: [{ key: "TJSP", label: "TJSP", bucket, href: "/processos?tribunal=TJSP" }] });
    expect(model.series).toEqual(["official", "estimate"]);
    expect(model.rows[0].values).toEqual([130_000_000, 500_000]);
    expect(model.rows[0].values).not.toContain(130_500_000);
    expect(model.rows[0].valueText).toBe("1,30 · est. 0,01");
    expect(plain(model.rows[0].tip)).toBe("Exposição apurada: R$ 1.300.000,00 (apurado em 1 de 2) · Exposição estimada: R$ 5.000,00");
  });

  it("never turns não apurado or a missing basis into zero", () => {
    // No drawn row has a valor apurado: the official series is dropped, not drawn as 0.
    const onlyEstimate = dimensionChartModel({ rows: dimensions.court.rows.filter((r) => r.key === "TRT10") });
    expect(onlyEstimate.series).toEqual(["estimate"]);
    expect(onlyEstimate.withOfficial).toBe(false);
    expect(plain(onlyEstimate.rows[0].tip)).toBe("Exposição estimada: R$ 5.000,00");

    // A row with neither valor apurado nor estimate basis reads "sem base de cálculo".
    const noBasis = bucketOf([{ ...base, processId: "z", number: "9", classification: null, percentageBp: null }]);
    const apurado = bucketOf([portfolio[1]]);
    const model = dimensionChartModel({
      rows: [
        { key: "TRT2", label: "TRT2", bucket: apurado, href: "/a" },
        { key: "TRT1", label: "TRT1", bucket: noBasis, href: "/b" },
      ],
    });
    expect(model.rows[1].valueText).toBe("não apurado · sem base de cálculo");
    expect(plain(model.rows[1].tip)).toBe("Exposição apurada: não apurado · 1 processo sem base de cálculo");
    expect(model.someRowUnassessed).toBe(true);

    // Without any exposure the bars show the number of processes (no money unit).
    const counts = dimensionChartModel({ rows: [{ key: "TRT22", label: "TRT22", bucket: { ...emptyBucket(), count: 3 }, href: "/c" }] });
    expect(counts).toMatchObject({ kind: "count", scale: null, unitLabel: "Processos", series: ["count"] });
    expect(counts.rows[0]).toMatchObject({ label: "TRT22", values: [3], valueText: "3" });
  });
});
