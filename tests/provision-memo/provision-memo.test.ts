/**
 * P1.10: memória de cálculo da provisão por competência (PGlite).
 *
 * Carteira fictícia da organização A, competência = mês anterior, data-base =
 * último dia dele:
 *   A  apurado 100.000 − garantia 20.000, provável 100% (advogada SP)     -> base apurada 80.000
 *   B  só valor da causa 50.000, possível 50% (sugestão por regra aprovada) -> estimada 25.000
 *   C  unidade RE, valor da causa 30.000, sem classificação                -> sem provisão (ressalva)
 *   D  sigiloso, apurado 40.000, provável 100%                             -> oculto para a contabilidade
 *   E  apurado 10.000, possível 50% derivada dos pedidos                   -> 5.000
 *   F  classificação só no cadastro (possível 50%), causa 20.000           -> estimada 10.000 (ressalva)
 *   G  quitação (apurado 0), provável 100%                                 -> provisão apurada 0,00
 *   H  apurado 60.000, 30% definida manualmente contra a derivada          -> 18.000
 *   I  causa 12.345,67, 40% registrada depois de avaliação de pedido       -> estimada 4.938,27
 *   X1..X24 carteira adicional (tabelas de várias páginas na amostra).
 *
 * Com PROVISION_MEMO_SAMPLE_OUT=<pasta> grava os PDFs (prévia e fechada) e o
 * XLSX para conferência visual (ex.: .data/provision-memo-sample).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import readXlsxFile from "read-excel-file/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { periodReferenceDate, previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { createGuarantee } from "@/modules/contingency/guarantee-service";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { periodOf } from "@/modules/contingency/rules";
import { addValuation, registerExtinction } from "@/modules/contingency/service";
import { closeSnapshot, generateSnapshot, getSnapshot } from "@/modules/contingency/snapshot-service";
import { memoMoney, totalsLineAmounts, type ProvisionMemo, type ProvisionMemoRow } from "@/modules/provision-memo/memo";
import { renderProvisionMemoPdf } from "@/modules/provision-memo/pdf";
import { exportProvisionMemo, getProvisionMemo } from "@/modules/provision-memo/service";
import { buildProvisionMemoXlsx, MEMO_SHEET, TOTALS_SHEET } from "@/modules/provision-memo/xlsx";
import type { AuthContext } from "@/server/auth/context";
import {
  auditLogs,
  companies,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processClaimAssessments,
  processClaimRiskLinks,
  processClaims,
  processRiskAssessments,
} from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import { pageTexts } from "../legal-reports/pdf-inspect";

const session = vi.hoisted(() => ({ current: null as AuthContext | null }));
vi.mock("@/server/auth/session", () => ({ getCurrentUser: async () => session.current }));

const { GET } = await import("@/app/api/provision-memo/[period]/route");

let f: Fixture;
const today = todayISO();
const current = periodOf(today);
const previous = previousPeriod(current);
const ref = periodReferenceDate(previous);
const OLD = "2024-03-01";
const D = (day: number) => `${previous}-${String(day).padStart(2, "0")}`;
const JUSTIFICATION = "Processos recebidos de outro escritório; classificação de risco em revisão pelo jurídico.";
const NOW = new Date("2026-10-12T17:03:00.000Z");

const OP = {
  A: "Parecer fictício A: cálculo de liquidação homologado e depósito judicial efetuado; condenação provável.",
  B: "Sugestão automática por regra (fictícia): pedido trabalhista em primeiro grau, risco possível.",
  D: "Parecer fictício D: processo sigiloso com condenação provável.",
  E: "Derivado dos pedidos: pior classificação possível (texto fictício).",
  G: "Parecer fictício G: acordo quitado, provisão mantida em zero.",
  H: "Classificação definida manualmente, diferente da derivada dos pedidos. Justificativa fictícia: perícia desfavorável.",
  I: "Parecer fictício I: classificação registrada na aba de valores depois da avaliação dos pedidos.",
  A_LATER: "Parecer fictício registrado depois do fechamento, com vigência retroativa: não pode alterar a memória.",
};

const ids: Record<string, string> = {};
const numbers: Record<string, string> = {};
let companyB = "";
let companyC = "";

function cnj(i: number): string {
  return `${String(4_100_000 + i).padStart(7, "0")}-22.2025.5.02.0001`;
}

async function insertProcess(key: string, i: number, values: Partial<typeof legalProcesses.$inferInsert> = {}) {
  const number = cnj(i);
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      number,
      title: `Processo fictício ${key}`,
      court: "TRT-2",
      area: "labor",
      phase: "knowledge",
      filedAt: OLD,
      unitId: f.unitSp,
      ...values,
    })
    .returning({ id: legalProcesses.id });
  ids[key] = p.id;
  numbers[key] = number;
  return p.id;
}

async function officialRisk(
  processId: string,
  v: {
    classification: "remote" | "possible" | "probable";
    percentageBp: number;
    opinion: string;
    origin?: "manual" | "system";
    assessedBy?: AuthContext | null;
    reviewedBy: AuthContext;
    effectiveFrom?: string;
  },
): Promise<string> {
  const [r] = await f.db
    .insert(processRiskAssessments)
    .values({
      organizationId: f.orgA,
      processId,
      classification: v.classification,
      percentageBp: v.percentageBp,
      opinion: v.opinion,
      effectiveFrom: v.effectiveFrom ?? D(1),
      status: "official",
      origin: v.origin ?? "manual",
      assessedById: v.assessedBy === null ? null : (v.assessedBy ?? v.reviewedBy).userId,
      reviewedById: v.reviewedBy.userId,
      reviewedAt: new Date(),
    })
    .returning({ id: processRiskAssessments.id });
  return r.id;
}

async function link(processId: string, riskAssessmentId: string, kind: "derived" | "override") {
  await f.db.insert(processClaimRiskLinks).values({
    organizationId: f.orgA,
    processId,
    riskAssessmentId,
    kind,
    derivedClassification: "possible",
    derivedPercentageBp: 5000,
    basisFingerprint: `fp-${processId}`,
    createdById: f.ctx.lawyer.userId,
  });
}

function rowOf(memo: ProvisionMemo, key: string): ProvisionMemoRow {
  const r = memo.rows.find((x) => x.processId === ids[key]);
  if (!r) throw new Error(`row ${key} not listed`);
  return r;
}

async function pdfText(memo: ProvisionMemo): Promise<{ pages: string[]; text: string; bytes: Uint8Array }> {
  const { bytes } = await renderProvisionMemoPdf(memo);
  const pages = await pageTexts(bytes);
  return { pages, text: pages.join(" "), bytes };
}

type Sheets = { sheet: string; data: unknown[][] }[];
async function xlsx(memo: ProvisionMemo): Promise<{ sheets: Sheets; buffer: Buffer }> {
  const buffer = await buildProvisionMemoXlsx(memo);
  return { sheets: (await readXlsxFile(buffer)) as Sheets, buffer };
}

/** "Memória" sheet: header row + data rows (until the "Soma" line). */
function memoTable(sheets: Sheets) {
  const data = sheets.find((s) => s.sheet === MEMO_SHEET)!.data;
  const h = data.findIndex((r) => r[0] === "Processo (CNJ)");
  const header = data[h] as string[];
  const rows = data.slice(h + 1).filter((r) => typeof r[0] === "string" && /^\d{7}-/.test(r[0] as string));
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`column ${name}`);
    return i;
  };
  return { header, rows, col, data, h };
}

