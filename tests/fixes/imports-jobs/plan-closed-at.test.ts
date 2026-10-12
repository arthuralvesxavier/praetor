import { describe, expect, it } from "vitest";
import { ISSUE_CODE_LABELS, issueCodeLabel } from "@/modules/imports/labels";
import { parseWorkbook } from "@/modules/imports/parser";
import { buildImportPlan, CLOSED_AT_ASSUMED_MESSAGE, type ExistingProcess, type PlanInput } from "@/modules/imports/plan";
import { DEMO_CLIENT, row, sheet, validCnj } from "../../imports/helpers";

const COMPANY = "00000000-0000-4000-8000-000000000001";
const BASE_DATE = "2026-07-31";

function planOf(rows: Parameters<typeof sheet>[1], extra: Partial<PlanInput> = {}) {
  const wb = parseWorkbook([sheet("Consolidado Geral", rows)], { clientName: DEMO_CLIENT });
  return buildImportPlan({ rows: wb.rows, existing: new Map(), companyId: COMPANY, defaultUnitId: null, fileName: "carteira.xlsx", ...extra });
}

function existingActive(cnj: string, overrides: Partial<ExistingProcess> = {}): ExistingProcess {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    number: cnj,
    court: "TRT10",
    instance: "first",
    courtDivision: "1ª VARA DO TRABALHO",
    processClass: "ATOrd",
    city: null,
    state: null,
    phase: "enforcement",
    status: "active",
    closureReason: null,
    closedAt: null,
    needsVerification: false,
    verificationNote: null,
    phaseDetail: "Execução",
    companyId: COMPANY,
    unitId: null,
    claimAmountCents: 100000,
    liquidatedAmountCents: null,
    instances: [],
    ...overrides,
  };
}

describe("closing date of processes closed by the import without a date (closedAt never null)", () => {
  it("uses the import base date for a new process and warns to check it", () => {
    const cnj = validCnj(701);
    const p = planOf([row({ number: cnj, phase: "PAGO/EXTINTO", claim: 1000, liquidated: 0 })], { baseDate: BASE_DATE });
    const proc = p.processes[0];
    // P0.5: closure is the status, never a phase. Without a phase term the closed process is registered in
    // conhecimento with an informative note (no verification: it is out of the active portfolio).
    expect(proc.target).toMatchObject({ status: "closed", phase: "knowledge", closureReason: "paid_extinct", closedAt: BASE_DATE, needsVerification: false });
    const issues = p.outcomes.get(proc.primaryRowKey)!.issues;
    expect(issues.map((i) => i.code)).toContain("phase_fallback_closed");
    expect(issues.map((i) => i.code)).not.toContain("phase_fallback");
    expect(issues).toContainEqual({ level: "warning", code: "closed_at_assumed", field: "Fase", message: CLOSED_AT_ASSUMED_MESSAGE });
    expect(CLOSED_AT_ASSUMED_MESSAGE).toMatch(/^Data de encerramento não informada: usada a data-base da importação; conferir/);
    expect(issueCodeLabel("closed_at_assumed")).toBe(ISSUE_CODE_LABELS.closed_at_assumed);
    expect(issueCodeLabel("closed_at_assumed")).not.toBe("closed_at_assumed");
  });

  it("keeps the date written in the spreadsheet (no warning)", () => {
    const cnj = validCnj(702);
    const p = planOf([row({ number: cnj, phase: "PAGO/EXTINTO — arquivado def. 2026-06-25", claim: 1000, liquidated: 0 })], { baseDate: BASE_DATE });
    expect(p.processes[0].target.closedAt).toBe("2026-06-25");
    expect(p.outcomes.get(p.processes[0].primaryRowKey)!.issues.map((i) => i.code)).not.toContain("closed_at_assumed");
  });

  it("closes an existing active process with the base date and keeps the before-state for rollback", () => {
    const cnj = validCnj(703);
    const p = planOf([row({ number: cnj, phase: "PAGO/EXTINTO", claim: 1000 })], {
      baseDate: BASE_DATE,
      existing: new Map([[cnj, existingActive(cnj)]]),
    });
    const proc = p.processes[0];
    expect(proc.action).toBe("update");
    expect(proc.changes).toMatchObject({ status: "closed", closureReason: "paid_extinct", closedAt: BASE_DATE });
    // The text has no phase term: the phase already registered is kept (closure is not a phase).
    expect(proc.changes).not.toHaveProperty("phase");
    expect(proc.before).toMatchObject({ status: "active", closedAt: null });
    expect(p.outcomes.get(proc.primaryRowKey)!.issues.map((i) => i.code)).toContain("closed_at_assumed");
  });

  it("does not touch nor warn about a process that is already closed in the system", () => {
    const cnj = validCnj(704);
    const p = planOf([row({ number: cnj, phase: "PAGO/EXTINTO", claim: 1000 })], {
      baseDate: BASE_DATE,
      existing: new Map([[cnj, existingActive(cnj, { status: "closed", phase: "enforcement", closureReason: "archived", closedAt: "2025-01-10" })]]),
    });
    const proc = p.processes[0];
    expect(proc.changes.closedAt).toBeUndefined();
    expect(p.outcomes.get(proc.primaryRowKey)!.issues.map((i) => i.code)).not.toContain("closed_at_assumed");
  });
});
