/**
 * P0.6 (deferred 19): the audit summaries of `snapshot.generate` / `snapshot.close`
 * carry org-wide provision totals, confidential processes included. Readers of the
 * audit trail without `snapshot:close` (the auditor) get them redacted when the
 * competência includes a confidential process (stored item flag, or a process made
 * confidential afterwards); the entries stay listed (action, actor, date).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { AUDIT_REDACTED_SUMMARY, exportAuditLogs, listAuditLogs } from "@/modules/admin/service";
import { periodOf } from "@/modules/contingency/rules";
import { closeSnapshot, generateSnapshot } from "@/modules/contingency/snapshot-service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { legalProcesses } from "@/server/db/schema";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
const previous = previousPeriod(periodOf(todayISO()));
const beforePrevious = previousPeriod(previous);
let plainSnapshot: string;
let confidentialSnapshot: string;
let plainProcess: string;

async function snapshotEntries(ctx: AuthContext, snapshotId: string) {
  const { items } = await listAuditLogs(ctx, { entityType: "snapshot", entityId: snapshotId, pageSize: 100 });
  return items;
}

beforeAll(async () => {
  f = await setupFixture("p06-snap");
  const { admin, accountant } = f.ctx;
  plainProcess = await makeProcess(admin, { title: "Processo comum (fictício)", claimAmountCents: 1_000_000 });
  // Competência without confidential processes.
  plainSnapshot = (await generateSnapshot(accountant, beforePrevious)).id;
  // A confidential process enters the portfolio; the next competência includes it.
  await makeProcess(admin, { title: "Processo sigiloso (fictício)", isConfidential: true, claimAmountCents: 9_000_000 });
  confidentialSnapshot = (await generateSnapshot(accountant, previous)).id;
  await closeSnapshot(accountant, previous, {
    justification: "Fechamento de teste com processos sem classificação oficial (fictício).",
  });
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

describe("snapshot audit entries for readers without snapshot:close", () => {
  it("the auditor (audit:read, no snapshot:close) sees generate/close of a competência with a confidential process redacted", async () => {
    const { auditor } = f.ctx;
    expect(can(auditor, "audit:read")).toBe(true);
    expect(can(auditor, "snapshot:close")).toBe(false);
    const entries = await snapshotEntries(auditor, confidentialSnapshot);
    expect(entries.map((e) => e.action).sort()).toEqual(["snapshot.close", "snapshot.generate"]);
    for (const e of entries) {
      expect(e.summary).toBe(AUDIT_REDACTED_SUMMARY);
      expect(e.summary).not.toMatch(/R\$/);
    }
    const exported = await exportAuditLogs(auditor, { entityType: "snapshot" });
    const closeRow = exported.items.find((e) => e.entityId === confidentialSnapshot && e.action === "snapshot.close");
    expect(closeRow?.summary).toBe(AUDIT_REDACTED_SUMMARY);
  });

  it("a competência without confidential processes keeps its summary", async () => {
    const [entry] = await snapshotEntries(f.ctx.auditor, plainSnapshot);
    expect(entry.action).toBe("snapshot.generate");
    expect(entry.summary).not.toBe(AUDIT_REDACTED_SUMMARY);
    expect(entry.summary).toMatch(/provisão R\$/);
  });

  it("the administrator sees every summary", async () => {
    const entries = await snapshotEntries(f.ctx.admin, confidentialSnapshot);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.summary).not.toBe(AUDIT_REDACTED_SUMMARY);
      expect(e.summary).toMatch(/provisão R\$/);
    }
  });

  it("a process made confidential after the calculation also hides the totals that include it", async () => {
    await f.db.update(legalProcesses).set({ isConfidential: true }).where(and(eq(legalProcesses.id, plainProcess), eq(legalProcesses.organizationId, f.orgA)));
    const [entry] = await snapshotEntries(f.ctx.auditor, plainSnapshot);
    expect(entry.summary).toBe(AUDIT_REDACTED_SUMMARY);
  });
});
