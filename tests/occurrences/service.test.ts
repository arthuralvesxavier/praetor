import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/modules/analyses/service", () => ({
  markAnalysesStaleForEntity: vi.fn(async () => 0),
}));

import { createTestDatabase } from "../helpers/db";
import type { AuthContext } from "@/server/auth/context";
import type { Database } from "@/server/db/client";
import { auditLogs, legalProcesses, occurrences, organizations, tasks, units, users } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import {
  createOccurrence,
  deleteOccurrence,
  getActionPlanProgress,
  getOccurrence,
  getOccurrenceStats,
  linkOccurrenceToProcess,
  listOccurrenceOptions,
  listOccurrences,
  unlinkOccurrenceFromProcess,
  updateOccurrence,
} from "@/modules/occurrences/service";
import { todayISO } from "@/lib/format";

let db: Database;
let close: () => Promise<void>;
const ids: Record<string, string> = {};
const ctxs: Record<string, AuthContext> = {};

const markStale = vi.mocked(markAnalysesStaleForEntity);

function mkCtx(role: AuthContext["role"], userId: string, orgId: string, unitId: string | null): AuthContext {
  return { kind: "user", userId, organizationId: orgId, role, unitId, name: role, email: `${role}@x`, isDemoOrganization: false };
}

const baseInput = {
  title: "Reclamação recorrente de horas extras",
  facts: "Colaboradores do turno noturno relatam horas extras não pagas desde março.",
  category: "labor" as const,
};

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [a] = await db.insert(organizations).values({ name: "A", slug: "occ-a" }).returning();
  const [b] = await db.insert(organizations).values({ name: "B", slug: "occ-b" }).returning();
  const [sp] = await db.insert(units).values({ organizationId: a.id, name: "SP" }).returning();
  const [re] = await db.insert(units).values({ organizationId: a.id, name: "RE" }).returning();
  const [unitB] = await db.insert(units).values({ organizationId: b.id, name: "B1" }).returning();
  const mk = async (org: string, email: string, role: AuthContext["role"], unitId: string | null, isActive = true) =>
    (await db.insert(users).values({ organizationId: org, name: email, email, passwordHash: "x", role, unitId, isActive }).returning())[0];
  const admin = await mk(a.id, "admin@occ-a", "admin", null);
  const manager = await mk(a.id, "manager@occ-a", "legal_manager", null);
  const lawyerSp = await mk(a.id, "lawyer.sp@occ-a", "lawyer", sp.id);
  const lawyerRe = await mk(a.id, "lawyer.re@occ-a", "lawyer", re.id);
  const analystSp = await mk(a.id, "analyst.sp@occ-a", "analyst", sp.id);
  const exec = await mk(a.id, "exec@occ-a", "executive", null);
  const inactive = await mk(a.id, "inactive@occ-a", "lawyer", sp.id, false);
  const adminB = await mk(b.id, "admin@occ-b", "admin", null);

  const proc = { court: "TJSP", area: "labor" as const, phase: "knowledge" as const };
  const [pSp] = await db.insert(legalProcesses).values({ ...proc, organizationId: a.id, number: "100", title: "SP", unitId: sp.id }).returning();
  const [pRe] = await db.insert(legalProcesses).values({ ...proc, organizationId: a.id, number: "200", title: "RE", unitId: re.id }).returning();
  const [pConf] = await db
    .insert(legalProcesses)
    .values({ ...proc, organizationId: a.id, number: "300", title: "Conf", unitId: sp.id, isConfidential: true })
    .returning();
  const [pB] = await db.insert(legalProcesses).values({ ...proc, organizationId: b.id, number: "100", title: "B" }).returning();

  Object.assign(ids, {
    a: a.id, b: b.id, sp: sp.id, re: re.id, unitB: unitB.id,
    admin: admin.id, manager: manager.id, lawyerSp: lawyerSp.id, lawyerRe: lawyerRe.id, analystSp: analystSp.id,
    exec: exec.id, inactive: inactive.id, adminB: adminB.id,
    pSp: pSp.id, pRe: pRe.id, pConf: pConf.id, pB: pB.id,
  });
  Object.assign(ctxs, {
    admin: mkCtx("admin", admin.id, a.id, null),
    manager: mkCtx("legal_manager", manager.id, a.id, null),
    lawyerSp: mkCtx("lawyer", lawyerSp.id, a.id, sp.id),
    lawyerRe: mkCtx("lawyer", lawyerRe.id, a.id, re.id),
    analystSp: mkCtx("analyst", analystSp.id, a.id, sp.id),
    exec: mkCtx("executive", exec.id, a.id, null),
    adminB: mkCtx("admin", adminB.id, b.id, null),
  });
});

