/**
 * P0.4 — decision band of the process detail (`/processos/[id]`).
 *
 * 1. Pure model (`buildProcessDecisionBand`): next-act ordering, pending items,
 *    risk and values blocks, the no-responsible case and the permission gates.
 * 2. Loader (`getProcessDecisionBand`) on PGlite: row scope and permissions — a lawyer
 *    without `contingency:read` gets no amount, percentage, classification or value alert.
 * 3. Server render of the band.
 */
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/domain/enums";
import { addDaysISO, todayISO } from "@/lib/format";
import { upsertAlert } from "@/modules/alerts/service";
import { zonedDateTimeToUtc } from "@/modules/hearings/time";
import { ProcessDecisionBandView } from "@/modules/processes/components/process-decision-band";
import {
  buildProcessDecisionBand,
  type BandAccess,
  type BandProcessFacts,
  type ProcessBandInput,
} from "@/modules/processes/decision-band";
import { getProcessDecisionBand, processBandAccess } from "@/modules/processes/decision-band-service";
import {
  deadlines,
  hearings,
  legalProcesses,
  processGuarantees,
  processRiskAssessments,
  processValuations,
} from "@/server/db/schema";
import { ROLE_PERMISSIONS, type Permission } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

// ---------------------------------------------------------------------------
// 1. Pure model
// ---------------------------------------------------------------------------

const TODAY = "2026-10-12";
const PID = "00000000-0000-4000-8000-000000000001";
const day = (n: number) => addDaysISO(TODAY, n);
const at = (n: number, time: string) => zonedDateTimeToUtc(day(n), time);

const fullAccess = (over: Partial<BandAccess> = {}): BandAccess => ({
  alerts: true,
  deadlines: true,
  contingency: true,
  classify: true,
  distribute: false,
  ...over,
});

const facts = (over: Partial<BandProcessFacts> = {}): BandProcessFacts => ({
  id: PID,
  needsVerification: false,
  verificationNote: null,
  responsibleId: "user-1",
  responsibleName: "Laura Advogada (fictícia)",
  lawFirmName: null,
  lossProbability: null,
  recordRiskBp: null,
  ...over,
});

const input = (over: Partial<ProcessBandInput> = {}): ProcessBandInput => ({
  today: TODAY,
  access: fullAccess(),
  process: facts(),
  alerts: [],
  deadlines: [],
  hearings: [],
  valuations: [],
  risks: [],
  ...over,
});

const deadline = (id: string, dueDate: string, validationStatus: ProcessBandInput["deadlines"][number]["validationStatus"] = "not_required") => ({
  id,
  title: `Prazo ${id} (fictício)`,
  kind: "procedural" as const,
  dueDate,
  validationStatus,
});
const hearing = (id: string, scheduledAt: Date) => ({ id, kind: "instruction" as const, mode: "virtual" as const, scheduledAt });

