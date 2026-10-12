import { beforeAll, describe, expect, it } from "vitest";
import {
  classifySheetName,
  detectHeader,
  matchHeader,
  normalizeCourt,
  normalizeStoredPhase,
  parseCityCell,
  parseInstance,
  parseMoneyCell,
  parsePartyCell,
  parsePhase,
  parseWorkbook,
  type ParsedWorkbook,
  type PhaseParse,
} from "@/modules/imports/parser";
import { hasZipSignature, readWorkbook, UnreadableWorkbookError } from "@/modules/imports/xlsx";
import { DEMO_CLIENT, demoBytes, invalidCnj, row, sheet, validCnj } from "./helpers";

describe("header detection and sheet roles", () => {
  it("maps header synonyms to canonical fields", () => {
    expect(matchHeader("Nº do Processo")).toBe("number");
    expect(matchHeader("Número do processo")).toBe("number");
    expect(matchHeader("No do Processo")).toBe("number");
    expect(matchHeader("TRT/Tribunal")).toBe("court");
    expect(matchHeader("Instância")).toBe("instance");
    expect(matchHeader("Parte Autora")).toBe("plaintiff");
    expect(matchHeader("Reclamante")).toBe("plaintiff");
    expect(matchHeader("Parte Ré")).toBe("defendant");
    expect(matchHeader("Reclamada")).toBe("defendant");
    expect(matchHeader("Cidade")).toBe("city");
    expect(matchHeader("Vara / Órgão Julgador / Turma")).toBe("courtDivision");
    expect(matchHeader("Classe")).toBe("processClass");
    expect(matchHeader("Fase")).toBe("phase");
    expect(matchHeader("Valor da Causa (R$)")).toBe("claimAmount");
    expect(matchHeader("Valor Liquidado/Apurado - 1º grau (R$)")).toBe("liquidatedAmount");
    expect(matchHeader("Observações gerais")).toBeNull();
    expect(matchHeader(null)).toBeNull();
  });

  it("finds the header row below title lines and requires the number column", () => {
    const rows = [["RELATÓRIO FICTÍCIO"], [null], ["Nº do Processo", "Fase", "Valor da Causa"], ["x", "y", 1]];
    expect(detectHeader(rows)?.headerRow).toBe(3);
    expect(detectHeader([["Fase", "Classe", "Cidade"]])).toBeNull();
  });

  it("classifies sheets by name", () => {
    expect(classifySheetName("Dashboard")?.role).toBe("ignored");
    expect(classifySheetName("Atualização Geral (29-07-2026)")?.role).toBe("ignored");
    expect(classifySheetName("Consolidado Geral")?.role).toBe("consolidated");
    expect(classifySheetName("1º Grau")).toMatchObject({ role: "instance", instance: "first" });
    expect(classifySheetName("2º Grau")).toMatchObject({ role: "instance", instance: "second" });
    expect(classifySheetName("3º Grau (TST)")).toMatchObject({ role: "instance", instance: "superior" });
    expect(classifySheetName("Planilha1")).toBeNull();
  });

  it("promotes an unknown sheet with a header to consolidated only when there is no consolidated sheet", () => {
    const alone = parseWorkbook([sheet("Planilha1", [row({ number: validCnj(1) })])], { clientName: null });
    expect(alone.sheets[0].role).toBe("consolidated");
    const withConsolidated = parseWorkbook(
      [sheet("Consolidado", [row({ number: validCnj(1) })]), sheet("Planilha1", [row({ number: validCnj(2) })])],
      { clientName: null },
    );
    expect(withConsolidated.sheets[1].role).toBe("ignored");
    expect(withConsolidated.rows.every((r) => r.sheet === "Consolidado")).toBe(true);
  });
});

