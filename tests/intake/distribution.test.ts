import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { makeDeadline, setupFixture, type Fixture } from "../helpers/fixtures";
import type { Role } from "@/domain/enums";
import {
  assignResponsible,
  createRule,
  decideAssignment,
  deleteRule,
  getRule,
  getWorkload,
  listAssignableUsers,
  listRules,
  moveRule,
  previewAssignment,
  reassignResponsible,
  setRuleActive,
  updateRule,
} from "@/modules/distribution/service";
import type { RuleInput } from "@/modules/distribution/schemas";
import { createProcess, getProcess } from "@/modules/processes/service";
import type { CreateProcessInput } from "@/modules/processes/schemas";
import type { AuthContext } from "@/server/auth/context";
import { auditLogs, companies, distributionRules, legalProcesses, processValuations, users } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";

let f: Fixture;
let lawyer2: AuthContext;
let inactiveLawyer: AuthContext;
let lawyerB: AuthContext;
let seq = 0;

async function addUser(orgId: string, name: string, role: Role, unitId: string | null, isActive = true): Promise<AuthContext> {
  seq += 1;
  const [u] = await f.db
    .insert(users)
    .values({ organizationId: orgId, name, email: `dist.extra${seq}@test.invalid`, passwordHash: "x", role, unitId, isActive })
    .returning();
  return { kind: "user", userId: u.id, organizationId: orgId, role, unitId, lawFirmId: null, name, email: u.email, isDemoOrganization: false };
}

async function proc(ctx: AuthContext, overrides: Partial<CreateProcessInput> = {}): Promise<string> {
  seq += 1;
  const { id } = await createProcess(ctx, {
    number: `${String(seq).padStart(7, "0")}-00.2026.5.10.0801`,
    title: `Reclamação trabalhista fictícia ${seq}`,
    court: "TRT10",
    area: "labor",
    phase: "knowledge",
    ...overrides,
  });
  return id;
}

function rule(overrides: Partial<RuleInput> & Pick<RuleInput, "userIds">): RuleInput {
  return { name: `Regra ${++seq}`, priority: 10, method: "fixed", isActive: true, ...overrides };
}

async function activeLoad(userId: string): Promise<number> {
  const [row] = await f.db
    .select({ n: sql<number>`count(*)::int` })
    .from(legalProcesses)
    .where(
      and(
        eq(legalProcesses.responsibleId, userId),
        isNull(legalProcesses.deletedAt),
        inArray(legalProcesses.status, ["active", "suspended"]),
      ),
    );
  return row.n;
}

beforeAll(async () => {
  f = await setupFixture("dist");
  lawyer2 = await addUser(f.orgA, "Sofia Segunda Advogada SP", "lawyer", f.unitSp);
  inactiveLawyer = await addUser(f.orgA, "Ivo Inativo", "lawyer", f.unitSp, false);
  lawyerB = await addUser(f.orgB, "Bia Advogada B", "lawyer", f.unitB);
});

afterAll(async () => {
  await f?.teardown();
});

afterEach(async () => {
  await f.db.delete(distributionRules);
});

describe("decideAssignment — fallback and kept", () => {
  it("no rule: least loaded among the lawyers of the process unit", async () => {
    // Laura (SP) gets two active processes; Sofia (SP) none.
    await proc(f.ctx.manager, { unitId: f.unitSp, responsibleId: f.ctx.lawyer.userId });
    await proc(f.ctx.manager, { unitId: f.unitSp, responsibleId: f.ctx.lawyer.userId });
    const p = await proc(f.ctx.manager, { unitId: f.unitSp });
    const d = await decideAssignment(f.ctx.manager, p);
    expect(d.userId).toBe(lawyer2.userId);
    expect(d.method).toBe("least_loaded");
    expect(d.ruleId).toBeNull();
    expect(d.reason).toContain("Nenhuma regra aplicável — menor carga entre advogados da unidade São Paulo");
    // decide does not persist
    expect((await getProcess(f.ctx.manager, p)).responsibleId).toBeNull();
  });

  it("no rule and no unit: least loaded among every active lawyer (never inactive or other roles)", async () => {
    const p = await proc(f.ctx.manager);
    const d = await decideAssignment(f.ctx.manager, p);
    const candidates = [f.ctx.lawyer.userId!, f.ctx.lawyerRe.userId!, lawyer2.userId!];
    expect(candidates).toContain(d.userId);
    const loads = await Promise.all(candidates.map(activeLoad));
    expect(await activeLoad(d.userId!)).toBe(Math.min(...loads));
    expect(d.userId).not.toBe(inactiveLawyer.userId);
    expect(d.reason).toContain("todos os advogados");
  });

  it("process with responsible keeps it (method kept)", async () => {
    const p = await proc(f.ctx.manager, { responsibleId: f.ctx.lawyerRe.userId });
    const d = await decideAssignment(f.ctx.manager, p);
    expect(d).toMatchObject({ userId: f.ctx.lawyerRe.userId, method: "kept", ruleId: null });
    expect(d.reason).toContain("já cadastrado");
  });
});

