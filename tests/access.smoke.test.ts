import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDatabase } from "./helpers/db";
import type { AuthContext } from "@/server/auth/context";
import { analysisWhere, deadlineWhere, documentWhere, entityReferenceWhere, processWhere } from "@/server/auth/access";
import { alerts, aiAnalyses, deadlines, documents, legalProcesses, organizations, units, users } from "@/server/db/schema";
import type { Database } from "@/server/db/client";

let db: Database;
let close: () => Promise<void>;
const ids: Record<string, string> = {};

function ctx(role: AuthContext["role"], userId: string, orgId: string, unitId: string | null): AuthContext {
  return { kind: "user", userId, organizationId: orgId, role, unitId, name: "x", email: "x", isDemoOrganization: false };
}

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [a] = await db.insert(organizations).values({ name: "A", slug: "a" }).returning();
  const [b] = await db.insert(organizations).values({ name: "B", slug: "b" }).returning();
  const [u1] = await db.insert(units).values({ organizationId: a.id, name: "SP" }).returning();
  const [u2] = await db.insert(units).values({ organizationId: a.id, name: "RE" }).returning();
  const mk = async (org: string, email: string, role: AuthContext["role"], unitId: string | null) =>
    (await db.insert(users).values({ organizationId: org, name: email, email, passwordHash: "x", role, unitId }).returning())[0];
  const lawyerSp = await mk(a.id, "l1@a", "lawyer", u1.id);
  const lawyerRe = await mk(a.id, "l2@a", "lawyer", u2.id);
  const exec = await mk(a.id, "e@a", "executive", null);
  const adminB = await mk(b.id, "a@b", "admin", null);
  Object.assign(ids, { a: a.id, b: b.id, u1: u1.id, u2: u2.id, lawyerSp: lawyerSp.id, lawyerRe: lawyerRe.id, exec: exec.id, adminB: adminB.id });

  const base = { organizationId: a.id, court: "TJ", area: "civil" as const, phase: "knowledge" as const };
  const [pSp] = await db.insert(legalProcesses).values({ ...base, number: "1", title: "SP", unitId: u1.id }).returning();
  const [pConf] = await db.insert(legalProcesses).values({ ...base, number: "2", title: "conf", unitId: u1.id, isConfidential: true }).returning();
  ids.pSp = pSp.id;
  ids.pConf = pConf.id;
  const [dSp] = await db.insert(documents).values({ organizationId: a.id, title: "d", category: "other", processId: pSp.id }).returning();
  const [dRestricted] = await db
    .insert(documents)
    .values({ organizationId: a.id, title: "r", category: "other", processId: pSp.id, confidentiality: "restricted" })
    .returning();
  ids.dSp = dSp.id;
  ids.dRestricted = dRestricted.id;
  const [dl] = await db
    .insert(deadlines)
    .values({ organizationId: a.id, title: "p", dueDate: "2026-01-01", kind: "procedural", processId: pConf.id })
    .returning();
  ids.dl = dl.id;
  const [an] = await db
    .insert(aiAnalyses)
    .values({ organizationId: a.id, type: "summary", subjectType: "legal_process", subjectId: pSp.id, mode: "demo", provider: "demo", model: "demo", promptVersion: "1", inputHash: "h" })
    .returning();
  ids.an = an.id;
  await db.insert(alerts).values({ organizationId: a.id, type: "risk_signal", severity: "info", title: "t", message: "m", entityType: "legal_process", entityId: pConf.id, dedupeKey: "k" });
});

afterAll(async () => close());

describe("access policy (smoke)", () => {
  it("scopes processes by org, unit and confidentiality", async () => {
    const see = async (c: AuthContext) => (await db.select().from(legalProcesses).where(processWhere(c))).map((p) => p.title).sort();
    expect(await see(ctx("lawyer", ids.lawyerSp, ids.a, ids.u1))).toEqual(["SP"]);
    expect(await see(ctx("lawyer", ids.lawyerRe, ids.a, ids.u2))).toEqual([]);
    expect(await see(ctx("executive", ids.exec, ids.a, null))).toEqual(["SP"]);
    expect(await see(ctx("admin", ids.adminB, ids.b, null))).toEqual([]);
    expect(await see(ctx("legal_manager", ids.lawyerSp, ids.a, null))).toEqual(["SP", "conf"]);
  });

  it("applies inheritance for documents, deadlines, analyses and alerts", async () => {
    const lawyerSp = ctx("lawyer", ids.lawyerSp, ids.a, ids.u1);
    const docs = await db.select().from(documents).where(documentWhere(lawyerSp));
    expect(docs.map((d) => d.id)).toEqual([ids.dSp]);
    expect(await db.select().from(deadlines).where(deadlineWhere(lawyerSp))).toHaveLength(0);
    expect(await db.select().from(aiAnalyses).where(and(eq(aiAnalyses.id, ids.an), analysisWhere(lawyerSp)))).toHaveLength(1);
    expect(await db.select().from(alerts).where(entityReferenceWhere(lawyerSp, alerts.entityType, alerts.entityId))).toHaveLength(0);
    const otherOrg = ctx("admin", ids.adminB, ids.b, null);
    expect(await db.select().from(aiAnalyses).where(analysisWhere(otherOrg))).toHaveLength(0);
  });
});
