import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  countUpcomingProcessHearings,
  createHearing,
  findVisibleProcessByNumber,
  getHearing,
  getHearingCounts,
  listHearings,
  listProcessHearings,
  listUpcomingHearings,
  setHearingStatus,
  updateHearing,
} from "@/modules/hearings/service";
import { formatTime, zonedDateTimeToUtc } from "@/modules/hearings/time";
import { listCalendarItems } from "@/modules/work/service";
import { auditLogs, hearings, legalProcesses } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

let fx: Fixture;
const ids: Record<string, string> = {};
const today = todayISO();
const inDays = (n: number) => addDaysISO(today, n);

function hearingInput(processId: string, overrides: Record<string, unknown> = {}) {
  return {
    processId,
    kind: "instruction" as const,
    mode: "in_person" as const,
    date: inDays(5),
    time: "14:00",
    location: "Fórum Trabalhista — 2ª Vara, sala 3 (fictício)",
    ...overrides,
  };
}

async function expectField(promise: Promise<unknown>, field: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).fieldErrors?.[field]?.length ?? 0).toBeGreaterThan(0);
}

beforeAll(async () => {
  fx = await setupFixture("hear");
  const { admin } = fx.ctx;
  ids.pSp = await makeProcess(admin, { unitId: fx.unitSp, number: "1000001-11.2026.5.10.0001", title: "Processo SP (fictício)" });
  ids.pRe = await makeProcess(admin, { unitId: fx.unitRe, title: "Processo RE (fictício)" });
  ids.pConf = await makeProcess(admin, { unitId: fx.unitSp, isConfidential: true, title: "Processo sigiloso (fictício)" });
  ids.pFirm = await makeProcess(admin, { unitId: fx.unitRe, title: "Processo do escritório (fictício)" });
  // The firm link is set directly so this suite does not depend on the portfolio form.
  await fx.db.update(legalProcesses).set({ lawFirmId: fx.lawFirmA }).where(eq(legalProcesses.id, ids.pFirm));
  ids.pB = await makeProcess(fx.ctx.adminB, { title: "Processo org B (fictício)" });
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("time helpers", () => {
  it("converts São Paulo wall time to UTC and back", () => {
    const at = zonedDateTimeToUtc("2026-11-12", "14:00");
    expect(at.toISOString()).toBe("2026-11-12T17:00:00.000Z");
    expect(formatTime(at)).toBe("14:00");
    expect(zonedDateTimeToUtc("2026-01-01", "00:30").toISOString()).toBe("2026-01-01T03:30:00.000Z");
  });
});

describe("createHearing", () => {
  it("creates a hearing on a visible process and audits it on the process", async () => {
    const { lawyer } = fx.ctx;
    const { id } = await createHearing(lawyer, { ...hearingInput(ids.pSp), responsibleId: lawyer.userId, notes: "Levar preposto." });
    ids.hSp = id;
    const h = await getHearing(lawyer, id);
    expect(h.status).toBe("scheduled");
    expect(h.origin).toBe("manual");
    expect(h.processId).toBe(ids.pSp);
    expect(h.responsibleName).toBe(lawyer.name);
    expect(h.scheduledAt.toISOString()).toBe(zonedDateTimeToUtc(inDays(5), "14:00").toISOString());
    expect(h.canManage).toBe(true);

    const [audit] = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "hearing.create"), eq(auditLogs.entityId, ids.pSp)));
    expect(audit.entityType).toBe("legal_process");
    expect((audit.metadata as Record<string, unknown>).hearingId).toBe(id);
    // Free text is never audited.
    expect(JSON.stringify(audit.changes)).not.toContain("preposto");
  });

  it("requires process:write", async () => {
    await expect(createHearing(fx.ctx.analyst, hearingInput(ids.pSp))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createHearing(fx.ctx.auditor, hearingInput(ids.pSp))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects processes the user cannot see (other unit, other organization)", async () => {
    await expectField(createHearing(fx.ctx.lawyerRe, hearingInput(ids.pSp)), "processId");
    await expectField(createHearing(fx.ctx.adminB, hearingInput(ids.pSp)), "processId");
    await expectField(createHearing(fx.ctx.externalCounsel, hearingInput(ids.pSp)), "processId");
  });

  it("validates mode/location, link, date and time", async () => {
    const { lawyer } = fx.ctx;
    await expectField(createHearing(lawyer, hearingInput(ids.pSp, { location: null })), "location");
    await expectField(createHearing(lawyer, hearingInput(ids.pSp, { mode: "virtual", meetingUrl: "javascript:alert(1)" })), "meetingUrl");
    await expectField(createHearing(lawyer, hearingInput(ids.pSp, { time: "25:00" })), "time");
    await expectField(createHearing(lawyer, hearingInput(ids.pSp, { date: "2026-02-30" })), "date");
    const { id } = await createHearing(lawyer, {
      ...hearingInput(ids.pSp, { mode: "virtual", location: null, meetingUrl: "https://exemplo.invalid/sala-ficticia" }),
      date: inDays(40),
    });
    ids.hVirtual = id;
  });

  it("requires the responsible person to be an active user who can see the process", async () => {
    await expectField(createHearing(fx.ctx.admin, { ...hearingInput(ids.pSp), responsibleId: fx.ctx.lawyerRe.userId }), "responsibleId");
    await expectField(createHearing(fx.ctx.admin, { ...hearingInput(ids.pSp), responsibleId: fx.ctx.adminB.userId }), "responsibleId");
    await expectField(createHearing(fx.ctx.admin, { ...hearingInput(ids.pConf), responsibleId: fx.ctx.lawyer.userId }), "responsibleId");
  });

  it("external counsel manages hearings of the firm's processes", async () => {
    const { externalCounsel } = fx.ctx;
    const { id } = await createHearing(externalCounsel, {
      ...hearingInput(ids.pFirm, { kind: "conciliation" }),
      responsibleId: externalCounsel.userId,
    });
    ids.hFirm = id;
    expect((await getHearing(externalCounsel, id)).processId).toBe(ids.pFirm);
  });
});