afterAll(async () => close());

beforeEach(() => {
  markStale.mockClear();
});

describe("occurrences service", () => {
  it("lets an analyst create an occurrence, with defaults and audit", async () => {
    const { id } = await createOccurrence(ctxs.analystSp, {
      ...baseInput,
      unitId: ids.sp,
      areasInvolved: ["RH", "Operações", "rh"],
      missingInformation: ["Espelhos de ponto de março"],
      estimatedExposureCents: 1_500_000,
    });
    const [row] = await db.select().from(occurrences).where(eq(occurrences.id, id));
    expect(row.organizationId).toBe(ids.a);
    expect(row.status).toBe("open");
    expect(row.riskLevel).toBe("medium");
    expect(row.reportedById).toBe(ids.analystSp);
    expect(row.createdById).toBe(ids.analystSp);
    expect(row.reportedOn).toBe(todayISO());
    expect(row.areasInvolved).toEqual(["RH", "Operações"]);
    expect(row.isConfidential).toBe(false);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "occurrence.create")));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBe(ids.analystSp);
    expect(audit[0].organizationId).toBe(ids.a);
  });

  it("forbids executives from creating occurrences", async () => {
    await expect(createOccurrence(ctxs.exec, baseInput)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("validates input and foreign ids", async () => {
    await expect(createOccurrence(ctxs.lawyerSp, { ...baseInput, title: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createOccurrence(ctxs.lawyerSp, { ...baseInput, unitId: ids.unitB })).rejects.toMatchObject({
      fieldErrors: { unitId: expect.any(Array) },
    });
    await expect(createOccurrence(ctxs.lawyerSp, { ...baseInput, responsibleId: ids.adminB })).rejects.toMatchObject({
      fieldErrors: { responsibleId: expect.any(Array) },
    });
    await expect(createOccurrence(ctxs.lawyerSp, { ...baseInput, responsibleId: ids.inactive })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      createOccurrence(ctxs.lawyerSp, { ...baseInput, status: "converted_to_process" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createOccurrence(ctxs.lawyerSp, { ...baseInput, occurredOn: "2026-05-10", reportedOn: "2026-05-01" }),
    ).rejects.toMatchObject({ fieldErrors: { occurredOn: expect.any(Array) } });
  });

  it("only lets admins and legal managers mark occurrences as confidential", async () => {
    await expect(createOccurrence(ctxs.lawyerSp, { ...baseInput, isConfidential: true })).rejects.toMatchObject({
      fieldErrors: { isConfidential: expect.any(Array) },
    });
    const { id } = await createOccurrence(ctxs.manager, { ...baseInput, isConfidential: true, unitId: ids.sp });
    // Lawyers of the unit do not see confidential occurrences.
    await expect(getOccurrence(ctxs.lawyerSp, id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getOccurrence(ctxs.admin, id)).isConfidential).toBe(true);
  });

  it("updates fields, sets resolvedAt, audits the diff and marks analyses stale", async () => {
    const { id } = await createOccurrence(ctxs.lawyerSp, { ...baseInput, unitId: ids.sp });
    await updateOccurrence(ctxs.lawyerSp, id, {
      status: "resolved",
      riskLevel: "high",
      facts: "Fatos complementados após entrevista com a liderança do turno.",
    });
    const detail = await getOccurrence(ctxs.lawyerSp, id);
    expect(detail.status).toBe("resolved");
    expect(detail.riskLevel).toBe("high");
    expect(detail.resolvedAt).toBeInstanceOf(Date);
    expect(detail.unitId).toBe(ids.sp); // omitted fields are kept

    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "occurrence.update")));
    expect(audit.changes).toMatchObject({ status: { from: "open", to: "resolved" }, riskLevel: { from: "medium", to: "high" } });
    expect(markStale).toHaveBeenCalledTimes(1);
    expect(markStale.mock.calls[0][0]).toMatchObject({ organizationId: ids.a, entityId: id });

    // Reopening clears resolvedAt.
    await updateOccurrence(ctxs.lawyerSp, id, { status: "monitoring" });
    expect((await getOccurrence(ctxs.lawyerSp, id)).resolvedAt).toBeNull();

    // Changes that do not affect analyses (responsible) do not mark them stale.
    markStale.mockClear();
    await updateOccurrence(ctxs.lawyerSp, id, { responsibleId: ids.lawyerSp });
    expect(markStale).not.toHaveBeenCalled();

    // No-op updates do not write audit entries.
    const before = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    await updateOccurrence(ctxs.lawyerSp, id, { responsibleId: ids.lawyerSp });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).toHaveLength(before.length);
  });

  it("rejects foreign ids from another organization on update", async () => {
    const { id } = await createOccurrence(ctxs.lawyerSp, { ...baseInput, unitId: ids.sp });
    await expect(updateOccurrence(ctxs.lawyerSp, id, { unitId: ids.unitB })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateOccurrence(ctxs.lawyerSp, id, { reportedById: ids.adminB })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateOccurrence(ctxs.lawyerSp, id, { isConfidential: true })).rejects.toBeInstanceOf(ValidationError);
  });

  it("links an occurrence to a visible process and converts it", async () => {
    const { id } = await createOccurrence(ctxs.lawyerSp, { ...baseInput, unitId: ids.sp });
    await linkOccurrenceToProcess(ctxs.lawyerSp, id, ids.pSp);
    const detail = await getOccurrence(ctxs.lawyerSp, id);
    expect(detail.status).toBe("converted_to_process");
    expect(detail.linkedProcess).toMatchObject({ id: ids.pSp, visible: true, number: "100" });
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "occurrence.link_process")));
    expect(audit).toHaveLength(1);
    expect(markStale).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ids.a, entityId: id }), expect.anything());

    // The converted status cannot be set by hand without a link, but unlinking reverts it.
    await unlinkOccurrenceFromProcess(ctxs.lawyerSp, id);
    const after = await getOccurrence(ctxs.lawyerSp, id);
    expect(after.linkedProcess).toBeNull();
    expect(after.status).toBe("under_analysis");
    await expect(updateOccurrence(ctxs.lawyerSp, id, { status: "converted_to_process" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(unlinkOccurrenceFromProcess(ctxs.lawyerSp, id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("cannot link to a process from another organization or invisible to the user", async () => {
    const { id } = await createOccurrence(ctxs.lawyerSp, { ...baseInput, unitId: ids.sp });
    await expect(linkOccurrenceToProcess(ctxs.lawyerSp, id, ids.pB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(linkOccurrenceToProcess(ctxs.lawyerSp, id, ids.pRe)).rejects.toBeInstanceOf(NotFoundError);
    await expect(linkOccurrenceToProcess(ctxs.lawyerSp, id, ids.pConf)).rejects.toBeInstanceOf(NotFoundError);
    await expect(linkOccurrenceToProcess(ctxs.lawyerSp, id, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(linkOccurrenceToProcess(ctxs.exec, id, ids.pSp)).rejects.toBeInstanceOf(ForbiddenError);
    const [row] = await db.select().from(occurrences).where(eq(occurrences.id, id));
    expect(row.linkedProcessId).toBeNull();
    expect(row.status).toBe("open");
  });

  it("hides the linked process details when the process is not visible", async () => {
    const { id } = await createOccurrence(ctxs.admin, { ...baseInput, unitId: ids.sp });
    await linkOccurrenceToProcess(ctxs.admin, id, ids.pConf);
    const seenByLawyer = await getOccurrence(ctxs.lawyerSp, id);
    expect(seenByLawyer.linkedProcess).toEqual({ id: ids.pConf, visible: false, number: null, title: null, status: null });
  });

  it("isolates organizations and units", async () => {
    const { id } = await createOccurrence(ctxs.lawyerSp, { ...baseInput, title: "Ocorrência isolada SP", unitId: ids.sp });
    await expect(getOccurrence(ctxs.adminB, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateOccurrence(ctxs.adminB, id, { title: "Invasão" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteOccurrence(ctxs.adminB, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(linkOccurrenceToProcess(ctxs.adminB, id, ids.pB)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listOccurrences(ctxs.adminB, {})).total).toBe(0);
    expect(await listOccurrenceOptions(ctxs.adminB)).toEqual([]);
    expect((await getOccurrenceStats(ctxs.adminB)).total).toBe(0);

    // Lawyer of another unit does not see it; executive (org-wide, non-confidential) does.
    await expect(getOccurrence(ctxs.lawyerRe, id)).rejects.toBeInstanceOf(NotFoundError);
    const listRe = await listOccurrences(ctxs.lawyerRe, { q: "isolada" });
    expect(listRe.total).toBe(0);
    const listExec = await listOccurrences(ctxs.exec, { q: "isolada" });
    expect(listExec.items.map((o) => o.id)).toEqual([id]);
  });

  it("filters and searches the list", async () => {
    const { id } = await createOccurrence(ctxs.manager, {
      ...baseInput,
      title: "Vazamento de dados de clientes",
      facts: "Planilha com dados pessoais enviada por engano a fornecedor.",
      category: "data_privacy",
      riskLevel: "critical",
      involvedParties: "Fornecedor Alfa Logística (fictício)",
      areasInvolved: ["TI"],
      responsibleId: ids.lawyerSp,
    });
    const byParty = await listOccurrences(ctxs.manager, { q: "alfa log" });
    expect(byParty.items.map((o) => o.id)).toContain(id);
    const byArea = await listOccurrences(ctxs.manager, { q: "TI", category: "data_privacy" });
    expect(byArea.items.map((o) => o.id)).toEqual([id]);
    const highOrCritical = await listOccurrences(ctxs.manager, { riskLevel: ["high", "critical"] });
    expect(highOrCritical.items.every((o) => o.riskLevel === "high" || o.riskLevel === "critical")).toBe(true);
    expect(highOrCritical.items.map((o) => o.id)).toContain(id);
    const byResponsible = await listOccurrences(ctxs.manager, { responsibleId: ids.lawyerSp, category: "data_privacy" });
    expect(byResponsible.items[0]).toMatchObject({ id, responsibleName: "lawyer.sp@occ-a" });
    expect((await listOccurrences(ctxs.manager, { q: "%" })).total).toBe(0);

    const stats = await getOccurrenceStats(ctxs.manager);
    expect(stats.highRisk).toBe(highOrCritical.total);
    // Responsible lawyer sees it even without unit match.
    expect((await getOccurrence(ctxs.lawyerSp, id)).id).toBe(id);
  });

  it("summarizes the action plan from visible tasks", async () => {
    const { id } = await createOccurrence(ctxs.lawyerSp, { ...baseInput, unitId: ids.sp });
    const t = { organizationId: ids.a, occurrenceId: id, kind: "action_plan" as const };
    await db.insert(tasks).values([
      { ...t, title: "Levantar espelhos de ponto", status: "done" },
      { ...t, title: "Entrevistar liderança", status: "todo", dueDate: "2020-01-01" },
      { ...t, title: "Revisar política", status: "cancelled" },
      { ...t, title: "Tarefa geral", kind: "general", status: "todo" },
    ]);
    expect(await getActionPlanProgress(ctxs.lawyerSp, id)).toEqual({ total: 2, done: 1, inProgress: 0, blocked: 0, overdue: 1 });
    await expect(getActionPlanProgress(ctxs.adminB, id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("soft-deletes with occurrence:delete and respects legal hold", async () => {
    const { id } = await createOccurrence(ctxs.lawyerSp, { ...baseInput, unitId: ids.sp });
    await expect(deleteOccurrence(ctxs.lawyerSp, id)).rejects.toBeInstanceOf(ForbiddenError);

    await db.update(occurrences).set({ legalHold: true }).where(eq(occurrences.id, id));
    await expect(deleteOccurrence(ctxs.manager, id)).rejects.toBeInstanceOf(ConflictError);

    await db.update(occurrences).set({ legalHold: false }).where(eq(occurrences.id, id));
    await deleteOccurrence(ctxs.manager, id);
    await expect(getOccurrence(ctxs.manager, id)).rejects.toBeInstanceOf(NotFoundError);
    const [row] = await db.select().from(occurrences).where(eq(occurrences.id, id));
    expect(row.deletedAt).toBeInstanceOf(Date);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "occurrence.delete")));
    expect(audit).toHaveLength(1);
  });
});
