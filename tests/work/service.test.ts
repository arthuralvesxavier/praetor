import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDatabase } from "../helpers/db";
import type { AuthContext } from "@/server/auth/context";
import type { Database } from "@/server/db/client";
import { aiAnalyses, auditLogs, legalProcesses, organizations, units, users } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "@/server/lib/errors";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  createDeadline,
  createSuggestedDeadline,
  createTask,
  deleteTask,
  getDeadline,
  getTask,
  getWorkSummary,
  listCalendarItems,
  listDeadlines,
  listTasks,
  listWorkLinkOptions,
  listWorkUserOptions,
  setDeadlineStatus,
  updateTask,
  validateDeadline,
} from "@/modules/work/service";
import { addComment, deleteComment, listComments } from "@/modules/comments/service";
import { buildMonthGrid, shiftMonth, monthRange } from "@/modules/work/calendar";

let db: Database;
let close: () => Promise<void>;
const ids: Record<string, string> = {};

function ctx(role: AuthContext["role"], userId: string, orgId: string, unitId: string | null): AuthContext {
  return { kind: "user", userId, organizationId: orgId, role, unitId, name: role, email: `${role}@x`, isDemoOrganization: false };
}

let admin: AuthContext;
let lawyerSp: AuthContext;
let lawyerRe: AuthContext;
let analystSp: AuthContext;
let exec: AuthContext;
let adminB: AuthContext;

const today = todayISO();

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [a] = await db.insert(organizations).values({ name: "A", slug: "a" }).returning();
  const [b] = await db.insert(organizations).values({ name: "B", slug: "b" }).returning();
  const [sp] = await db.insert(units).values({ organizationId: a.id, name: "SP" }).returning();
  const [re] = await db.insert(units).values({ organizationId: a.id, name: "RE" }).returning();
  const mk = async (org: string, email: string, role: AuthContext["role"], unitId: string | null, isActive = true) =>
    (await db.insert(users).values({ organizationId: org, name: email, email, passwordHash: "x", role, unitId, isActive }).returning())[0];
  const uAdmin = await mk(a.id, "admin@a", "admin", null);
  const uLawyerSp = await mk(a.id, "l1@a", "lawyer", sp.id);
  const uLawyerRe = await mk(a.id, "l2@a", "lawyer", re.id);
  const uAnalyst = await mk(a.id, "an@a", "analyst", sp.id);
  const uExec = await mk(a.id, "ex@a", "executive", null);
  const uInactive = await mk(a.id, "off@a", "lawyer", sp.id, false);
  const uAdminB = await mk(b.id, "admin@b", "admin", null);
  Object.assign(ids, { a: a.id, b: b.id, sp: sp.id, re: re.id, inactive: uInactive.id, adminBUser: uAdminB.id });

  admin = ctx("admin", uAdmin.id, a.id, null);
  lawyerSp = ctx("lawyer", uLawyerSp.id, a.id, sp.id);
  lawyerRe = ctx("lawyer", uLawyerRe.id, a.id, re.id);
  analystSp = ctx("analyst", uAnalyst.id, a.id, sp.id);
  exec = ctx("executive", uExec.id, a.id, null);
  adminB = ctx("admin", uAdminB.id, b.id, null);

  const base = { organizationId: a.id, court: "TJ", area: "civil" as const, phase: "knowledge" as const };
  const [pSp] = await db.insert(legalProcesses).values({ ...base, number: "1", title: "Processo SP", unitId: sp.id }).returning();
  const [pConf] = await db
    .insert(legalProcesses)
    .values({ ...base, number: "2", title: "Confidencial", unitId: sp.id, isConfidential: true })
    .returning();
  const [pB] = await db
    .insert(legalProcesses)
    .values({ ...base, organizationId: b.id, number: "9", title: "Org B" })
    .returning();
  ids.pSp = pSp.id;
  ids.pConf = pConf.id;
  ids.pB = pB.id;

  const [an] = await db
    .insert(aiAnalyses)
    .values({
      organizationId: a.id,
      type: "extraction",
      subjectType: "legal_process",
      subjectId: pSp.id,
      mode: "demo",
      provider: "demo",
      model: "demo",
      promptVersion: "1",
      inputHash: "h1",
      status: "succeeded",
    })
    .returning();
  ids.analysis = an.id;
});

