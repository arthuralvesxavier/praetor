import { describe, expect, it } from "vitest";
import {
  formatCompactMoneyCents,
  formatInScale,
  formatLongDate,
  formatRelativeTime,
  moneyScaleFor,
} from "@/modules/dashboard/format";

describe("dashboard format helpers", () => {
  it("formats a calendar date without timezone shift", () => {
    expect(formatLongDate("2026-10-11")).toBe("Domingo, 11 de outubro de 2026");
    expect(formatLongDate("inválida")).toBe("inválida");
  });

  it("formats compact BRL from cents", () => {
    expect(formatCompactMoneyCents(120_000_000)).toMatch(/^R\$\s?1,2\s?mi/);
    expect(formatCompactMoneyCents(0)).toMatch(/^R\$\s?0/);
  });

  it("chooses one chart unit from the largest value (P0.3)", () => {
    // R$ 1,3 mi and R$ 571 mil in the same chart: both in R$ milhões, same decimals.
    const millions = moneyScaleFor([130_000_000, 57_100_000]);
    expect(millions).toMatchObject({ unit: "million", label: "R$ milhões", fractionDigits: 2 });
    expect(formatInScale(130_000_000, millions)).toBe("1,30");
    expect(formatInScale(57_100_000, millions)).toBe("0,57");
    // A positive value below the chart precision is never shown as zero.
    expect(formatInScale(300_000, millions)).toBe("< 0,01");
    expect(formatInScale(0, millions)).toBe("0,00");

    const thousands = moneyScaleFor([57_100_000, 5_000_000]);
    expect(thousands).toMatchObject({ unit: "thousand", label: "R$ mil", fractionDigits: 0 });
    expect(formatInScale(57_100_000, thousands)).toBe("571");
    expect(formatInScale(5_000_000, thousands)).toBe("50");
    expect(formatInScale(10_000, thousands)).toBe("< 1");

    expect(moneyScaleFor([5_000_000, 500_000])).toMatchObject({ label: "R$ mil", fractionDigits: 1 }); // R$ 50 mil
    expect(moneyScaleFor([4_500_000_000_00])).toMatchObject({ unit: "billion", label: "R$ bilhões", fractionDigits: 2 });
    expect(formatInScale(4_500_000_000_00, moneyScaleFor([4_500_000_000_00]))).toBe("4,50");
    expect(moneyScaleFor([99_900])).toMatchObject({ unit: "real", label: "R$", fractionDigits: 0 }); // R$ 999
    expect(formatInScale(1_234_567_89, moneyScaleFor([1_234_567_89]))).toBe("1,23");
    // Empty or non-finite datasets fall back to reais.
    expect(moneyScaleFor([])).toMatchObject({ unit: "real" });
    expect(moneyScaleFor([Number.NaN, Number.POSITIVE_INFINITY, 200_000])).toMatchObject({ unit: "thousand" });
  });

  it("formats relative time in pt-BR", () => {
    const now = new Date("2026-10-11T12:00:00Z");
    expect(formatRelativeTime(new Date("2026-10-11T11:59:40Z"), now)).toBe("agora mesmo");
    expect(formatRelativeTime(new Date("2026-10-11T11:55:00Z"), now)).toBe("há 5 minutos");
    expect(formatRelativeTime(new Date("2026-10-11T09:00:00Z"), now)).toBe("há 3 horas");
    expect(formatRelativeTime(new Date("2026-10-10T12:00:00Z"), now)).toBe("há 1 dia");
    expect(formatRelativeTime(new Date("2026-08-01T12:00:00Z"), now)).toBe("há 2 meses");
  });
});