describe("field normalizers", () => {
  it("normalizes courts", () => {
    expect(normalizeCourt("TRT 10")).toBe("TRT10");
    expect(normalizeCourt("TRT-10")).toBe("TRT10");
    expect(normalizeCourt("trt10")).toBe("TRT10");
    expect(normalizeCourt("TRT da 2ª Região")).toBe("TRT2");
    expect(normalizeCourt("TST")).toBe("TST");
    expect(normalizeCourt("TJ-SP")).toBe("TJSP");
    expect(normalizeCourt("  ")).toBeNull();
  });

  it("parses the instance from the cell", () => {
    expect(parseInstance("1º Grau")).toBe("first");
    expect(parseInstance("2º Grau")).toBe("second");
    expect(parseInstance("3º Grau (TST)")).toBe("superior");
    expect(parseInstance("TST")).toBe("superior");
    expect(parseInstance("Primeiro grau")).toBe("first");
    expect(parseInstance("TOTAL")).toBeNull();
  });

  it("splits city and UF and flags non-geographic values", () => {
    expect(parseCityCell("Palmas - TO")).toMatchObject({ city: "Palmas", state: "TO", kind: "city" });
    expect(parseCityCell("Palmas/TO")).toMatchObject({ city: "Palmas", state: "TO", kind: "city" });
    expect(parseCityCell("Brasília/DF")).toMatchObject({ city: "Brasília", state: "DF", kind: "city" });
    expect(parseCityCell("Palmas")).toMatchObject({ city: "Palmas", state: null, kind: "city" });
    expect(parseCityCell("Cejusc Digital")).toMatchObject({ city: null, state: null, kind: "non_geographic" });
    expect(parseCityCell("Secretaria de Cálculos Judiciais")).toMatchObject({ city: null, kind: "non_geographic" });
    expect(parseCityCell("Vara do Trabalho do Gama - DF")).toMatchObject({ city: null, state: "DF", kind: "non_geographic" });
    expect(parseCityCell("Brasília/Palmas")).toMatchObject({ city: null, state: null, kind: "ambiguous" });
    expect(parseCityCell(null).kind).toBe("empty");
  });

  it("keeps null different from zero (RN-03)", () => {
    expect(parseMoneyCell(null)).toEqual({ cents: null, issue: null });
    expect(parseMoneyCell("")).toEqual({ cents: null, issue: null });
    expect(parseMoneyCell("-")).toEqual({ cents: null, issue: null });
    expect(parseMoneyCell(0)).toEqual({ cents: 0, issue: null });
    expect(parseMoneyCell("R$ 0,00")).toEqual({ cents: 0, issue: null });
    expect(parseMoneyCell(1541598.05)).toEqual({ cents: 154159805, issue: null });
    expect(parseMoneyCell("R$ 1.234,56")).toEqual({ cents: 123456, issue: null });
    expect(parseMoneyCell(0.01).cents).toBe(1);
    expect(parseMoneyCell("valor a apurar")).toMatchObject({ cents: null, issue: { code: "money_unrecognized" } });
    expect(parseMoneyCell(-10)).toMatchObject({ cents: null, issue: { code: "money_negative" } });
  });

  it("strips '(e outros)', detects the client and the Ministério Público", () => {
    expect(parsePartyCell("EMPRESA MODELO TESTE LTDA e outros", "defendant", DEMO_CLIENT)).toEqual({
      name: "EMPRESA MODELO TESTE LTDA",
      role: "defendant",
      hasOthers: true,
      isClient: true,
    });
    expect(parsePartyCell("Empresa Modelo Teste Ltda. (e outros)", "defendant", DEMO_CLIENT)).toMatchObject({
      name: "Empresa Modelo Teste Ltda.",
      hasOthers: true,
      isClient: true,
    });
    expect(parsePartyCell("Émpresa  modelo teste LTDA", "plaintiff", DEMO_CLIENT)?.isClient).toBe(true);
    expect(parsePartyCell("OUTRA EMPRESA LTDA", "defendant", DEMO_CLIENT)?.isClient).toBe(false);
    expect(parsePartyCell("MINISTÉRIO PÚBLICO DO TRABALHO", "plaintiff", DEMO_CLIENT)?.role).toBe("public_prosecutor");
    expect(parsePartyCell("MPT", "plaintiff", DEMO_CLIENT)?.role).toBe("public_prosecutor");
    expect(parsePartyCell("Ministério Público do Trabalho", "defendant", DEMO_CLIENT)?.role).toBe("public_prosecutor");
    expect(parsePartyCell("   ", "plaintiff", DEMO_CLIENT)).toBeNull();
  });
});

