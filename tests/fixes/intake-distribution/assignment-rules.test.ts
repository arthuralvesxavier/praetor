/**
 * Review fixes (intake-distribution): who may assign / reassign, the law firm
 * following external counsel, the process row lock and the workload risk.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupFixture, type Fixture } from "../../helpers/fixtures";
import {
  applyManualAssignment,
  assignResponsible,
  getWorkload,
  reassignResponsible,
} from "@/modules/distribution/service";
import { buildSimulatedCnj } from "@/modules/intake/simulation";
import { assignIntakeManually, getIntake, registerIncomingProcess } from "@/modules/intake/service";
import type { RegisterIntakeInput } from "@/modules/intake/schemas";
import { createProcess, getProcess } from "@/modules/processes/service";
import type { CreateProcessInput } from "@/modules/processes/schemas";
import type { AuthContext } from "@/server/auth/context";
import { auditLogs, lawFirms, legalProcesses, organizations, users, DEFAULT_ORGANIZATION_SETTINGS } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";

let f: Fixture;
let firmB: string;
let counselB: AuthContext;
let seq = 7000;

function cnj(): string {
  seq += 1;
  return buildSimulatedCnj({ seed: seq, year: 2026, tribunal: "10", origin: "0801" });
}

async function proc(overrides: Partial<CreateProcessInput> = {}): Promise<string> {
  const { id } = await createProcess(f.ctx.manager, {
    number: cnj(),
    title: `Reclamação trabalhista fictícia ${seq}`,
    court: "TRT10",
    area: "labor",
    phase: "knowledge",
    unitId: f.unitSp,
    ...overrides,
  });
  return id;
}

function intakeInput(overrides: Partial<RegisterIntakeInput> = {}): RegisterIntakeInput {
  return {
    number: cnj(),
    court: "TRT10",
    city: "Palmas",
    state: "TO",
    area: "labor",
    phase: "knowledge",
    instance: "first",
    plaintiffName: "Fulano Fictício de Teste",
    defendantName: "Empresa Fictícia A Ltda.",
    unitId: f.unitSp,
    ...overrides,
  };
}

async function firmOf(processId: string): Promise<string | null> {
  const [row] = await f.db.select({ lawFirmId: legalProcesses.lawFirmId }).from(legalProcesses).where(eq(legalProcesses.id, processId));
  return row.lawFirmId;
}

beforeAll(async () => {
  f = await setupFixture("fixasg");
  // Assignment e-mails are covered elsewhere; keep these tests on the process data.
  await f.db
    .update(organizations)
    .set({ settings: { ...DEFAULT_ORGANIZATION_SETTINGS, email: { ...DEFAULT_ORGANIZATION_SETTINGS.email, notifyOnAssignment: false } } })
    .where(eq(organizations.id, f.orgA));
  const [firm] = await f.db.insert(lawFirms).values({ organizationId: f.orgA, name: "Escritório Fictício B Advogados" }).returning();
  firmB = firm.id;
  const [u] = await f.db
    .insert(users)
    .values({ organizationId: f.orgA, name: "Beto Escritório B", email: "fixasg.escritorio.b@a.test", passwordHash: "x", role: "external_counsel", lawFirmId: firmB })
    .returning();
  counselB = { kind: "user", userId: u.id, organizationId: f.orgA, role: "external_counsel", unitId: null, lawFirmId: firmB, name: u.name, email: u.email, isDemoOrganization: false };
});

afterAll(async () => {
  await f?.teardown();
});

describe("law firm follows the external counsel responsible (finding 1)", () => {
  it("firm A → firm B: the process moves to firm B and firm A loses access", async () => {
    const p = await proc();
    await reassignResponsible(f.ctx.manager, p, { userId: f.ctx.externalCounsel.userId!, reason: "Escritório A assume o caso" });
    expect(await firmOf(p)).toBe(f.lawFirmA);
    expect((await getProcess(f.ctx.externalCounsel, p)).id).toBe(p);

    await reassignResponsible(f.ctx.manager, p, { userId: counselB.userId!, reason: "Troca de escritório" });
    expect(await firmOf(p)).toBe(firmB);
    await expect(getProcess(f.ctx.externalCounsel, p)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getProcess(counselB, p)).responsibleId).toBe(counselB.userId);

    const audits = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "legal_process.assign"), eq(auditLogs.entityId, p)));
    const last = audits.find((a) => (a.changes as Record<string, { from: unknown; to: unknown }> | null)?.lawFirmId?.to === firmB);
    expect(last?.changes).toMatchObject({ lawFirmId: { from: f.lawFirmA, to: firmB } });
  });

  it("firm A → internal lawyer: the firm link is removed and firm A loses access", async () => {
    const p = await proc();
    await reassignResponsible(f.ctx.manager, p, { userId: f.ctx.externalCounsel.userId!, reason: "Escritório A assume o caso" });
    expect(await firmOf(p)).toBe(f.lawFirmA);
    await reassignResponsible(f.ctx.manager, p, { userId: f.ctx.lawyer.userId!, reason: "Caso volta para o jurídico interno" });
    expect(await firmOf(p)).toBeNull();
    await expect(getProcess(f.ctx.externalCounsel, p)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getProcess(f.ctx.lawyer, p)).responsibleId).toBe(f.ctx.lawyer.userId);
  });

  it("internal → firm A: the firm is linked", async () => {
    const p = await proc({ responsibleId: f.ctx.lawyer.userId });
    expect(await firmOf(p)).toBeNull();
    await reassignResponsible(f.ctx.manager, p, { userId: f.ctx.externalCounsel.userId!, reason: "Contratação do escritório A" });
    expect(await firmOf(p)).toBe(f.lawFirmA);
  });

  it("a firm linked independently of an external responsible is kept when the internal responsible changes", async () => {
    const p = await proc({ responsibleId: f.ctx.lawyer.userId });
    await f.db.update(legalProcesses).set({ lawFirmId: f.lawFirmA }).where(eq(legalProcesses.id, p));
    await reassignResponsible(f.ctx.manager, p, { userId: f.ctx.lawyerRe.userId!, reason: "Redistribuição interna" });
    expect(await firmOf(p)).toBe(f.lawFirmA);
    expect((await getProcess(f.ctx.externalCounsel, p)).id).toBe(p);
  });
});

describe("assignment permissions (finding 2)", () => {
  it("intake:manage makes only the first assignment, to an internal lawyer; reassignment and external counsel need distribution:manage", async () => {
    const r = await registerIncomingProcess(f.ctx.analyst, { ...intakeInput(), deferProcessing: true });
    expect((await getIntake(f.ctx.analyst, r.intakeId)).permissions.canAssign).toBe(true);

    await expect(
      assignIntakeManually(f.ctx.analyst, r.intakeId, { userId: f.ctx.externalCounsel.userId!, reason: "Mandar ao escritório" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await firmOf(r.processId)).toBeNull();

    const first = await assignIntakeManually(f.ctx.analyst, r.intakeId, { userId: f.ctx.lawyer.userId!, reason: "Primeira atribuição" });
    expect(first.userId).toBe(f.ctx.lawyer.userId);
    expect((await getProcess(f.ctx.manager, r.processId)).responsibleId).toBe(f.ctx.lawyer.userId);
    expect((await getIntake(f.ctx.analyst, r.intakeId)).permissions.canAssign).toBe(false);

    await expect(
      assignIntakeManually(f.ctx.analyst, r.intakeId, { userId: f.ctx.lawyerRe.userId!, reason: "Trocar" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      applyManualAssignment(f.ctx.analyst, r.processId, { userId: f.ctx.lawyerRe.userId!, reason: "Trocar" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignResponsible(f.ctx.analyst, r.processId, { force: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getProcess(f.ctx.manager, r.processId)).responsibleId).toBe(f.ctx.lawyer.userId);

    expect((await getIntake(f.ctx.manager, r.intakeId)).permissions.canAssign).toBe(true);
    const moved = await assignIntakeManually(f.ctx.manager, r.intakeId, { userId: f.ctx.externalCounsel.userId!, reason: "Escritório A assume" });
    expect(moved.userId).toBe(f.ctx.externalCounsel.userId);
    expect(await firmOf(r.processId)).toBe(f.lawFirmA);
  });

  it("an intake registered with a responsible cannot be moved to an external firm by an analyst", async () => {
    const r = await registerIncomingProcess(f.ctx.lawyer, { ...intakeInput({ responsibleId: f.ctx.lawyer.userId }), deferProcessing: true });
    expect((await getIntake(f.ctx.analyst, r.intakeId)).permissions.canAssign).toBe(false);
    await expect(
      assignIntakeManually(f.ctx.analyst, r.intakeId, { userId: f.ctx.externalCounsel.userId!, reason: "Escritório" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getProcess(f.ctx.externalCounsel, r.processId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("registration with an external counsel responsible requires distribution:manage", async () => {
    await expect(
      registerIncomingProcess(f.ctx.analyst, intakeInput({ responsibleId: f.ctx.externalCounsel.userId })),
    ).rejects.toMatchObject({ fieldErrors: { responsibleId: expect.any(Array) } });
    await expect(
      registerIncomingProcess(f.ctx.lawyer, intakeInput({ responsibleId: f.ctx.externalCounsel.userId })),
    ).rejects.toBeInstanceOf(ValidationError);
    const ok = await registerIncomingProcess(f.ctx.manager, { ...intakeInput({ responsibleId: f.ctx.externalCounsel.userId }), deferProcessing: true });
    expect((await getProcess(f.ctx.manager, ok.processId)).responsibleId).toBe(f.ctx.externalCounsel.userId);
  });
});

describe("concurrent assignment (finding 6)", () => {
  it("two simultaneous assignments of the same process apply only once", async () => {
    const p = await proc();
    const [a, b] = await Promise.all([assignResponsible(f.ctx.manager, p), assignResponsible(f.ctx.manager, p)]);
    const final = (await getProcess(f.ctx.manager, p)).responsibleId;
    expect(final).toBeTruthy();
    expect([a.userId, b.userId]).toEqual([final, final]);
    expect([a.method, b.method]).toContain("kept");
    const audits = await f.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "legal_process.assign"), eq(auditLogs.entityId, p)));
    expect(audits).toHaveLength(1);
  });
});

describe("workload uses the effective risk of each record (finding 8)", () => {
  it("a process with loss probability and no bp mirror is weighted by the organization percentage", async () => {
    const [u] = await f.db
      .insert(users)
      .values({ organizationId: f.orgA, name: "Wanda Carga Risco", email: "fixasg.carga@a.test", passwordHash: "x", role: "lawyer", unitId: f.unitSp })
      .returning();
    const p = await proc({ responsibleId: u.id, claimAmountCents: 10_000_000 });
    await f.db
      .update(legalProcesses)
      .set({ lossProbability: "possible", riskPercentageBp: null, liquidatedAmountCents: null })
      .where(eq(legalProcesses.id, p));

    const w = await getWorkload(f.ctx.manager);
    const row = w.byLawyer.find((r) => r.key === u.id)!;
    expect(row.activeProcesses).toBe(1);
    // possible = 50% (default parameters): claim × 50%, flagged as an estimate; never "unknown".
    expect(row.money.exposureEstimateCents).toBe(5_000_000);
    expect(row.money.exposureUnknown).toBe(0);
    expect(row.money.provisionEstimateCents).toBe(5_000_000);
    // Claim and liquidated stay apart (null liquidated is unknown, not zero).
    expect(row.money.claimCents).toBe(10_000_000);
    expect(row.money.liquidatedUnknown).toBe(1);
  });
});
