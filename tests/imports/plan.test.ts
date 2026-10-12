import { beforeAll, describe, expect, it } from "vitest";
import { parseWorkbook, type ParsedWorkbook } from "@/modules/imports/parser";
import { buildImportPlan, rowKey, type ExistingProcess, type ImportPlan, type PlanInput } from "@/modules/imports/plan";
import { readWorkbook } from "@/modules/imports/xlsx";
import { DEMO_CLIENT, demoBytes, row, sheet, validCnj } from "./helpers";

const COMPANY = "00000000-0000-4000-8000-000000000001";

function plan(sheets: Parameters<typeof parseWorkbook>[0], extra: Partial<PlanInput> = {}): { wb: ParsedWorkbook; plan: ImportPlan } {
  const wb = parseWorkbook(sheets, { clientName: DEMO_CLIENT });
  return {
    wb,
    plan: buildImportPlan({ rows: wb.rows, existing: new Map(), companyId: COMPANY, defaultUnitId: null, fileName: "carteira.xlsx", ...extra }),
  };
}

describe("grouping by CNJ and current instance (RN-01/RN-09)", () => {
  it("creates one process per CNJ with one instance link per instance", () => {
    const cnj = validCnj(10);
    const { plan: p } = plan([
      sheet("Consolidado Geral", [
        row({ number: cnj, instance: "1º Grau", city: "Palmas - TO", claim: 1000, phase: "Conhecimento" }),
        row({ number: cnj, instance: "2º Grau", division: "1ª Turma", cls: "ROT", claim: 1000, phase: "Conhecimento (recurso) — em tramitação" }),
      ]),
    ]);
    expect(p.processes).toHaveLength(1);
    const proc = p.processes[0];
    expect(proc.action).toBe("create");
    expect(proc.instances.map((i) => [i.instance, i.values.isCurrent])).toEqual([
      ["first", false],
      ["second", true],
    ]);
    expect(proc.target).toMatchObject({ instance: "second", phase: "appeal", city: "Palmas", state: "TO", claimAmountCents: 100000, area: "labor" });
    expect(p.stats).toMatchObject({ processesDetected: 1, toCreate: 1, instanceLinks: 1, rowsRead: 2 });
    expect(p.outcomes.get(rowKey("Consolidado Geral", 3))?.action).toBe("create");
    expect(p.outcomes.get(rowKey("Consolidado Geral", 2))?.action).toBe("merge_instance");
  });

  it("uses the highest instance that was not returned ('baixou à origem')", () => {
    const cnj = validCnj(11);
    const { plan: p } = plan([
      sheet("Consolidado Geral", [
        row({ number: cnj, instance: "1º Grau", phase: "Liquidação" }),
        row({ number: cnj, instance: "2º Grau", phase: "Recurso decidido — baixou do 2º grau (à origem/TST)" }),
      ]),
    ]);
    expect(p.processes[0].target).toMatchObject({ instance: "first", phase: "liquidation", needsVerification: false });
  });

  it("marks the process for verification when every instance was returned", () => {
    const { plan: p } = plan([
      sheet("Consolidado Geral", [row({ number: validCnj(12), instance: "2º Grau", phase: "Recurso decidido — baixou do 2º grau (à origem/TST)" })]),
    ]);
    const proc = p.processes[0];
    expect(proc.target.instance).toBeNull();
    expect(proc.target.needsVerification).toBe(true);
    expect(proc.instances[0].values.isCurrent).toBe(false);
    expect(p.outcomes.get(proc.primaryRowKey)?.issues.map((i) => i.code)).toContain("current_instance_undetermined");
  });

  it("closes paid processes with a zero liquidated value and keeps VERIFICAR rows open", () => {
    const paid = validCnj(13);
    const verify = validCnj(14);
    const { plan: p } = plan([
      sheet("Consolidado Geral", [
        row({ number: paid, phase: "PAGO/EXTINTO — arquivado def. 2026-06-25", claim: 5000, liquidated: 0 }),
        row({ number: verify, phase: "Liquidação — VERIFICAR (menção de quitação/saiu do acervo)", claim: 100, liquidated: null }),
      ]),
    ]);
    const paidPlan = p.processes.find((x) => x.cnj === paid)!;
    expect(paidPlan.target).toMatchObject({ status: "closed", phase: "closed", closureReason: "paid_extinct", closedAt: "2026-06-25", liquidatedAmountCents: 0 });
    const liq = paidPlan.valuations.find((v) => v.kind === "liquidated")!;
    expect(liq).toMatchObject({ amountCents: 0, status: "official" });
    expect(liq.reason).toMatch(/^Quitação/);
    const verifyPlan = p.processes.find((x) => x.cnj === verify)!;
    expect(verifyPlan.target).toMatchObject({ status: "active", phase: "liquidation", closureReason: null, needsVerification: true, liquidatedAmountCents: null });
    expect(verifyPlan.target.verificationNote).toContain("VERIFICAR");
    // RN-03: no liquidated valuation is created from an empty cell.
    expect(verifyPlan.valuations.map((v) => v.kind)).toEqual(["claim"]);
  });

  it("takes parties and title from the lowest instance line and flags the client", () => {
    const cnj = validCnj(15);
    const { plan: p } = plan([
      sheet("Consolidado Geral", [
        row({ number: cnj, instance: "2º Grau", plaintiff: DEMO_CLIENT, defendant: "MARIA (FICTÍCIA)" }),
        row({ number: cnj, instance: "1º Grau", plaintiff: "MARIA (FICTÍCIA)", defendant: `${DEMO_CLIENT} (e outros)` }),
      ]),
    ]);
    const proc = p.processes[0];
    expect(proc.target.title).toBe(`MARIA (FICTÍCIA) x ${DEMO_CLIENT}`);
    expect(proc.parties).toEqual([
      { name: "MARIA (FICTÍCIA)", role: "plaintiff", hasOthers: false, isClient: false },
      { name: DEMO_CLIENT, role: "defendant", hasOthers: true, isClient: true },
    ]);
  });
});

