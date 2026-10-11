import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDatabase } from "../helpers/db";
import type { AuthContext } from "@/server/auth/context";
import type { Database } from "@/server/db/client";
import {
  auditLogs,
  deadlines,
  legalProcesses,
  occurrences,
  organizations,
  processEvents,
  units,
  users,
} from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";

// Cross-module services written by other modules: stubbed here.
const mocks = vi.hoisted(() => ({
  markAnalysesStaleForEntity: vi.fn(async () => 0),
  linkOccurrenceToProcess: vi.fn(async () => undefined),
}));
vi.mock("@/modules/analyses/service", () => ({ markAnalysesStaleForEntity: mocks.markAnalysesStaleForEntity }));
vi.mock("@/modules/occurrences/service", () => ({ linkOccurrenceToProcess: mocks.linkOccurrenceToProcess }));

const {
  addParty,
  addProcessEvent,
  createProcess,
  deleteProcess,
  escapeLike,
  getProcess,
  getProcessSummary,
  listProcessOptions,
  listProcesses,
  removeParty,
  removeProcessEvent,
  updateParty,
  updateProcess,
} = await import("@/modules/processes/service");
const { isCnjNumberFormat } = await import("@/modules/processes/schemas");

let db: Database;
let close: () => Promise<void>;
const ids: Record<string, string> = {};

function ctx(role: AuthContext["role"], userId: string, orgId: string, unitId: string | null): AuthContext {
  return { kind: "user", userId, organizationId: orgId, role, unitId, name: role, email: `${role}@x`, isDemoOrganization: false };
}
let admin: AuthContext;
let manager: AuthContext;
let lawyerSp: AuthContext;
let lawyerRe: AuthContext;
let executive: AuthContext;
let adminB: AuthContext;

const base = {
  title: "Reclamação trabalhista — ex-colaborador (fictício)",
  court: "TRT-2",
  area: "labor" as const,
  phase: "knowledge" as const,
};

async function auditFor(entityId: string, action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action)));
}

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [a] = await db.insert(organizations).values({ name: "Org A", slug: "org-a" }).returning();
  const [b] = await db.insert(organizations).values({ name: "Org B", slug: "org-b" }).returning();
  const [sp] = await db.insert(units).values({ organizationId: a.id, name: "Matriz SP" }).returning();
  const [re] = await db.insert(units).values({ organizationId: a.id, name: "Filial Recife" }).returning();
  const [ub] = await db.insert(units).values({ organizationId: b.id, name: "Unidade B" }).returning();
  const mk = async (org: string, email: string, role: AuthContext["role"], unitId: string | null, isActive = true) =>
    (
      await db
        .insert(users)
        .values({ organizationId: org, name: `Pessoa ${email}`, email, passwordHash: "x", role, unitId, isActive })
        .returning()
    )[0];
  const uAdmin = await mk(a.id, "admin@a", "admin", null);
  const uManager = await mk(a.id, "gestor@a", "legal_manager", null);
  const uLawyerSp = await mk(a.id, "adv.sp@a", "lawyer", sp.id);
  const uLawyerRe = await mk(a.id, "adv.re@a", "lawyer", re.id);
  const uExec = await mk(a.id, "exec@a", "executive", null);
  const uInactive = await mk(a.id, "inativo@a", "lawyer", sp.id, false);
  const uAdminB = await mk(b.id, "admin@b", "admin", ub.id);
  Object.assign(ids, {
    a: a.id,
    b: b.id,
    sp: sp.id,
    re: re.id,
    ub: ub.id,
    lawyerSp: uLawyerSp.id,
    lawyerRe: uLawyerRe.id,
    inactive: uInactive.id,
    adminB: uAdminB.id,
  });
  admin = ctx("admin", uAdmin.id, a.id, null);
  manager = ctx("legal_manager", uManager.id, a.id, null);
  lawyerSp = ctx("lawyer", uLawyerSp.id, a.id, sp.id);
  lawyerRe = ctx("lawyer", uLawyerRe.id, a.id, re.id);
  executive = ctx("executive", uExec.id, a.id, null);
  adminB = ctx("admin", uAdminB.id, b.id, ub.id);

  // A process of org B with a number that also exists in org A later (uniqueness is per org).
  await db.insert(legalProcesses).values({
    organizationId: b.id,
    number: "9999999-99.2024.8.26.0001",
    title: "Processo da organização B",
    court: "TJSP",
    area: "civil",
    phase: "knowledge",
    unitId: ub.id,
  });
});

afterAll(async () => close());