describe("rules: priority, methods and cursor", () => {
  it("first matching active rule by ascending priority wins; reorder and deactivate change it", async () => {
    const a = await createRule(f.ctx.manager, rule({ name: "A — TRT10", priority: 10, courts: ["TRT-10"], userIds: [f.ctx.lawyerRe.userId!] }));
    const b = await createRule(f.ctx.manager, rule({ name: "B — trabalhista", priority: 20, areas: ["labor"], userIds: [lawyer2.userId!] }));
    await createRule(f.ctx.manager, rule({ name: "C — TRT2", priority: 5, courts: ["TRT2"], userIds: [f.ctx.lawyer.userId!] }));
    const p = await proc(f.ctx.manager);

    let d = await decideAssignment(f.ctx.manager, p);
    expect(d).toMatchObject({ userId: f.ctx.lawyerRe.userId, method: "rule", ruleId: a.id, ruleName: "A — TRT10" });
    expect(d.reason).toContain("Regra “A — TRT10” (prioridade 10)");
    expect(d.reason).toContain("tribunal TRT10");

    await moveRule(f.ctx.manager, b.id, "up");
    const ordered = await listRules(f.ctx.manager);
    expect(ordered.map((r) => r.name)).toEqual(["C — TRT2", "B — trabalhista", "A — TRT10"]);
    expect(ordered.map((r) => r.priority)).toEqual([10, 20, 30]);
    d = await decideAssignment(f.ctx.manager, p);
    expect(d.ruleId).toBe(b.id);
    expect(d.userId).toBe(lawyer2.userId);

    await setRuleActive(f.ctx.manager, b.id, false);
    d = await decideAssignment(f.ctx.manager, p);
    expect(d.ruleId).toBe(a.id);
  });

  it("round robin rotates in list order and advances the cursor only when applied", async () => {
    const rr = await createRule(
      f.ctx.manager,
      rule({ method: "round_robin", courts: ["TRT10"], userIds: [f.ctx.lawyer.userId!, lawyer2.userId!] }),
    );
    const p1 = await proc(f.ctx.manager);
    const p2 = await proc(f.ctx.manager);
    const p3 = await proc(f.ctx.manager);

    // Preview twice: same answer, cursor unchanged.
    expect((await decideAssignment(f.ctx.manager, p1)).userId).toBe(f.ctx.lawyer.userId);
    expect((await decideAssignment(f.ctx.manager, p1)).userId).toBe(f.ctx.lawyer.userId);

    const d1 = await assignResponsible(f.ctx.manager, p1);
    const d2 = await assignResponsible(f.ctx.manager, p2);
    const d3 = await assignResponsible(f.ctx.manager, p3);
    expect([d1.userId, d2.userId, d3.userId]).toEqual([f.ctx.lawyer.userId, lawyer2.userId, f.ctx.lawyer.userId]);
    expect(d1.method).toBe("round_robin");
    expect(d2.reason).toContain("posição 2 de 2");
    const [row] = await f.db.select({ c: distributionRules.rrCursor }).from(distributionRules).where(eq(distributionRules.id, rr.id));
    expect(row.c).toBe(3);
    expect((await getProcess(f.ctx.manager, p2)).responsibleId).toBe(lawyer2.userId);
  });

  it("least loaded rule picks the rule member with fewer active processes + open intakes", async () => {
    for (let i = 0; i < 4; i++) await proc(f.ctx.manager, { responsibleId: lawyer2.userId });
    const ll = await createRule(
      f.ctx.manager,
      rule({ method: "least_loaded", areas: ["labor"], userIds: [lawyer2.userId!, f.ctx.lawyerRe.userId!] }),
    );
    const p = await proc(f.ctx.manager);
    const d = await decideAssignment(f.ctx.manager, p);
    const expected = (await activeLoad(lawyer2.userId!)) <= (await activeLoad(f.ctx.lawyerRe.userId!)) ? lawyer2.userId : f.ctx.lawyerRe.userId;
    expect(d).toMatchObject({ method: "least_loaded", ruleId: ll.id, userId: expected });
    expect(d.reason).toMatch(/processos? ativos?/);
  });

  it("inactive members are skipped; a rule without active members falls through", async () => {
    // Inactive users cannot be saved in a rule.
    await expect(
      createRule(f.ctx.manager, rule({ priority: 1, courts: ["TRT10"], userIds: [inactiveLawyer.userId!, f.ctx.lawyerRe.userId!] })),
    ).rejects.toBeInstanceOf(ValidationError);
    // Rule saved with active users, then one is deactivated.
    const r = await createRule(f.ctx.manager, rule({ priority: 1, courts: ["TRT10"], userIds: [lawyer2.userId!, f.ctx.lawyerRe.userId!] }));
    await f.db.update(users).set({ isActive: false }).where(eq(users.id, lawyer2.userId!));
    try {
      const p = await proc(f.ctx.manager);
      let d = await decideAssignment(f.ctx.manager, p);
      expect(d).toMatchObject({ ruleId: r.id, userId: f.ctx.lawyerRe.userId });
      const only = await createRule(f.ctx.manager, rule({ priority: 0, courts: ["TRT10"], userIds: [f.ctx.lawyer.userId!] }));
      await f.db.update(users).set({ isActive: false }).where(eq(users.id, f.ctx.lawyer.userId!));
      d = await decideAssignment(f.ctx.manager, p);
      expect(d.ruleId).toBe(r.id); // "only" has no active member → next rule
      const preview = await previewAssignment(f.ctx.manager, p);
      expect(preview.evaluations.find((e) => e.ruleId === only.id)?.skippedReason).toContain("nenhum advogado ativo");
    } finally {
      await f.db.update(users).set({ isActive: true }).where(inArray(users.id, [lawyer2.userId!, f.ctx.lawyer.userId!]));
    }
  });
});