const cents = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));

function allStrings(sheets: Sheets): string[] {
  return sheets.flatMap((s) => s.data.flatMap((r) => r.filter((c): c is string => typeof c === "string")));
}

/** Text of the row of `number` in section 4 of the PDF (from its number to the next row's number). */
function section4Segments(text: string, memo: ProvisionMemo): Map<string, string> {
  const start = text.indexOf("Memória por processo");
  const end = text.indexOf("Classificação, parecer e responsável", start);
  const body = text.slice(start, end);
  const out = new Map<string, string>();
  memo.rows.forEach((r, i) => {
    const from = body.indexOf(r.number);
    const next = memo.rows[i + 1];
    const to = next ? body.indexOf(next.number, from + 1) : body.length;
    out.set(r.number, body.slice(from, to));
  });
  return out;
}

const samples = process.env.PROVISION_MEMO_SAMPLE_OUT;
async function saveSample(name: string, bytes: Uint8Array | Buffer) {
  if (!samples) return;
  await mkdir(samples, { recursive: true });
  await writeFile(path.join(samples, name), bytes);
}

let closedMemo: ProvisionMemo;

beforeAll(async () => {
  f = await setupFixture("pmemo");
  const m = f.ctx.manager;
  [{ id: companyB }, { id: companyC }] = await f.db
    .insert(companies)
    .values([
      { organizationId: f.orgA, name: "Comércio Fictício B S.A." },
      { organizationId: f.orgA, name: "Indústria Fictícia C Ltda." },
    ])
    .returning({ id: companies.id });

  // A: apurado − garantia, provável 100% pela advogada responsável.
  await insertProcess("A", 1, { companyId: f.companyA, responsibleId: f.ctx.lawyer.userId, claimAmountCents: 15_000_000 });
  await addValuation(m, { processId: ids.A, kind: "liquidated", amountCents: 10_000_000, baseDate: D(10), source: "manual" });
  await createGuarantee(m, ids.A, { kind: "judicial_deposit", amountCents: 2_000_000, depositedAt: D(5) });
  await addRiskAssessment(f.ctx.lawyer, ids.A, { classification: "probable", percentage: 100, opinion: OP.A, effectiveFrom: D(2) });

  // B: só valor da causa, sugestão por regra aprovada (origem sistema, conferida pelo gestor), garantia não abatida.
  await insertProcess("B", 2, { companyId: companyB, lawFirmId: f.lawFirmA, claimAmountCents: 5_000_000 });
  await createGuarantee(m, ids.B, { kind: "appeal_deposit", amountCents: 500_000, depositedAt: D(3) });
  await officialRisk(ids.B, { classification: "possible", percentageBp: 5000, opinion: OP.B, origin: "system", assessedBy: null, reviewedBy: m });

  // C: unidade RE, sem classificação.
  await insertProcess("C", 3, { unitId: f.unitRe, claimAmountCents: 3_000_000 });

  // D: sigiloso.
  await insertProcess("D", 4, { companyId: f.companyA, isConfidential: true });
  await addValuation(m, { processId: ids.D, kind: "liquidated", amountCents: 4_000_000, baseDate: D(8), source: "manual" });
  await addRiskAssessment(m, ids.D, { classification: "probable", percentage: 100, opinion: OP.D, effectiveFrom: D(2) });

  // E: derivada dos pedidos.
  await insertProcess("E", 5, { companyId: companyC });
  await addValuation(m, { processId: ids.E, kind: "liquidated", amountCents: 1_000_000, baseDate: D(9), source: "manual" });
  await link(
    ids.E,
    await officialRisk(ids.E, { classification: "possible", percentageBp: 5000, opinion: OP.E, origin: "system", reviewedBy: f.ctx.lawyer }),
    "derived",
  );

  // F: classificação só no cadastro.
  await insertProcess("F", 6, { companyId: companyB, lossProbability: "possible", riskPercentageBp: 5000, claimAmountCents: 2_000_000 });

  // G: quitação (apurado zero).
  await insertProcess("G", 7, { companyId: f.companyA, claimAmountCents: 800_000 });
  await registerExtinction(m, ids.G, { baseDate: D(12) });
  await addRiskAssessment(m, ids.G, { classification: "probable", percentage: 100, opinion: OP.G, effectiveFrom: D(2) });

  // H: definida manualmente contra a derivada dos pedidos.
  await insertProcess("H", 8, { companyId: companyC });
  await addValuation(m, { processId: ids.H, kind: "liquidated", amountCents: 6_000_000, baseDate: D(11), source: "manual" });
  await link(ids.H, await officialRisk(ids.H, { classification: "possible", percentageBp: 3000, opinion: OP.H, reviewedBy: m }), "override");

  // I: registrada na aba de valores depois de uma avaliação de pedido.
  await insertProcess("I", 9, { companyId: companyC, claimAmountCents: 1_234_567 });
  const [claim] = await f.db
    .insert(processClaims)
    .values({ organizationId: f.orgA, processId: ids.I, description: "Pedido fictício de horas extras", claimedAmountCents: 1_234_567 })
    .returning({ id: processClaims.id });
  await f.db.insert(processClaimAssessments).values({
    organizationId: f.orgA,
    claimId: claim.id,
    processId: ids.I,
    classification: "possible",
    percentageBp: 5000,
    baseAmountCents: 1_234_567,
    opinion: "Avaliação fictícia do pedido.",
    effectiveFrom: D(1),
    assessedById: m.userId!,
  });
  await new Promise((r) => setTimeout(r, 5));
  await addRiskAssessment(m, ids.I, { classification: "possible", percentage: 40, opinion: OP.I, effectiveFrom: D(3) });

  // Carteira adicional (só para a amostra ter tabelas de várias páginas).
  const classes = ["remote", "possible", "probable"] as const;
  const pct = { remote: 0, possible: 5000, probable: 10000 };
  const companyIds = [f.companyA, companyB, companyC];
  for (let k = 1; k <= 24; k++) {
    const id = await insertProcess(`X${k}`, 100 + k, {
      unitId: k % 4 === 0 ? f.unitRe : f.unitSp,
      companyId: k % 5 === 0 ? null : companyIds[k % 3],
      claimAmountCents: 1_500_000 + k * 137_011,
      liquidatedAmountCents: k % 2 === 0 ? 900_000 + k * 53_317 : null,
    });
    const c = classes[k % 3];
    await officialRisk(id, {
      classification: c,
      percentageBp: pct[c],
      opinion: `Parecer fictício X${k}: provas e andamento analisados pelo responsável; classificação ${c === "remote" ? "remota" : c === "possible" ? "possível" : "provável"}.`,
      reviewedBy: k % 2 ? f.ctx.lawyer : m,
    });
  }

  await generateSnapshot(f.ctx.accountant, previous);
}, 240_000);

