/**
 * Fictional portfolio with two CLOSED competências (two months ago and last month) for the
 * "nulo não é zero" checks of the comparisons (provision report, exposure report, exports and
 * /contingencias/provisao). Amounts are in cents.
 *
 *   Q1 TRT2  provável, valor da causa 1.000.000; valor apurado 500.000 only this month
 *   Q2 TRT2  possível, valor da causa 600.000; never apurado (estimate only)
 *   Q3 TRT15 possível, filed last month; valor apurado 200.000 last month
 *   Q4 TRT3  without classification; valor apurado 400.000 since two months ago
 *   Q5 TRT3  provável, valor da causa 300.000; valor apurado 360.000 since last month
 *   Q6 TRT9  provável, filed this month; valor apurado 100.000 (no process of TRT9 before)
 *
 * Two months ago nothing classified had a valor apurado: the provision on the valor apurado did
 * not exist there ("Não apurada" / "Não calculada"), only estimates.
 */
import { previousPeriod } from "@/domain/contingency";
import { periodOf } from "@/modules/contingency/rules";
import type { Fixture } from "../helpers/fixtures";

export const JUSTIFICATION = "Carteira fictícia: processo sem classificação de risco mantido de propósito para o teste de comparação.";

export type ComparisonScenario = { current: string; last: string; before: string; ids: Record<string, string> };

export async function buildComparisonScenario(f: Fixture): Promise<ComparisonScenario> {
  const { todayISO } = await import("@/lib/format");
  const { legalProcesses } = await import("@/server/db/schema");
  const { addValuation } = await import("@/modules/contingency/service");
  const { addRiskAssessment } = await import("@/modules/contingency/risk-service");
  const { closeSnapshot, generateSnapshot } = await import("@/modules/contingency/snapshot-service");

  const today = todayISO();
  const current = periodOf(today);
  const last = previousPeriod(current);
  const before = previousPeriod(last);
  const ids: Record<string, string> = {};
  let seq = 0;
  const proc = async (key: string, court: string, filedAt: string) => {
    seq += 1;
    const [p] = await f.db
      .insert(legalProcesses)
      .values({
        organizationId: f.orgA,
        number: `${String(4_100_000 + seq * 7).padStart(7, "0")}-55.2025.5.02.0001`,
        title: `Reclamação trabalhista ${key} (fictícia, comparação)`,
        court,
        area: "labor",
        phase: "knowledge",
        instance: "first",
        city: "São Paulo",
        companyId: f.companyA,
        unitId: f.unitSp,
        filedAt,
      })
      .returning();
    ids[key] = p.id;
  };
  await proc("Q1", "TRT2", `${before}-01`);
  await proc("Q2", "TRT2", `${before}-01`);
  await proc("Q3", "TRT15", `${last}-10`);
  await proc("Q4", "TRT3", `${before}-01`);
  await proc("Q5", "TRT3", `${before}-01`);
  await proc("Q6", "TRT9", `${current}-01`);

  const m = f.ctx.manager;
  const value = (key: string, kind: "claim" | "liquidated", amountCents: number, baseDate: string) =>
    addValuation(m, { processId: ids[key], kind, amountCents, baseDate });
  await value("Q1", "claim", 1_000_000, `${before}-01`);
  await value("Q1", "liquidated", 500_000, `${current}-01`);
  await value("Q2", "claim", 600_000, `${before}-01`);
  await value("Q3", "liquidated", 200_000, `${last}-12`);
  await value("Q4", "liquidated", 400_000, `${before}-05`);
  await value("Q5", "claim", 300_000, `${before}-02`);
  await value("Q5", "liquidated", 360_000, `${last}-10`);
  await value("Q6", "liquidated", 100_000, `${current}-01`);

  const risk = (key: string, classification: "probable" | "possible", effectiveFrom: string) =>
    addRiskAssessment(m, ids[key], { classification, opinion: "Parecer fictício para o teste de comparação.", effectiveFrom });
  await risk("Q1", "probable", `${before}-01`);
  await risk("Q2", "possible", `${before}-01`);
  await risk("Q3", "possible", `${last}-10`);
  await risk("Q5", "probable", `${before}-01`);
  await risk("Q6", "probable", `${current}-01`);

  for (const period of [before, last]) {
    await generateSnapshot(m, period);
    await closeSnapshot(m, period, { justification: JUSTIFICATION });
  }
  return { current, last, before, ids };
}
