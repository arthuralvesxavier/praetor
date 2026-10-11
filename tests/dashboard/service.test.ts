import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/db";
import type { AuthContext } from "@/server/auth/context";
import type { Database } from "@/server/db/client";
import {
  aiAnalyses,
  auditLogs,
  contracts,
  deadlines,
  legalProcesses,
  occurrences,
  organizations,
  tasks,
  units,
  users,
} from "@/server/db/schema";
import { getDashboardData } from "@/modules/dashboard/service";

const TODAY = "2026-10-11";
const NOW = new Date("2026-10-11T15:00:00Z");

let db: Database;
let close: () => Promise<void>;
const ids: Record<string, string> = {};

function ctx(role: AuthContext["role"], userId: string, orgId: string, unitId: string | null): AuthContext {
  return { kind: "user", userId, organizationId: orgId, role, unitId, name: "x", email: "x", isDemoOrganization: false };
}

const asAdmin = () => ctx("admin", ids.admin, ids.a, null);
const asExec = () => ctx("executive", ids.exec, ids.a, null);
const asLawyerSp = () => ctx("lawyer", ids.lawyerSp, ids.a, ids.sp);
const asLawyerRe = () => ctx("lawyer", ids.lawyerRe, ids.a, ids.re);
const asAdminB = () => ctx("admin", ids.adminB, ids.b, null);
const load = (c: AuthContext) => getDashboardData(c, { today: TODAY, now: NOW });

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [a] = await db.insert(organizations).values({ name: "Org A", slug: "org-a" }).returning();
  const [b] = await db.insert(organizations).values({ name: "Org B", slug: "org-b" }).returning();
  const [sp] = await db.insert(units).values({ organizationId: a.id, name: "SP" }).returning();
  const [re] = await db.insert(units).values({ organizationId: a.id, name: "RE" }).returning();
  const mk = async (org: string, email: string, role: AuthContext["role"], unitId: string | null) =>
    (await db.insert(users).values({ organizationId: org, name: email, email, passwordHash: "x", role, unitId }).returning())[0];
  const admin = await mk(a.id, "admin@a", "admin", null);
  const exec = await mk(a.id, "exec@a", "executive", null);
  const lawyerSp = await mk(a.id, "sp@a", "lawyer", sp.id);
  const lawyerRe = await mk(a.id, "re@a", "lawyer", re.id);
  const adminB = await mk(b.id, "admin@b", "admin", null);
  Object.assign(ids, { a: a.id, b: b.id, sp: sp.id, re: re.id, admin: admin.id, exec: exec.id, lawyerSp: lawyerSp.id, lawyerRe: lawyerRe.id, adminB: adminB.id });

  const base = { organizationId: a.id, court: "TJSP", area: "civil" as const, phase: "knowledge" as const };
  const [p1] = await db
    .insert(legalProcesses)
    .values({ ...base, number: "1", title: "Público SP", unitId: sp.id, riskLevel: "critical", lossProbability: "probable", claimAmountCents: 100_000, provisionAmountCents: 50_000, responsibleId: lawyerSp.id })
    .returning();
  const [p2] = await db
    .insert(legalProcesses)
    .values({ ...base, number: "2", title: "Confidencial SP", unitId: sp.id, riskLevel: "high", claimAmountCents: 500_000, provisionAmountCents: 400_000, isConfidential: true })
    .returning();
  const [p3] = await db
    .insert(legalProcesses)
    .values({ ...base, number: "3", title: "Público RE", unitId: re.id, area: "labor", riskLevel: "low", lossProbability: "remote", claimAmountCents: 1_000 })
    .returning();
  await db.insert(legalProcesses).values({ ...base, number: "4", title: "Encerrado SP", unitId: sp.id, status: "closed", claimAmountCents: 9_999_999 });
  await db.insert(legalProcesses).values({ ...base, number: "5", title: "Excluído", unitId: sp.id, deletedAt: new Date() });
  // Org B data must never leak into org A and vice versa.
  await db.insert(legalProcesses).values({ ...base, organizationId: b.id, number: "B1", title: "Org B", claimAmountCents: 777 });
  Object.assign(ids, { p1: p1.id, p2: p2.id, p3: p3.id });

  await db.insert(occurrences).values([
    { organizationId: a.id, title: "Ocorrência SP", facts: "f", category: "labor", reportedOn: TODAY, unitId: sp.id, riskLevel: "high", estimatedExposureCents: 20_000 },
    { organizationId: a.id, title: "Ocorrência conf", facts: "f", category: "labor", reportedOn: TODAY, unitId: sp.id, status: "under_analysis", isConfidential: true, estimatedExposureCents: 80_000 },
    { organizationId: a.id, title: "Convertida", facts: "f", category: "labor", reportedOn: TODAY, unitId: re.id, status: "converted_to_process", linkedProcessId: p3.id },
  ]);

  const dl = { organizationId: a.id, kind: "procedural" as const };
  const [dOverdue] = await db.insert(deadlines).values({ ...dl, title: "Vencido manual", dueDate: "2026-10-01", processId: p1.id, responsibleId: lawyerSp.id }).returning();
  await db.insert(deadlines).values([
    { ...dl, title: "Sugerido IA vencido", dueDate: "2026-10-02", processId: p1.id, origin: "ai_suggested", validationStatus: "pending_validation" },
    { ...dl, title: "Próximo validado", dueDate: "2026-10-14", processId: p1.id, origin: "ai_suggested", validationStatus: "validated", responsibleId: lawyerSp.id },
    { ...dl, title: "Rejeitado", dueDate: "2026-10-12", processId: p1.id, origin: "ai_suggested", validationStatus: "rejected" },
    { ...dl, title: "Cumprido", dueDate: "2026-10-03", processId: p1.id, status: "done" },
    { ...dl, title: "Confidencial vencido", dueDate: "2026-10-05", processId: p2.id },
    { ...dl, title: "Longe", dueDate: "2026-12-30", processId: p3.id },
  ]);
  ids.dOverdue = dOverdue.id;

  await db.insert(tasks).values([
    { organizationId: a.id, title: "Tarefa atrasada", dueDate: "2026-10-01", assigneeId: lawyerSp.id, processId: p1.id },
    { organizationId: a.id, title: "Tarefa concluída", dueDate: "2026-10-01", assigneeId: lawyerSp.id, processId: p1.id, status: "done" },
    { organizationId: a.id, title: "Tarefa RE", dueDate: "2026-11-01", assigneeId: lawyerRe.id, processId: p3.id },
  ]);

  await db.insert(contracts).values([
    { organizationId: a.id, title: "Vencendo", counterparty: "X", type: "services", status: "active", endDate: "2026-11-01", valueCents: 300_000 },
    { organizationId: a.id, title: "Vencido ativo", counterparty: "Y", type: "services", status: "active", endDate: "2026-09-01" },
    { organizationId: a.id, title: "Longo", counterparty: "Z", type: "lease", status: "active", endDate: "2028-01-01", valueCents: 100_000 },
    { organizationId: a.id, title: "Minuta", counterparty: "W", type: "nda", status: "draft", endDate: "2026-10-20" },
  ]);

  const an = { organizationId: a.id, type: "summary" as const, subjectType: "legal_process" as const, mode: "demo" as const, provider: "demo", model: "demo", promptVersion: "1" };
  await db.insert(aiAnalyses).values([
    { ...an, subjectId: p1.id, inputHash: "h1", status: "succeeded" },
    { ...an, subjectId: p1.id, inputHash: "h2", status: "succeeded", reviewStatus: "reviewed", isStale: true },
    { ...an, subjectId: p2.id, inputHash: "h3", status: "succeeded" },
    { ...an, subjectId: p1.id, inputHash: "h4", status: "failed", completedAt: new Date("2026-10-10T12:00:00Z") },
    { ...an, subjectId: p1.id, inputHash: "h5", status: "failed", completedAt: new Date("2026-09-01T12:00:00Z") },
  ]);

  await db.insert(auditLogs).values([
    { organizationId: a.id, actorId: admin.id, action: "legal_process.update", entityType: "legal_process", entityId: p1.id, summary: "Processo 1 atualizado", createdAt: new Date("2026-10-10T10:00:00Z") },
    { organizationId: a.id, actorId: admin.id, action: "legal_process.update", entityType: "legal_process", entityId: p2.id, summary: "Processo confidencial atualizado", createdAt: new Date("2026-10-10T11:00:00Z") },
    { organizationId: a.id, actorId: admin.id, action: "auth.login", entityType: "user", entityId: admin.id, summary: "Login", createdAt: new Date("2026-10-10T12:00:00Z") },
    { organizationId: a.id, actorId: admin.id, action: "deadline.create", entityType: "deadline", entityId: dOverdue.id, summary: "Prazo criado", createdAt: new Date("2026-10-10T13:00:00Z") },
  ]);
});

