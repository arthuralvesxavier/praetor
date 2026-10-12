import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeContract, setupFixture, type Fixture } from "../helpers/fixtures";
import { addDaysISO, todayISO } from "@/lib/format";
import { addMonthsISO } from "@/modules/contracts/obligations";
import {
  addObligation,
  fulfillObligation,
  getContract,
  getContractKpis,
  listContractDocumentOptions,
  listContractLifecycle,
  listContracts,
  renewContract,
  terminateContract,
} from "@/modules/contracts/service";
import { alerts, auditLogs, contractObligations, contracts, documents } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";

let fx: Fixture;
const today = todayISO();
const ids: Record<string, string> = {};

async function expectRejects<T extends Error>(p: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected ${type.name}`);
}

async function insertDocument(contractId: string, title: string) {
  const [d] = await fx.db
    .insert(documents)
    .values({ organizationId: fx.orgA, title, category: "amendment", contractId, uploadedById: fx.ctx.lawyer.userId })
    .returning({ id: documents.id });
  return d.id;
}

async function insertAlert(dedupeKey: string, entityId: string, type: "contract_expiring" | "obligation_due") {
  await fx.db.insert(alerts).values({
    organizationId: fx.orgA,
    type,
    severity: "warning",
    title: "Alerta de teste",
    message: "Mensagem de teste",
    entityType: "contract",
    entityId,
    dedupeKey,
  });
}

async function alertResolved(dedupeKey: string): Promise<boolean> {
  const [a] = await fx.db.select({ resolvedAt: alerts.resolvedAt }).from(alerts).where(eq(alerts.dedupeKey, dedupeKey));
  return a?.resolvedAt != null;
}

beforeAll(async () => {
  fx = await setupFixture("ctr");
  const base = { status: "active" as const, unitId: fx.unitSp, startDate: addDaysISO(today, -300) };
  ids.main = await makeContract(fx.ctx.lawyer, { ...base, title: "Serviços de limpeza", endDate: addDaysISO(today, 200) });
  ids.noticeSoon = await makeContract(fx.ctx.lawyer, { ...base, endDate: addDaysISO(today, 40), renewalNoticeDays: 30 });
  ids.noticeLater = await makeContract(fx.ctx.lawyer, { ...base, endDate: addDaysISO(today, 200), renewalNoticeDays: 30 });
  ids.noticePassed = await makeContract(fx.ctx.lawyer, { ...base, endDate: addDaysISO(today, 20), renewalNoticeDays: 30 });
  ids.noNotice = await makeContract(fx.ctx.lawyer, { ...base, endDate: addDaysISO(today, 40) });
});

afterAll(async () => fx.teardown());

describe("obligations: recurrence and computed overdue status", () => {
  it("computes overdue from the due date in detail, list filter and KPIs", async () => {
    const { id } = await addObligation(fx.ctx.lawyer, ids.main, {
      description: "Enviar relatório mensal de execução",
      responsibleId: fx.ctx.lawyer.userId,
      dueDate: addDaysISO(today, -5),
      recurrence: "monthly",
    });
    ids.monthly = id;
    const detail = await getContract(fx.ctx.lawyer, ids.main);
    const o = detail.obligations.find((x) => x.id === id)!;
    expect(o).toMatchObject({
      status: "pending",
      effectiveStatus: "overdue",
      recurrence: "mensal",
      recurrenceKind: "monthly",
      nextDueDate: addMonthsISO(addDaysISO(today, -5), 1),
      nextBlockedReason: null,
    });
    expect(detail.overdueObligations).toBe(1);
    expect(detail.nextObligation).toMatchObject({ id, status: "overdue" });

    const list = await listContracts(fx.ctx.lawyer, { overdueObligations: true });
    expect(list.items.map((c) => c.id)).toEqual([ids.main]);
    expect(list.items[0]).toMatchObject({ pendingObligations: 1, overdueObligations: 1, nextObligation: { id } });
    const kpis = await getContractKpis(fx.ctx.lawyer);
    expect(kpis).toMatchObject({ overdueObligations: 1, pendingObligations: 1 });
  });

  it("'Cumprir e gerar próxima' fulfils and creates the next occurrence (audited, alert resolved)", async () => {
    await insertAlert(`obligation_due:${ids.monthly}`, ids.main, "obligation_due");
    const result = await fulfillObligation(fx.ctx.lawyer, ids.monthly, { generateNext: true });
    const expectedNext = addMonthsISO(addDaysISO(today, -5), 1);
    expect(result).toMatchObject({ contractId: ids.main, nextDueDate: expectedNext });
    ids.monthlyNext = result.nextObligationId!;

    const [next] = await fx.db.select().from(contractObligations).where(eq(contractObligations.id, ids.monthlyNext));
    expect(next).toMatchObject({
      contractId: ids.main,
      description: "Enviar relatório mensal de execução",
      dueDate: expectedNext,
      recurrence: "mensal",
      status: "pending",
      origin: "system",
      responsibleId: fx.ctx.lawyer.userId,
    });
    const [done] = await fx.db.select().from(contractObligations).where(eq(contractObligations.id, ids.monthly));
    expect(done.status).toBe("fulfilled");
    expect(await alertResolved(`obligation_due:${ids.monthly}`)).toBe(true);

    const [audit] = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.main), eq(auditLogs.action, "contract_obligation.fulfill")));
    expect(audit.changes).toMatchObject({ status: { from: "pending", to: "fulfilled" } });
    expect(audit.metadata).toMatchObject({ obligationId: ids.monthly, nextObligationId: ids.monthlyNext, nextDueDate: expectedNext });

    await expectRejects(fulfillObligation(fx.ctx.lawyer, ids.monthly, { generateNext: true }), ConflictError);
    const kpis = await getContractKpis(fx.ctx.lawyer);
    expect(kpis.overdueObligations).toBe(0);
  });

  it("reuses an identical open next occurrence instead of duplicating it", async () => {
    const due = addMonthsISO(addDaysISO(today, 20), 3);
    const { id } = await addObligation(fx.ctx.lawyer, ids.main, {
      description: "Reajuste trimestral",
      dueDate: addDaysISO(today, 20),
      recurrence: "quarterly",
    });
    const { id: existing } = await addObligation(fx.ctx.lawyer, ids.main, { description: "Reajuste trimestral", dueDate: due });
    const result = await fulfillObligation(fx.ctx.lawyer, id, { generateNext: true });
    expect(result.nextObligationId).toBe(existing);
  });

  it("blocks the next occurrence past the contract end and for custom recurrences", async () => {
    const { id: nearEnd } = await addObligation(fx.ctx.lawyer, ids.noticePassed, {
      description: "Pagamento mensal",
      dueDate: addDaysISO(today, 5),
      recurrence: "mensal",
    });
    const detail = await getContract(fx.ctx.lawyer, ids.noticePassed);
    expect(detail.obligations.find((o) => o.id === nearEnd)?.nextBlockedReason).toMatch(/posterior ao término/);
    await expectRejects(fulfillObligation(fx.ctx.lawyer, nearEnd, { generateNext: true }), ConflictError);
    // Plain fulfilment still works.
    expect((await fulfillObligation(fx.ctx.lawyer, nearEnd, {})).nextObligationId).toBeNull();

    const { id: custom } = await addObligation(fx.ctx.lawyer, ids.main, {
      description: "Vistoria",
      dueDate: addDaysISO(today, 5),
      recurrence: "quando solicitado pela contratante",
    });
    const c = (await getContract(fx.ctx.lawyer, ids.main)).obligations.find((o) => o.id === custom)!;
    expect(c.recurrenceKind).toBe("custom");
    expect(c.nextDueDate).toBeNull();
    await expectRejects(fulfillObligation(fx.ctx.lawyer, custom, { generateNext: true }), ValidationError);
  });

  it("enforces permission, unit visibility and organization isolation", async () => {
    await expectRejects(fulfillObligation(fx.ctx.executive, ids.monthlyNext, { generateNext: true }), ForbiddenError);
    await expectRejects(fulfillObligation(fx.ctx.accountant, ids.monthlyNext, {}), ForbiddenError);
    await expectRejects(fulfillObligation(fx.ctx.lawyerRe, ids.monthlyNext, {}), NotFoundError);
    await expectRejects(fulfillObligation(fx.ctx.adminB, ids.monthlyNext, {}), NotFoundError);
    await expectRejects(fulfillObligation(fx.ctx.externalCounsel, ids.monthlyNext, {}), ForbiddenError);
  });
});

describe("renewal/termination notice", () => {
  it("filters contracts whose notice date is within the window or already reached", async () => {
    const found = (await listContracts(fx.ctx.lawyer, { noticeSoon: true, pageSize: 100 })).items;
    const byId = new Map(found.map((c) => [c.id, c]));
    expect([...byId.keys()].sort()).toEqual([ids.noticeSoon, ids.noticePassed].sort());
    expect(byId.get(ids.noticeSoon)?.notice).toEqual({ date: addDaysISO(today, 10), days: 10, state: "soon" });
    expect(byId.get(ids.noticePassed)?.notice).toEqual({ date: addDaysISO(today, -10), days: -10, state: "passed" });
    expect((await getContractKpis(fx.ctx.lawyer)).noticeSoon).toBe(2);
    // Same scope as the lists: the RE lawyer sees none of these contracts.
    expect((await getContractKpis(fx.ctx.lawyerRe)).noticeSoon).toBe(0);
    expect((await listContracts(fx.ctx.adminB, { noticeSoon: true })).total).toBe(0);
  });
});

describe("renewContract", () => {
  it("moves the end date, links the aditivo, audits and lists the renewal history", async () => {
    ids.amendment = await insertDocument(ids.noticeSoon, "Aditivo 1 — prorrogação (fictício)");
    ids.otherDoc = await insertDocument(ids.main, "Documento de outro contrato");
    expect((await listContractDocumentOptions(fx.ctx.lawyer, ids.noticeSoon)).map((d) => d.id)).toEqual([ids.amendment]);
    await insertAlert(`contract_expiring:${ids.noticeSoon}`, ids.noticeSoon, "contract_expiring");

    const newEnd = addDaysISO(today, 405);
    await renewContract(fx.ctx.lawyer, ids.noticeSoon, {
      newEndDate: newEnd,
      amendmentDocumentId: ids.amendment,
      note: "Prorrogação por 12 meses.",
    });
    const detail = await getContract(fx.ctx.lawyer, ids.noticeSoon);
    expect(detail).toMatchObject({ endDate: newEnd, status: "active", noticeDeadline: addDaysISO(newEnd, -30) });
    expect(detail.notice.state).toBe("later");
    expect(await alertResolved(`contract_expiring:${ids.noticeSoon}`)).toBe(true);

    const history = await listContractLifecycle(fx.ctx.lawyer, ids.noticeSoon);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: "renewal",
      previousEndDate: addDaysISO(today, 40),
      newEndDate: newEnd,
      note: "Prorrogação por 12 meses.",
      document: { id: ids.amendment, title: "Aditivo 1 — prorrogação (fictício)", visible: true },
      actorName: "Laura Advogada SP",
    });
    const [audit] = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.noticeSoon), eq(auditLogs.action, "contract.renew")));
    expect(audit.changes).toMatchObject({ endDate: { from: addDaysISO(today, 40), to: newEnd } });
  });

  it("validates dates, documents and status", async () => {
    const current = addDaysISO(today, 405);
    const sameDate = await expectRejects(renewContract(fx.ctx.lawyer, ids.noticeSoon, { newEndDate: current }), ValidationError);
    expect(sameDate.fieldErrors?.newEndDate?.[0]).toMatch(/posterior ao término atual/);
    expect(
      (await expectRejects(renewContract(fx.ctx.lawyer, ids.noticeSoon, { newEndDate: "2030-02-30" }), ValidationError)).fieldErrors
        ?.newEndDate,
    ).toBeDefined();
    const wrongDoc = await expectRejects(
      renewContract(fx.ctx.lawyer, ids.noticeSoon, { newEndDate: addDaysISO(today, 900), amendmentDocumentId: ids.otherDoc }),
      ValidationError,
    );
    expect(wrongDoc.fieldErrors?.amendmentDocumentId).toBeDefined();

    const indeterminate = await makeContract(fx.ctx.lawyer, { status: "active", unitId: fx.unitSp });
    await expectRejects(renewContract(fx.ctx.lawyer, indeterminate, { newEndDate: addDaysISO(today, 30) }), ConflictError);
    const draft = await makeContract(fx.ctx.lawyer, { status: "draft", unitId: fx.unitSp, endDate: addDaysISO(today, 30) });
    await expectRejects(renewContract(fx.ctx.lawyer, draft, { newEndDate: addDaysISO(today, 60) }), ConflictError);

    // An expired contract becomes active again.
    const expired = await makeContract(fx.ctx.lawyer, {
      status: "expired",
      unitId: fx.unitSp,
      startDate: addDaysISO(today, -400),
      endDate: addDaysISO(today, -35),
    });
    await renewContract(fx.ctx.lawyer, expired, { newEndDate: addDaysISO(today, 330) });
    expect((await getContract(fx.ctx.lawyer, expired)).status).toBe("active");
  });

  it("enforces permission, visibility and organization isolation", async () => {
    const input = { newEndDate: addDaysISO(today, 999) };
    await expectRejects(renewContract(fx.ctx.executive, ids.noticeSoon, input), ForbiddenError);
    await expectRejects(renewContract(fx.ctx.lawyerRe, ids.noticeSoon, input), NotFoundError);
    await expectRejects(renewContract(fx.ctx.adminB, ids.noticeSoon, input), NotFoundError);
    await expectRejects(listContractLifecycle(fx.ctx.lawyerRe, ids.noticeSoon), NotFoundError);
    await expectRejects(listContractDocumentOptions(fx.ctx.adminB, ids.noticeSoon), NotFoundError);
    // Executives can read the history (contract:read) but not change it.
    expect(await listContractLifecycle(fx.ctx.executive, ids.noticeSoon)).toHaveLength(1);
  });
});

describe("terminateContract", () => {
  it("terminates with an effective date, keeps open obligations and resolves alerts", async () => {
    const { id: openObligation } = await addObligation(fx.ctx.lawyer, ids.noticeLater, {
      description: "Devolução de equipamentos",
      dueDate: addDaysISO(today, 10),
      recurrence: "monthly",
    });
    await insertAlert(`obligation_due:${openObligation}`, ids.noticeLater, "obligation_due");
    await insertAlert(`contract_expiring:${ids.noticeLater}`, ids.noticeLater, "contract_expiring");

    const after = await expectRejects(
      terminateContract(fx.ctx.lawyer, ids.noticeLater, { terminationDate: addDaysISO(today, 201) }),
      ValidationError,
    );
    expect(after.fieldErrors?.terminationDate?.[0]).toMatch(/posterior ao término/);
    const before = await expectRejects(
      terminateContract(fx.ctx.lawyer, ids.noticeLater, { terminationDate: addDaysISO(today, -301) }),
      ValidationError,
    );
    expect(before.fieldErrors?.terminationDate?.[0]).toMatch(/anterior ao início/);

    await terminateContract(fx.ctx.lawyer, ids.noticeLater, { terminationDate: today, note: "Rescisão amigável." });
    const detail = await getContract(fx.ctx.lawyer, ids.noticeLater);
    expect(detail).toMatchObject({ status: "terminated", endDate: today, vigency: "encerrado", pendingObligations: 1 });
    expect(detail.notice.state).toBe("none");
    // No next occurrence after termination.
    expect(detail.obligations.find((o) => o.id === openObligation)?.nextBlockedReason).toMatch(/rescindido/);
    expect(await alertResolved(`obligation_due:${openObligation}`)).toBe(true);
    expect(await alertResolved(`contract_expiring:${ids.noticeLater}`)).toBe(true);

    const history = await listContractLifecycle(fx.ctx.manager, ids.noticeLater);
    expect(history[0]).toMatchObject({
      kind: "termination",
      terminationDate: today,
      previousEndDate: addDaysISO(today, 200),
      note: "Rescisão amigável.",
      document: null,
    });
    const [row] = await fx.db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, ids.noticeLater));
    expect(row.status).toBe("terminated");

    await expectRejects(terminateContract(fx.ctx.lawyer, ids.noticeLater, { terminationDate: today }), ConflictError);
    await expectRejects(renewContract(fx.ctx.lawyer, ids.noticeLater, { newEndDate: addDaysISO(today, 500) }), ConflictError);
  });

  it("enforces permission, visibility and organization isolation", async () => {
    await expectRejects(terminateContract(fx.ctx.executive, ids.noNotice, { terminationDate: today }), ForbiddenError);
    await expectRejects(terminateContract(fx.ctx.lawyerRe, ids.noNotice, { terminationDate: today }), NotFoundError);
    await expectRejects(terminateContract(fx.ctx.adminB, ids.noNotice, { terminationDate: today }), NotFoundError);
    await expectRejects(terminateContract(fx.ctx.lawyer, ids.noNotice, { terminationDate: "" }), ValidationError);
  });
});
