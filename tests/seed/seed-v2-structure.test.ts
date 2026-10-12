import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, inArray, like } from "drizzle-orm";
import { createTeam, updateTeam, updateUnit } from "@/modules/admin/service";
import { deleteRule, updateRule } from "@/modules/distribution/service";
import { deleteCompany, updateCompany, updateLawFirm } from "@/modules/organization/service";
import type { AuthContext } from "@/server/auth/context";
import {
  auditLogs,
  companies,
  distributionRules,
  importBatches,
  lawFirms,
  teamMembers,
  units,
  users,
} from "@/server/db/schema";
import type { UserKey } from "../../scripts/seed-data/aurora";
import type { SeededUser } from "../../scripts/seed-data/helpers";
import {
  AURORA_V2_USERS,
  DEMO_SPREADSHEET,
  V2_COMPANY_NAME,
  V2_RULES,
  V2_TEAM,
  V2_UNITS,
} from "../../scripts/seed-data/v2/aurora-v2";
import {
  committedDemoBatch,
  ensureRules,
  ensureStructure,
  rulesPlan,
  structurePending,
  structurePlan,
  type DemoStructure,
} from "../../scripts/seed-data/v2/structure";
import { setupFixture, type Fixture } from "../helpers/fixtures";

/**
 * Steps b and c of the v2 seed (scripts/seed-data/v2/structure.ts): the
 * company, the law firm, the units, the v2 accounts (and their team) and the
 * distribution rules are created ONCE. A person's later rename or removal
 * (company, unit, rule, team membership) must never make a later run create
 * them again nor a second one with the old name.
 */

let fx: Fixture;
let v1: Record<UserKey, SeededUser>;
let teamId: string;
const TEAM_DESCRIPTION = "Equipe de teste (dados fictícios).";

function seeded(ctx: AuthContext): SeededUser {
  return {
    id: ctx.userId!,
    organizationId: ctx.organizationId,
    name: ctx.name!,
    email: ctx.email!,
    role: ctx.role,
    unitId: ctx.unitId,
    lawFirmId: ctx.lawFirmId,
  };
}

const gestor = () => fx.ctx.manager;
const admin = () => fx.ctx.admin;

/** Rows of every table the step writes (organization A). */
async function snapshot() {
  const org = fx.orgA;
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0].n;
  return {
    companies: await n(fx.db.select({ n: count() }).from(companies).where(eq(companies.organizationId, org))),
    lawFirms: await n(fx.db.select({ n: count() }).from(lawFirms).where(eq(lawFirms.organizationId, org))),
    units: await n(fx.db.select({ n: count() }).from(units).where(eq(units.organizationId, org))),
    users: await n(fx.db.select({ n: count() }).from(users).where(eq(users.organizationId, org))),
    teamMembers: await n(fx.db.select({ n: count() }).from(teamMembers).where(eq(teamMembers.organizationId, org))),
    rules: await n(fx.db.select({ n: count() }).from(distributionRules).where(eq(distributionRules.organizationId, org))),
  };
}

async function teamEmails(): Promise<string[]> {
  const rows = await fx.db
    .select({ email: users.email })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId));
  return rows.map((r) => r.email).sort();
}

async function runSteps(): Promise<{ structure: DemoStructure; created: Awaited<ReturnType<typeof ensureStructure>>["created"]; rules: number }> {
  const { structure, created } = await ensureStructure(fx.orgA, v1);
  const rules = await ensureRules(gestor(), structure);
  return { structure, created, rules };
}

const NOTHING_CREATED = { company: false, lawFirm: false, units: [], accounts: 0, teamMembers: 0 };

const v2Email = (key: string) => Object.entries(AURORA_V2_USERS).find(([, m]) => m.key === key)![0];

beforeAll(async () => {
  fx = await setupFixture("seeds");
  // The v1 unit "Matriz São Paulo" is looked up by its code.
  await fx.db.update(units).set({ code: "SP" }).where(eq(units.id, fx.unitSp));
  v1 = {
    admin: seeded(fx.ctx.admin),
    gestor: seeded(fx.ctx.manager),
    advogada: seeded(fx.ctx.lawyer),
    advogadoRecife: seeded(fx.ctx.lawyerRe),
    analista: seeded(fx.ctx.analyst),
    executivo: seeded(fx.ctx.executive),
  };
  // The team of the v1 seed that the v2 lawyers join.
  teamId = (await createTeam(admin(), { name: V2_TEAM.name, description: TEAM_DESCRIPTION, memberIds: [fx.ctx.lawyer.userId!] })).id;
});

afterAll(async () => {
  await fx.teardown();
});