beforeEach(() => {
  mocks.markAnalysesStaleForEntity.mockClear();
  mocks.linkOccurrenceToProcess.mockReset();
  mocks.linkOccurrenceToProcess.mockResolvedValue(undefined);
});

describe("processes service", () => {
  it("creates a process with audit and lists it with names", async () => {
    const { id, occurrenceLinkError } = await createProcess(lawyerSp, {
      ...base,
      number: "0001234-56.2024.5.02.0001",
      unitId: ids.sp,
      responsibleId: ids.lawyerSp,
      claimAmountCents: 15_000_00,
    });
    expect(occurrenceLinkError).toBeNull();
    ids.p1 = id;

    const audit = await auditFor(id, "legal_process.create");
    expect(audit).toHaveLength(1);
    expect(audit[0].organizationId).toBe(ids.a);
    expect(audit[0].changes?.number).toEqual({ from: null, to: "0001234-56.2024.5.02.0001" });

    const list = await listProcesses(lawyerSp, {});
    const item = list.items.find((i) => i.id === id);
    expect(item).toMatchObject({
      responsibleName: "Pessoa adv.sp@a",
      unitName: "Matriz SP",
      status: "active",
      riskLevel: "medium",
      dataOrigin: "manual",
      isCnjFormat: true,
      openDeadlineCount: 0,
    });

    const detail = await getProcess(lawyerSp, id);
    expect(detail.createdByName).toBe("Pessoa adv.sp@a");
    expect(detail.permissions).toEqual({ canEdit: true, canDelete: false, canEditConfidential: false });
  });

  it("updates with a field diff in the audit and marks analyses stale", async () => {
    await updateProcess(lawyerSp, ids.p1, { phase: "appeal", riskLevel: "high", title: base.title });
    const audit = await auditFor(ids.p1, "legal_process.update");
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toEqual({
      phase: { from: "knowledge", to: "appeal" },
      riskLevel: { from: "medium", to: "high" },
    });
    expect(mocks.markAnalysesStaleForEntity).toHaveBeenCalledTimes(1);
    const [input] = mocks.markAnalysesStaleForEntity.mock.calls[0] as unknown as [
      { organizationId: string; entityId: string; reason: string },
    ];
    expect(input.organizationId).toBe(ids.a);
    expect(input.entityId).toBe(ids.p1);
    expect(input.reason).toMatch(/^Dados do processo alterados: .*fase/);

    // No-op update writes nothing.
    await updateProcess(lawyerSp, ids.p1, { phase: "appeal" });
    expect(await auditFor(ids.p1, "legal_process.update")).toHaveLength(1);
  });

  it("rejects duplicate numbers in the same organization only", async () => {
    await expect(
      createProcess(manager, { ...base, number: "0001234-56.2024.5.02.0001" }),
    ).rejects.toBeInstanceOf(ConflictError);

    const other = await createProcess(manager, { ...base, number: "9999999-99.2024.8.26.0001" });
    await expect(
      updateProcess(manager, other.id, { number: "0001234-56.2024.5.02.0001" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("accepts numbers outside the CNJ shape and flags them", async () => {
    const { id } = await createProcess(manager, { ...base, number: "Proc. adm. 123/2024" });
    const detail = await getProcess(manager, id);
    expect(detail.number).toBe("Proc. adm. 123/2024");
    expect(detail.isCnjFormat).toBe(false);
    expect(isCnjNumberFormat("0001234-56.2024.5.02.0001")).toBe(true);
    expect(isCnjNumberFormat("00012345620245020001")).toBe(false);
  });

  it("forbids executives from creating", async () => {
    await expect(createProcess(executive, { ...base, number: "1" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides processes of another unit from lawyers (NotFoundError)", async () => {
    await expect(getProcess(lawyerRe, ids.p1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateProcess(lawyerRe, ids.p1, { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
    const list = await listProcesses(lawyerRe, {});
    expect(list.items.map((i) => i.id)).not.toContain(ids.p1);
    await expect(getProcess(lawyerRe, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("isolates organizations", async () => {
    const listB = await listProcesses(adminB, {});
    expect(listB.items.map((i) => i.title)).toEqual(["Processo da organização B"]);
    await expect(getProcess(adminB, ids.p1)).rejects.toBeInstanceOf(NotFoundError);
    const listA = await listProcesses(admin, { q: "organização B" });
    expect(listA.total).toBe(0);
    const options = await listProcessOptions(admin);
    expect(options.some((o) => o.title === "Processo da organização B")).toBe(false);
  });

  it("validates responsible and unit against the organization", async () => {
    const err = await createProcess(admin, { ...base, number: "X-1", responsibleId: ids.adminB }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors?.responsibleId).toBeDefined();

    const inactive = await createProcess(admin, { ...base, number: "X-2", responsibleId: ids.inactive }).catch((e) => e);
    expect(inactive).toBeInstanceOf(ValidationError);

    const unit = await createProcess(admin, { ...base, number: "X-3", unitId: ids.ub }).catch((e) => e);
    expect(unit).toBeInstanceOf(ValidationError);
    expect((unit as ValidationError).fieldErrors?.unitId).toBeDefined();

    await expect(updateProcess(admin, ids.p1, { responsibleId: ids.adminB })).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates input fields with pt-BR messages", async () => {
    const err = await createProcess(admin, {
      ...base,
      number: "",
      area: "nope" as never,
      claimAmountCents: Number.NaN,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const fe = (err as ValidationError).fieldErrors ?? {};
    expect(fe.number?.[0]).toBe("Informe o número do processo.");
    expect(fe.area).toBeDefined();
    expect(fe.claimAmountCents).toBeDefined();

    const dates = await createProcess(admin, { ...base, number: "X-4", filedAt: "2024-05-10", closedAt: "2024-01-01" }).catch(
      (e) => e,
    );
    expect((dates as ValidationError).fieldErrors?.closedAt).toBeDefined();
    // Checked against stored values on partial updates too.
    await updateProcess(lawyerSp, ids.p1, { filedAt: "2024-05-10" });
    await expect(updateProcess(lawyerSp, ids.p1, { closedAt: "2024-01-01" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("searches by party name and escapes LIKE wildcards", async () => {
    await addParty(lawyerSp, ids.p1, { name: "Fulano de Tal (fictício)", role: "plaintiff", documentNumber: "123.456.789-09" });
    const byParty = await listProcesses(lawyerSp, { q: "fulano" });
    expect(byParty.items.map((i) => i.id)).toEqual([ids.p1]);
    const byDigits = await listProcesses(lawyerSp, { q: "00012345620245" });
    expect(byDigits.items.map((i) => i.id)).toEqual([ids.p1]);
    const wildcard = await listProcesses(admin, { q: "%" });
    expect(wildcard.total).toBe(0);
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
    const filtered = await listProcesses(admin, { riskLevel: "high", status: "active" });
    expect(filtered.items.map((i) => i.id)).toEqual([ids.p1]);
  });

  it("only lets admin / legal manager set confidentiality", async () => {
    const { id: lawyerConf } = await createProcess(lawyerSp, { ...base, number: "C-1", isConfidential: true });
    expect((await getProcess(lawyerSp, lawyerConf)).isConfidential).toBe(false);

    const { id: managerConf } = await createProcess(manager, { ...base, number: "C-2", isConfidential: true, unitId: ids.sp });
    expect((await getProcess(manager, managerConf)).isConfidential).toBe(true);
    // Confidential + not responsible/creator: invisible to the unit lawyer and to executives.
    await expect(getProcess(lawyerSp, managerConf)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProcess(executive, managerConf)).rejects.toBeInstanceOf(NotFoundError);

    await updateProcess(lawyerSp, lawyerConf, { isConfidential: true });
    expect((await getProcess(admin, lawyerConf)).isConfidential).toBe(false);
  });

  it("soft-deletes with process:delete and respects legal hold", async () => {
    const { id } = await createProcess(lawyerSp, { ...base, number: "D-1" });
    await expect(deleteProcess(lawyerSp, id)).rejects.toBeInstanceOf(ForbiddenError);

    await db.update(legalProcesses).set({ legalHold: true }).where(eq(legalProcesses.id, id));
    await expect(deleteProcess(manager, id)).rejects.toBeInstanceOf(ConflictError);

    await db.update(legalProcesses).set({ legalHold: false }).where(eq(legalProcesses.id, id));
    await deleteProcess(manager, id);
    await expect(getProcess(manager, id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await auditFor(id, "legal_process.delete")).toHaveLength(1);
    // The number is free again after deletion.
    await createProcess(manager, { ...base, number: "D-1" });
  });

  it("links the origin occurrence and keeps the process when linking fails", async () => {
    const [occ] = await db
      .insert(occurrences)
      .values({
        organizationId: ids.a,
        title: "Ocorrência fictícia",
        facts: "Fatos fictícios.",
        category: "labor",
        reportedOn: "2026-01-10",
        unitId: ids.sp,
        isConfidential: true,
        responsibleId: ids.lawyerSp,
      })
      .returning();

    const ok = await createProcess(lawyerSp, { ...base, number: "O-1", fromOccurrenceId: occ.id });
    expect(mocks.linkOccurrenceToProcess).toHaveBeenCalledWith(lawyerSp, occ.id, ok.id);
    expect(ok.occurrenceLinkError).toBeNull();
    // Inherits confidentiality from the confidential occurrence (lawyer cannot choose otherwise).
    expect((await getProcess(admin, ok.id)).isConfidential).toBe(true);

    mocks.linkOccurrenceToProcess.mockRejectedValueOnce(new ForbiddenError());
    const failed = await createProcess(lawyerSp, { ...base, number: "O-2", fromOccurrenceId: occ.id });
    expect(failed.occurrenceLinkError).toBe(new ForbiddenError().message);
    expect((await getProcess(lawyerSp, failed.id)).number).toBe("O-2");

    // An occurrence the user cannot see is rejected before anything is created.
    await expect(
      createProcess(lawyerRe, { ...base, number: "O-3", fromOccurrenceId: occ.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("manages parties with normalized documents", async () => {
    const { id } = await addParty(lawyerSp, ids.p1, {
      name: "Empresa Exemplo Ltda. (fictícia)",
      role: "defendant",
      documentNumber: "12.345.678/0001-90",
      isClient: true,
    });
    let detail = await getProcess(lawyerSp, ids.p1);
    expect(detail.parties.find((p) => p.id === id)?.documentNumber).toBe("12345678000190");

    const bad = await addParty(lawyerSp, ids.p1, { name: "X", role: "other", documentNumber: "123" }).catch((e) => e);
    expect(bad).toBeInstanceOf(ValidationError);

    await updateParty(lawyerSp, id, { name: "Empresa Exemplo S.A. (fictícia)", role: "defendant", isClient: true });
    await expect(updateParty(lawyerRe, id, { name: "x", role: "other" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeParty(adminB, id)).rejects.toBeInstanceOf(NotFoundError);
    await removeParty(lawyerSp, id);
    detail = await getProcess(lawyerSp, ids.p1);
    expect(detail.parties.some((p) => p.id === id)).toBe(false);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, ids.p1));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["legal_process.party_add", "legal_process.party_update", "legal_process.party_remove"]),
    );
    // Document numbers never reach the audit trail in clear text.
    expect(JSON.stringify(audits)).not.toContain("12345678000190");
  });

  it("adds/removes manual movements; imported movements are read-only", async () => {
    const { id } = await addProcessEvent(lawyerSp, ids.p1, {
      occurredAt: "2026-02-01",
      type: "hearing",
      title: "Audiência de conciliação designada",
    });
    const [imported] = await db
      .insert(processEvents)
      .values({
        organizationId: ids.a,
        processId: ids.p1,
        occurredAt: "2026-01-15",
        type: "publication",
        title: "Publicação importada",
        origin: "imported",
        externalSource: "planilha-fictícia.csv",
      })
      .returning();

    const detail = await getProcess(lawyerSp, ids.p1);
    expect(detail.events.map((e) => e.id)).toEqual([id, imported.id]);
    expect(detail.events.find((e) => e.id === imported.id)?.removable).toBe(false);

    await expect(removeProcessEvent(lawyerSp, imported.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(removeProcessEvent(lawyerRe, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addProcessEvent(executive, ids.p1, { occurredAt: "2026-02-01", type: "note", title: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await removeProcessEvent(lawyerSp, id);
    expect((await getProcess(lawyerSp, ids.p1)).events.map((e) => e.id)).toEqual([imported.id]);
  });

  it("counts real open deadlines per process in the list", async () => {
    const d = { organizationId: ids.a, kind: "procedural" as const, processId: ids.p1 };
    await db.insert(deadlines).values([
      { ...d, title: "Contestação", dueDate: "2026-11-20" },
      { ...d, title: "Réplica", dueDate: "2026-11-05" },
      { ...d, title: "Cumprido", dueDate: "2026-10-01", status: "done" },
      { ...d, title: "Sugestão IA", dueDate: "2026-10-02", origin: "ai_suggested", validationStatus: "pending_validation" },
    ]);
    const list = await listProcesses(lawyerSp, { q: "0001234-56" });
    expect(list.items[0]).toMatchObject({ id: ids.p1, openDeadlineCount: 2, nextDeadlineDate: "2026-11-05" });
  });

  it("summarizes visible processes", async () => {
    const all = await getProcessSummary(admin);
    const unitLawyer = await getProcessSummary(lawyerRe);
    expect(all.total).toBeGreaterThan(unitLawyer.total);
    expect(all.highRisk).toBeGreaterThanOrEqual(1);
    const b = await getProcessSummary(adminB);
    expect(b).toEqual({ total: 1, active: 1, highRisk: 0 });
  });
});
