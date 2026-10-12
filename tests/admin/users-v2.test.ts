import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, getUser, listUsers, updateUser } from "@/modules/admin/service";
import { createLawFirm, setLawFirmActive } from "@/modules/organization/service";
import { auditLogs, sessions, users } from "@/server/db/schema";
import { ValidationError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

const PASSWORD = "SenhaSegura2026";
let fx: Fixture;
let firmB: string;
let inactiveFirm: string;

beforeAll(async () => {
  fx = await setupFixture("usrv2");
  ({ id: firmB } = await createLawFirm(fx.ctx.adminB, { name: "Escritório da Organização B" }));
  ({ id: inactiveFirm } = await createLawFirm(fx.ctx.admin, { name: "Escritório Inativo (fictício)" }));
  await setLawFirmActive(fx.ctx.admin, inactiveFirm, false);
});

afterAll(async () => fx.teardown());

async function fieldErrorsOf(promise: Promise<unknown>): Promise<Record<string, string[]>> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as ValidationError).fieldErrors ?? {};
  }
  throw new Error("expected a ValidationError");
}

describe("external counsel users", () => {
  it("require a law firm of the organization, active, and have no unit", async () => {
    const { admin } = fx.ctx;
    const base = { name: "Advogada Externa", email: "externa@a.test", role: "external_counsel" as const, password: PASSWORD };

    expect((await fieldErrorsOf(createUser(admin, base))).lawFirmId).toBeDefined();
    expect((await fieldErrorsOf(createUser(admin, { ...base, lawFirmId: fx.lawFirmA, unitId: fx.unitSp }))).unitId).toBeDefined();
    // A law firm of another organization is rejected (tenant isolation).
    expect((await fieldErrorsOf(createUser(admin, { ...base, lawFirmId: firmB }))).lawFirmId?.[0]).toMatch(/organização/);
    expect((await fieldErrorsOf(createUser(admin, { ...base, lawFirmId: inactiveFirm }))).lawFirmId?.[0]).toMatch(/desativado/);

    const { id } = await createUser(admin, { ...base, lawFirmId: fx.lawFirmA });
    const detail = await getUser(admin, id);
    expect(detail).toMatchObject({ role: "external_counsel", lawFirmId: fx.lawFirmA, unitId: null });
    expect(detail.lawFirmName).toBe("Escritório Fictício A Advogados");
    const [audit] = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "user.create")));
    expect(audit.changes).toMatchObject({ lawFirmId: { from: null, to: fx.lawFirmA } });

    const filtered = await listUsers(admin, { lawFirmId: fx.lawFirmA });
    expect(filtered.items.map((u) => u.id).sort()).toEqual([id, fx.ctx.externalCounsel.userId].sort());
  });

  it("other roles never keep a law firm", async () => {
    const { admin } = fx.ctx;
    const { id } = await createUser(admin, {
      name: "Advogado Interno",
      email: "interno@a.test",
      role: "lawyer",
      unitId: fx.unitSp,
      lawFirmId: fx.lawFirmA,
      password: PASSWORD,
    });
    const [row] = await fx.db.select().from(users).where(eq(users.id, id));
    expect(row.lawFirmId).toBeNull();
    expect(row.unitId).toBe(fx.unitSp);
  });

  it("changing the law firm or the role revokes sessions and clears the firm", async () => {
    const { admin, externalCounsel } = fx.ctx;
    const userId = externalCounsel.userId!;
    const { id: otherFirm } = await createLawFirm(admin, { name: "Outro Escritório (fictício)" });
    const insertSession = (sid: string) =>
      fx.db.insert(sessions).values({ id: sid, userId, organizationId: fx.orgA, expiresAt: new Date(Date.now() + 3_600_000) });
    const sessionCount = async () => (await fx.db.select().from(sessions).where(eq(sessions.userId, userId))).length;
    const current = await getUser(admin, userId);
    const input = { name: current.name, role: current.role, unitId: null, lawFirmId: current.lawFirmId, isActive: true, teamIds: [] };

    await insertSession("ext-1");
    await updateUser(admin, userId, { ...input, jobTitle: "Sócia" });
    expect(await sessionCount()).toBe(1);

    await updateUser(admin, userId, { ...input, lawFirmId: otherFirm });
    expect(await sessionCount()).toBe(0);
    const updates = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, "user.update")));
    const firmChange = updates.find((a) => a.changes?.lawFirmId);
    expect(firmChange?.changes?.lawFirmId).toEqual({ from: fx.lawFirmA, to: otherFirm });
    expect(firmChange?.metadata).toMatchObject({ sessionsRevoked: true });

    await insertSession("ext-2");
    await updateUser(admin, userId, { ...input, role: "lawyer", unitId: fx.unitSp, lawFirmId: otherFirm });
    expect(await sessionCount()).toBe(0);
    const after = await getUser(admin, userId);
    expect(after).toMatchObject({ role: "lawyer", lawFirmId: null, unitId: fx.unitSp });
  });
});