describe("structure and distribution rules of the v2 demo (database)", () => {
  it("creates the company, the firm, the units, the accounts (joining the team) and the rules", async () => {
    const plan = await structurePlan(fx.orgA);
    expect(plan).toEqual({ company: true, lawFirm: true, units: V2_UNITS.map((u) => u.key), accounts: Object.keys(AURORA_V2_USERS) });
    expect(structurePending(plan)).toBe(true);
    expect(await rulesPlan(fx.orgA)).toHaveLength(V2_RULES.length);

    const { structure, created, rules } = await runSteps();
    expect(created).toEqual({
      company: true,
      lawFirm: true,
      units: V2_UNITS.map((u) => u.name),
      accounts: Object.keys(AURORA_V2_USERS).length,
      teamMembers: V2_TEAM.members.length,
    });
    expect(rules).toBe(V2_RULES.length);
    expect(structure.companyId).not.toBeNull();
    expect(structure.lawFirmId).not.toBeNull();
    expect(structure.units.sp).toBe(fx.unitSp);
    expect(structure.people.escritorio.lawFirmId).toBe(structure.lawFirmId);
    expect(structure.people.advogadaPalmas.unitId).toBe(structure.units.centroNorte);
    expect(await teamEmails()).toEqual([fx.ctx.lawyer.email, ...V2_TEAM.members.map(v2Email)].sort());

    // Units through the admin service: their create entry is in the audit log.
    const unitEntries = await fx.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, fx.orgA), eq(auditLogs.action, "unit.create")));
    expect(unitEntries).toHaveLength(V2_UNITS.length);
    expect(structurePending(await structurePlan(fx.orgA))).toBe(false);
    expect(await rulesPlan(fx.orgA)).toEqual([]);
  });

  it("does nothing the second time", async () => {
    const before = await snapshot();
    const r = await runSteps();
    expect(r.created).toEqual(NOTHING_CREATED);
    expect(r.rules).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("never creates a second company, firm or unit after a person renames them (units by code, then the audit entry)", async () => {
    const before = await snapshot();
    const initial = await ensureStructure(fx.orgA, v1);
    const { companyId, lawFirmId } = initial.structure;
    await updateCompany(admin(), companyId!, { name: "Empresa Modelo Teste Ltda. (nome corrigido)", document: null });
    await updateLawFirm(admin(), lawFirmId!, { name: "Parceiro Exemplo Advogados (renomeado)", document: null });
    const nordeste = V2_UNITS.find((u) => u.key === "nordeste")!;
    const centroNorte = V2_UNITS.find((u) => u.key === "centroNorte")!;
    await updateUnit(admin(), initial.structure.units.nordeste!, { name: "Regional Norte e Nordeste (fictícia)", code: nordeste.code });
    // Name and code changed: only the seed's create entry still identifies it.
    await updateUnit(admin(), initial.structure.units.centroNorte!, { name: "Regional Centro-Oeste (fictícia)", code: "RCO" });

    expect(structurePending(await structurePlan(fx.orgA))).toBe(false);
    const r = await runSteps();
    expect(r.created).toEqual(NOTHING_CREATED);
    expect(r.rules).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(r.structure.companyId).toBe(companyId);
    expect(r.structure.lawFirmId).toBe(lawFirmId);
    expect(r.structure.units.nordeste).toBe(initial.structure.units.nordeste);
    expect(r.structure.units.centroNorte).toBe(initial.structure.units.centroNorte);
    const old = await fx.db
      .select({ id: units.id })
      .from(units)
      .where(and(eq(units.organizationId, fx.orgA), inArray(units.name, [nordeste.name, centroNorte.name])));
    expect(old).toEqual([]);
    const oldCompany = await fx.db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.organizationId, fx.orgA), eq(companies.name, V2_COMPANY_NAME)));
    expect(oldCompany).toEqual([]);
  });

  it("never brings back a rule a person deleted nor creates a second one for a renamed rule", async () => {
    const structure = (await ensureStructure(fx.orgA, v1)).structure;
    const trt10 = V2_RULES.find((r) => r.courts?.includes("TRT10"))!;
    const trt5 = V2_RULES.find((r) => r.courts?.includes("TRT5"))!;
    const [deleted] = await fx.db
      .select({ id: distributionRules.id })
      .from(distributionRules)
      .where(and(eq(distributionRules.organizationId, fx.orgA), eq(distributionRules.name, trt10.name)));
    await deleteRule(gestor(), deleted.id);
    const [renamed] = await fx.db
      .select({ id: distributionRules.id })
      .from(distributionRules)
      .where(and(eq(distributionRules.organizationId, fx.orgA), eq(distributionRules.name, trt5.name)));
    await updateRule(gestor(), renamed.id, {
      name: "Bahia: advogado do Nordeste (renomeada)",
      description: trt5.description,
      priority: trt5.priority,
      courts: trt5.courts,
      method: trt5.method,
      userIds: trt5.users.map((k) => structure.people[k].id),
      assignUnitId: structure.units.nordeste,
    });
    const before = await snapshot();
    expect(before.rules).toBe(V2_RULES.length - 1);

    expect(await rulesPlan(fx.orgA)).toEqual([]);
    const r = await runSteps();
    expect(r.rules).toBe(0);
    expect(await snapshot()).toEqual(before);
    const names = (
      await fx.db.select({ name: distributionRules.name }).from(distributionRules).where(eq(distributionRules.organizationId, fx.orgA))
    ).map((x) => x.name);
    expect(names).not.toContain(trt10.name);
    expect(names).not.toContain(trt5.name);
  });

  it("never adds back a lawyer a person took out of the team", async () => {
    const palmas = v2Email("advogadaPalmas");
    const [palmasRow] = await fx.db.select({ id: users.id }).from(users).where(eq(users.email, palmas));
    const keep = (await fx.db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, teamId)))
      .map((m) => m.userId)
      .filter((id) => id !== palmasRow.id);
    await updateTeam(admin(), teamId, { name: V2_TEAM.name, description: TEAM_DESCRIPTION, memberIds: keep });
    const before = await snapshot();
    expect(await teamEmails()).not.toContain(palmas);

    const r = await runSteps();
    expect(r.created).toEqual(NOTHING_CREATED);
    expect(await teamEmails()).not.toContain(palmas);
    expect(await snapshot()).toEqual(before);
  });

  it("does not recreate a company a person removed (the seed's create entry is the marker)", async () => {
    const { structure } = await ensureStructure(fx.orgA, v1);
    expect(await deleteCompany(admin(), structure.companyId!)).toEqual({ outcome: "deleted" });
    const before = await snapshot();
    expect(await structurePlan(fx.orgA)).toMatchObject({ company: false });
    const r = await runSteps();
    expect(r.created).toEqual(NOTHING_CREATED);
    expect(r.structure.companyId).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("once the demo import is committed, steps b and c are done even without the rows or their audit entries", async () => {
    expect(await committedDemoBatch(fx.orgA)).toBeNull();
    // Rows written by an earlier seed without a create entry: removed row and no entry = would be pending.
    const nordeste = (await ensureStructure(fx.orgA, v1)).structure.units.nordeste!;
    await fx.db.delete(units).where(eq(units.id, nordeste));
    await fx.db.delete(auditLogs).where(and(eq(auditLogs.organizationId, fx.orgA), like(auditLogs.action, "unit.%"), eq(auditLogs.entityId, nordeste)));
    await fx.db.delete(auditLogs).where(and(eq(auditLogs.organizationId, fx.orgA), eq(auditLogs.action, "distribution_rule.create")));
    await fx.db.delete(auditLogs).where(and(eq(auditLogs.organizationId, fx.orgA), inArray(auditLogs.action, ["company.create", "law_firm.create"])));
    expect(await structurePlan(fx.orgA)).toMatchObject({ company: true, units: ["nordeste"] });
    expect((await rulesPlan(fx.orgA)).length).toBeGreaterThan(0);

    const [batch] = await fx.db
      .insert(importBatches)
      .values({
        organizationId: fx.orgA,
        fileName: DEMO_SPREADSHEET.fileName,
        fileSha256: "0".repeat(64),
        sizeBytes: 1,
        status: "committed",
        committedAt: new Date(),
      })
      .returning({ id: importBatches.id });
    expect(await committedDemoBatch(fx.orgA)).toBe(batch.id);

    const before = await snapshot();
    expect(structurePending(await structurePlan(fx.orgA))).toBe(false);
    expect(await rulesPlan(fx.orgA)).toEqual([]);
    const r = await runSteps();
    expect(r.created).toEqual(NOTHING_CREATED);
    expect(r.rules).toBe(0);
    expect(r.structure.units.nordeste).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("still creates a v2 account that never existed (e-mails never change and accounts are never removed)", async () => {
    const email = v2Email("auditoria");
    await fx.db.delete(users).where(eq(users.email, email));
    const before = await snapshot();
    expect(await structurePlan(fx.orgA)).toEqual({ company: false, lawFirm: false, units: [], accounts: [email] });
    const r = await runSteps();
    expect(r.created).toEqual({ ...NOTHING_CREATED, accounts: 1 });
    expect(r.structure.people.auditoria.email).toBe(email);
    expect(await snapshot()).toEqual({ ...before, users: before.users + 1 });
    expect(structurePending(await structurePlan(fx.orgA))).toBe(false);
  });

  it("stops when a v2 demo e-mail belongs to another organization, without touching it", async () => {
    const email = v2Email("auditoria");
    await fx.db.update(users).set({ organizationId: fx.orgB }).where(eq(users.email, email));
    await expect(structurePlan(fx.orgA)).rejects.toThrow(/outra organização/);
    const [row] = await fx.db.select({ org: users.organizationId }).from(users).where(eq(users.email, email));
    expect(row.org).toBe(fx.orgB);
  });
});
