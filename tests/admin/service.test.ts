import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDatabase } from "../helpers/db";
import type { AuthContext } from "@/server/auth/context";
import type { Database } from "@/server/db/client";
import { auditLogs, legalProcesses, organizations, sessions, teamMembers, teams, units, users } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import {
  createTeam,
  createUnit,
  createUser,
  deleteUnit,
  getUser,
  listAuditLogs,
  listEntityHistory,
  listRoutines,
  listUnitOptions,
  listUserOptions,
  listUsers,
  resetUserPassword,
  updateOrganizationSettings,
  getOrganizationSettings,
  updateRoutine,
  updateUser,
} from "@/modules/admin/service";

let db: Database;
let close: () => Promise<void>;
const ids: Record<string, string> = {};
const PASSWORD = "SenhaSegura123";

function ctx(role: AuthContext["role"], userId: string, orgId: string, unitId: string | null = null): AuthContext {
  return { kind: "user", userId, organizationId: orgId, role, unitId, name: role, email: `${role}@x`, isDemoOrganization: false };
}

const adminA = () => ctx("admin", ids.adminA, ids.a);
const managerA = () => ctx("legal_manager", ids.managerA, ids.a);
const lawyerSp = () => ctx("lawyer", ids.lawyerSp, ids.a, ids.sp);

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [a] = await db.insert(organizations).values({ name: "Org A", slug: "org-a" }).returning();
  const [b] = await db.insert(organizations).values({ name: "Org B", slug: "org-b" }).returning();
  const [sp] = await db.insert(units).values({ organizationId: a.id, name: "Matriz SP" }).returning();
  const [re] = await db.insert(units).values({ organizationId: a.id, name: "Filial RE" }).returning();
  const [unitB] = await db.insert(units).values({ organizationId: b.id, name: "Unidade B" }).returning();
  const mk = async (org: string, email: string, role: AuthContext["role"], unitId: string | null = null) =>
    (await db.insert(users).values({ organizationId: org, name: email, email, passwordHash: "x", role, unitId }).returning())[0];
  const admin = await mk(a.id, "admin@a.test", "admin");
  const manager = await mk(a.id, "manager@a.test", "legal_manager");
  const lawyer = await mk(a.id, "lawyer@a.test", "lawyer", sp.id);
  const adminB = await mk(b.id, "admin@b.test", "admin");
  const userB = await mk(b.id, "user@b.test", "analyst", unitB.id);
  const [teamB] = await db.insert(teams).values({ organizationId: b.id, name: "Equipe B" }).returning();
  Object.assign(ids, {
    a: a.id,
    b: b.id,
    sp: sp.id,
    re: re.id,
    unitB: unitB.id,
    adminA: admin.id,
    managerA: manager.id,
    lawyerSp: lawyer.id,
    adminB: adminB.id,
    userB: userB.id,
    teamB: teamB.id,
  });
});

afterAll(async () => close());

