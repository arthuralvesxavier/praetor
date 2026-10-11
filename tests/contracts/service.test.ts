import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/analyses/service", () => ({
  markAnalysesStaleForEntity: vi.fn(async () => 0),
}));

import { and, eq } from "drizzle-orm";
import { createTestDatabase } from "../helpers/db";
import { addDaysISO, todayISO } from "@/lib/format";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import {
  addObligation,
  createContract,
  deleteContract,
  getContract,
  getContractKpis,
  listContractOptions,
  listContracts,
  removeObligation,
  updateContract,
  updateObligation,
} from "@/modules/contracts/service";
import type { ContractInput } from "@/modules/contracts/schemas";
import type { AuthContext } from "@/server/auth/context";
import type { Database } from "@/server/db/client";
import { auditLogs, contracts, legalProcesses, organizations, units, users } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";

let db: Database;
let close: () => Promise<void>;
const ids: Record<string, string> = {};
const today = todayISO();

function ctx(role: AuthContext["role"], userId: string, orgId: string, unitId: string | null): AuthContext {
  return { kind: "user", userId, organizationId: orgId, role, unitId, name: "Teste", email: "t@t", isDemoOrganization: false };
}
const adminA = () => ctx("admin", ids.adminA, ids.a, null);
const lawyerSp = () => ctx("lawyer", ids.lawyerSp, ids.a, ids.unitSp);
const lawyerRe = () => ctx("lawyer", ids.lawyerRe, ids.a, ids.unitRe);
const executive = () => ctx("executive", ids.exec, ids.a, null);
const adminB = () => ctx("admin", ids.adminB, ids.b, null);

function input(overrides: Partial<ContractInput> = {}): ContractInput {
  return {
    title: "Contrato de prestação de serviços de limpeza",
    counterparty: "Limpa Bem Serviços Ltda. (fictícia)",
    type: "services",
    status: "active",
    startDate: addDaysISO(today, -300),
    endDate: addDaysISO(today, 10),
    renewalType: "manual",
    renewalNoticeDays: 30,
    valueCents: 1_250_000,
    riskLevel: "medium",
    unitId: ids.unitSp,
    ...overrides,
  };
}

