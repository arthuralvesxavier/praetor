import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { addDaysISO, todayISO } from "@/lib/format";
import { ALERT_TYPES } from "@/domain/enums";
import { ALERT_AREAS, ALERT_TYPES_BY_AREA, alertAreaOf } from "@/modules/alerts/areas";
import {
  alertHref,
  countAlertsByArea,
  countOpenAlerts,
  listAlertGroups,
  listAlerts,
  listAlertsPaged,
  resolveAlert,
  resolveAlertHrefs,
  upsertAlert,
} from "@/modules/alerts/service";
import { createHearing } from "@/modules/hearings/service";
import {
  alerts,
  auditLogs,
  caseBriefs,
  caseIntakes,
  processGuarantees,
  processValuations,
  settlements,
} from "@/server/db/schema";
import { ForbiddenError, NotFoundError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

let fx: Fixture;
const ids: Record<string, string> = {};
const today = todayISO();

async function alert(
  orgId: string,
  type: (typeof ALERT_TYPES)[number],
  entityType: Parameters<typeof upsertAlert>[0]["entityType"],
  entityId: string,
  severity: "info" | "warning" | "critical" = "warning",
) {
  const key = `${type}:${entityId}`;
  await upsertAlert({
    organizationId: orgId,
    type,
    severity,
    title: `Alerta ${type} (fictício)`,
    message: "Mensagem de teste (fictícia).",
    entityType,
    entityId,
    dedupeKey: key,
  });
  const [row] = await fx.db.select().from(alerts).where(and(eq(alerts.organizationId, orgId), eq(alerts.dedupeKey, key)));
  return row.id;
}

beforeAll(async () => {
  fx = await setupFixture("halert");
  const { admin } = fx.ctx;
  const orgA = fx.orgA;
  ids.pSp = await makeProcess(admin, { unitId: fx.unitSp, title: "Processo SP (fictício)" });
  ids.pRe = await makeProcess(admin, { unitId: fx.unitRe, title: "Processo RE (fictício)" });
  ids.pB = await makeProcess(fx.ctx.adminB, { title: "Processo B (fictício)" });

  ids.hearing = (
    await createHearing(admin, {
      processId: ids.pSp,
      kind: "conciliation",
      mode: "virtual",
      date: addDaysISO(today, 3),
      time: "10:00",
    })
  ).id;
  // Rows of other packages' tables are inserted directly: this suite only checks alert links and scope.
  ids.settlement = (await fx.db.insert(settlements).values({ organizationId: orgA, processId: ids.pSp }).returning())[0].id;
  ids.guarantee = (
    await fx.db
      .insert(processGuarantees)
      .values({ organizationId: orgA, processId: ids.pSp, kind: "judicial_deposit", amountCents: 150_000 })
      .returning()
  )[0].id;
  ids.valuation = (
    await fx.db
      .insert(processValuations)
      .values({ organizationId: orgA, processId: ids.pSp, kind: "liquidated", amountCents: 1_000, baseDate: today, source: "manual" })
      .returning()
  )[0].id;
  ids.brief = (
    await fx.db
      .insert(caseBriefs)
      .values({
        organizationId: orgA,
        processId: ids.pSp,
        version: 1,
        status: "ready_for_review",
        mode: "demo",
        provider: "simulado",
        model: "simulado",
        promptVersion: "teste",
        inputHash: "teste",
      })
      .returning()
  )[0].id;
  ids.intake = (await fx.db.insert(caseIntakes).values({ organizationId: orgA, processId: ids.pSp, source: "manual" }).returning())[0].id;

  ids.aHearing = await alert(orgA, "hearing_upcoming", "hearing", ids.hearing, "critical");
  ids.aSettlement = await alert(orgA, "settlement_installment_due", "settlement", ids.settlement);
  ids.aGuarantee = await alert(orgA, "guarantee_idle", "guarantee", ids.guarantee, "info");
  ids.aValuation = await alert(orgA, "valuation_pending_review", "valuation", ids.valuation);
  ids.aValuationProcess = await alert(orgA, "valuation_pending_review", "legal_process", ids.pRe);
  ids.aVerification = await alert(orgA, "process_needs_verification", "legal_process", ids.pSp, "info");
  ids.aBrief = await alert(orgA, "brief_pending_review", "case_brief", ids.brief);
  ids.aIntake = await alert(orgA, "intake_unassigned", "intake", ids.intake, "critical");
  ids.aOrgB = await alert(fx.orgB, "process_needs_verification", "legal_process", ids.pB);
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("areas", () => {
  it("every alert type belongs to exactly one area", () => {
    const all = ALERT_AREAS.flatMap((a) => ALERT_TYPES_BY_AREA[a]);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ALERT_TYPES].sort());
    expect(alertAreaOf("hearing_upcoming")).toBe("hearings");
    expect(alertAreaOf("guarantee_idle")).toBe("values");
  });
});

describe("link resolution", () => {
  it("links entities with their own route without a lookup", () => {
    expect(alertHref("case_brief", "b1")).toBe("/analises-preliminares/b1");
    expect(alertHref("intake", "i1")).toBe("/entrada/i1");
    expect(alertHref("legal_process", "p1")).toBe("/processos/p1");
    expect(alertHref("legal_process", "p1", "enforcement_without_value")).toBe("/processos/p1?aba=valores");
    expect(alertHref("deadline", "d1")).toBe("/prazos?aba=prazos&prazo=d1");
    expect(alertHref("deadline", "d1", "deadline_pending_validation")).toBe("/prazos?aba=validacao&prazo=d1");
    expect(alertHref("hearing", "h1")).toBeNull();
    expect(alertHref("user", "u1")).toBeNull();
  });

  it("batch-resolves process-owned entities to their process tab, scoped to the organization", async () => {
    const map = await resolveAlertHrefs(fx.orgA, [
      { type: "hearing_upcoming", entityType: "hearing", entityId: ids.hearing },
      { type: "settlement_installment_due", entityType: "settlement", entityId: ids.settlement },
      { type: "guarantee_idle", entityType: "guarantee", entityId: ids.guarantee },
      { type: "valuation_pending_review", entityType: "valuation", entityId: ids.valuation },
    ]);
    expect(map.get(`hearing:${ids.hearing}`)).toBe(`/processos/${ids.pSp}?aba=audiencias`);
    expect(map.get(`settlement:${ids.settlement}`)).toBe(`/processos/${ids.pSp}?aba=acordos`);
    expect(map.get(`guarantee:${ids.guarantee}`)).toBe(`/processos/${ids.pSp}?aba=valores`);
    expect(map.get(`valuation:${ids.valuation}`)).toBe(`/processos/${ids.pSp}?aba=valores`);
    const other = await resolveAlertHrefs(fx.orgB, [{ type: "hearing_upcoming", entityType: "hearing", entityId: ids.hearing }]);
    expect(other.get(`hearing:${ids.hearing}`)).toBeNull();
  });

  it("listAlerts returns the resolved links for every new entity type", async () => {
    const items = await listAlerts(fx.ctx.admin, { limit: 100 });
    const href = (id: string) => items.find((a) => a.id === id)?.href;
    expect(href(ids.aHearing)).toBe(`/processos/${ids.pSp}?aba=audiencias`);
    expect(href(ids.aSettlement)).toBe(`/processos/${ids.pSp}?aba=acordos`);
    expect(href(ids.aGuarantee)).toBe(`/processos/${ids.pSp}?aba=valores`);
    expect(href(ids.aValuation)).toBe(`/processos/${ids.pSp}?aba=valores`);
    expect(href(ids.aValuationProcess)).toBe(`/processos/${ids.pRe}?aba=valores`);
    expect(href(ids.aVerification)).toBe(`/processos/${ids.pSp}`);
    expect(href(ids.aBrief)).toBe(`/analises-preliminares/${ids.brief}`);
    expect(href(ids.aIntake)).toBe(`/entrada/${ids.intake}`);
    // Most severe first.
    expect(items[0].severity).toBe("critical");
  });
});

describe("alerts center", () => {
  it("counts per area and lists groups", async () => {
    const counts = await countAlertsByArea(fx.ctx.admin);
    expect(counts.hearings.total).toBe(1);
    expect(counts.hearings.critical).toBe(1);
    expect(counts.values.total).toBe(3);
    expect(counts.settlements.total).toBe(1);
    expect(counts.verification.total).toBe(1);
    expect(counts.briefs.total).toBe(1);
    expect(counts.intake.total).toBe(1);
    expect(counts.contracts.total).toBe(0);

    const groups = await listAlertGroups(fx.ctx.admin, {}, 2);
    expect(groups.map((g) => g.area)).toEqual(["hearings", "intake", "values", "settlements", "verification", "briefs"]);
    const values = groups.find((g) => g.area === "values")!;
    expect(values.items).toHaveLength(2);
    expect(values.count.total).toBe(3);
  });

  it("filters by area, type and severity with pagination", async () => {
    const values = await listAlertsPaged(fx.ctx.admin, { area: "values", pageSize: 2 });
    expect(values.total).toBe(3);
    expect(values.items).toHaveLength(2);
    expect(values.items.every((a) => a.area === "values")).toBe(true);
    const page2 = await listAlertsPaged(fx.ctx.admin, { area: "values", pageSize: 2, page: 2 });
    expect(page2.items).toHaveLength(1);

    const byType = await listAlertsPaged(fx.ctx.admin, { type: "guarantee_idle" });
    expect(byType.items.map((a) => a.id)).toEqual([ids.aGuarantee]);
    const critical = await listAlertsPaged(fx.ctx.admin, { severity: "critical" });
    expect(critical.items.map((a) => a.id).sort()).toEqual([ids.aHearing, ids.aIntake].sort());
    const critCounts = await countAlertsByArea(fx.ctx.admin, { severity: "critical" });
    expect(critCounts.values.total).toBe(0);
  });

  it("follows the visibility of the referenced records", async () => {
    const lawyer = await listAlertsPaged(fx.ctx.lawyer, { pageSize: 100 });
    const lawyerIds = lawyer.items.map((a) => a.id);
    expect(lawyerIds).toContain(ids.aHearing);
    expect(lawyerIds).toContain(ids.aBrief);
    expect(lawyerIds).not.toContain(ids.aValuationProcess); // RE process
    expect(lawyerIds).not.toContain(ids.aOrgB);

    const lawyerRe = await listAlertsPaged(fx.ctx.lawyerRe, { pageSize: 100 });
    expect(lawyerRe.items.map((a) => a.id)).toEqual([ids.aValuationProcess]);

    const external = await listAlertsPaged(fx.ctx.externalCounsel, { pageSize: 100 });
    expect(external.total).toBe(0);

    const adminB = await listAlertsPaged(fx.ctx.adminB, { pageSize: 100 });
    expect(adminB.items.map((a) => a.id)).toEqual([ids.aOrgB]);
    expect((await countOpenAlerts(fx.ctx.adminB)).total).toBe(1);
    expect((await countOpenAlerts(fx.ctx.admin)).total).toBe(8);
    expect((await countOpenAlerts(fx.ctx.admin)).critical).toBe(2);
  });

  it("resolves alerts with permission and scope, and lists them as resolved", async () => {
    await expect(resolveAlert(fx.ctx.accountant, ids.aHearing)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resolveAlert(fx.ctx.lawyerRe, ids.aHearing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveAlert(fx.ctx.adminB, ids.aHearing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveAlert(fx.ctx.lawyer, "nope")).rejects.toBeInstanceOf(NotFoundError);

    await resolveAlert(fx.ctx.lawyer, ids.aHearing);
    await resolveAlert(fx.ctx.lawyer, ids.aHearing); // idempotent
    const audits = await fx.db.select().from(auditLogs).where(eq(auditLogs.action, "alert.resolve"));
    expect(audits).toHaveLength(1);

    const open = await listAlertsPaged(fx.ctx.lawyer, { area: "hearings" });
    expect(open.total).toBe(0);
    const resolved = await listAlertsPaged(fx.ctx.lawyer, { situation: "resolved" });
    expect(resolved.items.map((a) => a.id)).toEqual([ids.aHearing]);
    expect(resolved.items[0].resolvedByName).toBe(fx.ctx.lawyer.name);
    expect(resolved.items[0].resolvedAt).toBeInstanceOf(Date);
  });
});
