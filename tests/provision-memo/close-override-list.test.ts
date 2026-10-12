/**
 * P1.10: competência fechada com justificativa e MAIS de 500 processos sem
 * classificação (carteira legada importada). A memória lista todos na ressalva
 * (a tela de fechamento limita a 500), no XLSX e no PDF; colunas de totais sem
 * nenhum valor saem como "Sem provisão" / célula vazia, nunca R$ 0,00 (RN-03);
 * sugestão por regra aprovada depois da avaliação dos pedidos prevalece sobre a
 * derivação e o rótulo diz isso (PGlite).
 *
 * Carteira fictícia da organização A, competência = mês anterior:
 *   U0..U509  só valor da causa, sem classificação (U0 sigiloso)  -> ressalva do fechamento
 *   P         apurado 10.000, provável 100% (manual)              -> provisão apurada 10.000
 *   J         causa 2.000, pedido avaliado, depois sugestão por regra possível 50% -> estimada 1.000
 *
 * Com PROVISION_MEMO_SAMPLE_OUT=<pasta> grava o PDF e o XLSX para conferência visual.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readXlsxFile from "read-excel-file/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { periodOf } from "@/modules/contingency/rules";
import { addValuation } from "@/modules/contingency/service";
import { closeSnapshot, generateSnapshot, getCloseGate } from "@/modules/contingency/snapshot-service";
import {
  emptyTotalsLine,
  MEMO_CLASSIFICATION_SOURCE_LABELS,
  memoMoney,
  totalsLineAmounts,
  type ProvisionMemo,
  type ProvisionMemoOverride,
} from "@/modules/provision-memo/memo";
import { renderProvisionMemoPdf } from "@/modules/provision-memo/pdf";
import { getProvisionMemo } from "@/modules/provision-memo/service";
import { buildProvisionMemoXlsx, MEMO_SHEET, TOTALS_SHEET } from "@/modules/provision-memo/xlsx";
import type { AuthContext } from "@/server/auth/context";
import { legalProcesses, processClaimAssessments, processClaims, processRiskAssessments } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import { pageTexts } from "../legal-reports/pdf-inspect";

let f: Fixture;
const previous = previousPeriod(periodOf(todayISO()));
const D = (day: number) => `${previous}-${String(day).padStart(2, "0")}`;
const UNCLASSIFIED = 510;
const JUSTIFICATION = "Carteira legada importada sem classificação de risco; revisão em andamento pelo jurídico (fictício).";
const NOW = new Date("2026-10-12T17:03:00.000Z");
const unclassifiedNumber = (k: number) => `${String(4_300_000 + k).padStart(7, "0")}-33.2025.5.02.0001`;
const UNCLASSIFIED_RE = /43\d{5}-33\.2025\.5\.02\.0001/g;
const ids: Record<string, string> = {};

type Sheets = { sheet: string; data: unknown[][] }[];
const cents = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));

async function officialRisk(
  processId: string,
  v: { classification: "possible" | "probable"; percentageBp: number; origin: "manual" | "system"; reviewedBy: AuthContext },
) {
  await f.db.insert(processRiskAssessments).values({
    organizationId: f.orgA,
    processId,
    classification: v.classification,
    percentageBp: v.percentageBp,
    opinion: `Parecer fictício (${v.origin}).`,
    effectiveFrom: D(2),
    status: "official",
    origin: v.origin,
    assessedById: v.origin === "system" ? null : v.reviewedBy.userId,
    reviewedById: v.reviewedBy.userId,
    reviewedAt: new Date(),
  });
}

/** Everything of the ressalva except its list (the closing screen caps its list at 500). */
function overrideHeader(o: Omit<ProvisionMemoOverride, "items">) {
  return { reason: o.reason, createdAt: o.createdAt, closedByName: o.closedByName, count: o.count, hiddenCount: o.hiddenCount };
}

/** Distinct CNJ numbers of the unclassified portfolio in a text. */
function unclassifiedNumbersIn(text: string): Set<string> {
  return new Set(text.match(UNCLASSIFIED_RE) ?? []);
}

let adminMemo: ProvisionMemo;

const samples = process.env.PROVISION_MEMO_SAMPLE_OUT;
async function saveSample(name: string, bytes: Uint8Array | Buffer) {
  if (!samples) return;
  await mkdir(samples, { recursive: true });
  await writeFile(path.join(samples, name), bytes);
}

