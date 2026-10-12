/**
 * Every alert type resolves to a working link (PGlite for the process-owned
 * entities): the entity types each producer uses (MODULE_CONTRACTS "Alert
 * producers") give a route, and links into the process page use a tab of the
 * contract ("Process detail tabs").
 *
 * claims_risk_review and snapshot_close_blocked open the risk classification
 * card of the "Valores e risco" tab; court movements and designated hearings
 * open the movements and hearings tabs. The link depends on the alert type, so
 * several alerts of the same process each keep their own (`alertHrefKey`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALERT_TYPES, type AlertType, type EntityType } from "@/domain/enums";
import { todayISO } from "@/lib/format";
import { alertHref, alertHrefKey, listAlerts, listAlertsPaged, resolveAlertHrefs, upsertAlert } from "@/modules/alerts/service";
import { RISK_SECTION_ID } from "@/modules/processes/decision-band";
import { hearings, legalProcesses, processGuarantees, processValuations, settlements } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";

/** MODULE_CONTRACTS "Process detail tabs". */
const PROCESS_TABS = [
  "visao-geral",
  "partes",
  "instancias",
  "movimentacoes",
  "valores",
  "acordos",
  "audiencias",
  "analise-preliminar",
  "documentos",
  "prazos",
  "emails",
  "ia",
  "comentarios",
  "historico",
];

/** Entity types each producer uses for the alert type (a new type must be added here). */
const PRODUCER_ENTITIES: Record<AlertType, EntityType[]> = {
  deadline_upcoming: ["deadline"],
  deadline_overdue: ["deadline"],
  deadline_pending_validation: ["deadline"],
  contract_expiring: ["contract"],
  obligation_due: ["contract"],
  // Analyses: the subject of the analysis, or the analysis itself (organization subject).
  risk_signal: ["legal_process", "occurrence", "contract", "document", "analysis"],
  analysis_stale: ["analysis"],
  analysis_failed: ["legal_process", "occurrence", "contract", "document", "analysis"],
  hearing_upcoming: ["hearing"],
  settlement_installment_due: ["settlement"],
  valuation_pending_review: ["legal_process", "valuation"],
  enforcement_without_value: ["legal_process"],
  guarantee_idle: ["guarantee"],
  process_needs_verification: ["legal_process"],
  brief_pending_review: ["case_brief"],
  intake_unassigned: ["intake"],
  new_process_received: ["intake"],
  court_movement_relevant: ["legal_process"],
  court_hearing_designated: ["legal_process"],
  court_sync_failed: ["legal_process"],
  claims_risk_review: ["legal_process"],
  snapshot_close_blocked: ["legal_process"],
};

/** Expected destination of the `legal_process` alerts (tab and card). */
const PROCESS_DESTINATION: Partial<Record<AlertType, string>> = {
  valuation_pending_review: "?aba=valores",
  enforcement_without_value: "?aba=valores",
  claims_risk_review: `?aba=valores#${RISK_SECTION_ID}`,
  snapshot_close_blocked: `?aba=valores#${RISK_SECTION_ID}`,
  court_movement_relevant: "?aba=movimentacoes",
  court_hearing_designated: "?aba=audiencias",
};

let f: Fixture;
let processId: string;
const ids: Partial<Record<EntityType, string>> = {};
const OTHER = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  f = await setupFixture("alertlinks");
  const [p] = await f.db
    .insert(legalProcesses)
    .values({
      organizationId: f.orgA,
      number: "0000901-11.2026.5.10.0001",
      title: "Processo fictício dos links de alerta",
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
    })
    .returning({ id: legalProcesses.id });
  processId = p.id;
  // Rows of other modules' tables are inserted directly: only the links are checked here.
  ids.hearing = (
    await f.db
      .insert(hearings)
      .values({ organizationId: f.orgA, processId, kind: "conciliation", scheduledAt: new Date() })
      .returning({ id: hearings.id })
  )[0].id;
  ids.settlement = (await f.db.insert(settlements).values({ organizationId: f.orgA, processId }).returning({ id: settlements.id }))[0].id;
  ids.guarantee = (
    await f.db
      .insert(processGuarantees)
      .values({ organizationId: f.orgA, processId, kind: "judicial_deposit", amountCents: 1_000 })
      .returning({ id: processGuarantees.id })
  )[0].id;
  ids.valuation = (
    await f.db
      .insert(processValuations)
      .values({ organizationId: f.orgA, processId, kind: "liquidated", amountCents: 1_000, baseDate: todayISO(), source: "manual" })
      .returning({ id: processValuations.id })
  )[0].id;
}, 180_000);

afterAll(async () => {
  await f?.teardown();
});

function entityIdOf(entityType: EntityType): string {
  if (entityType === "legal_process") return processId;
  return ids[entityType] ?? OTHER;
}

