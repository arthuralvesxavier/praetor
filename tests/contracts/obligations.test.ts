import { describe, expect, it } from "vitest";
import {
  addMonthsISO,
  effectiveObligationStatus,
  nextDueDate,
  parseRecurrence,
  recurrenceDisplay,
  recurrenceToStored,
} from "@/modules/contracts/obligations";
import { obligationInputSchema, obligationPatchSchema } from "@/modules/contracts/schemas";
import { contractNoticeInfo, noticeRelativeText } from "@/modules/contracts/vigencia";

const TODAY = "2026-10-11";

describe("parseRecurrence", () => {
  it("recognizes ids, canonical words and common legacy spellings", () => {
    expect(parseRecurrence("mensal").kind).toBe("monthly");
    expect(parseRecurrence("Mensal").kind).toBe("monthly");
    expect(parseRecurrence("  MENSALMENTE. ").kind).toBe("monthly");
    expect(parseRecurrence("monthly").kind).toBe("monthly");
    expect(parseRecurrence("Trimestral").kind).toBe("quarterly");
    expect(parseRecurrence("a cada 6 meses").kind).toBe("semiannual");
    expect(parseRecurrence("anual").kind).toBe("annual");
    expect(parseRecurrence("Única").kind).toBe("none");
    expect(parseRecurrence(null)).toEqual({ kind: "none", text: null });
    expect(parseRecurrence("   ")).toEqual({ kind: "none", text: null });
  });

  it("keeps unrecognized text as custom (backward compatible)", () => {
    expect(parseRecurrence("toda segunda quinzena")).toEqual({ kind: "custom", text: "toda segunda quinzena" });
    expect(recurrenceDisplay("toda segunda quinzena")).toBe("toda segunda quinzena");
    expect(recurrenceDisplay("mensal")).toBe("Mensal");
  });

  it("maps ids to the stored pt-BR text", () => {
    expect(recurrenceToStored("monthly")).toBe("mensal");
    expect(recurrenceToStored("semiannual")).toBe("semestral");
    expect(recurrenceToStored("none")).toBeNull();
  });

  it("schemas accept ids, keep legacy text and clear with 'none' or empty", () => {
    expect(obligationInputSchema.parse({ description: "Pagar fatura", recurrence: "quarterly" }).recurrence).toBe("trimestral");
    expect(obligationInputSchema.parse({ description: "Pagar fatura", recurrence: "none" }).recurrence).toBeNull();
    expect(obligationInputSchema.parse({ description: "Pagar fatura", recurrence: "" }).recurrence).toBeNull();
    expect(obligationInputSchema.parse({ description: "Pagar fatura", recurrence: "quinzenal" }).recurrence).toBe("quinzenal");
    // Patch: undefined keeps the stored value.
    expect(obligationPatchSchema.parse({ status: "fulfilled" }).recurrence).toBeUndefined();
  });
});

describe("addMonthsISO / nextDueDate", () => {
  it("keeps the day of the month and clamps to the last day of shorter months", () => {
    expect(addMonthsISO("2026-01-15", 1)).toBe("2026-02-15");
    expect(addMonthsISO("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsISO("2028-01-31", 1)).toBe("2028-02-29"); // leap year
    expect(addMonthsISO("2026-11-30", 3)).toBe("2027-02-28"); // crosses year
    expect(addMonthsISO("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonthsISO("2026-02-28", 12)).toBe("2027-02-28");
    expect(() => addMonthsISO("31/01/2026", 1)).toThrow(RangeError);
  });

  it("computes the next due date per recurrence", () => {
    expect(nextDueDate("2026-10-10", "monthly")).toBe("2026-11-10");
    expect(nextDueDate("2026-10-10", "quarterly")).toBe("2027-01-10");
    expect(nextDueDate("2026-10-10", "semiannual")).toBe("2027-04-10");
    expect(nextDueDate("2026-10-10", "annual")).toBe("2027-10-10");
    expect(nextDueDate("2026-10-10", "none")).toBeNull();
    expect(nextDueDate("2026-10-10", "custom")).toBeNull();
    expect(nextDueDate(null, "monthly")).toBeNull();
  });
});

describe("effectiveObligationStatus", () => {
  it("computes overdue from the due date for open obligations", () => {
    expect(effectiveObligationStatus("pending", "2026-10-10", TODAY)).toBe("overdue");
    expect(effectiveObligationStatus("pending", TODAY, TODAY)).toBe("pending"); // due today is not late
    expect(effectiveObligationStatus("overdue", "2026-10-20", TODAY)).toBe("pending"); // date moved forward
    expect(effectiveObligationStatus("overdue", null, TODAY)).toBe("overdue"); // manual, no date
    expect(effectiveObligationStatus("pending", null, TODAY)).toBe("pending");
  });

  it("never reopens closed obligations", () => {
    expect(effectiveObligationStatus("fulfilled", "2026-01-01", TODAY)).toBe("fulfilled");
    expect(effectiveObligationStatus("waived", "2026-01-01", TODAY)).toBe("waived");
  });
});

describe("contractNoticeInfo", () => {
  const active = (endDate: string | null, renewalNoticeDays: number | null) => ({
    status: "active" as const,
    startDate: "2026-01-01",
    endDate,
    renewalNoticeDays,
  });

  it("computes end − notice days and classifies it against the window", () => {
    expect(contractNoticeInfo(active("2026-12-31", 30), TODAY, 60)).toEqual({ date: "2026-12-01", days: 51, state: "soon" });
    expect(contractNoticeInfo(active("2027-06-30", 30), TODAY, 60)).toMatchObject({ date: "2027-05-31", state: "later" });
    // Notice date already behind, contract still running.
    expect(contractNoticeInfo(active("2026-10-20", 30), TODAY, 60)).toEqual({ date: "2026-09-20", days: -21, state: "passed" });
    expect(contractNoticeInfo(active("2026-11-10", 30), TODAY, 60)).toMatchObject({ date: TODAY, days: 0, state: "soon" });
  });

  it("is 'none' without notice days, for ended or non-active contracts", () => {
    expect(contractNoticeInfo(active("2026-12-31", null), TODAY).state).toBe("none");
    expect(contractNoticeInfo(active("2026-12-31", 0), TODAY)).toEqual({ date: null, days: null, state: "none" });
    expect(contractNoticeInfo(active("2026-10-01", 30), TODAY).state).toBe("none"); // already ended
    expect(contractNoticeInfo({ ...active("2026-12-31", 30), status: "terminated" }, TODAY).state).toBe("none");
    expect(contractNoticeInfo(active(null, 30), TODAY)).toEqual({ date: null, days: null, state: "none" });
  });

  it("formats relative notice text", () => {
    expect(noticeRelativeText(0)).toBe("aviso hoje");
    expect(noticeRelativeText(1)).toBe("aviso amanhã");
    expect(noticeRelativeText(12)).toBe("aviso em 12 dias");
    expect(noticeRelativeText(-1)).toBe("prazo de aviso encerrado há 1 dia");
    expect(noticeRelativeText(-5)).toBe("prazo de aviso encerrado há 5 dias");
    expect(noticeRelativeText(null)).toBeNull();
  });
});
