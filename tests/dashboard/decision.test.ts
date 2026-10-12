import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDaysISO, todayISO } from "@/lib/format";
import { mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import { listReviewQueue } from "@/modules/contingency/service";
import { listSettlements } from "@/modules/contingency/settlement-service";
import { DecisionBand, itemHeading } from "@/modules/dashboard/components/decision-band";
import {
  DECISION_HREFS,
  getDecisionBand,
  type DecisionBand as DecisionBandData,
  type DecisionBlock,
  type DeadlineDecisionBlock,
} from "@/modules/dashboard/decision-service";
import { listIdleGuarantees } from "@/modules/dashboard/idle-guarantees";
import type { Section } from "@/modules/dashboard/portfolio-service";
import { listHearings } from "@/modules/hearings/service";
import { zonedDateTimeToUtc } from "@/modules/hearings/time";
import type { AuthContext } from "@/server/auth/context";
import {
  deadlines,
  hearings,
  legalProcesses,
  organizations,
  processGuarantees,
  processValuations,
  settlementInstallments,
  settlements,
} from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";

// The review queue is another module's API: wrapped (real implementation) so one test can make it fail.
vi.mock("@/modules/contingency/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/contingency/service")>();
  return { ...actual, listReviewQueue: vi.fn(actual.listReviewQueue) };
});

const today = todayISO();
const d = (days: number) => addDaysISO(today, days);
const IDLE_DAYS = 30;
const INSTALLMENT_DAYS = 15;

let fx: Fixture;
const ids: Record<string, string> = {};

function ok<T>(s: Section<T>): T {
  if (s.status !== "ok") throw new Error(`unexpected section status ${s.status}`);
  return s.data;
}

async function band(ctx: AuthContext): Promise<DecisionBandData> {
  return getDecisionBand(ctx);
}

async function setSettings(idleGuaranteeDays: number) {
  const settings = mergeOrganizationSettings({});
  settings.contingency.idleGuaranteeDays = idleGuaranteeDays;
  settings.alerts.installmentDueDays = INSTALLMENT_DAYS;
  await fx.db.update(organizations).set({ settings }).where(eq(organizations.id, fx.orgA));
}