describe("users", () => {
  it("only admins can create users", async () => {
    await expect(
      createUser(managerA(), { name: "Novo Usuário", email: "novo@a.test", role: "analyst", password: PASSWORD }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createUser(lawyerSp(), { name: "Novo Usuário", email: "novo@a.test", role: "analyst", password: PASSWORD }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const { id } = await createUser(adminA(), {
      name: "Ana Souza",
      email: "  Ana.Souza@A.test ",
      role: "analyst",
      unitId: ids.sp,
      password: PASSWORD,
    });
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row.email).toBe("ana.souza@a.test");
    expect(row.organizationId).toBe(ids.a);
    expect(row.passwordHash).not.toBe(PASSWORD);
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "user.create")));
    expect(JSON.stringify(audit.changes)).not.toContain(PASSWORD);
    ids.ana = id;
  });

  it("rejects duplicate e-mails (case-insensitive, across organizations)", async () => {
    await expect(
      createUser(adminA(), { name: "Outra Ana", email: "ANA.SOUZA@a.test", role: "analyst", password: PASSWORD }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      createUser(adminA(), { name: "Usuário B", email: "user@b.test", role: "analyst", password: PASSWORD }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("enforces the password policy and validates foreign ids", async () => {
    await expect(
      createUser(adminA(), { name: "Fraca", email: "fraca@a.test", role: "analyst", password: "curta" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createUser(adminA(), { name: "Cruzado", email: "cruzado@a.test", role: "analyst", unitId: ids.unitB, password: PASSWORD }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createUser(adminA(), { name: "Cruzado", email: "cruzado@a.test", role: "analyst", teamIds: [ids.teamB], password: PASSWORD }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("never exposes users of another organization", async () => {
    await expect(getUser(adminA(), ids.userB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateUser(adminA(), ids.userB, { name: "x y", role: "admin", isActive: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const list = await listUsers(adminA(), {});
    expect(list.items.map((u) => u.id)).not.toContain(ids.userB);
  });

  it("cannot deactivate or demote yourself and keeps at least one active admin", async () => {
    await expect(
      updateUser(adminA(), ids.adminA, { name: "admin@a.test", role: "legal_manager", isActive: true }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateUser(adminA(), ids.adminA, { name: "admin@a.test", role: "admin", isActive: false }),
    ).rejects.toBeInstanceOf(ConflictError);

    // A second admin tries to remove the only other admin: allowed while two exist...
    const { id: admin2 } = await createUser(adminA(), { name: "Admin Dois", email: "admin2@a.test", role: "admin", password: PASSWORD });
    const asAdmin2 = ctx("admin", admin2, ids.a);
    await updateUser(asAdmin2, ids.adminA, { name: "admin@a.test", role: "legal_manager", isActive: true });
    // ...but the last remaining admin cannot be demoted or deactivated by anyone.
    await expect(
      updateUser(asAdmin2, admin2, { name: "Admin Dois", role: "lawyer", isActive: true }),
    ).rejects.toBeInstanceOf(ConflictError);
    // Restore the original admin through admin2.
    await updateUser(asAdmin2, ids.adminA, { name: "admin@a.test", role: "admin", isActive: true });
    await updateUser(adminA(), admin2, { name: "Admin Dois", role: "admin", isActive: false });
    await expect(
      updateUser(asAdmin2, ids.adminA, { name: "admin@a.test", role: "admin", isActive: false }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("revokes sessions on role change and on password reset", async () => {
    const insertSession = (id: string) =>
      db.insert(sessions).values({ id, userId: ids.ana, organizationId: ids.a, expiresAt: new Date(Date.now() + 3_600_000) });
    const sessionCount = async () => (await db.select().from(sessions).where(eq(sessions.userId, ids.ana))).length;

    await insertSession("session-1");
    // Changing only the job title keeps sessions.
    await updateUser(adminA(), ids.ana, { name: "Ana Souza", role: "analyst", unitId: ids.sp, jobTitle: "Analista Jr.", isActive: true });
    expect(await sessionCount()).toBe(1);
    await updateUser(adminA(), ids.ana, { name: "Ana Souza", role: "lawyer", unitId: ids.sp, jobTitle: "Analista Jr.", isActive: true });
    expect(await sessionCount()).toBe(0);

    await insertSession("session-2");
    await resetUserPassword(adminA(), ids.ana, { password: "NovaSenha2026", confirmPassword: "NovaSenha2026" });
    expect(await sessionCount()).toBe(0);
    await expect(
      resetUserPassword(adminA(), ids.ana, { password: "NovaSenha2026", confirmPassword: "Diferente2026" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("lookups", () => {
  it("listUserOptions and listUnitOptions never return rows from another organization", async () => {
    const userOpts = await listUserOptions(lawyerSp());
    expect(userOpts.length).toBeGreaterThan(0);
    expect(userOpts.map((u) => u.id)).not.toContain(ids.userB);
    expect(userOpts.map((u) => u.id)).not.toContain(ids.adminB);
    const unitOpts = await listUnitOptions(lawyerSp());
    expect(unitOpts.map((u) => u.id)).not.toContain(ids.unitB);
    expect(unitOpts.map((u) => u.id)).toContain(ids.sp);
  });
});

describe("teams and units", () => {
  it("rejects members from another organization", async () => {
    await expect(createTeam(adminA(), { name: "Contencioso", memberIds: [ids.userB] })).rejects.toBeInstanceOf(ValidationError);
    const { id } = await createTeam(adminA(), { name: "Contencioso", memberIds: [ids.lawyerSp], leaderId: ids.managerA });
    const members = await db.select().from(teamMembers).where(eq(teamMembers.teamId, id));
    expect(members.map((m) => m.userId)).toEqual([ids.lawyerSp]);
    await expect(createTeam(adminA(), { name: "contencioso" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("units: unique name per org; deactivated instead of deleted when referenced", async () => {
    await expect(createUnit(adminA(), { name: "matriz sp" })).rejects.toBeInstanceOf(ConflictError);
    // Same name in another organization is fine.
    await createUnit(ctx("admin", ids.adminB, ids.b), { name: "Matriz SP" });

    expect(await deleteUnit(adminA(), ids.sp)).toEqual({ outcome: "deactivated" });
    const [sp] = await db.select().from(units).where(eq(units.id, ids.sp));
    expect(sp.isActive).toBe(false);

    const { id: empty } = await createUnit(adminA(), { name: "Unidade Vazia" });
    expect(await deleteUnit(adminA(), empty)).toEqual({ outcome: "deleted" });
    await expect(deleteUnit(adminA(), ids.unitB)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("organization settings and routines", () => {
  it("requires admin:organization and validates bounds", async () => {
    await expect(getOrganizationSettings(managerA())).rejects.toBeInstanceOf(ForbiddenError);
    const current = await getOrganizationSettings(adminA());
    const base = {
      name: "Org A Atualizada",
      monthlyTokenBudget: current.settings.ai.monthlyTokenBudget,
      maxInputChars: current.settings.ai.maxInputChars,
      autoAnalyzeOnUpload: false,
      upcomingDeadlineDays: 10,
      contractExpirationDays: 90,
      closedRecordRetentionDays: 1825,
      auditLogRetentionDays: 1825,
    };
    await expect(updateOrganizationSettings(adminA(), { ...base, upcomingDeadlineDays: 0 })).rejects.toBeInstanceOf(ValidationError);
    await updateOrganizationSettings(adminA(), base);
    const after = await getOrganizationSettings(adminA());
    expect(after.name).toBe("Org A Atualizada");
    expect(after.settings.alerts.upcomingDeadlineDays).toBe(10);
    expect(after.settings.ai.autoAnalyzeOnUpload).toBe(false);
  });

  it("creates default routines and enforces the minimum interval", async () => {
    const routines = await listRoutines(adminA());
    expect(routines.length).toBe(4);
    const stale = routines.find((r) => r.type === "stale_analysis_refresh")!;
    await expect(updateRoutine(adminA(), stale.id, { enabled: true, intervalMinutes: 5 })).rejects.toBeInstanceOf(ValidationError);
    await updateRoutine(adminA(), stale.id, { enabled: true, intervalMinutes: 30, autoRefresh: true, maxPerRun: 3 });
    const updated = (await listRoutines(adminA())).find((r) => r.id === stale.id)!;
    expect(updated.intervalMinutes).toBe(30);
    expect(updated.config).toEqual({ autoRefresh: true, maxPerRun: 3 });
    // Routines of another organization are not reachable.
    const routinesB = await listRoutines(ctx("admin", ids.adminB, ids.b));
    await expect(updateRoutine(adminA(), routinesB[0].id, { enabled: false, intervalMinutes: 60 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("audit and entity history", () => {
  it("listAuditLogs is organization-scoped and permission-checked", async () => {
    await expect(listAuditLogs(lawyerSp(), {})).rejects.toBeInstanceOf(ForbiddenError);
    const logs = await listAuditLogs(managerA(), { entityType: "user" });
    expect(logs.total).toBeGreaterThan(0);
    const orgB = await listAuditLogs(ctx("admin", ids.adminB, ids.b), {});
    expect(orgB.items.every((l) => !logs.items.some((x) => x.id === l.id))).toBe(true);
  });

  it("listEntityHistory hides entries for entities the user cannot see", async () => {
    const [conf] = await db
      .insert(legalProcesses)
      .values({ organizationId: ids.a, number: "0001", title: "Sigiloso", court: "TJ", area: "civil", phase: "knowledge", unitId: ids.re, isConfidential: true })
      .returning();
    await db.insert(auditLogs).values({
      organizationId: ids.a,
      actorId: ids.adminA,
      action: "legal_process.update",
      entityType: "legal_process",
      entityId: conf.id,
      summary: "Processo alterado",
      changes: { responsibleId: { from: null, to: ids.managerA }, status: { from: "active", to: "suspended" } },
    });

    const visible = await listEntityHistory(adminA(), { type: "legal_process", id: conf.id });
    expect(visible).toHaveLength(1);
    expect(visible[0].actorName).toBe("admin@a.test");
    expect(visible[0].refNames[ids.managerA]).toBe("manager@a.test");

    expect(await listEntityHistory(lawyerSp(), { type: "legal_process", id: conf.id })).toEqual([]);
    expect(await listEntityHistory(ctx("admin", ids.adminB, ids.b), { type: "legal_process", id: conf.id })).toEqual([]);
    expect(await listEntityHistory(adminA(), { type: "legal_process", id: "not-a-uuid" })).toEqual([]);
  });
});