describe("assignResponsible", () => {
  it("applies responsible, and law firm / unit only when empty; audited", async () => {
    await createRule(
      f.ctx.manager,
      rule({ courts: ["TRT10"], userIds: [f.ctx.lawyerRe.userId!], lawFirmId: f.lawFirmA, assignUnitId: f.unitRe }),
    );
    const empty = await proc(f.ctx.manager);
    const withUnit = await proc(f.ctx.manager, { unitId: f.unitSp });
    const d = await assignResponsible(f.ctx.manager, empty);
    expect(d).toMatchObject({ userId: f.ctx.lawyerRe.userId, lawFirmId: f.lawFirmA, unitId: f.unitRe });
    const p1 = await getProcess(f.ctx.manager, empty);
    expect(p1).toMatchObject({ responsibleId: f.ctx.lawyerRe.userId, lawFirmId: f.lawFirmA, unitId: f.unitRe });
    await assignResponsible(f.ctx.manager, withUnit);
    expect((await getProcess(f.ctx.manager, withUnit)).unitId).toBe(f.unitSp);

    const audits = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "legal_process.assign"), eq(auditLogs.entityId, empty)));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(f.ctx.manager.userId);
    expect(audits[0].metadata).toMatchObject({ method: "rule" });
    expect(String(audits[0].metadata?.reason)).toContain("Regra");
  });

  it("keeps an existing responsible unless forced", async () => {
    await createRule(f.ctx.manager, rule({ courts: ["TRT10"], userIds: [lawyer2.userId!] }));
    const p = await proc(f.ctx.manager, { responsibleId: f.ctx.lawyerRe.userId });
    const kept = await assignResponsible(f.ctx.manager, p);
    expect(kept.method).toBe("kept");
    expect((await getProcess(f.ctx.manager, p)).responsibleId).toBe(f.ctx.lawyerRe.userId);
    const forced = await assignResponsible(f.ctx.manager, p, { force: true });
    expect(forced.userId).toBe(lawyer2.userId);
    expect((await getProcess(f.ctx.manager, p)).responsibleId).toBe(lawyer2.userId);
  });

  it("an external counsel assignee brings their law firm, so the firm sees the process", async () => {
    await f.db.update(users).set({ lawFirmId: f.lawFirmA }).where(eq(users.id, f.ctx.externalCounsel.userId!));
    await createRule(f.ctx.manager, rule({ courts: ["TRT10"], userIds: [f.ctx.externalCounsel.userId!] }));
    const p = await proc(f.ctx.manager);
    const d = await assignResponsible(f.ctx.manager, p);
    expect(d).toMatchObject({ userId: f.ctx.externalCounsel.userId, lawFirmId: f.lawFirmA });
    expect((await getProcess(f.ctx.externalCounsel, p)).lawFirmId).toBe(f.lawFirmA);
  });

  it("manual redistribution requires distribution:manage, an eligible user and a reason", async () => {
    const p = await proc(f.ctx.manager, { responsibleId: f.ctx.lawyer.userId });
    await expect(reassignResponsible(f.ctx.lawyer, p, { userId: f.ctx.lawyerRe.userId!, reason: "Férias" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reassignResponsible(f.ctx.manager, p, { userId: f.ctx.lawyerRe.userId!, reason: "" })).rejects.toMatchObject({
      fieldErrors: { reason: expect.any(Array) },
    });
    await expect(reassignResponsible(f.ctx.manager, p, { userId: f.ctx.analyst.userId!, reason: "Teste" })).rejects.toMatchObject({
      fieldErrors: { userId: expect.any(Array) },
    });
    await expect(reassignResponsible(f.ctx.manager, p, { userId: f.ctx.lawyer.userId!, reason: "Mesmo" })).rejects.toBeInstanceOf(ConflictError);
    const d = await reassignResponsible(f.ctx.manager, p, { userId: f.ctx.lawyerRe.userId!, reason: "Férias do titular" });
    expect(d).toMatchObject({ method: "manual", userId: f.ctx.lawyerRe.userId });
    expect(d.reason).toContain("Férias do titular");
    expect((await getProcess(f.ctx.manager, p)).responsibleId).toBe(f.ctx.lawyerRe.userId);
  });
});