describe("divergences between sheets (RN-08)", () => {
  it("keeps the consolidated value as official and proposes the divergent one", () => {
    const cnj = validCnj(20);
    const { plan: p } = plan([
      sheet("Consolidado Geral", [row({ number: cnj, instance: "1º Grau", claim: 1000, liquidated: null, phase: "Execução" })]),
      sheet("1º Grau", [row({ number: cnj, instance: "1º Grau", claim: 1200, liquidated: 300.5, phase: "Liquidação" })]),
    ]);
    expect(p.stats.divergences).toBe(3);
    const fields = p.divergences.map((d) => d.field).sort();
    expect(fields).toEqual(["claimAmount", "liquidatedAmount", "phase"]);
    const proc = p.processes[0];
    expect(proc.target.claimAmountCents).toBe(100000);
    expect(proc.target.liquidatedAmountCents).toBeNull();
    expect(proc.valuations).toEqual([
      expect.objectContaining({ kind: "claim", amountCents: 100000, status: "official" }),
      expect.objectContaining({ kind: "claim", amountCents: 120000, status: "proposed", reason: expect.stringMatching(/^Divergência entre abas: 1º Grau \(linha 2\)/) }),
      expect.objectContaining({ kind: "liquidated", amountCents: 30050, status: "proposed" }),
    ]);
    // The instance sheet line is only used for conferência.
    const mirror = p.outcomes.get(rowKey("1º Grau", 2))!;
    expect(mirror.action).toBe("skip");
    expect(mirror.issues.filter((i) => i.code === "value_divergence")).toHaveLength(3);
    const official = p.outcomes.get(rowKey("Consolidado Geral", 2))!;
    expect(official.action).toBe("create");
    expect(official.divergences.map((d) => d.valuation).sort()).toEqual(["none", "proposed", "proposed"]);
  });

  it("flags repeated numbers inside the same sheet", () => {
    const cnj = validCnj(21);
    const { plan: p } = plan([sheet("Consolidado Geral", [row({ number: cnj, claim: 1 }), row({ number: cnj, claim: 2 })])]);
    expect(p.stats.duplicatesInSheet).toBe(1);
    const dup = p.outcomes.get(rowKey("Consolidado Geral", 3))!;
    expect(dup.action).toBe("skip");
    expect(dup.issues[0]).toMatchObject({ code: "duplicate_in_sheet", level: "warning" });
    expect(dup.issues[0].message).toContain("valores diferentes");
  });

  it("uses an instance sheet line when the number is missing from the consolidated sheet", () => {
    const { plan: p } = plan([
      sheet("Consolidado Geral", [row({ number: validCnj(22) })]),
      sheet("2º Grau", [row({ number: validCnj(23), instance: "2º Grau" })]),
    ]);
    expect(p.processes).toHaveLength(2);
    const only = p.outcomes.get(rowKey("2º Grau", 2))!;
    expect(only.action).toBe("create");
    expect(only.issues.map((i) => i.code)).toContain("only_in_instance_sheet");
  });
});

