import { describe, expect, it } from "vitest";
import { formatCompactMoneyCents, formatLongDate, formatRelativeTime } from "@/modules/dashboard/format";

describe("dashboard format helpers", () => {
  it("formats a calendar date without timezone shift", () => {
    expect(formatLongDate("2026-10-11")).toBe("Domingo, 11 de outubro de 2026");
    expect(formatLongDate("inválida")).toBe("inválida");
  });

  it("formats compact BRL from cents", () => {
    expect(formatCompactMoneyCents(120_000_000)).toMatch(/^R\$\s?1,2\s?mi/);
    expect(formatCompactMoneyCents(0)).toMatch(/^R\$\s?0/);
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