beforeAll(async () => {
  fx = await setupFixture("dashdec");
  await setSettings(IDLE_DAYS);
  const admin = fx.ctx.admin.userId!;

  // --- processes: SP (lawyer SP), RE (lawyer RE), confidential SP, organization B --------------
  const proc = async (key: string, values: Partial<typeof legalProcesses.$inferInsert>) => {
    const [p] = await fx.db
      .insert(legalProcesses)
      .values({
        organizationId: fx.orgA,
        number: `${key}-0000000.2026.5.10.0001`,
        title: `Processo ${key} (fictício)`,
        court: "TRT10",
        area: "labor",
        phase: "knowledge",
        ...values,
      })
      .returning();
    ids[key] = p.id;
  };
  await proc("PSP", { unitId: fx.unitSp });
  await proc("PRE", { unitId: fx.unitRe });
  await proc("PCONF", { unitId: fx.unitSp, isConfidential: true });
  await proc("PB", { organizationId: fx.orgB, unitId: fx.unitB });

  // --- hearings ----------------------------------------------------------------------------------
  const hearing = (processId: string, at: Date, values: Partial<typeof hearings.$inferInsert> = {}) => ({
    organizationId: fx.orgA,
    processId,
    kind: "instruction" as const,
    mode: "virtual" as const,
    scheduledAt: at,
    ...values,
  });
  await fx.db
    .insert(hearings)
    .values([
      hearing(ids.PSP, zonedDateTimeToUtc(d(2), "14:00")), // counted
      hearing(ids.PSP, zonedDateTimeToUtc(d(7), "12:00")), // last day of the window: counted
      hearing(ids.PSP, zonedDateTimeToUtc(d(8), "09:00")), // beyond 7 days
      hearing(ids.PSP, zonedDateTimeToUtc(d(3), "10:00"), { status: "cancelled" }),
      hearing(ids.PSP, zonedDateTimeToUtc(d(-1), "10:00")), // yesterday: out of the window
      hearing(ids.PSP, zonedDateTimeToUtc(today, "00:00")), // today, already passed, result not recorded: counted
      hearing(ids.PRE, zonedDateTimeToUtc(d(1), "09:30"), { responsibleId: fx.ctx.lawyerRe.userId }),
      hearing(ids.PCONF, zonedDateTimeToUtc(d(1), "16:00")),
      hearing(ids.PB, zonedDateTimeToUtc(d(1), "16:00"), { organizationId: fx.orgB }),
    ]);

  // --- deadlines ---------------------------------------------------------------------------------
  const deadline = (key: string, processId: string, dueDate: string, values: Partial<typeof deadlines.$inferInsert> = {}) => ({
    organizationId: fx.orgA,
    title: `Prazo ${key} (fictício)`,
    processId,
    dueDate,
    kind: "procedural" as const,
    ...values,
  });
  const dl = await fx.db
    .insert(deadlines)
    .values([
      deadline("D1", ids.PSP, d(-2)), // overdue, manual
      deadline("D2", ids.PSP, d(3), { origin: "ai_suggested", validationStatus: "validated", validatedById: admin }),
      deadline("D3", ids.PSP, d(3), { origin: "ai_suggested", validationStatus: "pending_validation" }),
      deadline("D4", ids.PSP, d(3), { origin: "ai_suggested", validationStatus: "rejected" }),
      deadline("D5", ids.PSP, d(1), { kind: "internal" }),
      deadline("D6", ids.PSP, d(10)),
      deadline("D7", ids.PSP, d(1), { status: "done" }),
      deadline("D8", ids.PRE, d(5), { kind: "regulatory" }),
      deadline("D9", ids.PSP, d(1), { kind: "contractual" }),
      // Lawyer SP is responsible for a deadline of a process they cannot see.
      deadline("D10", ids.PRE, d(2), { responsibleId: fx.ctx.lawyer.userId }),
      deadline("D11", ids.PCONF, d(1)),
    ])
    .returning({ id: deadlines.id, title: deadlines.title });
  for (const r of dl) ids[r.title.split(" ")[1]] = r.id;

  // --- settlements and installments --------------------------------------------------------------
  const settlement = async (key: string, processId: string, status: typeof settlements.$inferInsert.status) => {
    const [s] = await fx.db
      .insert(settlements)
      .values({ organizationId: fx.orgA, processId, status, totalAmountCents: 100_000, installmentsCount: 4 })
      .returning();
    ids[key] = s.id;
    return s.id;
  };
  const s1 = await settlement("S1", ids.PSP, "homologated");
  const s2 = await settlement("S2", ids.PSP, "proposal");
  const s3 = await settlement("S3", ids.PRE, "signed");
  const s4 = await settlement("S4", ids.PSP, "breached");
  const inst = (settlementId: string, number: number, dueDate: string, values: Partial<typeof settlementInstallments.$inferInsert> = {}) => ({
    organizationId: fx.orgA,
    settlementId,
    number,
    dueDate,
    amountCents: 25_000,
    ...values,
  });
  await fx.db.insert(settlementInstallments).values([
    inst(s1, 1, d(-35), { status: "paid", paidAt: d(-35) }),
    inst(s1, 2, d(-5)), // overdue: counted
    inst(s1, 3, d(INSTALLMENT_DAYS)), // last day of the window: counted
    inst(s1, 4, d(INSTALLMENT_DAYS + 1)), // beyond the window
    inst(s2, 1, d(1)), // proposal: not binding
    inst(s3, 1, d(2), { amountCents: 10_000 }),
    inst(s4, 1, d(-40), { amountCents: 5_000 }), // breached settlement: still owed
  ]);

  // --- guarantees ---------------------------------------------------------------------------------
  const guarantee = (processId: string, values: Partial<typeof processGuarantees.$inferInsert>) => ({
    organizationId: fx.orgA,
    processId,
    kind: "judicial_deposit" as const,
    amountCents: 50_000,
    ...values,
  });
  const longAgo = new Date(Date.now() - 400 * 86_400_000);
  const g = await fx.db
    .insert(processGuarantees)
    .values([
      guarantee(ids.PSP, { depositedAt: d(-(IDLE_DAYS + 1)), description: "G1" }), // idle
      guarantee(ids.PSP, { depositedAt: d(-IDLE_DAYS), description: "G2" }), // exactly N days: idle (routine rule)
      guarantee(ids.PSP, { depositedAt: d(-(IDLE_DAYS - 1)), description: "G3" }), // not yet
      guarantee(ids.PSP, { depositedAt: d(-500), statusChangedAt: d(-5), description: "G4" }), // recent movement
      guarantee(ids.PSP, { depositedAt: d(-500), status: "released_to_plaintiff", description: "G5" }),
      guarantee(ids.PRE, { createdAt: longAgo, description: "G6" }), // no dates: registration date
      guarantee(ids.PRE, { description: "G7" }), // registered today
      guarantee(ids.PSP, { depositedAt: d(-500), deletedAt: new Date(), description: "G8" }),
    ])
    .returning({ id: processGuarantees.id, description: processGuarantees.description });
  for (const r of g) ids[r.description!] = r.id;

  // --- valuations ---------------------------------------------------------------------------------
  const valuation = (processId: string, values: Partial<typeof processValuations.$inferInsert>) => ({
    organizationId: fx.orgA,
    processId,
    kind: "claim" as const,
    amountCents: 300_000,
    baseDate: d(-3),
    source: "manual" as const,
    ...values,
  });
  const v = await fx.db
    .insert(processValuations)
    .values([
      valuation(ids.PSP, { source: "simulation", reason: "V1", isEstimate: true }), // proposed (default)
      valuation(ids.PSP, { kind: "liquidated", status: "official", reviewedById: admin, reviewedAt: new Date(), reason: "V2" }),
      valuation(ids.PRE, { kind: "liquidated", source: "spreadsheet", amountCents: 120_000, reason: "V3" }),
      valuation(ids.PSP, { status: "rejected", reviewedById: admin, reason: "V4" }),
    ])
    .returning({ id: processValuations.id, reason: processValuations.reason });
  for (const r of v) ids[r.reason!] = r.id;
});

