/**
 * P1.9: the monthly close is blocked while processes active on the reference
 * date have no OFFICIAL risk classification in force on it (PGlite).
 *
 * Scenario (organization A, competência = previous month, reference date =
 * its last day):
 *   A  classified (official, in force on the reference date)   -> not listed
 *   B  no classification                                        -> listed (later classified: stale preview)
 *   C  official classification only from the current month      -> listed, "classifiedFrom"
 *   D  closed before the reference date                         -> excluded
 *   E  archived before the reference date                       -> excluded
 *   F  archived AFTER the reference date (in the competência)   -> listed
 *   G  confidential, no classification                          -> listed org-wide, hidden from the accountant
 *   H  classification only on the process record (no opinion)  -> listed, "recordOnly"
 *   I  only a rule suggestion (proposed)                        -> listed, "pendingProposal"
 *   J  soft-deleted                                             -> excluded
 *   K  filed after the reference date                           -> excluded
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { periodReferenceDate, previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { listAlerts } from "@/modules/alerts/service";
import { CLOSE_BLOCKED_ALERT_TYPE } from "@/modules/contingency/close-gate";
import { periodOf } from "@/modules/contingency/rules";
import {
  CloseBlockedError,
  closeSnapshot,
  generateSnapshot,
  getCloseGate,
  getSnapshot,
  getSnapshotStatus,
  refreshCloseGateAlerts,
} from "@/modules/contingency/snapshot-service";
import type { AuthContext } from "@/server/auth/context";
import {
  alerts,
  auditLogs,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processRiskAssessments,
  scheduledRoutines,
  snapshotCloseOverrides,
} from "@/server/db/schema";
import { ConflictError, ValidationError } from "@/server/lib/errors";
import { ensureDefaultRoutines, runRoutine } from "@/server/jobs/routines";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let f: Fixture;
const today = todayISO();
const current = periodOf(today);
const previous = previousPeriod(current);
const ref = periodReferenceDate(previous);
const OLD = "2025-01-10";
const JUSTIFICATION = "  Carteira importada em revisão pelo jurídico; classificação concluída na próxima competência.  ";

const N = (i: number) => `${String(3_000_000 + i).padStart(7, "0")}-11.2025.5.10.0009`;
const ids: Record<string, string> = {};
let snapshotId = "";

async function insertProcess(key: string, i: number, values: Partial<typeof legalProcesses.$inferInsert> = {}) {
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      number: N(i),
      title: `Processo fictício ${key}`,
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      filedAt: OLD,
      claimAmountCents: 1_000_000,
      ...values,
    })
    .returning({ id: legalProcesses.id });
  ids[key] = p.id;
}

async function assess(
  processId: string,
  effectiveFrom: string,
  status: "official" | "proposed" = "official",
  organizationId = f.orgA,
  by: AuthContext = f.ctx.admin,
) {
  await f.db.insert(processRiskAssessments).values({
    organizationId,
    processId,
    classification: "possible",
    percentageBp: 5000,
    opinion: "Parecer fictício de teste.",
    effectiveFrom,
    status,
    origin: status === "proposed" ? "system" : "manual",
    assessedById: by.userId,
    reviewedById: status === "official" ? by.userId : null,
    reviewedAt: status === "official" ? new Date() : null,
  });
}

async function expectError<T extends Error>(p: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected ${type.name}`);
}

const numbersOf = (keys: string[]) => keys.map((k) => N(KEY_INDEX[k])).sort();
const KEY_INDEX: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10, K: 11 };

beforeAll(async () => {
  f = await setupFixture("closegate");
  await insertProcess("A", 1, { unitId: f.unitSp });
  await insertProcess("B", 2, { unitId: f.unitSp, responsibleId: f.ctx.lawyer.userId });
  await insertProcess("C", 3, { unitId: f.unitSp });
  await insertProcess("D", 4, { unitId: f.unitSp, status: "closed", closedAt: `${previous}-05` });
  await insertProcess("E", 5, { unitId: f.unitSp, status: "archived", closedAt: `${previous}-15` });
  await insertProcess("F", 6, { unitId: f.unitRe, status: "archived", closedAt: `${current}-01` });
  await insertProcess("G", 7, { unitId: f.unitSp, isConfidential: true });
  await insertProcess("H", 8, { lossProbability: "possible", riskPercentageBp: 5000 });
  await insertProcess("I", 9, { unitId: f.unitRe });
  await insertProcess("J", 10, { unitId: f.unitSp, deletedAt: new Date() });
  await insertProcess("K", 11, { unitId: f.unitSp, filedAt: `${current}-02` });
  await assess(ids.A, `${previous}-01`);
  await assess(ids.C, `${current}-01`);
  await assess(ids.I, `${previous}-01`, "proposed");
  snapshotId = (await generateSnapshot(f.ctx.accountant, previous)).id;
});

afterAll(async () => {
  await f?.teardown();
});

describe("close gate: list of unclassified processes (preview)", () => {
  it("lists active processes without an official classification in force on the reference date", async () => {
    const gate = await getCloseGate(f.ctx.admin, previous);
    expect(gate.status).toBe("preview");
    expect(gate.referenceDate).toBe(ref);
    expect(gate.scope).toBe("all");
    expect(gate.items.map((i) => i.number)).toEqual(numbersOf(["B", "C", "F", "G", "H", "I"]));
    expect(gate.count).toBe(6);
    expect(gate.hiddenCount).toBe(0);
    expect(gate.isStale).toBe(false);
    expect(gate.staleness).toBeNull();
    expect(gate.canCloseWithoutJustification).toBe(false);

    const by = new Map(gate.items.map((i) => [i.processId, i]));
    expect(by.get(ids.B)?.responsibleName).toBe("Laura Advogada SP");
    expect(by.get(ids.B)?.title).toBe("Processo fictício B");
    expect(by.get(ids.C)?.classifiedFrom).toBe(`${current}-01`);
    expect(by.get(ids.H)?.recordOnly).toBe(true);
    expect(by.get(ids.B)?.recordOnly).toBe(false);
    expect(by.get(ids.I)?.pendingProposal).toBe(true);
    expect(by.get(ids.G)?.isConfidential).toBe(true);
    // Closed/archived before the reference date, deleted and filed afterwards: never listed.
    for (const k of ["A", "D", "E", "J", "K"]) expect(by.has(ids[k])).toBe(false);
  });

  it("names only visible processes: org-wide count for the accountant, own scope for a unit lawyer", async () => {
    const acc = await getCloseGate(f.ctx.accountant, previous);
    expect(acc.scope).toBe("org_wide");
    expect(acc.count).toBe(6);
    expect(acc.hiddenCount).toBe(1);
    expect(acc.items.map((i) => i.processId)).not.toContain(ids.G);
    expect(acc.canCloseWithoutJustification).toBe(false);

    const lawyer = await getCloseGate(f.ctx.lawyer, previous);
    expect(lawyer.scope).toBe("visible");
    expect(lawyer.items.map((i) => i.number)).toEqual(numbersOf(["B", "C", "H"]));
    expect(lawyer.count).toBe(3);
    expect(lawyer.hiddenCount).toBe(0);
    expect(lawyer.canCloseWithoutJustification).toBeNull();
  });
});

describe("close gate: closing", () => {
  it("blocks the close without justification, listing only what the closer may see", async () => {
    const err = await expectError(closeSnapshot(f.ctx.accountant, previous), CloseBlockedError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.unclassifiedCount).toBe(6);
    expect(err.hiddenCount).toBe(1);
    expect(err.unclassified.map((u) => u.number)).toEqual(numbersOf(["B", "C", "F", "H", "I"]));
    expect(err.message).toContain(N(2));
    expect(err.message).not.toContain(N(7));
    expect(err.message).toContain("1 sigiloso não listado");
    expect(err.message).not.toMatch(/ [—–] /);
    expect(await getSnapshotStatus(f.orgA, previous)).toBe("preview");
    expect(await f.db.select().from(snapshotCloseOverrides)).toHaveLength(0);
  });

  it("rejects a short justification", async () => {
    const err = await expectError(closeSnapshot(f.ctx.accountant, previous, { justification: "curta" }), ValidationError);
    expect(err.fieldErrors?.justification?.[0]).toContain("20 caracteres");
    expect(await getSnapshotStatus(f.orgA, previous)).toBe("preview");
  });

  it("refuses a preview calculated before a classification recorded afterwards, until it is recalculated", async () => {
    await assess(ids.B, `${previous}-20`);
    const err = await expectError(closeSnapshot(f.ctx.accountant, previous, { justification: JUSTIFICATION }), ConflictError);
    expect(err.message).toContain("Recalcule a prévia");
    const gate = await getCloseGate(f.ctx.accountant, previous);
    expect(gate.isStale).toBe(true);
    expect(gate.staleness).toEqual({ classified: 1, added: 0, removed: 0, changed: 0 });
    // A "visible"-scope viewer is told to recalculate, without org-wide counts.
    const lawyerGate = await getCloseGate(f.ctx.lawyer, previous);
    expect(lawyerGate.isStale).toBe(true);
    expect(lawyerGate.staleness).toBeNull();
    expect(gate.items.map((i) => i.processId)).not.toContain(ids.B);
    expect(gate.canCloseWithoutJustification).toBe(false);

    await generateSnapshot(f.ctx.accountant, previous);
    const fresh = await getCloseGate(f.ctx.accountant, previous);
    expect(fresh.isStale).toBe(false);
    expect(fresh.count).toBe(5);
  });

  it("the routine raises one alert per unclassified process of an open past competência and never closes", async () => {
    await ensureDefaultRoutines(f.orgA);
    const [routine] = await f.db
      .select({ id: scheduledRoutines.id })
      .from(scheduledRoutines)
      .where(and(eq(scheduledRoutines.organizationId, f.orgA), eq(scheduledRoutines.type, "monthly_snapshot")));
    const result = await runRoutine(routine.id);
    expect(result?.status).toContain("Nada foi fechado automaticamente");
    expect(await getSnapshotStatus(f.orgA, previous)).toBe("preview");
    expect(await getSnapshotStatus(f.orgA, current)).toBe("preview");

    const open = await f.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.organizationId, f.orgA), eq(alerts.type, CLOSE_BLOCKED_ALERT_TYPE), isNull(alerts.resolvedAt)));
    // Only the past competência counts (the current month's reference date has not passed).
    expect(open.map((a) => a.entityId).sort()).toEqual([ids.C, ids.F, ids.G, ids.H, ids.I].sort());
    expect(open.every((a) => a.entityType === "legal_process" && a.severity === "warning")).toBe(true);
    const h = open.find((a) => a.entityId === ids.H)!;
    expect(h.message).toContain(N(8));
    expect(h.message).not.toMatch(/ [—–] /);

    // Idempotent: a second run keeps the same open alerts.
    const again = await refreshCloseGateAlerts(f.orgA, today);
    expect(again.processCount).toBe(5);
    expect(again.resolved).toBe(0);

    // Alerts follow the process visibility (the confidential one is not shown to the accountant).
    const accAlerts = (await listAlerts(f.ctx.accountant, { limit: 200 })).filter((a) => a.type === CLOSE_BLOCKED_ALERT_TYPE);
    expect(accAlerts.map((a) => a.entityId)).not.toContain(ids.G);
    expect(accAlerts).toHaveLength(4);
  });

  it("closes with a justification and records the override (who, when, why, which processes) and the audit entry", async () => {
    const before = new Date();
    const result = await closeSnapshot(f.ctx.accountant, previous, { justification: JUSTIFICATION });
    expect(result.id).toBe(snapshotId);
    expect(result.override?.unclassifiedCount).toBe(5);
    expect(await getSnapshotStatus(f.orgA, previous)).toBe("closed");

    const rows = await f.db.select().from(snapshotCloseOverrides).where(eq(snapshotCloseOverrides.snapshotId, snapshotId));
    expect(rows).toHaveLength(1);
    const o = rows[0];
    expect(o.organizationId).toBe(f.orgA);
    expect(o.reason).toBe(JUSTIFICATION.trim());
    expect(o.closedById).toBe(f.ctx.accountant.userId);
    expect(o.unclassifiedCount).toBe(5);
    expect([...o.unclassifiedProcessIds].sort()).toEqual([ids.C, ids.F, ids.G, ids.H, ids.I].sort());
    expect(o.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    // The override lists only items of the closed competência.
    const closedIds = new Set(
      (await f.db.select({ id: portfolioSnapshotItems.processId }).from(portfolioSnapshotItems).where(eq(portfolioSnapshotItems.snapshotId, snapshotId))).map(
        (r) => r.id,
      ),
    );
    expect(o.unclassifiedProcessIds.every((id) => closedIds.has(id))).toBe(true);

    const [audit] = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "snapshot.close"), eq(auditLogs.entityId, snapshotId)));
    expect(audit.actorId).toBe(f.ctx.accountant.userId);
    expect(audit.summary).toContain("Fechada com justificativa: 5 processo(s)");
    expect(audit.metadata).toMatchObject({ closeOverrideId: o.id, unclassifiedCount: 5, justification: JUSTIFICATION.trim() });

    // The close resolves the alerts of the competência right away.
    const open = await f.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.organizationId, f.orgA), eq(alerts.type, CLOSE_BLOCKED_ALERT_TYPE), isNull(alerts.resolvedAt)));
    expect(open).toHaveLength(0);
  });

  it("shows the override on the closed competência, scoped to the viewer", async () => {
    const admin = await getCloseGate(f.ctx.admin, previous);
    expect(admin.status).toBe("closed");
    expect(admin.items).toHaveLength(0);
    expect(admin.override?.reason).toBe(JUSTIFICATION.trim());
    expect(admin.override?.closedByName).toBe("Clara Contadora");
    expect(admin.override?.count).toBe(5);
    expect(admin.override?.items.map((i) => i.number).sort()).toEqual(numbersOf(["C", "F", "G", "H", "I"]));

    const acc = await getCloseGate(f.ctx.accountant, previous);
    expect(acc.override?.count).toBe(5);
    expect(acc.override?.hiddenCount).toBe(1);
    expect(acc.override?.items.map((i) => i.processId)).not.toContain(ids.G);

    const lawyer = await getCloseGate(f.ctx.lawyer, previous);
    expect(lawyer.override?.count).toBe(2);
    expect(lawyer.override?.hiddenCount).toBe(0);
    expect(lawyer.override?.items.map((i) => i.number).sort()).toEqual(numbersOf(["C", "H"]));
  });

  it("the closed competência and its override are immutable", async () => {
    const itemsBefore = (await getSnapshot(f.ctx.admin, previous))!.items;
    await expectError(generateSnapshot(f.ctx.accountant, previous), ConflictError);
    await expectError(closeSnapshot(f.ctx.accountant, previous), ConflictError);
    await expectError(closeSnapshot(f.ctx.accountant, previous, { justification: JUSTIFICATION }), ConflictError);

    // A classification recorded after the close (in force on the reference date) changes nothing.
    await assess(ids.H, `${previous}-01`);
    const after = (await getSnapshot(f.ctx.admin, previous))!;
    expect(after.items).toEqual(itemsBefore);
    const gate = await getCloseGate(f.ctx.admin, previous);
    expect(gate.override?.count).toBe(5);
    expect(gate.isStale).toBe(false);
    expect(await f.db.select().from(snapshotCloseOverrides)).toHaveLength(1);

    // The database refuses a second override of the same competência and a short reason.
    await expect(
      f.db.insert(snapshotCloseOverrides).values({
        organizationId: f.orgA,
        snapshotId,
        reason: "Outra justificativa longa o bastante para passar.",
        unclassifiedProcessIds: [ids.C],
        unclassifiedCount: 1,
        closedById: f.ctx.admin.userId!,
      }),
    ).rejects.toThrow();
    const [other] = await f.db
      .select({ id: portfolioSnapshots.id })
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.organizationId, f.orgA), eq(portfolioSnapshots.period, current)));
    await expect(
      f.db.insert(snapshotCloseOverrides).values({
        organizationId: f.orgA,
        snapshotId: other.id,
        reason: "curta",
        unclassifiedProcessIds: [ids.C],
        unclassifiedCount: 1,
        closedById: f.ctx.admin.userId!,
      }),
    ).rejects.toThrow();
  });
});

describe("close gate: nothing pending", () => {
  it("closes normally (no override) when every active process is classified; a justification is then ignored", async () => {
    const [p] = await f.db
      .insert(legalProcesses)
      .values({
        organizationId: f.orgB,
        number: "3100001-11.2025.5.10.0009",
        title: "Processo fictício B1",
        court: "TRT-10",
        area: "labor",
        phase: "knowledge",
        filedAt: OLD,
      })
      .returning({ id: legalProcesses.id });
    await assess(p.id, `${previous}-01`, "official", f.orgB, f.ctx.adminB);
    await generateSnapshot(f.ctx.adminB, previous);
    const gate = await getCloseGate(f.ctx.adminB, previous);
    expect(gate.count).toBe(0);
    expect(gate.canCloseWithoutJustification).toBe(true);

    const result = await closeSnapshot(f.ctx.adminB, previous, { justification: JUSTIFICATION });
    expect(result.override).toBeNull();
    expect(await getSnapshotStatus(f.orgB, previous)).toBe("closed");
    const overrides = await f.db.select().from(snapshotCloseOverrides).where(eq(snapshotCloseOverrides.organizationId, f.orgB));
    expect(overrides).toHaveLength(0);
    expect((await getCloseGate(f.ctx.adminB, previous)).override).toBeNull();
  });
});
