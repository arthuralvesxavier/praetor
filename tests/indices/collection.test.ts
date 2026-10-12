/**
 * Pure rules of the P1.7 collection and of the index of a valuation (no
 * database, no network): confirmation window per series, gaps inside a stored
 * series, months still to collect and who may inform the index.
 */
import { describe, expect, it } from "vitest";
import { indexSeriesDefinition, lastStorableMonth, monthsToCollect } from "@/modules/indices/catalog";
import { formatMonthRanges, groupMonthRanges, seriesGaps } from "@/modules/indices/math";
import {
  canEditCorrectionIndex,
  correctionIndexChangeFor,
  correctionIndexEditability,
  pinnedCorrectionIndex,
} from "@/modules/indices/policy";

describe("lastStorableMonth", () => {
  const selic = indexSeriesDefinition("selic");
  const ipca = indexSeriesDefinition("ipca");

  it("never the current month; published-once series right after the month ends", () => {
    expect(ipca.confirmationDay).toBe(1);
    expect(lastStorableMonth(ipca, "2026-11-01")).toBe("2026-10");
    expect(lastStorableMonth(ipca, "2026-10-31")).toBe("2026-09");
    expect(lastStorableMonth(indexSeriesDefinition("tr"), "2026-01-01")).toBe("2025-12");
  });

  it("the Selic accumulated in the month waits until day 10 of the next month", () => {
    expect(selic.confirmationDay).toBe(10);
    expect(lastStorableMonth(selic, "2026-11-01")).toBe("2026-09");
    expect(lastStorableMonth(selic, "2026-11-09")).toBe("2026-09");
    expect(lastStorableMonth(selic, "2026-11-10")).toBe("2026-10");
    expect(lastStorableMonth(selic, "2026-01-05")).toBe("2025-11");
  });

  it("rejects an invalid date", () => {
    expect(() => lastStorableMonth(selic, "2026-13-01")).toThrow(RangeError);
  });
});

describe("gaps and months to collect", () => {
  it("lists only the months missing between the first and the last stored month", () => {
    expect(seriesGaps([])).toEqual([]);
    expect(seriesGaps(["2024-05"])).toEqual([]);
    expect(seriesGaps(["2024-05", "2024-01", "2024-02"])).toEqual(["2024-03", "2024-04"]);
    expect(seriesGaps(["2024-11", "2025-02"])).toEqual(["2024-12", "2025-01"]);
  });

  it("groups consecutive months", () => {
    expect(groupMonthRanges(["2025-08", "2025-03", "2025-04", "2025-05"])).toEqual([
      ["2025-03", "2025-05"],
      ["2025-08", "2025-08"],
    ]);
    expect(formatMonthRanges(["2025-03", "2025-04", "2025-05", "2025-08"])).toBe("03/2025 a 05/2025, 08/2025");
  });

  it("collects the gaps plus the months after the last stored one (or from 07/1994)", () => {
    expect(monthsToCollect([], "1994-09")).toEqual(["1994-07", "1994-08", "1994-09"]);
    expect(monthsToCollect(["2024-01", "2024-02", "2024-05"], "2024-07")).toEqual([
      "2024-03",
      "2024-04",
      "2024-06",
      "2024-07",
    ]);
    // Up to date and without gaps: nothing to ask.
    expect(monthsToCollect(["2024-01", "2024-02"], "2024-02")).toEqual([]);
    // A month stored beyond today's limit (earlier rule) is kept; nothing after it is asked.
    expect(monthsToCollect(["2024-01", "2024-02", "2024-03"], "2024-02")).toEqual([]);
  });
});

describe("who may inform the index of a valuation, and how", () => {
  const writer = { write: true, approve: false };
  const approver = { write: true, approve: true };

  it("proposed: whoever writes values, in place, until the review", () => {
    expect(correctionIndexEditability({ status: "proposed", correctionIndex: "none" })).toEqual({
      editable: true,
      mode: "in_place",
      permission: "contingency:write",
    });
    expect(canEditCorrectionIndex({ status: "proposed", correctionIndex: "ipca" }, writer)).toBe(true);
    expect(correctionIndexChangeFor({ status: "proposed", correctionIndex: "ipca" }, writer)).toBe("in_place");
    expect(canEditCorrectionIndex({ status: "proposed", correctionIndex: null }, { write: false, approve: false })).toBe(false);
  });

  it("official or superseded without index: only who approves, in place, once", () => {
    for (const status of ["official", "superseded"] as const) {
      expect(correctionIndexEditability({ status, correctionIndex: null })).toEqual({
        editable: true,
        mode: "in_place",
        permission: "contingency:approve",
      });
      expect(canEditCorrectionIndex({ status, correctionIndex: null }, writer)).toBe(false);
      expect(correctionIndexChangeFor({ status, correctionIndex: null }, approver)).toBe("in_place");
    }
  });

  it("official with an index (including the default 'none'): only who approves, with a NEW record", () => {
    for (const index of ["none", "ipca_e", "selic"] as const) {
      expect(correctionIndexEditability({ status: "official", correctionIndex: index })).toEqual({
        editable: true,
        mode: "new_record",
        permission: "contingency:approve",
      });
      expect(correctionIndexChangeFor({ status: "official", correctionIndex: index }, approver)).toBe("new_record");
      expect(correctionIndexChangeFor({ status: "official", correctionIndex: index }, writer)).toBeNull();
      expect(canEditCorrectionIndex({ status: "official", correctionIndex: index }, writer)).toBe(false);
    }
  });

  it("superseded with an index (history) and rejected: never", () => {
    expect(correctionIndexEditability({ status: "superseded", correctionIndex: "none" })).toEqual({ editable: false, reason: "history" });
    expect(canEditCorrectionIndex({ status: "superseded", correctionIndex: "ipca" }, approver)).toBe(false);
    expect(correctionIndexEditability({ status: "rejected", correctionIndex: null })).toEqual({ editable: false, reason: "rejected" });
    expect(canEditCorrectionIndex({ status: "rejected", correctionIndex: null }, approver)).toBe(false);
  });

  it("reads the index pinned by a review form", () => {
    expect(pinnedCorrectionIndex(null)).toBeUndefined();
    expect(pinnedCorrectionIndex(undefined)).toBeUndefined();
    expect(pinnedCorrectionIndex("")).toBeNull();
    expect(pinnedCorrectionIndex("ipca_e")).toBe("ipca_e");
    // An unknown value is kept as is: it never matches a stored index, so the decision is refused.
    expect(pinnedCorrectionIndex("igpm")).toBe("igpm");
  });
});
