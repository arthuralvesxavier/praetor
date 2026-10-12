/**
 * Regression (review: "Alert center, header bell, dashboard and daily digest
 * show alerts for modules the role has no read permission for", "Accountant
 * sees alerts about deadlines, tasks and AI analyses", "Header alert bell runs
 * the 13-way visibility query").
 *
 * access.ts rule 9: an alert is visible only when the referenced entity is
 * visible AND the role has the read permission of its module. The alerts
 * center (list, paged list, area counts, groups), the header bell, the daily
 * digest and `resolveAlert` all share `visibleAlertsWhere`.
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadShellData } from "@/components/layout/shell-data";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  alertEntityTypesFor,
  countAlertsByArea,
  countOpenAlerts,
  listAlertGroups,
  listAlerts,
  listAlertsPaged,
  resolveAlert,
  upsertAlert,
  visibleAlertsWhere,
} from "@/modules/alerts/service";
import { buildDailyDigestData } from "@/modules/emails/service";
import { createHearing } from "@/modules/hearings/service";
import { entityReferenceWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { aiAnalyses, alerts, caseBriefs } from "@/server/db/schema";
import type { EntityType } from "@/domain/enums";
import { NotFoundError } from "@/server/lib/errors";
import {
  makeContract,
  makeDeadline,
  makeOccurrence,
  makeProcess,
  makeTask,
  setupFixture,
  type Fixture,
} from "../../helpers/fixtures";

let f: Fixture;
/** entity type → alert id */
const alertIdByType: Partial<Record<EntityType, string>> = {};
const TYPES: EntityType[] = [
  "legal_process",
  "hearing",
  "contract",
  "occurrence",
  "deadline",
  "task",
  "analysis",
  "case_brief",
];

async function listedTypes(ctx: AuthContext): Promise<EntityType[]> {
  return (await listAlerts(ctx, { openOnly: true, limit: 200 })).map((a) => a.entityType).sort();
}

function sum(counts: Record<string, { total: number }>): number {
  return Object.values(counts).reduce((acc, c) => acc + c.total, 0);
}

beforeAll(async () => {
  f = await setupFixture("fix-alert-perm");
  const { admin } = f.ctx;

  const processId = await makeProcess(admin, { title: "Processo dos alertas (fictício)" });
  const contractId = await makeContract(admin, { title: "Contrato sigiloso de fornecimento ZQW (fictício)" });
  const occurrenceId = await makeOccurrence(admin);
  const deadlineId = await makeDeadline(admin, { processId, title: "Prazo de contestação ZQW (fictício)" });
  const taskId = await makeTask(admin, { processId, title: "Tarefa interna ZQW (fictícia)" });
  const hearingId = (
    await createHearing(admin, {
      processId,
      kind: "initial",
      mode: "in_person",
      date: addDaysISO(todayISO(), 3),
      time: "10:00",
      location: "Vara fictícia",
    })
  ).id;
  const [analysis] = await f.db
    .insert(aiAnalyses)
    .values({
      organizationId: f.orgA,
      type: "summary",
      subjectType: "legal_process",
      subjectId: processId,
      status: "succeeded",
      mode: "demo",
      provider: "demo",
      model: "demo",
      promptVersion: "test",
      inputHash: "fix-alert-perm",
    })
    .returning({ id: aiAnalyses.id });
  const [brief] = await f.db
    .insert(caseBriefs)
    .values({
      organizationId: f.orgA,
      processId,
      version: 1,
      status: "ready_for_review",
      mode: "demo",
      provider: "simulated",
      model: "simulated",
      promptVersion: "test",
      inputHash: "fix-alert-perm",
    })
    .returning({ id: caseBriefs.id });

  const entityIds: Record<string, string> = {
    legal_process: processId,
    hearing: hearingId,
    contract: contractId,
    occurrence: occurrenceId,
    deadline: deadlineId,
    task: taskId,
    analysis: analysis.id,
    case_brief: brief.id,
  };
  const alertTypeOf = {
    legal_process: "process_needs_verification",
    hearing: "hearing_upcoming",
    contract: "contract_expiring",
    occurrence: "risk_signal",
    deadline: "deadline_upcoming",
    task: "obligation_due",
    analysis: "analysis_stale",
    case_brief: "brief_pending_review",
  } as const;
  for (const type of TYPES) {
    await upsertAlert({
      organizationId: f.orgA,
      type: alertTypeOf[type as keyof typeof alertTypeOf],
      severity: type === "deadline" || type === "legal_process" ? "critical" : "warning",
      title: `Alerta de ${type} ZQW (fictício)`,
      message: "Mensagem de teste (fictícia).",
      entityType: type,
      entityId: entityIds[type],
      dedupeKey: `fix-alert-perm:${type}`,
    });
    const [row] = await f.db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.organizationId, f.orgA), eq(alerts.dedupeKey, `fix-alert-perm:${type}`)));
    alertIdByType[type] = row.id;
  }
}, 180_000);