beforeAll(async () => {
  f = await setupFixture("pmemoovr");
  const m = f.ctx.manager;
  await f.db.insert(legalProcesses).values(
    Array.from({ length: UNCLASSIFIED }, (_, k) => ({
      organizationId: f.orgA,
      number: unclassifiedNumber(k),
      title: `Processo legado fictício ${k}`,
      court: "TRT-2",
      area: "labor" as const,
      phase: "knowledge" as const,
      filedAt: "2024-01-01",
      unitId: f.unitSp,
      isConfidential: k === 0,
      claimAmountCents: 100_000 + k,
    })),
  );

  const [p, j] = await f.db
    .insert(legalProcesses)
    .values(
      [
        ["P", "4399001-33.2025.5.02.0001", null],
        ["J", "4399002-33.2025.5.02.0001", 200_000],
      ].map(([key, number, claim]) => ({
        organizationId: f.orgA,
        number: number as string,
        title: `Processo fictício ${key}`,
        court: "TRT-2",
        area: "labor" as const,
        phase: "knowledge" as const,
        filedAt: "2024-01-01",
        unitId: f.unitSp,
        claimAmountCents: claim as number | null,
      })),
    )
    .returning({ id: legalProcesses.id });
  ids.P = p.id;
  ids.J = j.id;

  await addValuation(m, { processId: ids.P, kind: "liquidated", amountCents: 1_000_000, baseDate: D(3), source: "manual" });
  await officialRisk(ids.P, { classification: "probable", percentageBp: 10_000, origin: "manual", reviewedBy: m });

  // J: the claims were assessed first; an approved rule suggestion (system origin, no claims link) came later.
  const [claim] = await f.db
    .insert(processClaims)
    .values({ organizationId: f.orgA, processId: ids.J, description: "Pedido fictício de horas extras", claimedAmountCents: 200_000 })
    .returning({ id: processClaims.id });
  await f.db.insert(processClaimAssessments).values({
    organizationId: f.orgA,
    claimId: claim.id,
    processId: ids.J,
    classification: "probable",
    percentageBp: 10_000,
    baseAmountCents: 200_000,
    opinion: "Avaliação fictícia do pedido.",
    effectiveFrom: D(1),
    assessedById: m.userId!,
  });
  await new Promise((r) => setTimeout(r, 5));
  await officialRisk(ids.J, { classification: "possible", percentageBp: 5000, origin: "system", reviewedBy: m });

  await generateSnapshot(f.ctx.accountant, previous);
  await closeSnapshot(f.ctx.accountant, previous, { justification: JUSTIFICATION });
  adminMemo = await getProvisionMemo(f.ctx.admin, previous, { now: NOW });
}, 240_000);

afterAll(async () => {
  await f?.teardown();
});

describe("memória de cálculo: ressalva do fechamento com mais de 500 processos", () => {
  it("lists every unclassified process (not only the 500 of the closing screen), with the close gate's policy", async () => {
    const all = Array.from({ length: UNCLASSIFIED }, (_, k) => unclassifiedNumber(k)).sort();
    expect(adminMemo.status).toBe("closed");
    expect(adminMemo.rows).toHaveLength(UNCLASSIFIED + 2);
    const o = adminMemo.override!;
    expect(o.reason).toBe(JUSTIFICATION);
    expect(o.count).toBe(UNCLASSIFIED);
    expect(o.items).toHaveLength(UNCLASSIFIED);
    expect(o.items.map((i) => i.number)).toEqual(all);
    expect(o.items.map((i) => i.number)).toEqual(adminMemo.rows.filter((r) => r.inCloseOverride).map((r) => r.number));

    // Same justification, counts and author as the closing screen, which caps its own list at 500.
    const gate = await getCloseGate(f.ctx.admin, previous, { limit: 500 });
    expect(gate.override!.items).toHaveLength(500);
    expect(overrideHeader(o)).toEqual(overrideHeader(gate.override!));

    // Organization-wide viewer without the confidential process: 509 listed, 1 counted as hidden.
    const accountant = await getProvisionMemo(f.ctx.accountant, previous, { now: NOW });
    expect(accountant.scope).toBe("org_wide");
    expect(accountant.override!.count).toBe(UNCLASSIFIED);
    expect(accountant.override!.items).toHaveLength(UNCLASSIFIED - 1);
    expect(accountant.override!.hiddenCount).toBe(1);
    expect(accountant.override!.items.map((i) => i.number)).not.toContain(unclassifiedNumber(0));
    const accountantGate = await getCloseGate(f.ctx.accountant, previous, { limit: 500 });
    expect(overrideHeader(accountant.override!)).toEqual(overrideHeader(accountantGate.override!));
  });

  it("writes the complete list in the XLSX 'Totais' sheet and in section 6 of the PDF", async () => {
    const xlsxBuffer = await buildProvisionMemoXlsx(adminMemo);
    await saveSample(`memoria-provisao-${previous}-ressalva-${UNCLASSIFIED}.xlsx`, xlsxBuffer);
    const sheets = (await readXlsxFile(xlsxBuffer)) as Sheets;
    const totals = sheets.find((s) => s.sheet === TOTALS_SHEET)!.data;
    const section = totals.findIndex((r) => r[0] === "Fechamento com justificativa");
    expect(section).toBeGreaterThan(0);
    const listed = totals.slice(section).filter((r) => typeof r[0] === "string" && new RegExp(UNCLASSIFIED_RE.source).test(r[0] as string));
    expect(listed).toHaveLength(UNCLASSIFIED);
    expect(new Set(listed.map((r) => r[0])).size).toBe(UNCLASSIFIED);

    const { bytes } = await renderProvisionMemoPdf(adminMemo);
    await saveSample(`memoria-provisao-${previous}-ressalva-${UNCLASSIFIED}.pdf`, bytes);
    const pages = await pageTexts(bytes);
    const text = pages.join(" ");
    const section6 = text.slice(text.lastIndexOf("Fechamento com justificativa"));
    expect(section6).toContain(JUSTIFICATION.slice(0, 40));
    expect(unclassifiedNumbersIn(section6).size).toBe(UNCLASSIFIED);
  }, 120_000);
});

