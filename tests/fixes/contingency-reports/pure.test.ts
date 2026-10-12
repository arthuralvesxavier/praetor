/**
 * Pure regressions of the "contingency-reports" review group:
 *  - snapshot CSV neutralizes spreadsheet formulas in text cells (CSV injection);
 *  - positionAt: removed valor da causa is null from today on; deterministic tiebreak;
 *  - report export row cap; audit-letter pagination and print version.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { addToBucket, emptyBucket } from "@/domain/contingency";
import { buildSnapshotCsv, csvText, type CsvSnapshotRow } from "@/modules/contingency/csv";
import { positionAt, type PositionValuation } from "@/modules/contingency/position";
import { AUDIT_LETTER_PAGE_SIZE, AuditLetterView } from "@/modules/reports/components/report-views";
import { assertExportRowLimit, REPORT_EXPORT_LIMIT } from "@/modules/reports/service";
import type { AuditLetterReport, AuditLetterRow } from "@/modules/reports/types";
import { ValidationError } from "@/server/lib/errors";

const params = { remote: 0, possible: 50, probable: 100 };
const t = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("snapshot CSV: formula neutralization (finding 4)", () => {
  const base: CsvSnapshotRow = {
    number: "0000001-11.2026.5.10.0001",
    companyName: "+1 Empresa",
    unitName: "-x unidade",
    court: "@SUM(1+1)",
    instance: "first",
    phase: "knowledge",
    city: '=HYPERLINK("http://example.invalid","x")',
    classification: "probable",
    percentageBp: 10_000,
    claimAmountCents: 1_000_000,
    liquidatedAmountCents: -5_000,
    guaranteesCents: 0,
    exposureCents: -5_000,
    exposureIsEstimate: false,
    provisionCents: -5_000,
    provisionIsEstimate: false,
  };

  it("prefixes text cells that start with = + - @ and keeps negative money as numbers", () => {
    const totals = addToBucket(emptyBucket(), {
      liquidatedCents: base.liquidatedAmountCents,
      linkedGuaranteesCents: 0,
      claimCents: base.claimAmountCents,
      riskPercentageBp: base.percentageBp,
    });
    const csv = buildSnapshotCsv({
      organizationName: "=Org",
      period: "2026-09",
      referenceDate: "2026-09-30",
      status: "closed",
      params: { riskPercentages: params, rulesVersion: 1, confidenceThreshold: 85 },
      rows: [base, { ...base, number: "\t0000002", court: "\rTRT" }],
      totals,
      hiddenCount: 0,
      totalsAreOrganizationWide: false,
    });
    const row = csv.split("\r\n").find((l) => l.startsWith("0000001"))!;
    expect(row).toContain(";'+1 Empresa;");
    expect(row).toContain(";'-x unidade;");
    expect(row).toContain(";'@SUM(1+1);");
    expect(row).toContain(`;"'=HYPERLINK(""http://example.invalid"",""x"")";`);
    // No cell of the row starts with an active formula character.
    expect(row).not.toMatch(/(^|;)[=+@]/);
    // Negative money keeps its sign and is NOT prefixed (it is a number, not a formula).
    expect(row).toContain(";-50,00;");
    expect(row).not.toContain("'-50,00");
    expect(csv).toContain("'\t0000002");
    expect(csv).toContain(`"'\rTRT"`);
    // Totals: negative liquidated stays numeric.
    expect(csv).toContain("Valor liquidado (R$);-50,00;");
  });

  it("csvText leaves plain text alone and empties nulls", () => {
    expect(csvText("TRT-10")).toBe("TRT-10");
    expect(csvText(null)).toBe("");
    expect(csvText("-x")).toBe("'-x");
    expect(csvText("a;b")).toBe('"a;b"');
  });

  it("notes processes deleted after the calculation", () => {
    const csv = buildSnapshotCsv({
      period: "2026-09",
      referenceDate: "2026-09-30",
      status: "closed",
      params: { riskPercentages: params, rulesVersion: 1, confidenceThreshold: 85 },
      rows: [{ ...base, processDeleted: true }],
      totals: emptyBucket(),
      hiddenCount: 0,
      totalsAreOrganizationWide: false,
    });
    expect(csv).toContain("1 processo(s) listado(s) foram excluídos do sistema após o fechamento");
    expect(csv).toContain("Processo excluído do sistema após o cálculo da competência.");
  });
});

describe("positionAt (findings 2 and 8)", () => {
  const removedProcess = { claimAmountCents: null, liquidatedAmountCents: null, riskPercentageBp: 10_000, lossProbability: "probable" as const };
  const claimHistory: PositionValuation[] = [
    { kind: "claim", amountCents: 300_000, baseDate: "2026-09-01", status: "superseded", createdAt: t("2026-09-01") },
  ];
  const risks = [
    { classification: "probable" as const, percentageBp: 10_000, effectiveFrom: "2026-08-01", status: "official" as const, createdAt: t("2026-08-01") },
  ];

  it("a removed valor da causa is null (not zero) from today on: no estimated provision", () => {
    const now = positionAt({ date: "2026-10-11", today: "2026-10-11", process: removedProcess, valuations: claimHistory, risks, guarantees: [], params });
    expect(now.claimCents).toBeNull();
    expect(now.claimBaseDate).toBeNull();
    expect(now.provision.provisionCents).toBeNull();
    expect(now.provision.isEstimate).toBe(false);
    // Open competência (reference date after today) too.
    const endOfMonth = positionAt({ date: "2026-10-31", today: "2026-10-11", process: removedProcess, valuations: claimHistory, risks, guarantees: [], params });
    expect(endOfMonth.claimCents).toBeNull();
    // Documented limitation: past dates keep the last official value (removal date not recorded).
    const past = positionAt({ date: "2026-09-30", today: "2026-10-11", process: removedProcess, valuations: claimHistory, risks, guarantees: [], params });
    expect(past.claimCents).toBe(300_000);
  });

  it("an official claim (or a record value) is not affected", () => {
    const official: PositionValuation[] = [{ ...claimHistory[0], status: "official" }];
    const p = { ...removedProcess, claimAmountCents: 300_000 };
    expect(positionAt({ date: "2026-10-11", today: "2026-10-11", process: p, valuations: official, risks, guarantees: [], params }).claimCents).toBe(300_000);
  });

  it("precomputed history flags prevent the record fallback for rows loaded with a date bound", () => {
    const p = { claimAmountCents: 999_000, liquidatedAmountCents: 888_000, riskPercentageBp: 10_000, lossProbability: "probable" as const };
    const bounded = positionAt({
      date: "2026-01-31",
      today: "2026-10-11",
      process: p,
      valuations: [],
      risks: [],
      guarantees: [],
      params,
      history: { claim: true, claimOfficial: true, liquidated: true, risk: true },
    });
    expect(bounded.claimCents).toBeNull();
    expect(bounded.liquidatedCents).toBeNull();
    expect(bounded.classification).toBeNull();
    expect(bounded.usedRecordFallback).toBe(false);
  });

  it("ties on the same base date and creation: the most recently reviewed wins, then the id", () => {
    const created = t("2026-09-01");
    const a: PositionValuation = { id: "a0000000-0000-0000-0000-000000000000", kind: "liquidated", amountCents: 100, baseDate: "2026-09-01", status: "official", createdAt: created, reviewedAt: t("2026-09-05") };
    const b: PositionValuation = { id: "b0000000-0000-0000-0000-000000000000", kind: "liquidated", amountCents: 200, baseDate: "2026-09-01", status: "official", createdAt: created, reviewedAt: t("2026-09-03") };
    const run = (rows: PositionValuation[]) =>
      positionAt({ date: "2026-09-30", today: "2026-10-11", process: removedProcess, valuations: rows, risks, guarantees: [], params }).liquidatedCents;
    expect(run([a, b])).toBe(100);
    expect(run([b, a])).toBe(100);
    const c = { ...b, reviewedAt: a.reviewedAt };
    expect(run([a, c])).toBe(200); // same review moment: greater id
    expect(run([c, a])).toBe(200);
  });
});

describe("report export cap (finding 5)", () => {
  it("refuses more rows than the limit with a pt-BR message", () => {
    expect(REPORT_EXPORT_LIMIT).toBe(20_000);
    expect(() => assertExportRowLimit(20_000)).not.toThrow();
    let err: unknown;
    try {
      assertExportRowLimit(20_001);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe("A exportação está limitada a 20.000 linhas por arquivo. Refine os filtros.");
  });
});

describe("audit letter pagination (finding 5)", () => {
  const row = (n: number): AuditLetterRow => ({
    processId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    number: `PROC-${String(n).padStart(5, "0")}`,
    title: `Processo fictício ${n}`,
    court: "TRT-10",
    courtDivision: null,
    instance: "first",
    phase: "knowledge",
    classification: "possible",
    percentageBp: 5_000,
    claimCents: 1_000,
    liquidatedCents: null,
    guaranteesCents: 0,
    exposureCents: 500,
    exposureIsEstimate: true,
    provisionCents: 500,
    provisionIsEstimate: true,
    caveats: [],
  });
  const total = AUDIT_LETTER_PAGE_SIZE * 2 + 50;
  const report: AuditLetterReport = {
    type: "auditoria",
    scope: { orgWide: true, includesConfidential: true, label: "Carteira completa", totalLabel: "Total" },
    generatedAt: new Date("2026-10-11T12:00:00Z"),
    organizationName: "Organização fictícia",
    filterSummary: "Sem filtros",
    baseDate: "2026-09-30",
    source: "snapshot",
    snapshot: { id: "s", period: "2026-09", referenceDate: "2026-09-30", status: "closed", closedAt: null },
    closedPeriods: ["2026-09"],
    rows: Array.from({ length: total }, (_, i) => row(i + 1)),
    totals: {
      processCount: total,
      claimCents: 0,
      claimUnknown: 0,
      liquidatedCents: 0,
      liquidatedUnknown: total,
      provisionCents: 0,
      provisionEstimateCents: 0,
      unclassified: 0,
      byClassification: { probable: 0, possible: total, remote: 0, unclassified: 0 },
    },
    generalCaveats: ["Ressalva fictícia."],
    hasEstimates: true,
  };
  const count = (html: string) => (html.match(/PROC-\d{5}/g) ?? []).length;
  const render = (props: Parameters<typeof AuditLetterView>[0]) => renderToString(createElement(AuditLetterView, props));

  it("shows 200 rows per page, keeps totals of the whole letter and links to the print version", () => {
    const sp = { tipo: "auditoria", competencia: "2026-09" };
    const first = render({ report, page: 1, sp });
    expect(count(first)).toBe(AUDIT_LETTER_PAGE_SIZE);
    expect(first).toContain("PROC-00001");
    expect(first).not.toContain("PROC-00201");
    expect(first).toContain("Relação paginada");
    expect(first).toContain("impressao=1");
    expect(first).toContain(String(total)); // totals cover every row

    const last = render({ report, page: 3, sp });
    expect(count(last)).toBe(50);
    expect(last).toContain("PROC-00450");

    const print = render({ report, page: 2, sp: { ...sp, impressao: "1" }, printAll: true });
    expect(count(print)).toBe(total);
    expect(print).not.toContain("Relação paginada");
    expect(print).toContain("Versão para impressão");
  });

  it("small letters are not paginated; deleted processes are listed without a link", () => {
    const small: AuditLetterReport = {
      ...report,
      rows: [row(1), { ...row(2), deletedAfterClose: true }],
    };
    const html = render({ report: small });
    expect(count(html)).toBe(2);
    expect(html).not.toContain("Relação paginada");
    expect(html).toContain("Excluído após o fechamento");
    expect(html).not.toContain(`/processos/${row(2).processId}`);
    expect(html).toContain(`/processos/${row(1).processId}`);
  });
});