afterAll(async () => close());

describe("deadlines", () => {
  it("creates manual deadlines that count in overdue/upcoming", async () => {
    const { id } = await createDeadline(lawyerSp, {
      title: "Contestação",
      dueDate: addDaysISO(today, -2),
      kind: "procedural",
      processId: ids.pSp,
      responsibleId: lawyerSp.userId,
    });
    ids.manualOverdue = id;
    const d = await getDeadline(lawyerSp, id);
    expect(d.origin).toBe("manual");
    expect(d.validationStatus).toBe("not_required");
    expect(d.isOverdue).toBe(true);
    expect(d.unitId).toBe(ids.sp);
    expect(d.links[0]).toMatchObject({ type: "legal_process", id: ids.pSp, href: `/processos/${ids.pSp}` });

    const overdue = await listDeadlines(lawyerSp, { situation: "overdue" });
    expect(overdue.items.map((i) => i.id)).toContain(id);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "deadline.create")));
    expect(audit).toHaveLength(1);
  });

  it("AI-suggested deadline is pending and excluded from overdue/upcoming/open", async () => {
    const { id } = await createSuggestedDeadline(lawyerSp, {
      title: "Prazo citado no documento",
      dueDate: addDaysISO(today, -1),
      kind: "procedural",
      sourceAnalysisId: ids.analysis,
      sourceExcerpt: "…no prazo de 15 dias…",
      processId: ids.pSp,
    });
    ids.suggested = id;
    const d = await getDeadline(lawyerSp, id);
    expect(d.origin).toBe("ai_suggested");
    expect(d.validationStatus).toBe("pending_validation");
    expect(d.isPendingValidation).toBe(true);
    expect(d.isOverdue).toBe(false);
    expect(d.countsAsDeadline).toBe(false);
    expect(d.sourceExcerpt).toBe("…no prazo de 15 dias…");

    for (const situation of ["overdue", "upcoming", "open"] as const) {
      const list = await listDeadlines(lawyerSp, { situation });
      expect(list.items.map((i) => i.id)).not.toContain(id);
    }
    const real = await listDeadlines(lawyerSp, { realOnly: true });
    expect(real.items.map((i) => i.id)).not.toContain(id);
    const pending = await listDeadlines(lawyerSp, { validationStatus: "pending_validation" });
    expect(pending.items.map((i) => i.id)).toEqual([id]);

    const summary = await getWorkSummary(lawyerSp);
    expect(summary.pendingValidation).toBe(1);
    expect(summary.overdueDeadlines).toBe(1); // only the manual one
  });

  it("requires source analysis and excerpt for suggestions", async () => {
    await expect(
      createSuggestedDeadline(lawyerSp, {
        title: "Sem fonte",
        dueDate: today,
        kind: "internal",
        sourceAnalysisId: ids.analysis,
        sourceExcerpt: "   ",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createSuggestedDeadline(adminB, {
        title: "Análise de outra organização",
        dueDate: today,
        kind: "internal",
        sourceAnalysisId: ids.analysis,
        sourceExcerpt: "x",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("pending suggestions cannot change status before validation", async () => {
    await expect(setDeadlineStatus(lawyerSp, ids.suggested, "done")).rejects.toBeInstanceOf(ConflictError);
  });

  it("analyst cannot validate (ForbiddenError)", async () => {
    await expect(validateDeadline(analystSp, ids.suggested, { decision: "validated" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(validateDeadline(exec, ids.suggested, { decision: "validated" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lawyer validates (with date adjustment) and the deadline starts counting", async () => {
    const adjusted = addDaysISO(today, -3);
    await validateDeadline(lawyerSp, ids.suggested, { decision: "validated", dueDate: adjusted, note: "Conferido na intimação" });
    const d = await getDeadline(lawyerSp, ids.suggested);
    expect(d.validationStatus).toBe("validated");
    expect(d.dueDate).toBe(adjusted);
    expect(d.isOverdue).toBe(true);
    expect(d.validatedByName).toBe("l1@a");

    const overdue = await listDeadlines(lawyerSp, { situation: "overdue" });
    expect(overdue.items.map((i) => i.id)).toContain(ids.suggested);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.suggested), eq(auditLogs.action, "deadline.validate")));
    expect(audit.metadata).toMatchObject({ decision: "validated", originalDueDate: addDaysISO(today, -1), dateAdjusted: true });
    expect(JSON.stringify(audit)).not.toContain("15 dias");

    await expect(validateDeadline(lawyerSp, ids.suggested, { decision: "validated" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejection requires a note and cancels the suggestion", async () => {
    const { id } = await createSuggestedDeadline(admin, {
      title: "Sugestão a rejeitar",
      dueDate: addDaysISO(today, 3),
      kind: "procedural",
      sourceAnalysisId: ids.analysis,
      sourceExcerpt: "trecho",
      processId: ids.pSp,
    });
    await expect(validateDeadline(lawyerSp, id, { decision: "rejected" })).rejects.toBeInstanceOf(ValidationError);
    await validateDeadline(lawyerSp, id, { decision: "rejected", note: "Data não se aplica" });
    const d = await getDeadline(lawyerSp, id);
    expect(d.status).toBe("cancelled");
    expect(d.validationStatus).toBe("rejected");
    await expect(setDeadlineStatus(lawyerSp, id, "open")).rejects.toBeInstanceOf(ConflictError);
  });

  it("upcoming uses the organization setting window", async () => {
    const { id: soon } = await createDeadline(admin, { title: "Em 3 dias", dueDate: addDaysISO(today, 3), kind: "internal" });
    const { id: far } = await createDeadline(admin, { title: "Em 30 dias", dueDate: addDaysISO(today, 30), kind: "internal" });
    const upcoming = (await listDeadlines(admin, { situation: "upcoming", pageSize: 100 })).items.map((i) => i.id);
    expect(upcoming).toContain(soon);
    expect(upcoming).not.toContain(far);
  });

  it("status changes set completedAt and are audited", async () => {
    await setDeadlineStatus(lawyerSp, ids.manualOverdue, "done");
    const d = await getDeadline(lawyerSp, ids.manualOverdue);
    expect(d.status).toBe("done");
    expect(d.completedAt).toBeInstanceOf(Date);
    expect(d.isOverdue).toBe(false);
    await setDeadlineStatus(lawyerSp, ids.manualOverdue, "open");
    expect((await getDeadline(lawyerSp, ids.manualOverdue)).completedAt).toBeNull();
  });

  it("validates foreign ids: links must be visible, responsible must be an active org user", async () => {
    await expect(
      createDeadline(lawyerRe, { title: "Prazo SP", dueDate: today, kind: "procedural", processId: ids.pSp }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createDeadline(lawyerSp, { title: "Confidencial", dueDate: today, kind: "procedural", processId: ids.pConf }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createDeadline(admin, { title: "Outra org", dueDate: today, kind: "procedural", processId: ids.pB }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createDeadline(admin, { title: "Resp. inativo", dueDate: today, kind: "internal", responsibleId: ids.inactive }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createDeadline(admin, { title: "Resp. outra org", dueDate: today, kind: "internal", responsibleId: ids.adminBUser }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createDeadline(admin, { title: "Data ruim", dueDate: "2026-02-30", kind: "internal" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(createDeadline(exec, { title: "Exec", dueDate: today, kind: "internal" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cross-organization isolation", async () => {
    await expect(getDeadline(adminB, ids.manualOverdue)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setDeadlineStatus(adminB, ids.manualOverdue, "done")).rejects.toBeInstanceOf(NotFoundError);
    expect((await listDeadlines(adminB)).total).toBe(0);
    expect((await getWorkSummary(adminB)).overdueDeadlines).toBe(0);
    await expect(getDeadline(admin, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("tasks", () => {
  it("are scoped by parent visibility (confidential process) unless assignee", async () => {
    const { id: hidden } = await createTask(admin, { title: "Tarefa confidencial", processId: ids.pConf });
    const { id: assigned } = await createTask(admin, {
      title: "Tarefa atribuída",
      processId: ids.pConf,
      assigneeId: lawyerRe.userId,
      dueDate: addDaysISO(today, -1),
    });
    ids.assignedTask = assigned;

    const seenRe = (await listTasks(lawyerRe)).items.map((t) => t.id);
    expect(seenRe).toContain(assigned);
    expect(seenRe).not.toContain(hidden);
    await expect(getTask(lawyerRe, hidden)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateTask(lawyerRe, hidden, { status: "done" })).rejects.toBeInstanceOf(NotFoundError);

    // The assignee sees the task, but not the confidential process label.
    const t = await getTask(lawyerRe, assigned);
    expect(t.links[0]).toMatchObject({ type: "legal_process", label: null, href: null });
    expect(t.isOverdue).toBe(true);

    const seenSp = (await listTasks(lawyerSp)).items.map((x) => x.id);
    expect(seenSp).not.toContain(hidden);
    expect(seenSp).not.toContain(assigned);

    expect((await listTasks(adminB)).total).toBe(0);
  });

  it("status transitions set completedAt; overdue filter ignores done", async () => {
    expect((await listTasks(lawyerRe, { overdue: true })).items.map((t) => t.id)).toContain(ids.assignedTask);
    await updateTask(lawyerRe, ids.assignedTask, { status: "done" });
    const t = await getTask(lawyerRe, ids.assignedTask);
    expect(t.completedAt).toBeInstanceOf(Date);
    expect(t.isOverdue).toBe(false);
    expect((await listTasks(lawyerRe, { overdue: true })).items.map((x) => x.id)).not.toContain(ids.assignedTask);
    await updateTask(lawyerRe, ids.assignedTask, { status: "in_progress" });
    expect((await getTask(lawyerRe, ids.assignedTask)).completedAt).toBeNull();
  });

  it("validates assignee and links; ai_suggested requires a visible source analysis", async () => {
    await expect(createTask(lawyerSp, { title: "Outra org", assigneeId: ids.adminBUser })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTask(lawyerRe, { title: "Processo SP", processId: ids.pSp })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTask(lawyerSp, { title: "IA sem fonte", origin: "ai_suggested" })).rejects.toBeInstanceOf(ValidationError);
    const { id } = await createTask(lawyerSp, {
      title: "Plano de ação sugerido",
      kind: "action_plan",
      origin: "ai_suggested",
      sourceAnalysisId: ids.analysis,
      processId: ids.pSp,
    });
    const t = await getTask(lawyerSp, id);
    expect(t.origin).toBe("ai_suggested");
    expect(t.kind).toBe("action_plan");
    await expect(createTask(exec, { title: "Executivo" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only creator, admins and legal managers delete tasks", async () => {
    const { id } = await createTask(lawyerSp, { title: "Minha tarefa", processId: ids.pSp });
    await expect(deleteTask(analystSp, id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteTask(lawyerSp, id);
    await expect(getTask(lawyerSp, id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("form options", () => {
  it("link options only include visible records; users are active users of the org", async () => {
    const sp = await listWorkLinkOptions(lawyerSp);
    expect(sp.processes.map((p) => p.id)).toEqual([ids.pSp]);
    const re = await listWorkLinkOptions(lawyerRe);
    expect(re.processes).toHaveLength(0);
    const all = await listWorkLinkOptions(admin);
    expect(all.processes.map((p) => p.id).sort()).toEqual([ids.pSp, ids.pConf].sort());
    await expect(listWorkLinkOptions(exec)).rejects.toBeInstanceOf(ForbiddenError);

    const usersA = (await listWorkUserOptions(lawyerSp)).map((u) => u.id);
    expect(usersA).not.toContain(ids.inactive);
    expect(usersA).not.toContain(ids.adminBUser);
    expect(usersA).toContain(lawyerRe.userId);
  });
});

describe("calendar", () => {
  it("builds Monday-first month grids", () => {
    const weeks = buildMonthGrid("2026-10");
    expect(weeks[0][0].date).toBe("2026-09-28");
    expect(weeks[0][3]).toMatchObject({ date: "2026-10-01", inMonth: true });
    expect(weeks.at(-1)!.at(-1)!.date).toBe("2026-11-01");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("lists scoped deadlines and tasks of the month, flagging pending suggestions", async () => {
    const month = today.slice(0, 7);
    const { id: pendingId } = await createSuggestedDeadline(lawyerSp, {
      title: "Sugestão do mês",
      dueDate: `${month}-15`,
      kind: "contractual",
      sourceAnalysisId: ids.analysis,
      sourceExcerpt: "vence no dia 15",
      processId: ids.pSp,
    });
    const data = await listCalendarItems(lawyerSp, month);
    const pending = data.deadlines.find((d) => d.id === pendingId);
    expect(pending?.isPendingValidation).toBe(true);
    expect(pending?.isOverdue).toBe(false);
    expect(data.deadlines.every((d) => d.dueDate.startsWith(month))).toBe(true);

    const other = await listCalendarItems(adminB, month);
    expect(other.deadlines).toHaveLength(0);
    await expect(listCalendarItems(lawyerSp, "2026-13")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("comments", () => {
  it("adds and lists comments on visible entities", async () => {
    const { id } = await addComment(lawyerSp, { type: "legal_process", id: ids.pSp }, "  Primeira linha\nSegunda linha  ");
    ids.comment = id;
    const list = await listComments(lawyerSp, { type: "legal_process", id: ids.pSp });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ body: "Primeira linha\nSegunda linha", canDelete: true, authorName: "l1@a" });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "comment.create"));
    expect(JSON.stringify(audit)).not.toContain("Primeira linha");
  });

  it("comments on invisible entities -> NotFoundError", async () => {
    await expect(listComments(lawyerRe, { type: "legal_process", id: ids.pSp })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addComment(lawyerSp, { type: "legal_process", id: ids.pConf }, "oi")).rejects.toBeInstanceOf(NotFoundError);
    await expect(addComment(adminB, { type: "legal_process", id: ids.pSp }, "oi")).rejects.toBeInstanceOf(NotFoundError);
    await expect(addComment(admin, { type: "legal_process", id: ids.pB }, "oi")).rejects.toBeInstanceOf(NotFoundError);
    await expect(listComments(adminB, { type: "deadline", id: ids.manualOverdue })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("requires comment:write and a non-empty body; only the author deletes", async () => {
    await expect(addComment(exec, { type: "legal_process", id: ids.pSp }, "oi")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addComment(lawyerSp, { type: "legal_process", id: ids.pSp }, "   ")).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteComment(admin, ids.comment)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteComment(adminB, ids.comment)).rejects.toBeInstanceOf(NotFoundError);
    await deleteComment(lawyerSp, ids.comment);
    expect(await listComments(lawyerSp, { type: "legal_process", id: ids.pSp })).toHaveLength(0);
  });

  it("comments on deadlines follow deadline visibility", async () => {
    await addComment(lawyerSp, { type: "deadline", id: ids.manualOverdue }, "Protocolado.");
    expect(await listComments(exec, { type: "deadline", id: ids.manualOverdue })).toHaveLength(1);
    await expect(listComments(lawyerRe, { type: "deadline", id: ids.manualOverdue })).rejects.toBeInstanceOf(NotFoundError);
  });
});
