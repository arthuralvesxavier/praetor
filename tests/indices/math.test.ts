import { describe, expect, it } from "vitest";
import {
  addMonths,
  formatMonthRanges,
  formatRateMicro,
  microToRateText,
  monthRange,
  parseRateMicro,
  unavailableMessage,
  updatedValue,
  type MonthlyRates,
} from "@/modules/indices/math";
import ipca from "./fixtures/sgs-433-ipca-2024-01-a-2025-06.json";
import tr from "./fixtures/sgs-7811-tr-2025-01-a-2025-06.json";

/** Fixture (real SGS answer) → month → micro-percent. */
function rates(points: { data: string; valor: string }[]): MonthlyRates {
  const map = new Map<string, number>();
  for (const p of points) {
    const [, mm, yyyy] = p.data.split("/");
    map.set(`${yyyy}-${mm}`, parseRateMicro(p.valor) as number);
  }
  return map;
}

const IPCA = rates(ipca);
const TR = rates(tr);

describe("months and rates", () => {
  it("adds months across years and lists ranges", () => {
    expect(addMonths("2024-12", 1)).toBe("2025-01");
    expect(addMonths("2025-01", -1)).toBe("2024-12");
    expect(addMonths("2024-03", -15)).toBe("2022-12");
    expect(monthRange("2024-11", "2025-02")).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
    expect(monthRange("2025-02", "2025-01")).toEqual([]);
  });

  it("parses published rates exactly (micro-percent), refusing anything else", () => {
    expect(parseRateMicro("0.16")).toBe(160_000);
    expect(parseRateMicro("-0.32")).toBe(-320_000);
    expect(parseRateMicro("0.1690")).toBe(169_000);
    expect(parseRateMicro("0.160000")).toBe(160_000);
    expect(parseRateMicro("41.31")).toBe(41_310_000);
    expect(parseRateMicro("-0.00")).toBe(0);
    expect(parseRateMicro("0,16")).toBeNull();
    expect(parseRateMicro("0.1234567")).toBeNull();
    expect(parseRateMicro("abc")).toBeNull();
    expect(parseRateMicro("-100")).toBeNull();
    expect(microToRateText(160_000)).toBe("0.160000");
    expect(microToRateText(-20_000)).toBe("-0.020000");
    expect(formatRateMicro(169_000)).toBe("0,169%");
    expect(formatRateMicro(-320_000)).toBe("-0,32%");
  });

  it("groups missing months in ranges", () => {
    expect(formatMonthRanges(["2025-05", "2025-03", "2025-04", "2025-08"])).toBe("03/2025 a 05/2025, 08/2025");
  });
});