afterAll(async () => {
  await f?.teardown();
});

describe("alerts are gated by the read permission of the referenced module", () => {
  it("admin and auditor (every read permission) see every alert", async () => {
    expect(await listedTypes(f.ctx.admin)).toEqual([...TYPES].sort());
    expect(await listedTypes(f.ctx.auditor)).toEqual([...TYPES].sort());
    expect(await countOpenAlerts(f.ctx.admin)).toEqual({ total: 8, critical: 2 });
  });

  it("the accountant only sees alerts about processes (and hearings)", async () => {
    const { accountant } = f.ctx;
    expect(await listedTypes(accountant)).toEqual(["hearing", "legal_process"]);
    const titles = (await listAlerts(accountant, { limit: 200 })).map((a) => a.title).join(" | ");
    expect(titles).not.toContain("contract");
    expect(titles).not.toContain("deadline");

    const paged = await listAlertsPaged(accountant, { pageSize: 100 });
    expect(paged.total).toBe(2);
    expect(sum(await countAlertsByArea(accountant))).toBe(2);
    const grouped = (await listAlertGroups(accountant)).flatMap((g) => g.items.map((i) => i.entityType));
    expect(grouped.sort()).toEqual(["hearing", "legal_process"]);
    expect(await countOpenAlerts(accountant)).toEqual({ total: 2, critical: 1 });
    expect((await loadShellData(accountant)).alerts).toEqual({ total: 2, critical: 1 });

    const digest = await buildDailyDigestData(accountant);
    expect(digest.items.find((i) => i.label === "Alertas abertos")?.count).toBe(2);
    expect(digest.items.find((i) => i.label === "Alertas críticos")?.count).toBe(1);
  });

  it("the executive does not see preliminary-analysis alerts (no brief:read)", async () => {
    const { executive } = f.ctx;
    const types = await listedTypes(executive);
    expect(types).not.toContain("case_brief");
    expect(types).toHaveLength(7);
    expect((await countOpenAlerts(executive)).total).toBe(7);
    expect((await listAlertsPaged(executive, { area: "briefs" })).total).toBe(0);
    expect((await countAlertsByArea(executive)).briefs.total).toBe(0);
  });

  it("the exported visibleAlertsWhere (also used by resolveAlert) applies the same gate", async () => {
    const visibleTo = async (ctx: AuthContext, id: string) => {
      const [row] = await f.db
        .select({ n: count() })
        .from(alerts)
        .where(and(eq(alerts.id, id), visibleAlertsWhere(ctx)));
      return row.n === 1;
    };
    expect(await visibleTo(f.ctx.executive, alertIdByType.case_brief!)).toBe(false);
    expect(await visibleTo(f.ctx.executive, alertIdByType.contract!)).toBe(true);
    expect(await visibleTo(f.ctx.accountant, alertIdByType.deadline!)).toBe(false);
    expect(await visibleTo(f.ctx.accountant, alertIdByType.legal_process!)).toBe(true);
    // Narrowing by present types never widens the permitted set.
    const [narrowed] = await f.db
      .select({ n: count() })
      .from(alerts)
      .where(visibleAlertsWhere(f.ctx.accountant, ["contract", "deadline", "legal_process"]));
    expect(narrowed.n).toBe(1);

    // The lawyer (alert:resolve and brief:read) resolves it; unknown ids are not found.
    const { lawyer } = f.ctx;
    await resolveAlert(lawyer, alertIdByType.case_brief!);
    await expect(resolveAlert(lawyer, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
    expect((await countOpenAlerts(f.ctx.admin)).total).toBe(7);
  });

  it("entityReferenceWhere keeps its default (row visibility only) for other callers", async () => {
    const { accountant } = f.ctx;
    const countWith = async (opts?: { types?: readonly EntityType[] }) => {
      const [row] = await f.db
        .select({ n: count() })
        .from(alerts)
        .where(
          and(eq(alerts.organizationId, f.orgA), entityReferenceWhere(accountant, alerts.entityType, alerts.entityId, opts)),
        );
      return row.n;
    };
    // Default: every resolvable type the accountant can see row-wise (org-wide role, nothing confidential).
    expect(await countWith()).toBe(8);
    expect(await countWith({ types: ["contract"] })).toBe(1);
    expect(await countWith({ types: [] })).toBe(0);
    expect(alertEntityTypesFor(accountant).sort()).toEqual(
      ["document", "guarantee", "hearing", "intake", "legal_process", "settlement", "valuation"].sort(),
    );
  });
});