describe("memória de cálculo: totais sem valor e origem da classificação", () => {
  it("shows a totals column without any value as 'Sem provisão' (PDF) or an empty cell (XLSX), never R$ 0,00", async () => {
    const line = (key: string) => adminMemo.totals.byClassification.find((l) => l.key === key)!;
    expect(totalsLineAmounts(line("probable"))).toEqual({ officialCents: 1_000_000, estimateCents: null });
    expect(totalsLineAmounts(line("possible"))).toEqual({ officialCents: null, estimateCents: 100_000 });
    expect(totalsLineAmounts(line("remote"))).toEqual({ officialCents: null, estimateCents: null });
    expect(line("unclassified")).toMatchObject({ count: UNCLASSIFIED, withoutProvisionCount: UNCLASSIFIED });
    expect(totalsLineAmounts(line("unclassified"))).toEqual({ officialCents: null, estimateCents: null });
    // A recorded zero (e.g. a quitação) is a value: it stays R$ 0,00.
    const zero = { ...emptyTotalsLine("probable", "Provável"), count: 1 };
    expect(totalsLineAmounts(zero)).toEqual({ officialCents: 0, estimateCents: null });

    const sheets = (await readXlsxFile(await buildProvisionMemoXlsx(adminMemo))) as Sheets;
    const totals = sheets.find((s) => s.sheet === TOTALS_SHEET)!.data;
    const xrow = (label: string) => totals.find((r) => r[0] === label)!;
    expect([xrow("Provável")[1], cents(xrow("Provável")[2]), xrow("Provável")[3]]).toEqual([1, 1_000_000, null]);
    expect([xrow("Possível")[1], xrow("Possível")[2], cents(xrow("Possível")[3])]).toEqual([1, null, 100_000]);
    expect([xrow("Remota")[1], xrow("Remota")[2], xrow("Remota")[3]]).toEqual([0, null, null]);
    expect([xrow("Não classificado")[1], xrow("Não classificado")[2], xrow("Não classificado")[3], xrow("Não classificado")[5]]).toEqual([
      UNCLASSIFIED,
      null,
      null,
      UNCLASSIFIED,
    ]);
    // "Soma dos listados" of the Memória sheet: each column has a value here.
    const soma = sheets.find((s) => s.sheet === MEMO_SHEET)!.data.find((r) => String(r[0]).startsWith("Soma dos listados"))!;
    expect(soma.filter((c) => typeof c === "number").map(cents)).toEqual([1_000_000, 100_000]);

    const text = (await pageTexts((await renderProvisionMemoPdf(adminMemo)).bytes)).join(" ");
    const section2 = text.slice(text.indexOf("Totais por classificação"), text.indexOf("Totais por empresa"));
    expect(section2).not.toContain(memoMoney(0));
    const unclassifiedSeg = section2.slice(section2.indexOf("Não classificado"));
    expect(unclassifiedSeg).toMatch(new RegExp(`Não classificado ${UNCLASSIFIED} Sem provisão Sem provisão ${UNCLASSIFIED}`));
    expect(section2).toMatch(/Remota 0 Sem provisão Sem provisão 0/);
    expect(section2).toContain(memoMoney(1_000_000));
    expect(section2).toContain(memoMoney(100_000));
  }, 120_000);

  it("labels an approved rule suggestion recorded after the claims assessment as prevailing over the derivation", () => {
    const j = adminMemo.rows.find((r) => r.processId === ids.J)!;
    expect(j.classificationSource).toBe("rule_suggestion_outside_panel");
    expect(MEMO_CLASSIFICATION_SOURCE_LABELS[j.classificationSource]).toContain("prevalece sobre a derivação");
    expect(j).toMatchObject({ classification: "possible", percentageBp: 5000, provisionEstimateCents: 100_000, reviewedByName: "Gustavo Gestor" });
    const p = adminMemo.rows.find((r) => r.processId === ids.P)!;
    expect(p.classificationSource).toBe("manual");
  });
});