describe("decision band model — próximo ato", () => {
  it("an overdue deadline comes first; the others count as following acts", () => {
    const band = buildProcessDecisionBand(
      input({
        deadlines: [deadline("d-later", day(3)), deadline("d-overdue", day(-2))],
        hearings: [hearing("h-tomorrow", at(1, "10:00"))],
      }),
    );
    expect(band.nextAct.act).toMatchObject({ kind: "deadline", id: "d-overdue", overdue: true, date: day(-2) });
    expect(band.nextAct.act?.href).toBe("/prazos?aba=prazos&prazo=d-overdue");
    expect(band.nextAct.more).toBe(2);
    // P0.6 tabs: deadlines and hearings share "Prazos e audiências".
    expect(band.nextAct.moreHref).toBe(`/processos/${PID}?aba=prazos-e-audiencias`);
  });

  it("on the same day the hearing (fixed time) comes before the deadline; hearings by time", () => {
    const band = buildProcessDecisionBand(
      input({
        deadlines: [deadline("d-today", day(0))],
        hearings: [hearing("h-16", at(0, "16:00")), hearing("h-09", at(0, "09:00"))],
      }),
    );
    expect(band.nextAct.act).toMatchObject({ kind: "hearing", id: "h-09", date: TODAY });
    expect(band.nextAct.act?.href).toBe(`/processos/${PID}?aba=prazos-e-audiencias#audiencias`);
    expect(band.nextAct.more).toBe(2);
  });

  it("the nearest date wins across kinds (hearing tomorrow before a deadline in 5 days)", () => {
    const band = buildProcessDecisionBand(
      input({ deadlines: [deadline("d5", day(5))], hearings: [hearing("h1", at(1, "18:00"))] }),
    );
    expect(band.nextAct.act).toMatchObject({ kind: "hearing", id: "h1" });
  });

  it("suggestions awaiting validation and rejected deadlines are never the next act", () => {
    const band = buildProcessDecisionBand(
      input({
        deadlines: [
          deadline("d-pending", day(1), "pending_validation"),
          deadline("d-rejected", day(1), "rejected"),
          deadline("d-validated", day(4), "validated"),
        ],
      }),
    );
    expect(band.nextAct.act).toMatchObject({ kind: "deadline", id: "d-validated", validated: true, overdue: false });
    expect(band.nextAct.more).toBe(0);
    const pending = band.pendencies.filter((p) => p.kind === "deadline_validation");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ href: "/prazos?aba=validacao&prazo=d-pending", date: day(1), actionLabel: "Validar" });
  });

  it("a scheduled hearing of a past day is a pending outcome, not the next act", () => {
    const band = buildProcessDecisionBand(input({ hearings: [hearing("h-past", at(-3, "10:00"))] }));
    expect(band.nextAct.act).toBeNull();
    expect(band.pendencies).toEqual([
      expect.objectContaining({ kind: "hearing_outcome", date: day(-3), href: `/processos/${PID}?aba=prazos-e-audiencias#audiencias` }),
    ]);
  });

  it("without deadline:read only hearings are considered (no deadline pendências either)", () => {
    const band = buildProcessDecisionBand(
      input({
        access: fullAccess({ deadlines: false }),
        deadlines: [deadline("d-overdue", day(-2)), deadline("d-pending", day(1), "pending_validation")],
        hearings: [hearing("h2", at(2, "10:00"))],
      }),
    );
    expect(band.nextAct).toMatchObject({
      deadlinesConsidered: false,
      more: 0,
      moreHref: `/processos/${PID}?aba=prazos-e-audiencias#audiencias`,
    });
    expect(band.nextAct.act).toMatchObject({ kind: "hearing", id: "h2" });
    expect(band.pendencies.some((p) => p.kind === "deadline_validation")).toBe(false);
  });
});

describe("decision band model — pendências", () => {
  it("lists the flag, alerts, validations and outcomes ordered by severity and kind", () => {
    const created = new Date("2026-10-01T12:00:00Z");
    const band = buildProcessDecisionBand(
      input({
        process: facts({ needsVerification: true, verificationNote: "  Divergência entre abas  " }),
        alerts: [
          { id: "a-info", type: "court_movement_relevant", severity: "info", title: "Movimentação relevante", href: `/processos/${PID}`, createdAt: created },
          { id: "a-crit", type: "hearing_upcoming", severity: "critical", title: "Audiência amanhã", href: `/processos/${PID}?aba=audiencias`, createdAt: created },
          { id: "a-warn", type: "enforcement_without_value", severity: "warning", title: "Execução sem valor apurado", href: `/processos/${PID}?aba=valores`, createdAt: created },
          // Shown by dedicated blocks: never repeated as pendências.
          { id: "a-flag", type: "process_needs_verification", severity: "warning", title: "Marcado", href: null, createdAt: created },
          { id: "a-val", type: "valuation_pending_review", severity: "info", title: "Valor aguardando", href: null, createdAt: created },
        ],
        deadlines: [deadline("d-pending", day(2), "pending_validation")],
        hearings: [hearing("h-past", at(-1, "09:00"))],
      }),
    );
    expect(band.pendencies.map((p) => p.key)).toEqual([
      "alert:a-crit",
      "verification",
      "alert:a-warn",
      "deadline:d-pending",
      "hearing:h-past",
      "alert:a-info",
    ]);
    expect(band.pendencies[0]).toMatchObject({ tone: "danger", href: `/processos/${PID}?aba=audiencias` });
    expect(band.pendencies[1]).toMatchObject({ label: "Pendente de conferência", detail: "Divergência entre abas", href: null });
    // A link back to this very page is replaced by the alert in the alerts center.
    expect(band.pendencies[5].href).toBe("/alertas?tipo=court_movement_relevant");
    // P0.6: registration gaps are listed once, by the cover of the "Resumo" tab, not by the band.
    expect(band.pendencies.some((p) => p.label === "Cadastro incompleto")).toBe(false);
  });

  it("a flag without a note says so", () => {
    const band = buildProcessDecisionBand(input({ process: facts({ needsVerification: true, verificationNote: "  " }) }));
    expect(band.pendencies).toEqual([
      expect.objectContaining({ kind: "verification", label: "Pendente de conferência", detail: "Marcado para conferência, sem nota registrada." }),
    ]);
  });

  it("an empty process has no pendências and no next act", () => {
    const band = buildProcessDecisionBand(input());
    expect(band.pendencies).toEqual([]);
    expect(band.nextAct.act).toBeNull();
  });

  it("alerts are omitted without dashboard:read", () => {
    const band = buildProcessDecisionBand(
      input({
        access: fullAccess({ alerts: false }),
        alerts: [{ id: "a", type: "hearing_upcoming", severity: "critical", title: "Audiência", href: null, createdAt: new Date() }],
      }),
    );
    expect(band.pendencies).toEqual([]);
  });
});

