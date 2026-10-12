/**
 * Closed competência regressions of the "contingency-reports" review group (PGlite):
 *  3. a process soft-deleted after the close stays in the snapshot views, CSV and
 *     reports (RN-10), for admin and for a lawyer of its unit, and is never counted
 *     as "sigiloso não listado";
 *  9. org-wide totals including confidential processes only for who books the
 *     provision (snapshot:close); executive and auditor get totals of listed items.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { periodOf } from "@/modules/contingency/rules";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { closeSnapshot, exportSnapshotCsv, generateSnapshot, getSnapshot, listSnapshots } from "@/modules/contingency/snapshot-service";
import {
  DELETED_AFTER_CLOSE_CAVEAT,
  getAuditLetterReport,
  getExposureReport,
  getProvisionReport,
} from "@/modules/reports/service";
import { legalProcesses } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
const current = periodOf(todayISO());
const previous = previousPeriod(current);
const NUMBERS = {
  unit: "2000001-44.2026.5.10.0004",
  re: "2000002-44.2026.5.10.0004",
  secret: "2000003-44.2026.5.10.0004",
};
let unitProc: string;
let reProc: string;
let secretProc: string;
let provisionCountBefore = 0;

async function insertProcess(values: Partial<typeof legalProcesses.$inferInsert> & { number: string }): Promise<string> {
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      title: `Processo fictício ${values.number}`,
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      ...values,
    })
    .returning({ id: legalProcesses.id });
  return p.id;
}

async function classify(processId: string, classification: "possible" | "probable"): Promise<void> {
  await addRiskAssessment(f.ctx.admin, processId, {
    classification,
    opinion: "Parecer fictício de teste para o fechamento mensal.",
    effectiveFrom: `${previous}-01`,
  });
}

beforeAll(async () => {
  f = await setupFixture("fixclose");
  unitProc = await insertProcess({ number: NUMBERS.unit, unitId: f.unitSp, claimAmountCents: 400_000, lossProbability: "possible" });
  reProc = await insertProcess({ number: NUMBERS.re, unitId: f.unitRe, claimAmountCents: 100_000, lossProbability: "possible" });
  secretProc = await insertProcess({ number: NUMBERS.secret, isConfidential: true, claimAmountCents: 900_000, lossProbability: "probable" });
  // P1.9 close gate: OFFICIAL classifications in force on the reference date (the record one does not count).
  await classify(unitProc, "possible");
  await classify(reProc, "possible");
  await classify(secretProc, "probable");
  await generateSnapshot(f.ctx.accountant, previous);
  const closed = await closeSnapshot(f.ctx.accountant, previous);
  if (closed.override) throw new Error("expected a close without reservation (every process classified)");
  provisionCountBefore = (await getProvisionReport(f.ctx.admin, { period: previous })).totals.processCount;
  // Soft delete after the close (deleteProcess / import rollback set deleted_at).
  await f.db.update(legalProcesses).set({ deletedAt: new Date() }).where(eq(legalProcesses.id, unitProc));
});

afterAll(async () => {
  await f?.teardown();
});

describe("finding 3 — closed competência after a soft delete (RN-10)", () => {
  it("snapshot views keep the deleted process, flagged, for admin and for a lawyer of its unit", async () => {
    const admin = (await getSnapshot(f.ctx.admin, previous))!;
    expect(admin.totals.count).toBe(3);
    expect(admin.itemsTotal).toBe(3);
    expect(admin.deletedCount).toBe(1);
    expect(admin.items.find((i) => i.processId === unitProc)?.processDeleted).toBe(true);
    expect(admin.items.find((i) => i.processId === reProc)?.processDeleted).toBe(false);

    const lawyer = (await getSnapshot(f.ctx.lawyer, previous))!;
    expect(lawyer.items.map((i) => i.processId)).toEqual([unitProc]);
    expect(lawyer.items[0].processDeleted).toBe(true);
    expect(lawyer.totals.count).toBe(1);
    const lawyerRe = (await getSnapshot(f.ctx.lawyerRe, previous))!;
    expect(lawyerRe.items.map((i) => i.processId)).toEqual([reProc]);

    // The deleted process is listed for the accountant: only the confidential one is hidden.
    const acc = (await getSnapshot(f.ctx.accountant, previous))!;
    expect(acc.items.some((i) => i.processId === unitProc)).toBe(true);
    expect(acc.hiddenCount).toBe(1);
    expect(acc.totals.count).toBe(acc.itemsTotal + acc.hiddenCount);
  });

  it("CSV keeps the row and explains it; the hidden note counts only confidential processes", async () => {
    const lawyerCsv = (await exportSnapshotCsv(f.ctx.lawyer, previous)).content;
    expect(lawyerCsv).toContain(NUMBERS.unit);
    expect(lawyerCsv).toContain("foram excluídos do sistema após o fechamento");
    const accCsv = (await exportSnapshotCsv(f.ctx.accountant, previous)).content;
    expect(accCsv).toContain(NUMBERS.unit);
    expect(accCsv).toContain("1 processo(s) sigiloso(s) não listado(s)");
    expect(accCsv).not.toContain(NUMBERS.secret);
  });

  it("provision, audit letter and exposure comparison read the closed items unchanged", async () => {
    const provision = await getProvisionReport(f.ctx.admin, { period: previous });
    expect(provision.totals.processCount).toBe(provisionCountBefore);
    expect(provision.totals.processCount).toBe(3);
    expect(provision.items.find((i) => i.processId === unitProc)?.deletedAfterClose).toBe(true);
    const lawyerProvision = await getProvisionReport(f.ctx.lawyer, { period: previous });
    expect(lawyerProvision.items.map((i) => i.processId)).toEqual([unitProc]);

    const letter = await getAuditLetterReport(f.ctx.admin, { period: previous });
    const row = letter.rows.find((r) => r.processId === unitProc)!;
    expect(row.deletedAfterClose).toBe(true);
    expect(row.caveats).toContain(DELETED_AFTER_CLOSE_CAVEAT);
    expect(letter.generalCaveats.some((c) => c.includes("excluído(s) do sistema após o fechamento"))).toBe(true);
    const lawyerLetter = await getAuditLetterReport(f.ctx.lawyer, { period: previous });
    expect(lawyerLetter.rows.map((r) => r.processId)).toEqual([unitProc]);
    const reLetter = await getAuditLetterReport(f.ctx.lawyerRe, { period: previous });
    expect(reLetter.rows.map((r) => r.processId)).toEqual([reProc]);

    const exposure = await getExposureReport(f.ctx.admin, { period: previous });
    expect(exposure.totals.previous?.processCount).toBe(3);
  });
});

describe("finding 9 — monthly-close totals by role", () => {
  it("accountant (books the provision) keeps org-wide totals with the hidden count", async () => {
    const acc = (await getSnapshot(f.ctx.accountant, previous))!;
    expect(acc.scope).toBe("org_wide");
    expect(acc.scopeNote).toBeNull();
    expect(acc.totals.count).toBe(3);
    expect(acc.byClassification.find((c) => c.key === "probable")?.bucket.count).toBe(1);
    expect((await listSnapshots(f.ctx.accountant)).find((s) => s.period === previous)?.totals?.count).toBe(3);
  });

  it("executive and auditor get totals, classification and comparison of the listed items only", async () => {
    await generateSnapshot(f.ctx.accountant, current);
    for (const ctx of [f.ctx.executive, f.ctx.auditor]) {
      const view = (await getSnapshot(ctx, previous))!;
      expect(view.scope).toBe("visible");
      expect(view.hiddenCount).toBe(0);
      expect(view.items.some((i) => i.processId === secretProc)).toBe(false);
      expect(view.totals.count).toBe(view.itemsTotal);
      expect(view.totals.claimCents).toBe(500_000); // 400.000 + 100.000, never the confidential 900.000
      expect(view.byClassification.find((c) => c.key === "probable")?.bucket.count).toBe(0);
      expect(view.scopeNote).toContain("exceto processos sigilosos");
      expect((await listSnapshots(ctx)).every((s) => s.totals === null)).toBe(true);

      const cur = (await getSnapshot(ctx, current))!;
      expect(cur.previous?.totals.count).toBe(2);
      expect(cur.variation?.count).toBe(cur.totals.count - 2);

      const csv = (await exportSnapshotCsv(ctx, previous)).content;
      expect(csv).not.toContain("sigiloso(s) não listado(s)");
      expect(csv).toContain("Totais dos processos listados");
      expect(csv).not.toContain(NUMBERS.secret);
    }
    const acc = (await getSnapshot(f.ctx.accountant, current))!;
    expect(acc.previous?.totals.count).toBe(3);
  });
});