describe("updatedValue", () => {
  it("compounds the IPCA of 2024 (real SGS fixture) from the month after the base date", () => {
    // Base date in December 2023, asOf in January 2025: January to December 2024 apply.
    const r = updatedValue(1_000_000, "2023-12-15", "ipca", "2025-01-10", { ipca: IPCA });
    expect(r.status).toBe("updated");
    // Π(1 + r/100) of the 12 published rates = 1,048312957918596… (IPCA 2024: 4,83%).
    expect(r.cents).toBe(1_048_313);
    expect(r.factor).toBeCloseTo(1.048312958, 9);
    expect(r.monthsApplied).toBe(12);
    expect(r.firstMonth).toBe("2024-01");
    expect(r.throughMonth).toBe("2024-12");
    expect(r.missingMonths).toEqual([]);
    expect(r.pendingMonths).toEqual([]);
  });

  it("keeps exact cents for large amounts (BigInt product, rounded once)", () => {
    const r = updatedValue(123_456_789, "2023-12-31", "ipca", "2025-01-01", { ipca: IPCA });
    expect(r.cents).toBe(129_421_352);
  });

  it("compounds 4-decimal TR rates", () => {
    const r = updatedValue(5_000_000, "2024-12-20", "tr", "2025-07-01", { tr: TR });
    expect(r.cents).toBe(5_046_206);
    expect(r.throughMonth).toBe("2025-06");
  });

  it("applies deflation (negative monthly rate)", () => {
    // August 2024 IPCA = -0,02%.
    const r = updatedValue(1_000_000, "2024-07-31", "ipca", "2024-09-01", { ipca: IPCA });
    expect(r.monthsApplied).toBe(1);
    expect(r.cents).toBe(999_800);
  });

  it("stops at the last month BEFORE asOf, even when later months exist", () => {
    const r = updatedValue(1_000_000, "2024-10-05", "ipca", "2025-01-31", { ipca: IPCA });
    expect(r.firstMonth).toBe("2024-11");
    expect(r.throughMonth).toBe("2024-12");
    expect(r.monthsApplied).toBe(2);
  });

  it("uses the last month available before asOf and reports the months not published yet", () => {
    // Series ends in June 2025; asOf in October 2025 → applied up to June, July to September pending.
    const r = updatedValue(1_000_000, "2025-03-10", "ipca", "2025-10-12", { ipca: IPCA });
    expect(r.status).toBe("updated");
    expect(r.throughMonth).toBe("2025-06");
    expect(r.pendingMonths).toEqual(["2025-07", "2025-08", "2025-09"]);
  });

  it("returns null (never estimates) when a month inside the range is missing", () => {
    const holes = new Map(IPCA);
    holes.delete("2024-03");
    holes.delete("2024-04");
    holes.delete("2024-08");
    const r = updatedValue(1_000_000, "2023-12-15", "ipca", "2025-01-10", { ipca: holes });
    expect(r.status).toBe("unavailable");
    expect(r.cents).toBeNull();
    expect(r.factor).toBeNull();
    expect(r.missingMonths).toEqual(["2024-03", "2024-04", "2024-08"]);
    expect(unavailableMessage(r)).toBe("atualização indisponível (faltam meses: 03/2024 a 04/2024, 08/2024)");
  });

  it("returns null when the series has no month after the base date", () => {
    const r = updatedValue(1_000_000, "2023-06-10", "ipca", "2023-10-01", { ipca: IPCA });
    expect(r.status).toBe("unavailable");
    expect(r.cents).toBeNull();
    expect(r.missingMonths).toEqual(["2023-07", "2023-08", "2023-09"]);
    // Index without any collected series.
    const empty = updatedValue(1_000_000, "2024-01-10", "inpc", "2024-05-01", { ipca: IPCA });
    expect(empty.status).toBe("unavailable");
    expect(empty.missingMonths).toEqual(["2024-02", "2024-03", "2024-04"]);
  });

  it('"none" keeps the original value; null means "sem índice informado"', () => {
    const none = updatedValue(1_000_000, "2020-01-01", "none", "2025-01-01", {});
    expect(none).toMatchObject({ status: "not_corrected", cents: 1_000_000, factor: 1, monthsApplied: 0 });
    const noIndex = updatedValue(1_000_000, "2020-01-01", null, "2025-01-01", { ipca: IPCA });
    expect(noIndex).toMatchObject({ status: "no_index", cents: null, factor: null });
  });

  it("keeps the original when no complete month has passed since the base date", () => {
    const sameMonth = updatedValue(1_000_000, "2024-12-03", "ipca", "2024-12-20", { ipca: IPCA });
    expect(sameMonth).toMatchObject({ status: "no_months", cents: 1_000_000, factor: 1, monthsApplied: 0 });
    const nextMonth = updatedValue(1_000_000, "2024-11-28", "ipca", "2024-12-02", { ipca: IPCA });
    expect(nextMonth.status).toBe("no_months");
  });

  it("is pure: the same inputs always give the same output and the series is not changed", () => {
    const before = [...IPCA.entries()];
    const a = updatedValue(777_777, "2023-12-15", "ipca", "2025-01-10", { ipca: IPCA });
    const b = updatedValue(777_777, "2023-12-15", "ipca", "2025-01-10", { ipca: IPCA });
    expect(a).toEqual(b);
    expect([...IPCA.entries()]).toEqual(before);
  });

  it("refuses invalid dates without guessing", () => {
    expect(updatedValue(100, "15/03/2024", "ipca", "2025-01-01", { ipca: IPCA }).cents).toBeNull();
    expect(updatedValue(100, "2024-03-15", "ipca", "2025-13-01", { ipca: IPCA }).cents).toBeNull();
  });
});