describe("phase parser", () => {
  // P0.5: phase and instance are distinct axes. Phase only from Conhecimento/Liquidação/Execução terms;
  // recurso/agravo/AIRR/RR/TST name the INSTANCE (2º/3º grau) and never the phase.
  it.each([
    ["Conhecimento", { phase: "knowledge", instance: null, closed: false, returned: false, needsVerification: false }],
    ["Liquidação", { phase: "liquidation", instance: null, closed: false }],
    ["Execução", { phase: "enforcement", instance: null, closed: false }],
    ["Conhecimento (AIRR) — em tramitação no TST", { phase: "knowledge", instance: "superior", returned: false }],
    ["Conhecimento (recurso) — em tramitação", { phase: "knowledge", instance: "second" }],
    ["Conhecimento — Concluso p/ julgamento (recurso)", { phase: "knowledge", instance: "second" }],
    ["Conhecimento (recursal) — AGRAVO DE PETIÇÃO pautado p/ julgamento", { phase: "knowledge", instance: "second" }],
    // Returned rows: the appeal already came back, so the text names no current instance.
    ["Recurso decidido — baixou do 2º grau (à origem/TST)", { phase: null, instance: null, returned: true, recognized: true }],
    ["TST decidiu (agravo/RR) — baixado à origem", { phase: null, instance: null, returned: true, recognized: true }],
    ["Recurso baixado — retornou ao 1º grau (liquidação)", { phase: "liquidation", instance: null, returned: true }],
    ["Recurso (AIRO) baixado — processo em liquidação no 1º grau", { phase: "liquidation", instance: null, returned: true }],
    ["Conhecimento — Julgado; autos remetidos ao TST (Recurso de Revista)", { phase: "knowledge", instance: "superior", forwarded: true }],
    ["Conhecimento — Julgado (acórdão); RR interposto 2026-05-02 (10ª Turma)", { phase: "knowledge", instance: "superior", forwarded: true }],
    ["Conhecimento — Acórdão publicado (2º grau julgado)", { phase: "knowledge", instance: null }],
    [
      "PAGO/EXTINTO — arquivado def. 2026-06-25",
      { phase: null, closed: true, closureReason: "paid_extinct", closedAt: "2026-06-25", needsVerification: false, recognized: true },
    ],
    ["PAGO/EXTINTO — extinta execução 2026-07-03", { phase: "enforcement", closed: true, closureReason: "paid_extinct", closedAt: "2026-07-03" }],
    ["Execução — EXTINTA (satisfação 20/04/2026)", { phase: "enforcement", closed: true, closureReason: "paid_extinct", closedAt: "2026-04-20" }],
    ["Execução — ARQUIVADO def. 2026-07-18", { phase: "enforcement", closed: true, closureReason: "archived", closedAt: "2026-07-18" }],
    ["Conhecimento — ARQUIVADO definitivamente em 07/07/2026", { phase: "knowledge", closed: true, closureReason: "archived", closedAt: "2026-07-07" }],
    // VERIFICAR / "saiu do acervo": verification, never an automatic closure (and no instance from a doubtful text).
    ["Liquidação — VERIFICAR (menção de quitação/saiu do acervo)", { phase: "liquidation", closed: false, needsVerification: true }],
    [
      "Conhecimento — Saiu do acervo 1º grau (provável recurso ao 2º grau) — verificar",
      { phase: "knowledge", instance: null, closed: false, needsVerification: true },
    ],
    ["Arquivados", { phase: null, closed: false, needsVerification: true, recognized: false }],
    ["A habilitar", { phase: null, closed: false, recognized: false }],
    // Negated or deadline-only appeal wording names no instance (P0.5 review).
    ["Sem recurso — aguardando sentença", { phase: null, instance: null, recognized: false }],
    ["Conhecimento — prazo recursal em aberto", { phase: "knowledge", instance: null }],
    ["Conhecimento — aberto prazo para recurso da sentença", { phase: "knowledge", instance: null }],
    ["Execução — não houve recurso da reclamada", { phase: "enforcement", instance: null }],
    ["Recurso não interposto — trânsito em julgado", { phase: null, instance: null, recognized: false }],
    ["Conhecimento — sem recurso da ré; recurso ordinário do autor pendente", { phase: "knowledge", instance: "second" }],
    ["Recurso Ordinário", { phase: null, instance: "second", recognized: true }],
  ] as const)("%s", (text, expected) => {
    const parsed = parsePhase(text);
    expect(parsed).toMatchObject(expected);
    expect(parsed.detail).toBe(text);
  });

  it("keeps a verification note and returns an empty parse for blank cells", () => {
    expect(parsePhase("Conhecimento — VERIFICAR (menção de quitação/saiu do acervo)").verificationNote).toContain("VERIFICAR");
    expect(parsePhase(null)).toMatchObject({ phase: null, detail: null, recognized: false, needsVerification: false });
  });

  it("re-reads a parse stored before P0.5 (phase of the previous model, no instance) from the cell text", () => {
    const appeal = { ...parsePhase("Recurso Ordinário — pautado"), phase: "appeal" } as unknown as PhaseParse;
    delete (appeal as Partial<PhaseParse>).instance;
    expect(normalizeStoredPhase(appeal)).toMatchObject({ phase: null, instance: "second", closed: false });
    const closed = { ...parsePhase("Execução — PAGO/EXTINTO 2026-06-25"), phase: "closed" } as unknown as PhaseParse;
    delete (closed as Partial<PhaseParse>).instance;
    expect(normalizeStoredPhase(closed)).toMatchObject({ phase: "enforcement", closed: true, closureReason: "paid_extinct", closedAt: "2026-06-25" });
    // A current parse is returned as is.
    const current = parsePhase("Liquidação");
    expect(normalizeStoredPhase(current)).toBe(current);
    expect(normalizeStoredPhase(null)).toMatchObject({ phase: null, instance: null, detail: null });
  });
});