afterAll(async () => {
  await f?.teardown();
});

describe("memória de cálculo da provisão: prévia", () => {
  it("labels a preview as 'Prévia, sujeita a alteração' in the PDF (every page) and in the XLSX", async () => {
    const memo = await getProvisionMemo(f.ctx.admin, previous, { now: NOW });
    expect(memo.status).toBe("preview");
    expect(memo.referenceDate).toBe(ref);
    const { pages, bytes } = await pdfText(memo);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((p, i) => {
      expect(p).toContain(`Página ${i + 1} de ${pages.length}`);
      expect(p).toContain("Prévia, sujeita a alteração");
      expect(p).toContain(`Data-base ${ref.split("-").reverse().join("/")}`);
    });
    expect(pages[0]).toContain("a partir da prévia da competência");
    const { sheets, buffer } = await xlsx(memo);
    expect(sheets.map((s) => s.sheet)).toEqual([MEMO_SHEET, TOTALS_SHEET]);
    expect(allStrings(sheets).some((s) => s.includes("PRÉVIA, SUJEITA A ALTERAÇÃO"))).toBe(true);
    await saveSample(`memoria-provisao-${previous}-previa.pdf`, bytes);
    await saveSample(`memoria-provisao-${previous}-previa.xlsx`, buffer);
  });
});