describe("diff against existing processes", () => {
  const cnj = validCnj(30);
  const existing = (overrides: Partial<ExistingProcess> = {}): ExistingProcess => ({
    id: "11111111-1111-4111-8111-111111111111",
    number: cnj,
    court: "TRT10",
    instance: "first",
    courtDivision: "1ª VARA DO TRABALHO",
    processClass: "ATOrd",
    city: null,
    state: null,
    phase: "knowledge",
    status: "active",
    closureReason: null,
    closedAt: null,
    needsVerification: false,
    verificationNote: null,
    phaseDetail: "Conhecimento",
    companyId: COMPANY,
    unitId: null,
    claimAmountCents: 100000,
    liquidatedAmountCents: null,
    instances: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        instance: "first",
        court: "TRT10",
        courtDivision: "1ª VARA DO TRABALHO",
        city: null,
        state: null,
        processClass: "ATOrd",
        phase: "knowledge",
        phaseDetail: "Conhecimento",
        claimAmountCents: 100000,
        liquidatedAmountCents: null,
        isCurrent: true,
      },
    ],
    ...overrides,
  });
  const sheetFor = (r: Parameters<typeof row>[0]) => [sheet("Consolidado Geral", [row(r)])];

  it("reports unchanged when nothing differs (idempotent re-import)", () => {
    const { plan: p } = plan(sheetFor({ number: cnj, claim: 1000 }), { existing: new Map([[cnj, existing()]]) });
    expect(p.processes[0].action).toBe("unchanged");
    expect(p.processes[0].valuations).toEqual([]);
    expect(p.stats).toMatchObject({ toCreate: 0, toUpdate: 0, unchanged: 1 });
  });

  it("updates fields, never erases data with blanks and proposes a different official value", () => {
    const { plan: p } = plan(sheetFor({ number: cnj, claim: 1500, liquidated: 200, phase: "Liquidação", division: null }), {
      existing: new Map([[cnj, existing()]]),
    });
    const proc = p.processes[0];
    expect(proc.action).toBe("update");
    expect(proc.changes).toMatchObject({ phase: "liquidation", phaseDetail: "Liquidação", liquidatedAmountCents: 20000 });
    expect(proc.changes).not.toHaveProperty("courtDivision");
    expect(proc.changes).not.toHaveProperty("claimAmountCents");
    expect(proc.before).toMatchObject({ phase: "knowledge", liquidatedAmountCents: null });
    expect(proc.valuations).toEqual([
      expect.objectContaining({ kind: "claim", amountCents: 150000, status: "proposed" }),
      expect.objectContaining({ kind: "liquidated", amountCents: 20000, status: "official" }),
    ]);
    expect(p.outcomes.get(proc.primaryRowKey)?.issues.map((i) => i.code)).toContain("existing_value_differs");
  });

  it("does not repeat a proposal already recorded and never reopens a closed process", () => {
    const ex = existing({ status: "closed", phase: "closed", closureReason: "lost_patronage" });
    const { plan: p } = plan(sheetFor({ number: cnj, claim: 1500, phase: "Conhecimento" }), {
      existing: new Map([[cnj, ex]]),
      existingValuationKeys: new Map([[ex.id, new Set(["claim:150000"])]]),
    });
    const proc = p.processes[0];
    expect(proc.changes).not.toHaveProperty("status");
    expect(proc.changes).not.toHaveProperty("phase");
    expect(proc.valuations).toEqual([]);
    expect(proc.action).toBe("unchanged");
    expect(p.outcomes.get(proc.primaryRowKey)?.issues.map((i) => i.code)).toContain("existing_closed_not_reopened");
  });
});

describe("plan of the client's demo spreadsheet", () => {
  let p: ImportPlan;
  beforeAll(async () => {
    const wb = parseWorkbook(await readWorkbook(await demoBytes()), { clientName: DEMO_CLIENT });
    p = buildImportPlan({ rows: wb.rows, existing: new Map(), companyId: COMPANY, defaultUnitId: null, fileName: "demo.xlsx" });
  });

  it("detects 928 processes and 237 extra instance links", () => {
    expect(p.stats).toMatchObject({
      rowsRead: 2330,
      processesDetected: 928,
      toCreate: 928,
      toUpdate: 0,
      unchanged: 0,
      instanceLinks: 237,
      errors: 0,
      duplicatesInSheet: 0,
    });
    expect(p.processes.reduce((n, x) => n + x.instances.length, 0)).toBe(1165);
  });

  it("finds the divergences between the consolidated and the instance sheets", () => {
    const byField = p.divergences.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.field]: (acc[d.field] ?? 0) + 1 }), {});
    expect(byField).toEqual({ claimAmount: 408, liquidatedAmount: 43 });
    expect(p.stats.divergences).toBe(451);
    const proposed = p.processes.flatMap((x) => x.valuations).filter((v) => v.status === "proposed");
    expect(proposed.length).toBeGreaterThan(300);
    expect(proposed.every((v) => v.reason.startsWith("Divergência entre abas:"))).toBe(true);
  });

  it("closes paid/archived processes and flags verification without closing", () => {
    const closed = p.processes.filter((x) => x.target.status === "closed");
    expect(closed.length).toBeGreaterThan(50);
    expect(closed.every((x) => x.target.closureReason === "paid_extinct" || x.target.closureReason === "archived")).toBe(true);
    const verify = p.processes.filter((x) => x.target.phaseDetail?.includes("VERIFICAR"));
    expect(verify.length).toBeGreaterThan(0);
    expect(verify.every((x) => x.target.status === "active" && x.target.needsVerification)).toBe(true);
  });
});