describe("permissions", () => {
  it("rules and workload require distribution:manage; deciding accepts intake:manage", async () => {
    const r = rule({ userIds: [f.ctx.lawyer.userId!] });
    await expect(createRule(f.ctx.lawyer, r)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createRule(f.ctx.analyst, r)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listRules(f.ctx.accountant)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getWorkload(f.ctx.auditor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getWorkload(f.ctx.lawyer)).rejects.toBeInstanceOf(ForbiddenError);
    const p = await proc(f.ctx.manager, { unitId: f.unitSp });
    await expect(decideAssignment(f.ctx.executive, p)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignResponsible(f.ctx.externalCounsel, p)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAssignableUsers(f.ctx.executive)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await decideAssignment(f.ctx.analyst, p)).userId).toBeTruthy();
  });

  it("row visibility: a lawyer cannot decide for a process of another unit", async () => {
    const p = await proc(f.ctx.manager, { unitId: f.unitRe });
    await expect(decideAssignment(f.ctx.lawyer, p)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("tenant isolation", () => {
  it("rules never reference users, companies or units of another organization", async () => {
    await expect(createRule(f.ctx.admin, rule({ userIds: [lawyerB.userId!] }))).rejects.toMatchObject({
      fieldErrors: { userIds: expect.any(Array) },
    });
    const [companyB] = await f.db.insert(companies).values({ organizationId: f.orgB, name: "Empresa B (fictícia)" }).returning();
    await expect(createRule(f.ctx.admin, rule({ userIds: [f.ctx.lawyer.userId!], companyIds: [companyB.id] }))).rejects.toMatchObject({
      fieldErrors: { companyIds: expect.any(Array) },
    });
    await expect(createRule(f.ctx.admin, rule({ userIds: [f.ctx.lawyer.userId!], assignUnitId: f.unitB }))).rejects.toMatchObject({
      fieldErrors: { assignUnitId: expect.any(Array) },
    });
    await expect(createRule(f.ctx.admin, rule({ userIds: [f.ctx.lawyer.userId!], unitIds: [f.unitB] }))).rejects.toMatchObject({
      fieldErrors: { unitIds: expect.any(Array) },
    });
  });

  it("rules and lawyers of organization B are never used for organization A", async () => {
    const ruleB = await createRule(f.ctx.adminB, rule({ priority: 0, userIds: [lawyerB.userId!] }));
    const p = await proc(f.ctx.manager);
    const d = await decideAssignment(f.ctx.manager, p);
    expect(d.userId).not.toBe(lawyerB.userId);
    expect(d.ruleId).toBeNull();
    expect((await listRules(f.ctx.admin)).map((r) => r.id)).not.toContain(ruleB.id);
    await expect(getRule(f.ctx.admin, ruleB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateRule(f.ctx.admin, ruleB.id, rule({ userIds: [f.ctx.lawyer.userId!] }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteRule(f.ctx.admin, ruleB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(decideAssignment(f.ctx.adminB, p)).rejects.toBeInstanceOf(NotFoundError);
    // Organization B process: its own rule applies.
    const pB = await proc(f.ctx.adminB);
    expect((await decideAssignment(f.ctx.adminB, pB)).userId).toBe(lawyerB.userId);
  });
});

describe("rule CRUD", () => {
  it("creates, updates (resetting the rotation when members change) and deletes with audit", async () => {
    const { id } = await createRule(
      f.ctx.manager,
      rule({ name: "Rodízio TRT10", method: "round_robin", courts: ["trt10", "TRT-10"], cities: ["Palmas"], userIds: [f.ctx.lawyer.userId!, lawyer2.userId!] }),
    );
    let r = await getRule(f.ctx.manager, id);
    expect(r.criteria.courts).toEqual(["TRT10"]); // deduplicated
    expect(r.criteriaSummary).toContain("Cidade: Palmas");
    expect(r.nextInRotation).toBe(f.ctx.lawyer.name);
    await f.db.update(distributionRules).set({ rrCursor: 5 }).where(eq(distributionRules.id, id));
    await updateRule(f.ctx.manager, id, rule({ name: "Rodízio TRT10", method: "round_robin", userIds: [lawyer2.userId!, f.ctx.lawyer.userId!] }));
    r = await getRule(f.ctx.manager, id);
    expect(r.assignment.userIds).toEqual([lawyer2.userId, f.ctx.lawyer.userId]);
    const [row] = await f.db.select({ c: distributionRules.rrCursor }).from(distributionRules).where(eq(distributionRules.id, id));
    expect(row.c).toBe(0);
    await deleteRule(f.ctx.manager, id);
    await expect(getRule(f.ctx.manager, id)).rejects.toBeInstanceOf(NotFoundError);
    const actions = (await f.db.select({ a: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, id))).map((x) => x.a);
    expect(actions).toEqual(expect.arrayContaining(["distribution_rule.create", "distribution_rule.update", "distribution_rule.delete"]));
  });
});

describe("workload (TE-08)", () => {
  it("keeps claim and liquidated apart, counts unknown values and pendências, per organization", async () => {
    const extra = await addUser(f.orgA, "Wagner Carga Advogado", "lawyer", f.unitRe);
    const p1 = await proc(f.ctx.manager, { responsibleId: extra.userId, claimAmountCents: 10_000_000 });
    const p2 = await proc(f.ctx.manager, { responsibleId: extra.userId });
    await f.db
      .update(legalProcesses)
      .set({ liquidatedAmountCents: 3_000_000, riskPercentageBp: 5000, needsVerification: true })
      .where(eq(legalProcesses.id, p1));
    await makeDeadline(f.ctx.manager, { processId: p2, responsibleId: extra.userId });
    await f.db.insert(processValuations).values({
      organizationId: f.orgA,
      processId: p2,
      kind: "liquidated",
      amountCents: 1_000,
      baseDate: "2026-01-01",
      source: "spreadsheet",
      status: "proposed",
    });

    const w = await getWorkload(f.ctx.manager);
    const row = w.byLawyer.find((r) => r.key === extra.userId)!;
    expect(row.activeProcesses).toBe(2);
    expect(row.money.claimCents).toBe(10_000_000);
    expect(row.money.claimUnknown).toBe(1);
    expect(row.money.liquidatedCents).toBe(3_000_000);
    expect(row.money.liquidatedUnknown).toBe(1);
    expect(row.money.exposureCents).toBe(3_000_000); // liquidated − guarantees (none)
    expect(row.pending).toMatchObject({ openDeadlines: 1, needsVerification: 1, valuationsPendingReview: 1 });
    expect(row.href).toBe(`/processos?responsavel=${extra.userId}`);
    expect(w.byLawFirm.some((r) => r.key === f.lawFirmA)).toBe(true);
    expect(w.totals.activeProcesses).toBeGreaterThanOrEqual(2);

    const wB = await getWorkload(f.ctx.adminB);
    expect(wB.byLawyer.find((r) => r.key === extra.userId)).toBeUndefined();
    expect(wB.totals.activeProcesses).toBe((await f.db.select({ id: legalProcesses.id }).from(legalProcesses).where(eq(legalProcesses.organizationId, f.orgB))).length);
  });
});