describe("visibility", () => {
  beforeAll(async () => {
    ids.hRe = (await createHearing(fx.ctx.admin, hearingInput(ids.pRe, { date: inDays(2) }))).id;
    ids.hConf = (await createHearing(fx.ctx.admin, hearingInput(ids.pConf, { date: inDays(3) }))).id;
    ids.hB = (await createHearing(fx.ctx.adminB, hearingInput(ids.pB, { date: inDays(3) }))).id;
  });

  it("follows the process: unit, confidentiality, law firm and organization", async () => {
    const seen = async (ctx: Fixture["ctx"][keyof Fixture["ctx"]]) =>
      new Set((await listHearings(ctx, { pageSize: 100 })).items.map((h) => h.id));

    const lawyer = await seen(fx.ctx.lawyer);
    expect(lawyer.has(ids.hSp)).toBe(true);
    expect(lawyer.has(ids.hRe)).toBe(false);
    expect(lawyer.has(ids.hConf)).toBe(false);
    expect(lawyer.has(ids.hB)).toBe(false);

    const lawyerRe = await seen(fx.ctx.lawyerRe);
    expect(lawyerRe.has(ids.hRe)).toBe(true);
    expect(lawyerRe.has(ids.hSp)).toBe(false);

    const external = await seen(fx.ctx.externalCounsel);
    expect([...external]).toEqual([ids.hFirm]);

    const auditor = await seen(fx.ctx.auditor);
    expect(auditor.has(ids.hSp) && auditor.has(ids.hRe)).toBe(true);
    expect(auditor.has(ids.hConf)).toBe(false);

    const manager = await seen(fx.ctx.manager);
    expect(manager.has(ids.hConf)).toBe(true);
    expect(manager.has(ids.hB)).toBe(false);

    const adminB = await seen(fx.ctx.adminB);
    expect([...adminB]).toEqual([ids.hB]);
  });

  it("single reads and writes do not reveal invisible hearings", async () => {
    await expect(getHearing(fx.ctx.lawyerRe, ids.hSp)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getHearing(fx.ctx.adminB, ids.hSp)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getHearing(fx.ctx.lawyer, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateHearing(fx.ctx.lawyerRe, ids.hSp, { kind: "initial", mode: "in_person", date: inDays(6), time: "10:00", location: "X" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(setHearingStatus(fx.ctx.adminB, ids.hSp, { status: "cancelled" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listProcessHearings(fx.ctx.lawyerRe, ids.pSp)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("read-only roles see but cannot manage", async () => {
    const h = await getHearing(fx.ctx.executive, ids.hSp);
    expect(h.canManage).toBe(false);
    await expect(setHearingStatus(fx.ctx.executive, ids.hSp, { status: "cancelled" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("filters, upcoming list and counts", () => {
  it("filters by period, status and responsible", async () => {
    const { admin, lawyer } = fx.ctx;
    const week = await listHearings(admin, { period: "7d", pageSize: 100 });
    expect(week.items.map((h) => h.id)).toContain(ids.hSp);
    expect(week.items.map((h) => h.id)).not.toContain(ids.hVirtual); // 40 days ahead
    const quarter = await listHearings(admin, { period: "90d", pageSize: 100 });
    expect(quarter.items.map((h) => h.id)).toContain(ids.hVirtual);
    // Chronological order for upcoming periods.
    const times = quarter.items.map((h) => h.scheduledAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    const mine = await listHearings(admin, { responsibleId: lawyer.userId!, pageSize: 100 });
    expect(mine.items.every((h) => h.responsibleId === lawyer.userId)).toBe(true);
    expect(mine.items.map((h) => h.id)).toContain(ids.hSp);

    const paged = await listHearings(admin, { pageSize: 1, page: 2 });
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBeGreaterThan(1);
  });

  it("listUpcomingHearings returns scheduled hearings of visible processes within the window", async () => {
    const list = await listUpcomingHearings(fx.ctx.lawyer, { days: 10 });
    expect(list.map((h) => h.id)).toContain(ids.hSp);
    expect(list.map((h) => h.id)).not.toContain(ids.hVirtual);
    expect(list.map((h) => h.id)).not.toContain(ids.hRe);
    expect(list.find((h) => h.id === ids.hSp)?.processNumber).toBe("1000001-11.2026.5.10.0001");
    expect(await listUpcomingHearings(fx.ctx.lawyer, { days: 60, limit: 1 })).toHaveLength(1);
    await expect(listUpcomingHearings({ ...fx.ctx.lawyer, role: "accountant" }, {})).resolves.toBeDefined();
  });

  it("counts upcoming hearings of a process for its tab (0 when not visible)", async () => {
    expect(await countUpcomingProcessHearings(fx.ctx.lawyer, ids.pSp)).toBeGreaterThanOrEqual(2);
    expect(await countUpcomingProcessHearings(fx.ctx.lawyerRe, ids.pSp)).toBe(0);
    expect(await countUpcomingProcessHearings(fx.ctx.adminB, ids.pSp)).toBe(0);
    expect(await countUpcomingProcessHearings(fx.ctx.lawyer, "x")).toBe(0);
  });

  it("counts follow the same scope", async () => {
    const lawyer = await getHearingCounts(fx.ctx.lawyer);
    const admin = await getHearingCounts(fx.ctx.admin);
    expect(lawyer.next7Days).toBeGreaterThanOrEqual(1);
    expect(admin.next7Days).toBeGreaterThan(lawyer.next7Days);
    expect(lawyer.mine).toBeGreaterThanOrEqual(1);
  });

  it("finds a visible process by number, with or without the CNJ mask", async () => {
    const { lawyer, lawyerRe } = fx.ctx;
    expect((await findVisibleProcessByNumber(lawyer, "1000001-11.2026.5.10.0001")).id).toBe(ids.pSp);
    expect((await findVisibleProcessByNumber(lawyer, "10000011120265100001")).id).toBe(ids.pSp);
    await expectField(findVisibleProcessByNumber(lawyerRe, "1000001-11.2026.5.10.0001"), "processNumber");
    await expectField(findVisibleProcessByNumber(fx.ctx.adminB, "1000001-11.2026.5.10.0001"), "processNumber");
  });

  it("shows scheduled hearings on the deadlines calendar", async () => {
    const month = inDays(5).slice(0, 7);
    const data = await listCalendarItems(fx.ctx.lawyer, month);
    const item = data.hearings.find((h) => h.id === ids.hSp);
    expect(item).toBeDefined();
    expect(item?.date).toBe(inDays(5));
    expect(item?.time).toBe("14:00");
    const other = await listCalendarItems(fx.ctx.lawyerRe, month);
    expect(other.hearings.map((h) => h.id)).not.toContain(ids.hSp);
    const orgB = await listCalendarItems(fx.ctx.adminB, month);
    expect(orgB.hearings.map((h) => h.id)).not.toContain(ids.hSp);
  });
});

describe("updates and status transitions", () => {
  it("updates a scheduled hearing with an audited diff", async () => {
    const { lawyer } = fx.ctx;
    await updateHearing(lawyer, ids.hSp, {
      kind: "unified",
      mode: "hybrid",
      date: inDays(6),
      time: "09:30",
      location: "Fórum (fictício), sala 5",
      meetingUrl: "https://exemplo.invalid/sala",
      responsibleId: lawyer.userId,
      notes: "Atualizado.",
    });
    const h = await getHearing(lawyer, ids.hSp);
    expect(h.kind).toBe("unified");
    expect(formatTime(h.scheduledAt)).toBe("09:30");
    const updates = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "hearing.update"), eq(auditLogs.entityId, ids.pSp)));
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].changes ?? {})).toEqual(expect.arrayContaining(["kind", "mode", "scheduledAt"]));
  });

  it("does not register the result before the date", async () => {
    await expect(setHearingStatus(fx.ctx.lawyer, ids.hSp, { status: "held", outcome: "Acordo celebrado." })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("registers a past hearing as held with its outcome", async () => {
    const { admin } = fx.ctx;
    const { id } = await createHearing(admin, hearingInput(ids.pSp, { date: inDays(-1), time: "10:00" }));
    expect((await getHearing(admin, id)).awaitingRecord).toBe(true);
    expect((await getHearingCounts(admin)).awaitingRecord).toBeGreaterThanOrEqual(1);
    await expectField(setHearingStatus(admin, id, { status: "held", outcome: "" }), "outcome");
    await setHearingStatus(admin, id, { status: "held", outcome: "Instrução encerrada; razões finais em 10 dias." });
    const h = await getHearing(admin, id);
    expect(h.status).toBe("held");
    expect(h.outcome).toContain("Instrução encerrada");
    expect(h.canManage).toBe(false);
    await expect(setHearingStatus(admin, id, { status: "cancelled" })).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateHearing(admin, id, { kind: "initial", mode: "in_person", date: inDays(1), time: "10:00", location: "X" }),
    ).rejects.toBeInstanceOf(ConflictError);
    const past = await listHearings(admin, { period: "past", pageSize: 100 });
    expect(past.items.map((x) => x.id)).toContain(id);
  });

  it("reschedules: keeps the old hearing as rescheduled and creates a new scheduled one (both audited)", async () => {
    const { lawyer } = fx.ctx;
    await expectField(
      setHearingStatus(lawyer, ids.hSp, { status: "rescheduled", date: inDays(-3), time: "10:00", mode: "in_person", location: "X" }),
      "date",
    );
    const { newHearingId } = await setHearingStatus(lawyer, ids.hSp, {
      status: "rescheduled",
      date: inDays(20),
      time: "15:00",
      mode: "virtual",
      meetingUrl: "https://exemplo.invalid/nova-sala",
      reason: "Pedido de adiamento deferido (fictício).",
    });
    expect(newHearingId).toBeTruthy();
    const old = await getHearing(lawyer, ids.hSp);
    expect(old.status).toBe("rescheduled");
    expect(old.outcome).toContain("adiamento");
    const created = await getHearing(lawyer, newHearingId!);
    expect(created.status).toBe("scheduled");
    expect(created.kind).toBe(old.kind);
    expect(created.responsibleId).toBe(old.responsibleId);
    expect(created.mode).toBe("virtual");
    expect(formatTime(created.scheduledAt)).toBe("15:00");

    const rows = await fx.db.select().from(auditLogs).where(eq(auditLogs.entityId, ids.pSp));
    const statusChange = rows.find(
      (r) => r.action === "hearing.status_change" && (r.metadata as Record<string, unknown>).hearingId === ids.hSp,
    );
    expect((statusChange?.metadata as Record<string, unknown>).newHearingId).toBe(newHearingId);
    const createdAudit = rows.find(
      (r) => r.action === "hearing.create" && (r.metadata as Record<string, unknown>).hearingId === newHearingId,
    );
    expect((createdAudit?.metadata as Record<string, unknown>).rescheduledFromId).toBe(ids.hSp);
    expect(JSON.stringify(rows.map((r) => [r.changes, r.summary]))).not.toContain("adiamento");

    // Default agenda hides the rescheduled one; the status filter shows it.
    const agenda = await listHearings(lawyer, { pageSize: 100 });
    expect(agenda.items.map((h) => h.id)).not.toContain(ids.hSp);
    expect(agenda.items.map((h) => h.id)).toContain(newHearingId);
    const rescheduled = await listHearings(lawyer, { status: "rescheduled", pageSize: 100 });
    expect(rescheduled.items.map((h) => h.id)).toContain(ids.hSp);
  });

  it("cancels a scheduled hearing", async () => {
    const { admin } = fx.ctx;
    await setHearingStatus(admin, ids.hRe, { status: "cancelled", reason: "Acordo extrajudicial (fictício)." });
    const h = await getHearing(admin, ids.hRe);
    expect(h.status).toBe("cancelled");
    expect(h.outcome).toContain("Acordo");
    const [row] = await fx.db.select().from(hearings).where(eq(hearings.id, ids.hRe));
    expect(row.status).toBe("cancelled");
  });

  it("lists every hearing of a process on its tab", async () => {
    const list = await listProcessHearings(fx.ctx.lawyer, ids.pSp);
    const statuses = new Set(list.map((h) => h.status));
    expect(statuses.has("rescheduled")).toBe(true);
    expect(statuses.has("held")).toBe(true);
    expect(statuses.has("scheduled")).toBe(true);
  });
});