afterAll(async () => close());

describe("getDashboardData", () => {
  it("admin sees every process, including confidential values", async () => {
    const d = await load(asAdmin());
    expect(d.processes.total).toBe(4);
    expect(d.processes.active).toBe(3);
    expect(d.processes.byStatus.closed).toBe(1);
    expect(d.processes.byRisk).toMatchObject({ critical: 1, high: 1, low: 1, medium: 0 });
    expect(d.processes.byArea).toMatchObject({ civil: 2, labor: 1 });
    expect(d.exposure.activeProcesses.claimCents).toBe(601_000);
    expect(d.exposure.activeProcesses.provisionCents).toBe(450_000);
    expect(d.exposure.byLossProbability.unclassified.claimCents).toBe(500_000);
    expect(d.exposure.byLossProbability.probable.claimCents).toBe(100_000);
    expect(d.occurrences.inProgress).toBe(2);
    expect(d.exposure.occurrencesExposureCents).toBe(100_000);
  });

  it("executive does not see confidential process values", async () => {
    const d = await load(asExec());
    expect(d.processes.active).toBe(2);
    expect(d.processes.byRisk.high).toBe(0);
    expect(d.exposure.activeProcesses.claimCents).toBe(101_000);
    expect(d.exposure.byRisk.high.claimCents).toBe(0);
    expect(d.exposure.activeProcesses.provisionCents).toBe(50_000);
    expect(d.occurrences.inProgress).toBe(1);
    expect(d.exposure.occurrencesExposureCents).toBe(20_000);
    expect(d.occurrences.convertedToProcess).toBe(1);
  });

  it("lawyer of another unit sees fewer processes", async () => {
    const re = await load(asLawyerRe());
    const sp = await load(asLawyerSp());
    expect(re.processes.total).toBe(1);
    expect(re.processes.byArea.labor).toBe(1);
    expect(re.exposure.activeProcesses.claimCents).toBe(1_000);
    expect(sp.processes.total).toBe(2); // public SP + closed SP (confidential excluded)
    expect(sp.processes.active).toBe(1);
    expect(re.deadlines.overdue).toBe(0);
    expect(sp.deadlines.overdue).toBe(1);
  });

  it("organization B sees nothing of organization A", async () => {
    const d = await load(asAdminB());
    expect(d.processes.total).toBe(1);
    expect(d.exposure.activeProcesses.claimCents).toBe(777);
    expect(d.occurrences.total).toBe(0);
    expect(d.deadlines).toMatchObject({ overdue: 0, upcoming: 0, pendingValidation: 0, next: [] });
    expect(d.contracts.active).toBe(0);
    expect(d.analyses).toMatchObject({ pendingReview: 0, stale: 0, failedLast7Days: 0 });
    expect(d.activity).toHaveLength(0);
    expect(d.workload.rows).toHaveLength(0);
  });

  it("excludes AI-pending, rejected and closed deadlines from overdue/upcoming", async () => {
    const admin = await load(asAdmin());
    // overdue: manual (p1) + confidential manual (p2); AI pending and done excluded
    expect(admin.deadlines.overdue).toBe(2);
    expect(admin.deadlines.pendingValidation).toBe(1);
    // upcoming within 7 days: validated AI deadline on 14/10 (rejected one excluded)
    expect(admin.deadlines.upcoming).toBe(1);
    expect(admin.deadlines.next.map((n) => n.title)).toEqual(["Próximo validado", "Longe"]);

    const exec = await load(asExec());
    expect(exec.deadlines.overdue).toBe(1);
  });

  it("lists upcoming deadlines with linked record and responsible", async () => {
    const d = await load(asExec());
    const first = d.deadlines.next[0];
    expect(first.title).toBe("Próximo validado");
    expect(first.responsibleName).toBe("sp@a");
    expect(first.linked).toMatchObject({ type: "legal_process", href: `/processos/${ids.p1}` });
  });

  it("groups workload by responsible with overdue counts", async () => {
    const d = await load(asAdmin());
    const sp = d.workload.rows.find((r) => r.userId === ids.lawyerSp);
    expect(sp).toMatchObject({ openTasks: 1, overdueTasks: 1, openDeadlines: 2, overdueDeadlines: 1 });
    expect(d.workload.rows[0].userId).toBe(ids.lawyerSp);
    expect(d.workload.unassigned.deadlines).toBe(2);
    const re = await load(asLawyerRe());
    expect(re.workload.rows.map((r) => r.userId)).toEqual([ids.lawyerRe]);
  });

  it("computes contract windows and values", async () => {
    const d = await load(asExec());
    expect(d.contracts.active).toBe(3);
    expect(d.contracts.expiring).toBe(1);
    expect(d.contracts.expiredStillActive).toBe(1);
    expect(d.exposure.activeContractsValueCents).toBe(400_000);
  });

  it("counts AI analyses within visibility", async () => {
    const admin = await load(asAdmin());
    expect(admin.analyses).toMatchObject({ pendingReview: 2, stale: 1, failedLast7Days: 1 });
    const exec = await load(asExec());
    expect(exec.analyses.pendingReview).toBe(1);
  });

  it("recent activity hides auth events and invisible entities", async () => {
    const admin = await load(asAdmin());
    expect(admin.activity.map((a) => a.summary)).toEqual(["Prazo criado", "Processo confidencial atualizado", "Processo 1 atualizado"]);
    expect(admin.activity[0].entityHref).toBe(`/prazos?aba=prazos&prazo=${ids.dOverdue}`);
    expect(admin.activity[0].actorName).toBe("admin@a");
    const exec = await load(asExec());
    expect(exec.activity.map((a) => a.summary)).toEqual(["Prazo criado", "Processo 1 atualizado"]);
    const re = await load(asLawyerRe());
    expect(re.activity).toHaveLength(0);
  });
});