describe("rows of a synthetic workbook", () => {
  it("skips blank and TOTAL rows and keeps reading after TOTAL", () => {
    const wb = parseWorkbook(
      [
        sheet("Consolidado Geral", [
          row({ number: validCnj(1) }),
          [null, null, null, null],
          ["TOTAL", null, null, null, null, null, null, null, null, 123, 4],
          row({ number: validCnj(2) }),
        ]),
      ],
      { clientName: DEMO_CLIENT },
    );
    expect(wb.rows.map((r) => [r.rowNumber, r.kind])).toEqual([
      [2, "data"],
      [4, "total"],
      [5, "data"],
    ]);
    expect(wb.rows[1].issues[0]).toMatchObject({ level: "info", code: "total_row" });
    expect(wb.rows[2].issues.find((i) => i.code === "after_total")).toMatchObject({ level: "info" });
    expect(wb.rows[2].data?.afterTotal).toBe(true);
    expect(wb.sheets[0].rowCount).toBe(3);
  });

  it("errors unparseable numbers, warns about check digits and never fixes them", () => {
    const wb = parseWorkbook(
      [sheet("Consolidado", [row({ number: "12345" }), row({ number: invalidCnj(7) }), row({ number: validCnj(8) }), row({ number: null })])],
      { clientName: DEMO_CLIENT },
    );
    const [bad, wrongDv, ok, missing] = wb.rows;
    expect(bad.error).toBe(true);
    expect(bad.issues.map((i) => i.code)).toContain("cnj_invalid_format");
    expect(wrongDv.error).toBe(false);
    expect(wrongDv.data?.cnj).toBe(invalidCnj(7));
    expect(wrongDv.data?.cnjValid).toBe(false);
    expect(wrongDv.issues.find((i) => i.code === "cnj_invalid_check_digit")).toMatchObject({ level: "warning" });
    expect(ok.data?.cnjValid).toBe(true);
    expect(ok.issues.some((i) => i.code.startsWith("cnj_"))).toBe(false);
    expect(missing.issues.map((i) => i.code)).toContain("cnj_missing");
  });

  it("derives the labor area from the CNJ segment and normalizes court and instance", () => {
    const wb = parseWorkbook(
      [
        sheet("Consolidado", [
          row({ number: validCnj(1), court: "TRT 10", instance: "2º Grau" }),
          row({ number: validCnj(2, { segment: "8", tribunal: "26" }), court: "TJSP" }),
          row({ number: validCnj(3), court: null, instance: null }),
        ]),
      ],
      { clientName: DEMO_CLIENT },
    );
    expect(wb.rows[0].data).toMatchObject({ court: "TRT10", instance: "second", area: "labor" });
    expect(wb.rows[1].data?.area).toBe("other");
    expect(wb.rows[1].issues.map((i) => i.code)).toContain("area_not_derived");
    expect(wb.rows[2].data).toMatchObject({ court: "TRT10", instance: "first" });
    expect(wb.rows[2].issues.map((i) => i.code)).toEqual(expect.arrayContaining(["court_derived", "instance_assumed"]));
  });

  it("appeal terms of the Fase fill a missing instance, and never become a phase (P0.5)", () => {
    const wb = parseWorkbook(
      [
        sheet("Consolidado", [
          row({ number: validCnj(31), instance: null, phase: "Conhecimento (AIRR) — em tramitação no TST" }),
          row({ number: validCnj(32), instance: null, phase: "Conhecimento (recurso) — em tramitação" }),
          // The cell wins over the text; a returned appeal names no instance (falls back to 1º grau, with a warning).
          row({ number: validCnj(33), instance: "1º Grau", phase: "Conhecimento (recurso) — em tramitação" }),
          row({ number: validCnj(34), instance: null, phase: "Recurso decidido — baixou do 2º grau (à origem/TST)" }),
          // Negated / deadline-only wording names no instance: 1º grau presumed, with the usual warning.
          row({ number: validCnj(35), instance: null, phase: "Sem recurso — aguardando sentença" }),
          row({ number: validCnj(36), instance: null, phase: "Conhecimento — prazo recursal em aberto" }),
        ]),
      ],
      { clientName: DEMO_CLIENT },
    );
    const [airr, recurso, cell, returned, noAppeal, deadline] = wb.rows;
    expect(airr.data).toMatchObject({ instance: "superior", instanceFromPhase: true, phase: { phase: "knowledge", instance: "superior" } });
    // A presumption from free text: warning (as strict as instance_assumed) and verification in the plan.
    expect(airr.issues.find((i) => i.code === "instance_from_phase")).toMatchObject({ level: "warning" });
    expect(airr.issues.find((i) => i.code === "instance_from_phase")?.message).toContain("pendente de conferência");
    expect(recurso.data).toMatchObject({ instance: "second", instanceFromPhase: true, phase: { phase: "knowledge" } });
    expect(cell.data).toMatchObject({ instance: "first", instanceFromPhase: false });
    expect(cell.issues.map((i) => i.code)).not.toContain("instance_from_phase");
    expect(returned.data?.instance).toBe("first");
    expect(returned.issues.map((i) => i.code)).toContain("instance_assumed");
    expect(returned.issues.map((i) => i.code)).not.toContain("phase_unrecognized");
    for (const r of [noAppeal, deadline]) {
      expect(r.data).toMatchObject({ instance: "first", instanceFromPhase: false, phase: { instance: null } });
      expect(r.issues.map((i) => i.code)).toContain("instance_assumed");
      expect(r.issues.map((i) => i.code)).not.toContain("instance_from_phase");
    }
    expect(noAppeal.issues.map((i) => i.code)).toContain("phase_unrecognized");
    expect(deadline.data?.phase.phase).toBe("knowledge");
    for (const r of wb.rows) expect(["knowledge", "liquidation", "enforcement", null]).toContain(r.data?.phase.phase);
  });

  it("infers the UF of a city only from other rows of the same file", () => {
    const wb = parseWorkbook(
      [
        sheet("Consolidado", [
          row({ number: validCnj(1), city: "Palmas - TO" }),
          row({ number: validCnj(2), city: "Palmas" }),
          row({ number: validCnj(3), city: "Caldas Novas" }),
          row({ number: validCnj(4), city: "Cejusc Digital" }),
        ]),
      ],
      { clientName: DEMO_CLIENT },
    );
    expect(wb.rows[1].data).toMatchObject({ city: "Palmas", state: "TO" });
    expect(wb.rows[1].issues.find((i) => i.code === "city_state_inferred")).toMatchObject({ level: "info" });
    expect(wb.rows[2].data).toMatchObject({ city: "Caldas Novas", state: null });
    expect(wb.rows[3].data).toMatchObject({ city: null, state: null });
    expect(wb.rows[3].issues.find((i) => i.code === "city_non_geographic")).toMatchObject({ level: "warning" });
  });

  it("warns on every row when the selected company is not a party", () => {
    const wb = parseWorkbook([sheet("Consolidado", [row({ number: validCnj(1) })])], { clientName: "Outra Empresa S.A." });
    expect(wb.clientMatches).toBe(0);
    expect(wb.rows[0].issues.map((i) => i.code)).toContain("client_not_found");
  });
});