describe("decision band model — responsável", () => {
  it("without a responsible: 'sem responsável' and a distribution link only for distribution:manage", () => {
    const process = facts({ responsibleId: null, responsibleName: null, lawFirmName: "Escritório Fictício A" });
    const allowed = buildProcessDecisionBand(input({ process, access: fullAccess({ distribute: true }) }));
    expect(allowed.responsible).toEqual({
      assigned: false,
      name: null,
      lawFirmName: "Escritório Fictício A",
      distributeHref: `/distribuicao?aba=regras&processo=${PID}`,
    });
    const denied = buildProcessDecisionBand(input({ process }));
    expect(denied.responsible).toMatchObject({ assigned: false, name: null, distributeHref: null });
  });

  it("with a responsible: name and law firm", () => {
    const band = buildProcessDecisionBand(input({ process: facts({ lawFirmName: "Escritório Fictício A" }) }));
    expect(band.responsible).toMatchObject({ assigned: true, name: "Laura Advogada (fictícia)", lawFirmName: "Escritório Fictício A" });
  });
});

describe("decision band model — valores e risco", () => {
  const created = (iso: string) => new Date(iso);
  const valuations: ProcessBandInput["valuations"] = [
    { id: "v-new", kind: "claim", amountCents: 990_000, baseDate: day(-1), source: "simulation", isEstimate: true, createdAt: created("2026-10-10T10:00:00Z") },
    { id: "v-old", kind: "liquidated", amountCents: 1_234_567, baseDate: day(-30), source: "spreadsheet", isEstimate: false, createdAt: created("2026-09-01T10:00:00Z") },
  ];

  it("lists proposed values oldest first, each linked to its review; the block opens the oldest", () => {
    const band = buildProcessDecisionBand(input({ valuations }));
    expect(band.valuations).toMatchObject({ total: 2, href: "/contingencias/revisao?item=v-old" });
    expect(band.valuations?.items.map((v) => [v.id, v.amountCents, v.simulated, v.estimate])).toEqual([
      ["v-old", 1_234_567, false, false],
      ["v-new", 990_000, true, true],
    ]);
    expect(band.valuations?.items[1].href).toBe("/contingencias/revisao?item=v-new");
  });

  it("no value waiting: total 0 and the block links to the queue", () => {
    expect(buildProcessDecisionBand(input()).valuations).toEqual({ total: 0, items: [], href: "/contingencias/revisao" });
  });

  it("risk: the official assessment in force today (future and proposed ones do not count)", () => {
    const risks: ProcessBandInput["risks"] = [
      { id: "r-old", classification: "remote", percentageBp: 0, effectiveFrom: day(-90), status: "official", createdAt: created("2026-07-01T00:00:00Z") },
      { id: "r-now", classification: "possible", percentageBp: 5000, effectiveFrom: day(-10), status: "official", createdAt: created("2026-10-02T00:00:00Z") },
      { id: "r-future", classification: "probable", percentageBp: 10000, effectiveFrom: day(5), status: "official", createdAt: created("2026-10-11T00:00:00Z") },
      { id: "r-prop", classification: "probable", percentageBp: 10000, effectiveFrom: day(0), status: "proposed", createdAt: created("2026-10-12T00:00:00Z") },
    ];
    const band = buildProcessDecisionBand(input({ risks }));
    expect(band.risk).toEqual({
      classification: "possible",
      percentageBp: 5000,
      basis: "official",
      effectiveFrom: day(-10),
      pendingProposals: 1,
      href: `/processos/${PID}?aba=valores-e-acordos#classificacao-risco`,
      canClassify: true,
    });
  });

  it("risk: the record classification is flagged; without any, 'sem classificação' with the classify link", () => {
    const record = buildProcessDecisionBand(input({ process: facts({ lossProbability: "probable", recordRiskBp: 10000 }) }));
    expect(record.risk).toMatchObject({ classification: "probable", percentageBp: 10000, basis: "record" });
    const none = buildProcessDecisionBand(input({ access: fullAccess({ classify: false }) }));
    expect(none.risk).toMatchObject({ classification: null, percentageBp: null, basis: "none", canClassify: false });
  });

  it("without contingency:read no value, percentage, classification or value alert reaches the model", () => {
    const band = buildProcessDecisionBand(
      input({
        access: fullAccess({ contingency: false, classify: false }),
        process: facts({ lossProbability: "probable", recordRiskBp: 10000 }),
        valuations,
        risks: [{ id: "r", classification: "possible", percentageBp: 5000, effectiveFrom: day(-1), status: "official", createdAt: new Date() }],
        alerts: [
          { id: "a1", type: "enforcement_without_value", severity: "warning", title: "Execução sem valor apurado", href: null, createdAt: new Date() },
          { id: "a2", type: "guarantee_idle", severity: "info", title: "Garantia parada", href: null, createdAt: new Date() },
          { id: "a3", type: "hearing_upcoming", severity: "warning", title: "Audiência próxima", href: null, createdAt: new Date() },
        ],
      }),
    );
    expect(band.valuations).toBeNull();
    expect(band.risk).toBeNull();
    expect(band.pendencies.map((p) => p.key)).toEqual(["alert:a3"]);
    const json = JSON.stringify(band);
    for (const leaked of ["1234567", "990000", "5000", "10000", "possible", "probable"]) expect(json).not.toContain(leaked);
  });
});