describe("memória de cálculo da provisão: competência fechada", () => {
  it("closes with justification and reads every row from the stored items", async () => {
    await closeSnapshot(f.ctx.accountant, previous, { justification: JUSTIFICATION });
    closedMemo = await getProvisionMemo(f.ctx.admin, previous, { now: NOW });
    expect(closedMemo.status).toBe("closed");
    expect(closedMemo.scope).toBe("all");
    expect(closedMemo.rows).toHaveLength(9 + 24);

    const [s] = await f.db.select().from(portfolioSnapshots).where(and(eq(portfolioSnapshots.organizationId, f.orgA), eq(portfolioSnapshots.period, previous)));
    const items = await f.db.select().from(portfolioSnapshotItems).where(eq(portfolioSnapshotItems.snapshotId, s.id));
    const byId = new Map(items.map((i) => [i.processId, i]));
    for (const r of closedMemo.rows) {
      const i = byId.get(r.processId)!;
      expect(r.number).toBe(i.number);
      expect(r.claimAmountCents).toBe(i.claimAmountCents);
      expect(r.liquidatedAmountCents).toBe(i.liquidatedAmountCents);
      expect(r.guaranteesCents).toBe(i.guaranteesCents);
      expect(r.classification).toBe(i.classification);
      expect(r.percentageBp).toBe(i.percentageBp);
      expect(r.provisionCents).toBe(i.provisionCents);
      expect(r.provisionIsEstimate).toBe(i.provisionIsEstimate);
    }
    // Same totals as the provision page (stored metrics).
    const view = await getSnapshot(f.ctx.admin, previous);
    expect(closedMemo.totals.overall.count).toBe(view!.totals.count);
    expect(closedMemo.totals.overall.provisionCents).toBe(view!.totals.provisionCents);
    expect(closedMemo.totals.overall.provisionEstimateCents).toBe(view!.totals.provisionEstimateCents);
    for (const { key, bucket } of view!.byClassification) {
      const line = closedMemo.totals.byClassification.find((l) => l.key === key)!;
      expect([line.count, line.provisionCents, line.provisionEstimateCents]).toEqual([bucket.count, bucket.provisionCents, bucket.provisionEstimateCents]);
    }

    // Override of the close: justification, who, and the unclassified processes (C and F).
    expect(closedMemo.override?.reason).toBe(JUSTIFICATION.trim());
    expect(closedMemo.override?.closedByName).toBe("Clara Contadora");
    expect(closedMemo.override?.items.map((i) => i.number).sort()).toEqual([numbers.C, numbers.F].sort());
    expect(rowOf(closedMemo, "C").inCloseOverride).toBe(true);
    expect(rowOf(closedMemo, "F").inCloseOverride).toBe(true);
    expect(rowOf(closedMemo, "A").inCloseOverride).toBe(false);
  });

  it("explains each row: base kind, guarantees, classification source, parecer and responsible", () => {
    const a = rowOf(closedMemo, "A");
    expect(a).toMatchObject({
      companyName: "Empresa Fictícia A Ltda.",
      baseKind: "net_liquidated",
      baseCents: 8_000_000,
      guaranteesDeductedCents: 2_000_000,
      classification: "probable",
      percentageBp: 10000,
      provisionOfficialCents: 8_000_000,
      provisionEstimateCents: null,
      classificationSource: "manual",
      opinion: OP.A,
      assessedByName: "Laura Advogada SP",
      reviewedByName: "Laura Advogada SP",
      classificationEffectiveFrom: D(2),
    });
    expect(rowOf(closedMemo, "B")).toMatchObject({
      baseKind: "claim",
      baseCents: 5_000_000,
      guaranteesDeductedCents: null,
      guaranteesCents: 500_000,
      provisionOfficialCents: null,
      provisionEstimateCents: 2_500_000,
      classificationSource: "rule_suggestion",
      opinion: OP.B,
      assessedByName: null,
      reviewedByName: "Gustavo Gestor",
    });
    expect(rowOf(closedMemo, "C")).toMatchObject({
      classification: null,
      provisionCents: null,
      provisionOfficialCents: null,
      provisionEstimateCents: null,
      classificationSource: "unclassified",
      opinion: null,
      companyName: null,
    });
    expect(rowOf(closedMemo, "E")).toMatchObject({ classificationSource: "claims_derived", provisionOfficialCents: 500_000, opinion: OP.E });
    expect(rowOf(closedMemo, "F")).toMatchObject({
      classification: "possible",
      classificationSource: "record",
      opinion: null,
      assessedByName: null,
      provisionEstimateCents: 1_000_000,
    });
    expect(rowOf(closedMemo, "G")).toMatchObject({ liquidatedAmountCents: 0, provisionOfficialCents: 0, provisionCents: 0 });
    expect(rowOf(closedMemo, "H")).toMatchObject({ classificationSource: "claims_override", percentageBp: 3000, provisionOfficialCents: 1_800_000 });
    expect(rowOf(closedMemo, "I")).toMatchObject({
      classificationSource: "outside_panel",
      baseKind: "claim",
      provisionEstimateCents: 493_827,
      opinion: OP.I,
    });
  });

  it("never sums valor da causa with valor apurado, never shows null as zero, and labels estimates", async () => {
    const { text, pages } = await pdfText(closedMemo);
    const { sheets } = await xlsx(closedMemo);
    const t = memoTable(sheets);
    const xrow = (key: string) => t.rows.find((r) => r[t.col("Processo (CNJ)")] === numbers[key])!;

    // A: causa 150.000 and apurado 100.000 side by side; base = apurado − garantias, never causa + apurado.
    const a = xrow("A");
    expect(cents(a[t.col("Valor da causa (R$)")])).toBe(15_000_000);
    expect(cents(a[t.col("Valor apurado (R$)")])).toBe(10_000_000);
    expect(cents(a[t.col("Base aplicável (R$)")])).toBe(8_000_000);
    const forbidden = [memoMoney(15_000_000 + 10_000_000), memoMoney(15_000_000 + 8_000_000)];
    const totals = closedMemo.totals.overall;
    forbidden.push(memoMoney(totals.provisionCents + totals.provisionEstimateCents));
    const listed = closedMemo.listedTotals;
    forbidden.push(memoMoney(listed.provisionCents + listed.provisionEstimateCents));
    for (const money of forbidden) {
      expect(text).not.toContain(money);
      expect(allStrings(sheets).join(" ")).not.toContain(money);
    }
    const allNumbers = sheets.flatMap((s) => s.data.flatMap((r) => r.filter((c): c is number => typeof c === "number")));
    expect(allNumbers.map((n) => Math.round(n * 100))).not.toContain(totals.provisionCents + totals.provisionEstimateCents);
    expect(t.header.join("|")).not.toMatch(/provisão total|total geral/i);

    // C: null is not zero (empty cells in the XLSX, words in the PDF).
    const c = xrow("C");
    for (const col of ["Valor apurado (R$)", "Provisão apurada (R$)", "Provisão estimada (R$)", "Percentual"]) expect(c[t.col(col)]).toBeNull();
    const seg = section4Segments(text, closedMemo);
    expect(seg.get(numbers.C)).toContain("Não apurado");
    expect(seg.get(numbers.C)).toContain("Sem provisão");
    expect(seg.get(numbers.C)).not.toContain("R$ 0,00");
    // G: a real zero stays zero.
    expect(cents(xrow("G")[t.col("Valor apurado (R$)")])).toBe(0);
    expect(cents(xrow("G")[t.col("Provisão apurada (R$)")])).toBe(0);
    expect(seg.get(numbers.G)).toContain("R$ 0,00");

    // Estimates: own column, labeled base and the RN-07 caveat in both files.
    const b = xrow("B");
    expect(b[t.col("Base aplicável")]).toBe("Valor da causa (estimada)");
    expect(b[t.col("Provisão apurada (R$)")]).toBeNull();
    expect(cents(b[t.col("Provisão estimada (R$)")])).toBe(2_500_000);
    expect(b[t.col("Garantias abatidas (R$)")]).toBeNull();
    expect(seg.get(numbers.B)).toContain("estimada");
    expect(seg.get(numbers.B)).toContain(`Garantias ${memoMoney(500_000)} não abatidas`);
    expect(text).toContain("Valores estimados");
    expect(text).not.toMatch(/\b(RN|RF|TE)-\d/);
    expect(allStrings(sheets).some((s) => s.startsWith("Atenção: "))).toBe(true);
    // Closed: footer says where it came from and when, on every page; no preview label, no approval watermark.
    pages.forEach((p) => {
      expect(p).toContain("a partir do fechamento da competência");
      expect(p).not.toContain("Prévia, sujeita a alteração");
      expect(p).not.toContain("PENDENTE DE REVISÃO");
    });
    // pt-BR text without em/en dash.
    const dashes = new RegExp("[\\u2013\\u2014]");
    expect(allStrings(sheets).join(" ")).not.toMatch(dashes);
    expect(text).not.toMatch(dashes);
  });

  it("writes identical numbers in the XLSX and in the PDF", async () => {
    const { text, bytes } = await pdfText(closedMemo);
    const { sheets, buffer } = await xlsx(closedMemo);
    await saveSample(`memoria-provisao-${previous}.pdf`, bytes);
    await saveSample(`memoria-provisao-${previous}.xlsx`, buffer);

    const t = memoTable(sheets);
    expect(t.rows).toHaveLength(closedMemo.rows.length);
    const seg = section4Segments(text, closedMemo);
    closedMemo.rows.forEach((r, i) => {
      const x = t.rows[i];
      expect(x[t.col("Processo (CNJ)")]).toBe(r.number);
      expect(cents(x[t.col("Provisão apurada (R$)")])).toBe(r.provisionOfficialCents);
      expect(cents(x[t.col("Provisão estimada (R$)")])).toBe(r.provisionEstimateCents);
      expect(cents(x[t.col("Base aplicável (R$)")])).toBe(r.baseCents);
      const s = seg.get(r.number)!;
      if (r.provisionCents !== null) expect(s).toContain(memoMoney(r.provisionCents));
      if (r.baseCents !== null) expect(s).toContain(memoMoney(r.baseCents));
    });

    // Totals sheet = PDF totals = memo totals.
    const totalsData = sheets.find((s) => s.sheet === TOTALS_SHEET)!.data;
    const totalRows = totalsData.filter((r) => r[0] === "Total");
    expect(totalRows).toHaveLength(2);
    // The overall line has both kinds here, so the displayed amounts are the line's numbers.
    expect(totalsLineAmounts(closedMemo.totals.overall)).toEqual({
      officialCents: closedMemo.totals.overall.provisionCents,
      estimateCents: closedMemo.totals.overall.provisionEstimateCents,
    });
    for (const r of totalRows) {
      expect(r[1]).toBe(closedMemo.totals.overall.count);
      expect(cents(r[2])).toBe(closedMemo.totals.overall.provisionCents);
      expect(cents(r[3])).toBe(closedMemo.totals.overall.provisionEstimateCents);
    }
    for (const line of [...closedMemo.totals.byClassification, ...closedMemo.totals.byCompany]) {
      const x = totalsData.find((r) => r[0] === line.label)!;
      const shown = totalsLineAmounts(line);
      // A column without any value is empty (never a 0 that nobody recorded).
      expect([x[1], cents(x[2]), cents(x[3])]).toEqual([line.count, shown.officialCents, shown.estimateCents]);
      if (shown.officialCents !== null) expect(text).toContain(memoMoney(shown.officialCents));
      if (shown.estimateCents !== null) expect(text).toContain(memoMoney(shown.estimateCents));
    }
    expect(text).toContain(memoMoney(closedMemo.totals.overall.provisionCents));
    expect(text).toContain(memoMoney(closedMemo.totals.overall.provisionEstimateCents));
    const soma = t.data.find((r) => typeof r[0] === "string" && (r[0] as string).startsWith("Soma dos"))!;
    expect(cents(soma[t.col("Provisão apurada (R$)")])).toBe(closedMemo.listedTotals.provisionCents);
    expect(cents(soma[t.col("Provisão estimada (R$)")])).toBe(closedMemo.listedTotals.provisionEstimateCents);
    // "Não classificado" (only C: F keeps its record-only class) has no provision value at all: no R$ 0,00 in either file.
    const unclassified = closedMemo.totals.byClassification.find((l) => l.key === "unclassified")!;
    expect(unclassified.count).toBe(unclassified.withoutProvisionCount);
    const xu = totalsData.find((r) => r[0] === unclassified.label)!;
    expect([xu[2], xu[3]]).toEqual([null, null]);
    const sec2 = text.slice(text.indexOf("Totais por classificação"), text.indexOf("Totais por empresa"));
    const uSeg = sec2.slice(sec2.indexOf(unclassified.label), sec2.indexOf("Total ", sec2.indexOf(unclassified.label)));
    expect(uSeg).toContain("Sem provisão");
    expect(uSeg).not.toContain("R$");
    // The close justification is in both files.
    expect(text).toContain(JUSTIFICATION.trim().slice(0, 40));
    expect(allStrings(sheets)).toContain(JUSTIFICATION.trim());
  });

  it("does not change when current data changes after the close (RN-10)", async () => {
    const m = f.ctx.manager;
    // Backdated official values and classifications, a new guarantee and a new company: a recalculation would differ.
    await addValuation(m, { processId: ids.B, kind: "liquidated", amountCents: 7_000_000, baseDate: D(20), source: "manual" });
    await addRiskAssessment(m, ids.C, { classification: "probable", percentage: 100, opinion: "Classificação fictícia retroativa.", effectiveFrom: D(1) });
    await addRiskAssessment(m, ids.A, { classification: "remote", percentage: 0, opinion: OP.A_LATER, effectiveFrom: D(15) });
    await createGuarantee(m, ids.H, { kind: "judicial_deposit", amountCents: 1_000_000, depositedAt: D(4) });
    await f.db.update(legalProcesses).set({ companyId: companyB }).where(eq(legalProcesses.id, ids.A));

    const after = await getProvisionMemo(f.ctx.admin, previous, { now: NOW });
    expect(after).toEqual(closedMemo);
    const { text } = await pdfText(after);
    expect(text).not.toContain(OP.A_LATER.slice(0, 40));

    // The changes are real: the current month's preview sees them.
    await generateSnapshot(f.ctx.accountant, current);
    const live = await getProvisionMemo(f.ctx.admin, current);
    expect(rowOf(live, "B")).toMatchObject({ baseKind: "net_liquidated", liquidatedAmountCents: 7_000_000 });
    expect(rowOf(live, "C").classification).toBe("probable");
    expect(rowOf(live, "A")).toMatchObject({ classification: "remote", opinion: OP.A_LATER, companyName: "Comércio Fictício B S.A." });
  });
});