describe("the client's demo spreadsheet (fictitious data)", () => {
  let wb: ParsedWorkbook;
  beforeAll(async () => {
    wb = parseWorkbook(await readWorkbook(await demoBytes()), { clientName: DEMO_CLIENT });
  });

  it("detects every sheet with its role and the base date suggestion", () => {
    expect(wb.sheets.map((s) => [s.name, s.role, s.instance])).toEqual([
      ["Dashboard", "ignored", null],
      ["Consolidado Geral", "consolidated", null],
      ["1º Grau", "instance", "first"],
      ["2º Grau", "instance", "second"],
      ["3º Grau (TST)", "instance", "superior"],
      ["Atualização Geral (29-07-2026)", "ignored", null],
    ]);
    expect(wb.sheets.find((s) => s.name === "Dashboard")?.note).toMatch(/resumo/i);
    expect(wb.sheets.find((s) => s.name.startsWith("Atualiza"))?.note).toMatch(/narrativo/i);
    expect(wb.baseDateHint).toEqual({ date: "2026-07-29", source: 'Aba "Atualização Geral (29-07-2026)"' });
  });

  it("maps the headers of each sheet (2º/3º Grau have no Cidade nor Liquidado column)", () => {
    const consolidated = wb.sheets.find((s) => s.name === "Consolidado Geral")!;
    expect(consolidated.headerRow).toBe(1);
    expect(consolidated.mapping).toMatchObject({
      instance: "Instância",
      court: "TRT/Tribunal",
      number: "Nº do Processo",
      plaintiff: "Parte Autora",
      defendant: "Parte Ré",
      city: "Cidade",
      courtDivision: "Vara / Órgão Julgador / Turma",
      processClass: "Classe",
      phase: "Fase",
      claimAmount: "Valor da Causa (R$)",
      liquidatedAmount: "Valor Liquidado/Apurado - 1º grau (R$)",
    });
    const second = wb.sheets.find((s) => s.name === "2º Grau")!;
    expect(second.mapping.city).toBeUndefined();
    expect(second.mapping.liquidatedAmount).toBeUndefined();
  });

  it("skips the four TOTAL rows and keeps the rows below them", () => {
    const totals = wb.rows.filter((r) => r.kind === "total");
    expect(totals.map((r) => [r.sheet, r.rowNumber])).toEqual([
      ["Consolidado Geral", 1097],
      ["1º Grau", 717],
      ["2º Grau", 241],
      ["3º Grau (TST)", 143],
    ]);
    const afterTotal = wb.rows.filter((r) => r.sheet === "Consolidado Geral" && r.data?.afterTotal);
    expect(afterTotal).toHaveLength(70);
    expect(afterTotal.every((r) => r.issues.some((i) => i.code === "after_total" && i.level === "info"))).toBe(true);
    expect(wb.rows.filter((r) => r.kind === "data")).toHaveLength(2330);
  });

  it("counts distinct and repeated CNJs (RN-09)", () => {
    const consolidated = wb.rows.filter((r) => r.sheet === "Consolidado Geral" && r.kind === "data");
    expect(consolidated).toHaveLength(1165);
    expect(consolidated.every((r) => !r.error && r.data?.cnj)).toBe(true);
    const counts = new Map<string, number>();
    for (const r of consolidated) counts.set(r.data!.cnj!, (counts.get(r.data!.cnj!) ?? 0) + 1);
    expect(counts.size).toBe(928);
    expect([...counts.values()].filter((n) => n > 1)).toHaveLength(208);
    expect(Math.max(...counts.values())).toBe(3);
    const allSheets = new Set(wb.rows.filter((r) => r.data?.cnj).map((r) => r.data!.cnj));
    expect(allSheets.size).toBe(928);
  });

  it("normalizes city variants and flags non-geographic values", () => {
    const rows = wb.rows.filter((r) => r.sheet === "Consolidado Geral" && r.data);
    const palmas = rows.filter((r) => r.data!.city === "Palmas");
    expect(palmas.length).toBeGreaterThan(200);
    expect(palmas.every((r) => r.data!.state === "TO")).toBe(true);
    expect(rows.filter((r) => r.data!.city === "Brasília").every((r) => r.data!.state === "DF")).toBe(true);
    expect(rows.filter((r) => r.data!.city === "Caldas Novas").every((r) => r.data!.state === null)).toBe(true);
    const nonGeo = rows.filter((r) => r.issues.some((i) => i.code === "city_non_geographic"));
    expect(nonGeo.length).toBeGreaterThanOrEqual(10);
    expect(nonGeo.every((r) => r.data!.city === null)).toBe(true);
  });

  it("strips '(e outros)', marks the client and keeps liquidated null apart from zero", () => {
    const rows = wb.rows.filter((r) => r.sheet === "Consolidado Geral" && r.data);
    expect(wb.clientMatches).toBe(2330);
    expect(rows.some((r) => r.data!.defendant?.name === DEMO_CLIENT && r.data!.defendant.hasOthers)).toBe(true);
    expect(rows.some((r) => r.data!.plaintiff?.role === "public_prosecutor")).toBe(true);
    const liquidated = rows.map((r) => r.data!.liquidatedAmountCents);
    expect(liquidated.filter((v) => v === 0).length).toBe(65);
    expect(liquidated.filter((v) => v === null).length).toBe(1165 - 289);
  });

  it("does not mark any CNJ as fixed: invalid check digits are only reported", () => {
    const warned = wb.rows.filter((r) => r.issues.some((i) => i.code === "cnj_invalid_check_digit"));
    expect(warned.length).toBeGreaterThan(0);
    expect(warned.every((r) => r.data?.cnjValid === false && !r.error)).toBe(true);
  });
});

describe("xlsx reader", () => {
  it("rejects files without the ZIP signature", async () => {
    const bytes = new TextEncoder().encode("Nº do Processo;Fase\n1;2");
    expect(hasZipSignature(bytes)).toBe(false);
    await expect(readWorkbook(bytes)).rejects.toBeInstanceOf(UnreadableWorkbookError);
  });

  it("rejects a ZIP that is not a spreadsheet", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(readWorkbook(bytes)).rejects.toBeInstanceOf(UnreadableWorkbookError);
  });
});