async function expectRejects<T extends Error>(p: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected ${type.name}`);
}

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [a] = await db.insert(organizations).values({ name: "Org A", slug: "org-a" }).returning();
  const [b] = await db.insert(organizations).values({ name: "Org B", slug: "org-b" }).returning();
  const [unitSp] = await db.insert(units).values({ organizationId: a.id, name: "São Paulo" }).returning();
  const [unitRe] = await db.insert(units).values({ organizationId: a.id, name: "Recife" }).returning();
  const [unitB] = await db.insert(units).values({ organizationId: b.id, name: "Matriz B" }).returning();
  const mk = async (org: string, email: string, role: AuthContext["role"], unitId: string | null) =>
    (await db.insert(users).values({ organizationId: org, name: email, email, passwordHash: "x", role, unitId }).returning())[0];
  const [adminAUser, lawyerSpUser, lawyerReUser, execUser, adminBUser] = [
    await mk(a.id, "admin@a", "admin", null),
    await mk(a.id, "adv-sp@a", "lawyer", unitSp.id),
    await mk(a.id, "adv-re@a", "lawyer", unitRe.id),
    await mk(a.id, "exec@a", "executive", null),
    await mk(b.id, "admin@b", "admin", null),
  ];
  const [processA] = await db
    .insert(legalProcesses)
    .values({ organizationId: a.id, number: "0001", title: "Processo A", court: "TJSP", area: "civil", phase: "knowledge", unitId: unitSp.id })
    .returning();
  Object.assign(ids, {
    a: a.id,
    b: b.id,
    unitSp: unitSp.id,
    unitRe: unitRe.id,
    unitB: unitB.id,
    adminA: adminAUser.id,
    lawyerSp: lawyerSpUser.id,
    lawyerRe: lawyerReUser.id,
    exec: execUser.id,
    adminB: adminBUser.id,
    processA: processA.id,
  });
});

afterAll(async () => close());

beforeEach(() => {
  vi.mocked(markAnalysesStaleForEntity).mockClear();
});

describe("contracts service", () => {
  it("creates a contract with audit and lists it in the expiring filter", async () => {
    const { id } = await createContract(lawyerSp(), input({ counterpartyDocument: "123.456.789-09", linkedProcessId: ids.processA }));
    ids.expiring = id;
    const { id: farId } = await createContract(lawyerSp(), input({ title: "Locação do galpão", type: "lease", endDate: addDaysISO(today, 200) }));
    ids.far = farId;
    await createContract(lawyerSp(), input({ title: "Minuta de NDA", type: "nda", status: "draft", endDate: addDaysISO(today, 5) }));
    await createContract(lawyerSp(), input({ title: "Fornecimento vencido", type: "supply", endDate: addDaysISO(today, -3) }));

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "contract.create")));
    expect(audit).toHaveLength(1);
    // The CPF/CNPJ is never stored in the audit trail.
    expect(JSON.stringify(audit[0].changes)).not.toContain("12345678909");

    const expiring = await listContracts(lawyerSp(), { expiring: true });
    expect(expiring.items.map((c) => c.id)).toEqual([id]);
    expect(expiring.items[0].vigency).toBe("vencendo");
    expect(expiring.items[0].daysToEnd).toBe(10);
    // CPF is masked in lists.
    expect(expiring.items[0].counterpartyDocumentMasked).toBe("***.456.789-**");

    const all = await listContracts(lawyerSp(), {});
    expect(all.total).toBe(4);
    const overdue = await listContracts(lawyerSp(), { overdue: true });
    expect(overdue.items.map((c) => c.title)).toEqual(["Fornecimento vencido"]);
    const search = await listContracts(lawyerSp(), { q: "galpão" });
    expect(search.items.map((c) => c.id)).toEqual([farId]);
    const byType = await listContracts(lawyerSp(), { type: "nda" });
    expect(byType.total).toBe(1);

    const kpis = await getContractKpis(lawyerSp());
    expect(kpis).toMatchObject({ active: 2, expiring: 1, expired: 1, expirationDays: 60 });
  });

  it("respects the organization's expiration window setting", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ids.a));
    await db
      .update(organizations)
      .set({ settings: { ...org.settings, alerts: { ...org.settings.alerts, contractExpirationDays: 300 } } })
      .where(eq(organizations.id, ids.a));
    try {
      const expiring = await listContracts(lawyerSp(), { expiring: true });
      expect(expiring.items.map((c) => c.id).sort()).toEqual([ids.expiring, ids.far].sort());
    } finally {
      await db.update(organizations).set({ settings: org.settings }).where(eq(organizations.id, ids.a));
    }
  });

  it("rejects endDate before startDate and invalid documents", async () => {
    const err = await expectRejects(
      createContract(lawyerSp(), input({ startDate: "2026-05-10", endDate: "2026-05-09" })),
      ValidationError,
    );
    expect(err.fieldErrors?.endDate?.[0]).toMatch(/anterior/);

    const doc = await expectRejects(createContract(lawyerSp(), input({ counterpartyDocument: "123" })), ValidationError);
    expect(doc.fieldErrors?.counterpartyDocument).toBeDefined();

    const date = await expectRejects(createContract(lawyerSp(), input({ endDate: "2026-02-30" })), ValidationError);
    expect(date.fieldErrors?.endDate).toBeDefined();
  });

  it("returns full detail with computed vigency and linked process", async () => {
    const detail = await getContract(lawyerSp(), ids.expiring);
    expect(detail.counterpartyDocument).toBe("12345678909");
    expect(detail.noticeDeadline).toBe(addDaysISO(today, -20));
    expect(detail.linkedProcess).toMatchObject({ id: ids.processA, visible: true });
    expect(detail.unitName).toBe("São Paulo");
  });

  it("isolates organizations", async () => {
    await expectRejects(getContract(adminB(), ids.expiring), NotFoundError);
    expect((await listContracts(adminB(), {})).total).toBe(0);
    expect(await listContractOptions(adminB())).toEqual([]);
    expect((await getContractKpis(adminB())).active).toBe(0);
    await expectRejects(updateContract(adminB(), ids.expiring, input()), NotFoundError);
    await expectRejects(deleteContract(adminB(), ids.expiring), NotFoundError);
    await expectRejects(addObligation(adminB(), ids.expiring, { description: "Entregar relatório" }), NotFoundError);

    // Foreign ids from another organization are rejected.
    const resp = await expectRejects(
      createContract(adminB(), input({ unitId: null, responsibleId: ids.lawyerSp })),
      ValidationError,
    );
    expect(resp.fieldErrors?.responsibleId).toBeDefined();
    const unit = await expectRejects(createContract(adminB(), input({ unitId: ids.unitSp })), ValidationError);
    expect(unit.fieldErrors?.unitId).toBeDefined();
    const proc = await expectRejects(
      createContract(adminB(), input({ unitId: ids.unitB, linkedProcessId: ids.processA })),
      ValidationError,
    );
    expect(proc.fieldErrors?.linkedProcessId).toBeDefined();
  });

  it("applies unit visibility to lawyers of other units", async () => {
    await expectRejects(getContract(lawyerRe(), ids.expiring), NotFoundError);
    expect((await listContracts(lawyerRe(), {})).total).toBe(0);
    await expectRejects(updateContract(lawyerRe(), ids.expiring, input()), NotFoundError);
  });

  it("lets executives read but never write", async () => {
    expect((await listContracts(executive(), {})).total).toBe(4);
    expect((await getContract(executive(), ids.expiring)).id).toBe(ids.expiring);
    await expectRejects(createContract(executive(), input()), ForbiddenError);
    await expectRejects(updateContract(executive(), ids.expiring, input()), ForbiddenError);
    await expectRejects(deleteContract(executive(), ids.expiring), ForbiddenError);
    await expectRejects(addObligation(executive(), ids.expiring, { description: "Pagar parcela" }), ForbiddenError);
  });

  it("only admins and legal managers set confidentiality", async () => {
    const err = await expectRejects(createContract(lawyerSp(), input({ isConfidential: true })), ValidationError);
    expect(err.fieldErrors?.isConfidential).toBeDefined();
    const { id } = await createContract(adminA(), input({ title: "Contrato confidencial", isConfidential: true }));
    await expectRejects(getContract(executive(), id), NotFoundError);
    await expectRejects(updateContract(lawyerSp(), id, input({ isConfidential: false })), NotFoundError);
  });

  it("updates with diff audit and marks analyses stale in the transaction", async () => {
    await updateContract(lawyerSp(), ids.far, input({ title: "Locação do galpão (aditivo 1)", type: "lease", endDate: addDaysISO(today, 400) }));
    expect(markAnalysesStaleForEntity).toHaveBeenCalledTimes(1);
    const [call] = vi.mocked(markAnalysesStaleForEntity).mock.calls;
    expect(call[0]).toMatchObject({ organizationId: ids.a, entityId: ids.far });
    expect(call[1]).toBeDefined(); // transaction handle

    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.far), eq(auditLogs.action, "contract.update")));
    expect(Object.keys(log.changes ?? {})).toEqual(expect.arrayContaining(["title", "endDate"]));

    // No-op update: no audit, no stale marking.
    vi.mocked(markAnalysesStaleForEntity).mockClear();
    await updateContract(lawyerSp(), ids.far, input({ title: "Locação do galpão (aditivo 1)", type: "lease", endDate: addDaysISO(today, 400) }));
    expect(markAnalysesStaleForEntity).not.toHaveBeenCalled();
  });

  it("manages obligations", async () => {
    const { id } = await addObligation(lawyerSp(), ids.expiring, {
      description: "Enviar relatório mensal de execução",
      responsibleId: ids.lawyerSp,
      dueDate: addDaysISO(today, 5),
      recurrence: "mensal",
    });
    let detail = await getContract(lawyerSp(), ids.expiring);
    expect(detail.obligations).toHaveLength(1);
    expect(detail.obligations[0]).toMatchObject({ status: "pending", origin: "manual", responsibleName: "adv-sp@a" });
    expect(detail.pendingObligations).toBe(1);
    expect((await getContractKpis(executive())).pendingObligations).toBe(1);

    await expectRejects(addObligation(lawyerSp(), ids.expiring, { description: "x", responsibleId: ids.adminB }), ValidationError);
    await expectRejects(updateObligation(adminB(), id, { status: "fulfilled" }), NotFoundError);
    await expectRejects(updateObligation(executive(), id, { status: "fulfilled" }), ForbiddenError);

    await updateObligation(lawyerSp(), id, { status: "fulfilled" });
    detail = await getContract(lawyerSp(), ids.expiring);
    expect(detail.obligations[0].status).toBe("fulfilled");
    expect(detail.obligations[0].recurrence).toBe("mensal"); // partial patch keeps other fields
    expect(detail.pendingObligations).toBe(0);
    const [statusLog] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.expiring), eq(auditLogs.action, "contract_obligation.status_change")));
    expect(statusLog.changes).toMatchObject({ status: { from: "pending", to: "fulfilled" } });

    await expectRejects(removeObligation(lawyerRe(), id), NotFoundError);
    expect(await removeObligation(lawyerSp(), id)).toEqual({ contractId: ids.expiring });
    expect((await getContract(lawyerSp(), ids.expiring)).obligations).toHaveLength(0);
  });

  it("soft-deletes with contract:delete and honors legal hold", async () => {
    await expectRejects(deleteContract(lawyerSp(), ids.expiring), ForbiddenError);

    await db.update(contracts).set({ legalHold: true }).where(eq(contracts.id, ids.expiring));
    await expectRejects(deleteContract(adminA(), ids.expiring), ConflictError);
    await db.update(contracts).set({ legalHold: false }).where(eq(contracts.id, ids.expiring));

    await deleteContract(adminA(), ids.expiring);
    await expectRejects(getContract(adminA(), ids.expiring), NotFoundError);
    const [row] = await db.select().from(contracts).where(eq(contracts.id, ids.expiring));
    expect(row.deletedAt).not.toBeNull();
    expect((await listContractOptions(adminA())).some((c) => c.id === ids.expiring)).toBe(false);
  });

  it("treats malformed ids as not found", async () => {
    await expectRejects(getContract(adminA(), "nao-e-um-uuid"), NotFoundError);
  });
});