afterAll(async () => fx?.teardown());

describe("decision band — counts", () => {
  it("counts hearings within 7 days (scheduled, from the start of today to the end of the 7th day)", async () => {
    const admin = ok((await band(fx.ctx.admin)).hearings);
    expect(admin.total).toBe(5); // PSP today (awaiting the result), PRE d+1, PCONF d+1, PSP d+2, PSP d+7
    expect(admin.items.map((i) => i.processNumber)).toEqual([
      "PSP-0000000.2026.5.10.0001",
      "PRE-0000000.2026.5.10.0001",
      "PCONF-0000000.2026.5.10.0001",
      "PSP-0000000.2026.5.10.0001",
      "PSP-0000000.2026.5.10.0001",
    ]);
    // Today's hearing whose time has passed is flagged so the result gets recorded.
    expect(admin.items[0]).toMatchObject({ overdue: true, href: `/processos/${ids.PSP}?aba=prazos-e-audiencias#audiencias` });
    expect(admin.items.slice(1).every((i) => !i.overdue)).toBe(true);
    expect(admin.items[1]).toMatchObject({ href: `/processos/${ids.PRE}?aba=prazos-e-audiencias#audiencias`, tags: ["Rafael Advogado RE"] });
    expect(admin.items[2].tags).toEqual(["Sem responsável"]);
    expect(admin.href).toBe("/audiencias?periodo=7d&status=scheduled");
    expect(admin.list).toEqual({ href: "/audiencias?periodo=7d&status=scheduled", count: 5 });
  });

  it("counts only real fatal deadlines; AI suggestions awaiting validation are reported apart", async () => {
    const b = ok((await band(fx.ctx.admin)).deadlines);
    // D1 (overdue), D2 (validated), D8 (regulatory), D10, D11 — never D3 (pending), D4 (rejected),
    // D5 (internal), D6 (beyond 7 days), D7 (done) nor D9 (contractual).
    expect(b.total).toBe(5);
    expect(b.overdue).toBe(1);
    expect(b.pendingValidation).toBe(1);
    expect(b.pendingValidationHref).toBe("/prazos?aba=validacao");
    expect(b.items.map((i) => i.id)).not.toContain(ids.D3);
    expect(b.items[0]).toMatchObject({ id: ids.D1, overdue: true, date: d(-2), href: `/prazos?aba=prazos&prazo=${ids.D1}`, tags: ["Processual"] });
    expect(b.items.find((i) => i.id === ids.D8)?.tags).toEqual(["Regulatório"]);
    // `/prazos` cannot reproduce the block (kinds, 7 days): the list link carries no count.
    expect(b.list).toEqual({ href: "/prazos?aba=prazos&situacao=abertos", count: null });
    expect(b.items.every((i) => !i.restricted)).toBe(true);
  });

  it("counts pending installments of binding settlements within the configured window, overdue included", async () => {
    const b = ok((await band(fx.ctx.admin)).installments);
    // S1 #2 (overdue), S1 #3 (last day of the window), S3 #1, S4 #1 (breached, overdue).
    expect(b.total).toBe(4);
    expect(b.overdue).toBe(2);
    expect(b.totalCents).toBe(25_000 + 25_000 + 10_000 + 5_000);
    expect(b.items[0]).toMatchObject({ date: d(-40), overdue: true, amountCents: 5_000, href: `/processos/${ids.PSP}?aba=valores-e-acordos#acordos` });
    expect(b.items.map((i) => i.date)).not.toContain(d(INSTALLMENT_DAYS + 1));
    expect(b.href).toBe("/acordos?vencendo=1");
    // `/acordos?vencendo=1` lists settlements: S1, S3 and S4 (S2 is a proposal).
    expect(b.list).toEqual({ href: "/acordos?vencendo=1", count: 3 });
  });

  it("applies the idle-guarantee threshold of the organization settings (N days or more without movement)", async () => {
    const b = ok((await band(fx.ctx.admin)).guarantees);
    expect(b.total).toBe(3); // G1, G2 (exactly N days), G6 (registration date fallback)
    expect(b.totalCents).toBe(150_000);
    expect(b.items.map((i) => i.id).sort()).toEqual([ids.G1, ids.G2, ids.G6].sort());
    expect(b.items[0]).toMatchObject({ id: ids.G6, href: `/processos/${ids.PRE}?aba=valores-e-acordos` });
    expect(b.items.find((i) => i.id === ids.G2)?.date).toBe(d(-IDLE_DAYS));
    expect(b.href).toBe("/contingencias/garantias");
    expect(b.list).toEqual({ href: "/contingencias/garantias", count: 3 });

    await setSettings(IDLE_DAYS + 1);
    try {
      const stricter = ok((await band(fx.ctx.admin)).guarantees);
      expect(stricter.items.map((i) => i.id).sort()).toEqual([ids.G1, ids.G6].sort());
      expect((await band(fx.ctx.admin)).windows.idleGuaranteeDays).toBe(IDLE_DAYS + 1);
    } finally {
      await setSettings(IDLE_DAYS);
    }
  });

  it("lists proposed valuations without adding different kinds together", async () => {
    const b = ok((await band(fx.ctx.admin)).valuations);
    expect(b.total).toBe(2); // V1 and V3 (V2 official, V4 rejected)
    expect(b.totalCents).toBeNull();
    const v1 = b.items.find((i) => i.id === ids.V1)!;
    expect(v1).toMatchObject({ simulated: true, estimate: true, tags: ["Extração simulada (demonstração)"] });
    expect(v1.href).toBe(`/contingencias/revisao?item=${ids.V1}`);
    expect(b.href).toBe(DECISION_HREFS.valuations);
  });
});