function expectValidProcessLink(href: string) {
  const url = new URL(href, "https://praetor.invalid");
  expect(url.pathname).toBe(`/processos/${processId}`);
  const tab = url.searchParams.get("aba");
  if (tab !== null) expect(PROCESS_TABS).toContain(tab);
  if (url.hash) expect(url.hash).toBe(`#${RISK_SECTION_ID}`);
}

describe("alert links", () => {
  it("covers every alert type", () => {
    expect(Object.keys(PRODUCER_ENTITIES).sort()).toEqual([...ALERT_TYPES].sort());
  });

  it("every alert type, with every entity type its producers use, resolves to a working link", async () => {
    const rows = ALERT_TYPES.flatMap((type) =>
      PRODUCER_ENTITIES[type].map((entityType) => ({ type, entityType, entityId: entityIdOf(entityType) })),
    );
    // One batch, every type on the same process: each alert keeps the link of its own type.
    const map = await resolveAlertHrefs(f.orgA, rows);
    for (const r of rows) {
      const href = map.get(alertHrefKey(r));
      expect(href, `${r.type} / ${r.entityType}`).toBeTruthy();
      if (href!.startsWith("/processos/")) expectValidProcessLink(href!);
      if (r.entityType === "legal_process") {
        expect(href, r.type).toBe(`/processos/${processId}${PROCESS_DESTINATION[r.type] ?? ""}`);
      } else {
        expect(href, `${r.type} / ${r.entityType}`).toBe(alertHref(r.entityType, r.entityId, r.type) ?? map.get(`${r.entityType}:${r.entityId}`));
      }
    }
    // Deprecated entity key: never the tab of another alert type (the process overview when the types differ).
    expect(map.get(`legal_process:${processId}`)).toBe(`/processos/${processId}`);
  });

  it("process alerts open the tab (and card) they are about", () => {
    for (const type of ALERT_TYPES) {
      if (!PRODUCER_ENTITIES[type].includes("legal_process")) continue;
      const href = alertHref("legal_process", processId, type)!;
      expect(href, type).toBe(`/processos/${processId}${PROCESS_DESTINATION[type] ?? ""}`);
      expectValidProcessLink(href);
    }
  });

  it("several alert types on the same process keep their own tab in the alert center", async () => {
    const [p] = await f.db
      .insert(legalProcesses)
      .values({
        organizationId: f.orgA,
        number: "0000902-11.2026.5.10.0001",
        title: "Processo fictício com vários alertas",
        court: "TRT-10",
        area: "labor",
        phase: "knowledge",
      })
      .returning({ id: legalProcesses.id });
    // One court-sync run raises the movement and the hearing alerts and flags the process for verification.
    const types = ["process_needs_verification", "court_movement_relevant", "court_hearing_designated", "claims_risk_review"] as const;
    for (const type of types) {
      await upsertAlert({
        organizationId: f.orgA,
        type,
        severity: "warning",
        title: `Alerta fictício ${type}`,
        message: `Mensagem fictícia ${type}`,
        entityType: "legal_process",
        entityId: p.id,
        dedupeKey: `links:${type}:${p.id}`,
      });
    }
    const expected = {
      process_needs_verification: `/processos/${p.id}`,
      court_movement_relevant: `/processos/${p.id}?aba=movimentacoes`,
      court_hearing_designated: `/processos/${p.id}?aba=audiencias`,
      claims_risk_review: `/processos/${p.id}?aba=valores#${RISK_SECTION_ID}`,
    };

    const listed = (await listAlerts(f.ctx.manager)).filter((a) => a.entityId === p.id);
    expect(Object.fromEntries(listed.map((a) => [a.type, a.href]))).toEqual(expected);

    const paged = await listAlertsPaged(f.ctx.manager, { pageSize: 100 });
    const pagedHrefs = Object.fromEntries(paged.items.filter((a) => a.entityId === p.id).map((a) => [a.type, a.href]));
    expect(pagedHrefs).toEqual(expected);
  });

  it("process-owned entities resolve to their process tab", async () => {
    const map = await resolveAlertHrefs(f.orgA, [
      { type: "hearing_upcoming", entityType: "hearing", entityId: ids.hearing! },
      { type: "settlement_installment_due", entityType: "settlement", entityId: ids.settlement! },
      { type: "guarantee_idle", entityType: "guarantee", entityId: ids.guarantee! },
      { type: "valuation_pending_review", entityType: "valuation", entityId: ids.valuation! },
    ]);
    expect(map.get(`hearing:${ids.hearing}`)).toBe(`/processos/${processId}?aba=audiencias`);
    expect(map.get(`settlement:${ids.settlement}`)).toBe(`/processos/${processId}?aba=acordos`);
    expect(map.get(`guarantee:${ids.guarantee}`)).toBe(`/processos/${processId}?aba=valores`);
    expect(map.get(`valuation:${ids.valuation}`)).toBe(`/processos/${processId}?aba=valores`);
    expect(map.get(alertHrefKey({ type: "hearing_upcoming", entityType: "hearing", entityId: ids.hearing! }))).toBe(
      `/processos/${processId}?aba=audiencias`,
    );
  });
});