describe("memória de cálculo da provisão: visibilidade", () => {
  it("accountant: rows without the confidential process, organization totals with the 'inclui N sigilosos' note", async () => {
    const memo = await getProvisionMemo(f.ctx.accountant, previous, { now: NOW });
    expect(memo.scope).toBe("org_wide");
    expect(memo.rows.map((r) => r.processId)).not.toContain(ids.D);
    expect(memo.rows).toHaveLength(closedMemo.rows.length - 1);
    expect(memo.totals.hiddenCount).toBe(1);
    expect(memo.totals.overall).toEqual(closedMemo.totals.overall);
    expect(memo.listedTotals.provisionCents).toBe(closedMemo.listedTotals.provisionCents - 4_000_000);
    const { text } = await pdfText(memo);
    expect(text).not.toContain(numbers.D);
    expect(text).not.toContain(OP.D.slice(0, 30));
    expect(text).toContain("incluem 1 processo(s) sigiloso(s) não listado(s)");
    const { sheets } = await xlsx(memo);
    expect(allStrings(sheets).join(" ")).not.toContain(numbers.D);
    expect(allStrings(sheets).some((s) => s.includes("1 processo(s) sigiloso(s) não listado(s)"))).toBe(true);
  });

  it("unit lawyer, executive and external counsel: only visible rows and totals of the listed rows", async () => {
    const lawyer = await getProvisionMemo(f.ctx.lawyer, previous, { now: NOW });
    expect(lawyer.scope).toBe("visible");
    const listed = new Set(lawyer.rows.map((r) => r.processId));
    for (const k of ["A", "B", "E", "F", "G", "H", "I"]) expect(listed.has(ids[k])).toBe(true);
    for (const k of ["C", "D"]) expect(listed.has(ids[k])).toBe(false);
    expect(lawyer.totals.hiddenCount).toBe(0);
    expect(lawyer.totals.overall.count).toBe(lawyer.rows.length);
    expect(lawyer.totals.overall.provisionCents).toBe(lawyer.listedTotals.provisionCents);
    expect(lawyer.scopeNote).toBe("Totais calculados somente sobre os processos que você pode ver.");
    // The override lists only what the lawyer may see (F; C is in unit RE).
    expect(lawyer.override?.items.map((i) => i.number)).toEqual([numbers.F]);
    expect(lawyer.override?.count).toBe(1);
    const { text } = await pdfText(lawyer);
    expect(text).not.toContain(numbers.C);
    expect(text).not.toContain("sigiloso(s) não listado(s)");

    const executive = await getProvisionMemo(f.ctx.executive, previous, { now: NOW });
    expect(executive.scope).toBe("visible");
    expect(executive.rows.map((r) => r.processId)).not.toContain(ids.D);
    expect(executive.totals.overall.count).toBe(executive.rows.length);
    expect(executive.scopeNote).toContain("exceto processos sigilosos");

    const counsel = await getProvisionMemo(f.ctx.externalCounsel, previous, { now: NOW });
    expect(counsel.rows.map((r) => r.number)).toEqual([numbers.B]);
    expect(counsel.totals.overall.provisionEstimateCents).toBe(2_500_000);
    expect(counsel.override?.reason).toBeNull();
    expect(counsel.override?.items).toEqual([]);
    const { text: counselText } = await pdfText(counsel);
    expect(counselText).not.toContain(JUSTIFICATION.trim().slice(0, 30));
  });

  it("another organization and a competência never calculated are not found; bad input is refused", async () => {
    await expect(getProvisionMemo(f.ctx.adminB, previous)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProvisionMemo(f.ctx.admin, "2020-01")).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProvisionMemo(f.ctx.admin, "2026-13")).rejects.toBeInstanceOf(ValidationError);
    await expect(exportProvisionMemo(f.ctx.admin, previous, "docx")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("GET /api/provision-memo/[period]", () => {
  const request = (period: string, query: string) =>
    [
      { nextUrl: new URL(`http://localhost/api/provision-memo/${period}?${query}`) } as unknown as NextRequest,
      { params: Promise.resolve({ period }) },
    ] as const;

  it("requires a session and validates the format", async () => {
    session.current = null;
    expect((await GET(...request(previous, "formato=pdf"))).status).toBe(401);
    session.current = f.ctx.manager;
    const bad = await GET(...request(previous, "formato=docx"));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Formato inválido");
    session.current = f.ctx.adminB;
    expect((await GET(...request(previous, "formato=pdf"))).status).toBe(404);
  });

  it("downloads the PDF and the XLSX and audits each download without content", async () => {
    session.current = f.ctx.manager;
    const before = (await f.db.select().from(auditLogs).where(eq(auditLogs.action, "provision_memo.export"))).length;

    const pdf = await GET(...request(previous, "formato=pdf"));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain(`memoria-provisao-${previous}.pdf`);
    const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe("%PDF-");

    const x = await GET(...request(previous, "formato=xlsx"));
    expect(x.status).toBe(200);
    expect(x.headers.get("content-type")).toContain("spreadsheetml");
    const xBytes = new Uint8Array(await x.arrayBuffer());
    expect(String.fromCharCode(xBytes[0], xBytes[1])).toBe("PK");

    const audits = await f.db.select().from(auditLogs).where(eq(auditLogs.action, "provision_memo.export"));
    expect(audits).toHaveLength(before + 2);
    const last = audits.slice(-2);
    expect(last.map((a) => (a.metadata as { format: string }).format).sort()).toEqual(["pdf", "xlsx"]);
    for (const a of last) {
      expect(a.entityType).toBe("snapshot");
      expect(a.actorId).toBe(f.ctx.manager.userId);
      expect((a.metadata as { status: string }).status).toBe("closed");
      const serialized = JSON.stringify(a);
      expect(serialized).not.toContain(OP.A.slice(0, 30));
      expect(serialized).not.toContain(numbers.A);
      expect(serialized).not.toContain("Empresa Fictícia");
    }
  });
});