// ---------------------------------------------------------------------------
// 2–3. Loader (PGlite) and render
// ---------------------------------------------------------------------------

/** Runs `fn` with `perms` removed from `role` (no role lacks contingency:read in the shipped matrix). */
async function withoutPermissions<T>(role: Role, perms: Permission[], fn: () => Promise<T>): Promise<T> {
  const table = ROLE_PERMISSIONS as Record<Role, readonly Permission[]>;
  const original = table[role];
  table[role] = original.filter((p) => !perms.includes(p));
  try {
    return await fn();
  } finally {
    table[role] = original;
  }
}

describe("getProcessDecisionBand (row scope and permissions)", () => {
  let fx: Fixture;
  const ids: Record<string, string> = {};
  const today = todayISO();
  const d = (n: number) => addDaysISO(today, n);

  beforeAll(async () => {
    fx = await setupFixture("procband");
    const lawyer = fx.ctx.lawyer.userId!;
    ids.P = await makeProcess(fx.ctx.manager, {
      title: "Processo da faixa de decisão (fictício)",
      unitId: fx.unitSp,
      responsibleId: lawyer,
      companyId: fx.companyA,
      instance: "first",
      city: "Palmas",
    });
    ids.Q = await makeProcess(fx.ctx.manager, { title: "Processo sem responsável (fictício)", unitId: fx.unitSp });
    ids.RE = await makeProcess(fx.ctx.manager, { title: "Processo de outra unidade (fictício)", unitId: fx.unitRe });
    await fx.db
      .update(legalProcesses)
      .set({ needsVerification: true, verificationNote: "Valor divergente entre planilhas (fictício)" })
      .where(eq(legalProcesses.id, ids.P));

    const dl = await fx.db
      .insert(deadlines)
      .values([
        { organizationId: fx.orgA, processId: ids.P, title: "Contestação (fictício)", dueDate: d(-1), kind: "procedural" as const },
        {
          organizationId: fx.orgA,
          processId: ids.P,
          title: "Sugestão de prazo (fictício)",
          dueDate: d(2),
          kind: "procedural" as const,
          origin: "ai_suggested" as const,
          validationStatus: "pending_validation" as const,
        },
        { organizationId: fx.orgA, processId: ids.P, title: "Cumprido (fictício)", dueDate: d(-5), kind: "procedural" as const, status: "done" as const },
      ])
      .returning({ id: deadlines.id, title: deadlines.title });
    ids.overdue = dl[0].id;
    ids.pending = dl[1].id;

    const hs = await fx.db
      .insert(hearings)
      .values([
        { organizationId: fx.orgA, processId: ids.P, kind: "instruction" as const, scheduledAt: zonedDateTimeToUtc(d(1), "10:00") },
        { organizationId: fx.orgA, processId: ids.P, kind: "conciliation" as const, scheduledAt: zonedDateTimeToUtc(d(-3), "10:00") },
      ])
      .returning({ id: hearings.id });
    ids.hearingNext = hs[0].id;
    ids.hearingPast = hs[1].id;

    const [g] = await fx.db
      .insert(processGuarantees)
      .values({ organizationId: fx.orgA, processId: ids.P, kind: "judicial_deposit", amountCents: 50_000 })
      .returning({ id: processGuarantees.id });
    ids.guarantee = g.id;

    const vs = await fx.db
      .insert(processValuations)
      .values([
        // Distinct creation times: the queue order (oldest first) must not depend on random ids.
        {
          organizationId: fx.orgA,
          processId: ids.P,
          kind: "liquidated" as const,
          amountCents: 1_234_567,
          baseDate: d(-20),
          source: "spreadsheet" as const,
          createdAt: new Date(Date.now() - 2 * 86_400_000),
        },
        {
          organizationId: fx.orgA,
          processId: ids.P,
          kind: "claim" as const,
          amountCents: 7_654_321,
          baseDate: d(-2),
          source: "simulation" as const,
          isEstimate: true,
          createdAt: new Date(Date.now() - 86_400_000),
        },
        {
          organizationId: fx.orgA,
          processId: ids.P,
          kind: "claim" as const,
          amountCents: 5_555_555,
          baseDate: d(-60),
          source: "manual" as const,
          status: "official" as const,
          reviewedById: fx.ctx.manager.userId!,
          reviewedAt: new Date(),
        },
      ])
      .returning({ id: processValuations.id });
    ids.valuationOld = vs[0].id;

    await fx.db.insert(processRiskAssessments).values([
      {
        organizationId: fx.orgA,
        processId: ids.P,
        classification: "possible",
        percentageBp: 5000,
        opinion: "Parecer fictício.",
        effectiveFrom: d(-10),
        status: "official",
        assessedById: lawyer,
      },
      {
        organizationId: fx.orgA,
        processId: ids.P,
        classification: "probable",
        percentageBp: 10000,
        opinion: "Sugestão por regra (fictícia).",
        effectiveFrom: today,
        status: "proposed",
        origin: "system",
      },
    ]);

    const alert = (type: Parameters<typeof upsertAlert>[0]["type"], severity: Parameters<typeof upsertAlert>[0]["severity"], entityType: Parameters<typeof upsertAlert>[0]["entityType"], entityId: string, title: string) =>
      upsertAlert({ organizationId: fx.orgA, type, severity, title, message: "Mensagem fictícia.", entityType, entityId, dedupeKey: `${type}:${entityId}` });
    await alert("hearing_upcoming", "critical", "hearing", ids.hearingNext, "Audiência amanhã (fictício)");
    await alert("enforcement_without_value", "warning", "legal_process", ids.P, "Execução sem valor apurado (fictício)");
    await alert("guarantee_idle", "info", "guarantee", ids.guarantee, "Garantia parada (fictício)");
    await alert("process_needs_verification", "warning", "legal_process", ids.P, "Marcado para verificação (fictício)");
    await alert("enforcement_without_value", "warning", "legal_process", ids.Q, "Alerta de outro processo (fictício)");
  });

  afterAll(async () => fx?.teardown());

  it("manager: every block, values and risk included", async () => {
    const band = await getProcessDecisionBand(fx.ctx.manager, ids.P);
    expect(band.nextAct.act).toMatchObject({ kind: "deadline", id: ids.overdue, overdue: true });
    expect(band.nextAct.more).toBe(1); // tomorrow's hearing
    expect(band.pendencies.map((p) => p.label)).toEqual([
      "Audiência amanhã (fictício)",
      "Pendente de conferência",
      "Execução sem valor apurado (fictício)",
      "Prazo sugerido aguardando validação humana",
      "Audiência sem desfecho registrado",
      "Garantia parada (fictício)",
    ]);
    expect(band.pendencies[0].href).toBe(`/processos/${ids.P}?aba=prazos-e-audiencias#audiencias`);
    expect(band.pendencies[5].href).toBe(`/processos/${ids.P}?aba=valores-e-acordos`);
    expect(band.valuations).toMatchObject({ total: 2, href: `/contingencias/revisao?item=${ids.valuationOld}` });
    expect(band.valuations?.items.map((v) => v.amountCents)).toEqual([1_234_567, 7_654_321]);
    expect(band.risk).toMatchObject({ classification: "possible", percentageBp: 5000, basis: "official", pendingProposals: 1, canClassify: true });
    expect(band.responsible).toMatchObject({
      assigned: true,
      name: "Laura Advogada SP",
      distributeHref: `/distribuicao?aba=regras&processo=${ids.P}`,
    });
  });

  it("lawyer without contingency:read: no values, risk or value alerts — in the model and in the HTML", async () => {
    const { band, html } = await withoutPermissions("lawyer", ["contingency:read", "contingency:write", "contingency:approve"], async () => {
      expect(processBandAccess(fx.ctx.lawyer)).toMatchObject({ contingency: false, classify: false });
      const b = await getProcessDecisionBand(fx.ctx.lawyer, ids.P);
      return { band: b, html: renderToStaticMarkup(ProcessDecisionBandView({ band: b })) };
    });
    expect(band.valuations).toBeNull();
    expect(band.risk).toBeNull();
    expect(band.pendencies.map((p) => p.label)).toEqual([
      "Audiência amanhã (fictício)",
      "Pendente de conferência",
      "Prazo sugerido aguardando validação humana",
      "Audiência sem desfecho registrado",
    ]);
    const json = JSON.stringify(band);
    for (const leaked of ["1234567", "7654321", "possible", "probable", "5000"]) expect(json).not.toContain(leaked);
    expect(html).not.toContain("R$");
    expect(html).not.toContain("Valor aguardando conferência");
    expect(html).not.toContain("decisao-risco");
    expect(html).toContain("Próximo ato");
    // Not allowed to distribute: no link, and the lawyer is the responsible.
    expect(band.responsible).toMatchObject({ assigned: true, distributeHref: null });
  });

  it("lawyer with the shipped matrix (contingency:read) sees values but cannot redistribute", async () => {
    const band = await getProcessDecisionBand(fx.ctx.lawyer, ids.P);
    expect(band.valuations?.total).toBe(2);
    expect(band.responsible.distributeHref).toBeNull();
  });

  it("process without responsible: 'sem responsável'; distribution link only for distribution:manage", async () => {
    const manager = await getProcessDecisionBand(fx.ctx.manager, ids.Q);
    expect(manager.responsible).toEqual({
      assigned: false,
      name: null,
      lawFirmName: null,
      distributeHref: `/distribuicao?aba=regras&processo=${ids.Q}`,
    });
    const lawyer = await getProcessDecisionBand(fx.ctx.lawyer, ids.Q);
    expect(lawyer.responsible).toMatchObject({ assigned: false, distributeHref: null });
    // The minimal record has registration gaps, but the band does not list them (the cover does).
    expect(lawyer.pendencies.some((p) => p.label === "Cadastro incompleto")).toBe(false);
  });

  it("follows row visibility: a process of another unit is not found", async () => {
    await expect(getProcessDecisionBand(fx.ctx.lawyerRe, ids.P)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProcessDecisionBand(fx.ctx.adminB, ids.P)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("renders the band with actionable links", async () => {
    const band = await getProcessDecisionBand(fx.ctx.manager, ids.P);
    const html = renderToStaticMarkup(ProcessDecisionBandView({ band }));
    expect(html).toContain("Exige decisão agora");
    expect(html).toContain(`/contingencias/revisao?item=${ids.valuationOld}`);
    expect(html).toContain(`/prazos?aba=prazos&amp;prazo=${ids.overdue}`);
    expect(html).toContain(`/prazos?aba=validacao&amp;prazo=${ids.pending}`);
    expect(html).toContain("Extração simulada (demonstração)");
    expect(html).toContain("Estimativa");
    expect(html).toContain(`/processos/${ids.P}?aba=valores-e-acordos#classificacao-risco`);
    expect(html).toContain("Ver mais 2 pendências");
  });
});
