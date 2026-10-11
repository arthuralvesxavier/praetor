import { describe, expect, it } from "vitest";
import {
  contractVigencyState,
  daysToEnd,
  noticeDeadline,
  vigencyRelativeText,
  type VigencyInput,
} from "@/modules/contracts/vigencia";

const TODAY = "2026-10-11";
const active = (startDate: string | null, endDate: string | null): VigencyInput => ({ status: "active", startDate, endDate });

describe("contractVigencyState", () => {
  it("maps terminal statuses regardless of dates", () => {
    expect(contractVigencyState({ status: "terminated", startDate: "2026-01-01", endDate: "2027-01-01" }, TODAY)).toBe("encerrado");
    expect(contractVigencyState({ status: "expired", startDate: "2026-01-01", endDate: "2027-01-01" }, TODAY)).toBe("vencido");
  });

  it("drafts and contracts under review have no vigency yet", () => {
    expect(contractVigencyState({ status: "draft", startDate: null, endDate: "2026-10-20" }, TODAY)).toBe("sem_vigencia");
    expect(contractVigencyState({ status: "under_review", startDate: null, endDate: null }, TODAY)).toBe("sem_vigencia");
  });

  it("active contracts that did not start yet have no vigency", () => {
    expect(contractVigencyState(active("2026-10-12", "2027-10-12"), TODAY)).toBe("sem_vigencia");
    // Starting today counts as started.
    expect(contractVigencyState(active(TODAY, "2027-10-12"), TODAY)).toBe("vigente");
  });

  it("active without end date is vigente (prazo indeterminado)", () => {
    expect(contractVigencyState(active("2020-01-01", null), TODAY)).toBe("vigente");
    expect(contractVigencyState(active(null, null), TODAY)).toBe("vigente");
  });

  it("uses the expiring window with inclusive boundaries", () => {
    // Ends today -> still vencendo (not vencido).
    expect(contractVigencyState(active("2026-01-01", TODAY), TODAY, 30)).toBe("vencendo");
    // Exactly at the window edge -> vencendo.
    expect(contractVigencyState(active("2026-01-01", "2026-11-10"), TODAY, 30)).toBe("vencendo");
    // One day beyond the window -> vigente.
    expect(contractVigencyState(active("2026-01-01", "2026-11-11"), TODAY, 30)).toBe("vigente");
    // Yesterday -> vencido.
    expect(contractVigencyState(active("2026-01-01", "2026-10-10"), TODAY, 30)).toBe("vencido");
  });

  it("defaults the window to 60 days and treats a zero window as 'ends today only'", () => {
    expect(contractVigencyState(active(null, "2026-12-10"), TODAY)).toBe("vencendo");
    expect(contractVigencyState(active(null, "2026-12-11"), TODAY)).toBe("vigente");
    expect(contractVigencyState(active(null, TODAY), TODAY, 0)).toBe("vencendo");
    expect(contractVigencyState(active(null, "2026-10-12"), TODAY, 0)).toBe("vigente");
  });
});

describe("noticeDeadline", () => {
  it("subtracts the notice days from the end date", () => {
    expect(noticeDeadline("2026-12-31", 30)).toBe("2026-12-01");
    expect(noticeDeadline("2027-03-01", 1)).toBe("2027-02-28");
    expect(noticeDeadline("2028-03-01", 1)).toBe("2028-02-29"); // leap year
    expect(noticeDeadline("2027-01-15", 20)).toBe("2026-12-26"); // crosses year
    expect(noticeDeadline("2026-12-31", 0)).toBe("2026-12-31");
  });

  it("returns null when data is missing or invalid", () => {
    expect(noticeDeadline(null, 30)).toBeNull();
    expect(noticeDeadline("2026-12-31", null)).toBeNull();
    expect(noticeDeadline("2026-12-31", undefined)).toBeNull();
    expect(noticeDeadline("2026-12-31", -5)).toBeNull();
    expect(noticeDeadline("31/12/2026", 10)).toBeNull();
  });
});

describe("daysToEnd", () => {
  it("counts calendar days (negative when past)", () => {
    expect(daysToEnd(TODAY, TODAY)).toBe(0);
    expect(daysToEnd("2026-10-21", TODAY)).toBe(10);
    expect(daysToEnd("2026-10-01", TODAY)).toBe(-10);
    expect(daysToEnd(null, TODAY)).toBeNull();
  });

  it("is not affected by DST or month lengths", () => {
    expect(daysToEnd("2027-10-11", TODAY)).toBe(365);
    expect(daysToEnd("2026-11-11", TODAY)).toBe(31);
  });
});

describe("vigencyRelativeText", () => {
  it("formats relative days in pt-BR", () => {
    expect(vigencyRelativeText(0)).toBe("vence hoje");
    expect(vigencyRelativeText(1)).toBe("vence amanhã");
    expect(vigencyRelativeText(12)).toBe("vence em 12 dias");
    expect(vigencyRelativeText(-1)).toBe("venceu há 1 dia");
    expect(vigencyRelativeText(-3)).toBe("venceu há 3 dias");
    expect(vigencyRelativeText(null)).toBeNull();
  });
});