describe("decision band — visibility and permissions", () => {
  it("restricts every block to the rows of the lawyer's unit (lawyer of another unit sees none of SP)", async () => {
    const sp = await band(fx.ctx.lawyer);
    expect(ok(sp.hearings).total).toBe(3);
    const spDeadlines = ok(sp.deadlines);
    expect(spDeadlines.total).toBe(3); // D1, D2 and D10 (responsible) — not D8 (RE) nor D11 (confidential)
    expect(spDeadlines.pendingValidation).toBe(1);
    // D10's process (RE) is invisible to the SP lawyer: its number is never shown, the item reads "Registro sem acesso".
    const d10 = spDeadlines.items.find((i) => i.id === ids.D10)!;
    expect(d10).toMatchObject({ processId: null, processNumber: null, reference: null, restricted: true });
    expect(itemHeading(d10)).toBe("Registro sem acesso");
    expect(spDeadlines.items.filter((i) => i.id !== ids.D10).every((i) => !i.restricted)).toBe(true);
    expect(ok(sp.installments).total).toBe(3);
    expect(ok(sp.guarantees).total).toBe(2);
    expect(ok(sp.valuations).total).toBe(1);

    const re = await band(fx.ctx.lawyerRe);
    const reHearings = ok(re.hearings);
    expect(reHearings.total).toBe(1);
    expect(reHearings.items.map((i) => i.processId)).toEqual([ids.PRE]);
    const reDeadlines = ok(re.deadlines);
    expect(reDeadlines.total).toBe(2); // D8 and D10
    expect(reDeadlines.overdue).toBe(0);
    expect(reDeadlines.pendingValidation).toBe(0);
    expect(reDeadlines.items.every((i) => i.processId === ids.PRE)).toBe(true);
    const reInstallments = ok(re.installments);
    expect(reInstallments).toMatchObject({ total: 1, overdue: 0, totalCents: 10_000 });
    expect(ok(re.guarantees).items.map((i) => i.id)).toEqual([ids.G6]);
    expect(ok(re.valuations).items.map((i) => i.id)).toEqual([ids.V3]);
  });

  it("hides confidential processes from executives and other organizations", async () => {
    const exec = await band(fx.ctx.executive);
    expect(ok(exec.hearings).total).toBe(4);
    expect(ok(exec.deadlines).items.map((i) => i.id)).not.toContain(ids.D11);

    const b = await band(fx.ctx.adminB);
    expect(ok(b.hearings).items.map((i) => i.processId)).toEqual([ids.PB]); // only its own organization
    expect(ok(b.deadlines)).toMatchObject({ total: 0, pendingValidation: 0 });
    expect(ok(b.installments).total).toBe(0);
    expect(ok(b.guarantees).total).toBe(0);
    expect(ok(b.valuations).total).toBe(0);
  });

  it("marks blocks without permission as forbidden and isolates failures", async () => {
    const accountant = await band(fx.ctx.accountant); // no deadline:read
    expect(accountant.deadlines).toEqual({ status: "forbidden" });
    expect(accountant.installments.status).toBe("ok");
    expect(ok(accountant.valuations).total).toBe(2);

    vi.mocked(listReviewQueue).mockRejectedValueOnce(new Error("falha simulada"));
    const failing = await band(fx.ctx.admin);
    expect(failing.valuations).toEqual({ status: "error" });
    expect(ok(failing.deadlines).total).toBe(5);
  });
});

describe("decision band: the complete list of each block has exactly the counted items", () => {
  it("matches /audiencias, /acordos, /contingencias/garantias and /contingencias/revisao for every profile", async () => {
    for (const ctx of [fx.ctx.admin, fx.ctx.lawyer, fx.ctx.lawyerRe, fx.ctx.executive, fx.ctx.accountant, fx.ctx.externalCounsel, fx.ctx.adminB]) {
      const b = await band(ctx);
      if (b.hearings.status === "ok") {
        const listed = await listHearings(ctx, { period: "7d", status: "scheduled" });
        expect(b.hearings.data.list.count).toBe(listed.total);
        expect(b.hearings.data.list.count).toBe(b.hearings.data.total);
      }
      if (b.installments.status === "ok") {
        expect(b.installments.data.list.count).toBe((await listSettlements(ctx, { dueSoon: true })).total);
      }
      if (b.guarantees.status === "ok") {
        const listed = await listIdleGuarantees(ctx);
        expect(b.guarantees.data.list.count).toBe(listed.total);
        expect(b.guarantees.data.totalCents).toBe(listed.totalCents);
        expect(listed.items.slice(0, b.guarantees.data.items.length).map((i) => i.id)).toEqual(
          b.guarantees.data.items.map((i) => i.id),
        );
      }
      if (b.valuations.status === "ok") {
        expect(b.valuations.data.list.count).toBe((await listReviewQueue(ctx, {})).total);
      }
    }
  });

  it("lists the idle guarantees with the process link, the movement basis and the configured threshold", async () => {
    const list = await listIdleGuarantees(fx.ctx.admin);
    expect(list.idleDays).toBe(IDLE_DAYS);
    expect(list.total).toBe(3);
    const g6 = list.items.find((i) => i.id === ids.G6)!;
    expect(g6).toMatchObject({ processId: ids.PRE, idleSinceBasis: "registration" });
    expect(list.items.find((i) => i.id === ids.G1)).toMatchObject({ idleSinceBasis: "deposit", idleSince: d(-(IDLE_DAYS + 1)) });
    // Row visibility: the RE lawyer only sees G6; organization B sees nothing.
    expect((await listIdleGuarantees(fx.ctx.lawyerRe)).items.map((i) => i.id)).toEqual([ids.G6]);
    expect((await listIdleGuarantees(fx.ctx.adminB)).total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Component (server render; no browser in CI)
// ---------------------------------------------------------------------------

describe("decision band — component", () => {
  const block = (overrides: Partial<DecisionBlock>): DecisionBlock => ({
    key: "hearings",
    total: 0,
    overdue: 0,
    totalCents: null,
    items: [],
    href: "/x",
    list: { href: overrides.href ?? "/x", count: overrides.total ?? 0 },
    ...overrides,
  });
  const deadlinesBlock: DeadlineDecisionBlock = {
    ...block({ key: "deadlines", total: 7, overdue: 2, href: DECISION_HREFS.deadlines }),
    list: { href: DECISION_HREFS.deadlines, count: null },
    items: [
      {
        id: "d1",
        processId: "p1",
        processNumber: "0000001-00.2026.5.10.0001",
        reference: null,
        restricted: false,
        description: "Contestação (fictício)",
        date: "2026-10-09",
        at: null,
        amountCents: null,
        overdue: true,
        tags: ["Processual"],
        simulated: false,
        estimate: false,
        href: "/prazos?aba=prazos&prazo=d1",
      },
    ],
    pendingValidation: 3,
    pendingValidationHref: DECISION_HREFS.pendingValidation,
  };
  const data: DecisionBandData = {
    today: "2026-10-11",
    windows: { hearingDays: 7, deadlineDays: 7, installmentDueDays: 10, idleGuaranteeDays: 180 },
    hearings: { status: "ok", data: block({ key: "hearings", href: DECISION_HREFS.hearings }) },
    deadlines: { status: "ok", data: deadlinesBlock },
    installments: { status: "error" },
    guarantees: { status: "forbidden" },
    valuations: {
      status: "ok",
      data: block({
        key: "valuations",
        total: 1,
        href: DECISION_HREFS.valuations,
        items: [
          {
            ...deadlinesBlock.items[0],
            id: "v1",
            description: "Valor da causa",
            date: "2026-10-01",
            overdue: false,
            amountCents: 300_000,
            tags: ["Extração simulada (demonstração)"],
            simulated: true,
            estimate: true,
            href: "/contingencias/revisao?item=v1",
          },
        ],
      }),
    },
  };

  it("renders the band first-class: counts, top items, action links, separate validation count", () => {
    const out = renderToStaticMarkup(createElement(DecisionBand, { band: data }));
    expect(out).toContain("Exige decisão agora");
    expect(out).toContain("Nenhuma audiência designada de hoje até os próximos 7 dias");
    expect(out).toContain("prazos fatais");
    expect(out).toContain("2 vencidos");
    expect(out).toContain("vencido há 2 dias");
    expect(out).toContain("/prazos?aba=prazos&amp;prazo=d1");
    // Deadlines: the list is wider than the block, so the link has no count.
    expect(out).toContain("Ver todos os prazos em aberto");
    expect(out).not.toContain("Ver lista completa (7)");
    expect(out).toContain("Aguardando validação");
    expect(out).toContain("/prazos?aba=validacao");
    expect(out).toContain("indisponível"); // installments failed
    expect(out).not.toContain("Garantias sem movimentação"); // forbidden: not rendered
    expect(out).toContain("Extração simulada (demonstração)");
    expect(out).toContain("Estimativa");
    expect(out).toContain("/contingencias/revisao?item=v1");
  });

  it("renders nothing when every block is forbidden", () => {
    const forbidden = { status: "forbidden" } as const;
    const none: DecisionBandData = {
      ...data,
      hearings: forbidden,
      deadlines: forbidden,
      installments: forbidden,
      guarantees: forbidden,
      valuations: forbidden,
    };
    expect(renderToStaticMarkup(createElement(DecisionBand, { band: none }))).toBe("");
  });
});
