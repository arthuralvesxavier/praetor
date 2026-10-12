/**
 * Steps b and c of the v2 seed (scripts/seed-v2.ts): the company of the
 * spreadsheet, the fictitious law firm, the fictitious regional units, the v2
 * demo accounts (and their team) and the distribution rules.
 *
 * They are created ONCE in the life of the demo organization. Afterwards a
 * person may rename or remove any of them (rename the company or a unit,
 * delete or rename a rule, take a lawyer out of the team), and a later run of
 * the seed (for example to issue a new demo API key) must never bring them
 * back nor create a second one with the old name:
 *
 * - once the demo spreadsheet import is committed, the company, the firm, the
 *   units and the rules are done (the seed always creates them before it);
 * - before that (a first run that stopped halfway), each record has a marker
 *   that survives a rename or a removal: the row itself (units by code first)
 *   or the seed's own "create" entry in the audit log (`company.create`,
 *   `law_firm.create`, `unit.create`, `distribution_rule.create`, by the name
 *   or code the seed gave it);
 * - accounts are looked up by e-mail, which never changes and is never
 *   removed (users are only deactivated). A missing account is created, and
 *   only then joins the team, in the same transaction: a person who takes a
 *   lawyer out of the team is never overruled by the seed.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/domain/demo";
import { createUnit } from "@/modules/admin/service";
import { createRule } from "@/modules/distribution/service";
import { createCompany, createLawFirm } from "@/modules/organization/service";
import type { AuthContext } from "@/server/auth/context";
import { hashPassword } from "@/server/auth/password";
import { getDb } from "@/server/db/client";
import { auditLogs, companies, distributionRules, importBatches, lawFirms, teamMembers, teams, units, users } from "@/server/db/schema";
import { AURORA_UNITS, type UnitKey, type UserKey } from "../aurora";
import { userContext, type SeededUser } from "../helpers";
import {
  AURORA_V2_USERS,
  DEMO_SPREADSHEET,
  V2_COMPANY_NAME,
  V2_LAW_FIRM,
  V2_RULES,
  V2_TEAM,
  V2_UNITS,
  type DemoUserKey,
  type RuleSeed,
  type V2UnitKey,
} from "./aurora-v2";

export type DemoPeople = Record<DemoUserKey, SeededUser>;

export type DemoUnitKey = V2UnitKey | UnitKey;

/** Ids the next steps use; null when a person removed the record (or it was never created). */
export type DemoStructure = {
  people: DemoPeople;
  companyId: string | null;
  lawFirmId: string | null;
  units: Record<DemoUnitKey, string | null>;
};

/** What the structure step still creates (empty lists / false = nothing). */
export type StructurePlan = {
  company: boolean;
  lawFirm: boolean;
  units: V2UnitKey[];
  /** E-mails of the v2 demo accounts missing in the organization. */
  accounts: string[];
};

export type StructureResult = {
  structure: DemoStructure;
  created: { company: boolean; lawFirm: boolean; units: string[]; accounts: number; teamMembers: number };
};

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/** The committed import of the demo spreadsheet (the seed's step d), the earliest one. */
export async function committedDemoBatch(organizationId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, organizationId),
        eq(importBatches.fileName, DEMO_SPREADSHEET.fileName),
        eq(importBatches.status, "committed"),
      ),
    )
    .orderBy(asc(importBatches.committedAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * "Create" entries of the audit log for `action` whose `field` was created
 * with one of `values` (the record may have been renamed or removed since).
 */
async function createdInAudit(
  organizationId: string,
  action: string,
  field: "name" | "code",
  values: readonly string[],
): Promise<{ value: string; entityId: string | null }[]> {
  if (values.length === 0) return [];
  const value = sql<string>`${auditLogs.changes} -> ${field} ->> 'to'`;
  return getDb()
    .select({ value, entityId: auditLogs.entityId })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, action), inArray(value, [...values])))
    .orderBy(asc(auditLogs.createdAt));
}

type Lookup = { id: string | null; recorded: boolean };

/** By the exact name, else by the seed's create entry (renamed: its id; removed: null). Never recorded: not created yet. */
async function namedRecord(
  organizationId: string,
  table: typeof companies | typeof lawFirms,
  action: "company.create" | "law_firm.create",
  name: string,
): Promise<Lookup> {
  const db = getDb();
  const [byName] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.organizationId, organizationId), eq(table.name, name)))
    .limit(1);
  if (byName) return { id: byName.id, recorded: true };
  const entries = await createdInAudit(organizationId, action, "name", [name]);
  if (entries.length === 0) return { id: null, recorded: false };
  for (const e of entries) {
    if (!e.entityId) continue;
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.organizationId, organizationId), eq(table.id, e.entityId)))
      .limit(1);
    if (row) return { id: row.id, recorded: true };
  }
  return { id: null, recorded: true };
}

/** Units of the demo by code first (survives a rename), then name, then the seed's `unit.create` entry. */
async function demoUnits(organizationId: string): Promise<Record<DemoUnitKey, Lookup>> {
  const rows = await getDb()
    .select({ id: units.id, name: units.name, code: units.code })
    .from(units)
    .where(eq(units.organizationId, organizationId));
  const wanted: { key: DemoUnitKey; name: string; code: string }[] = [...AURORA_UNITS, ...V2_UNITS];
  const byName = await createdInAudit(organizationId, "unit.create", "name", wanted.map((u) => u.name));
  const byCode = await createdInAudit(organizationId, "unit.create", "code", wanted.map((u) => u.code));
  const out = {} as Record<DemoUnitKey, Lookup>;
  for (const u of wanted) {
    const row = rows.find((r) => r.code === u.code) ?? rows.find((r) => r.name === u.name);
    if (row) {
      out[u.key] = { id: row.id, recorded: true };
      continue;
    }
    const entries = [...byCode.filter((e) => e.value === u.code), ...byName.filter((e) => e.value === u.name)];
    const alive = entries.map((e) => rows.find((r) => r.id === e.entityId)).find(Boolean);
    out[u.key] = { id: alive?.id ?? null, recorded: entries.length > 0 };
  }
  return out;
}

function toSeeded(row: typeof users.$inferSelect): SeededUser {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    email: row.email,
    role: row.role,
    unitId: row.unitId,
    lawFirmId: row.lawFirmId,
  };
}

/** v2 demo accounts by e-mail; an e-mail of another organization stops the seed (that account is never touched). */
async function demoAccounts(organizationId: string): Promise<Map<string, SeededUser>> {
  const emails = Object.keys(AURORA_V2_USERS).map((e) => e.toLowerCase());
  const rows = await getDb().select().from(users).where(inArray(users.email, emails));
  const out = new Map<string, SeededUser>();
  for (const row of rows) {
    if (row.organizationId !== organizationId) {
      throw new Error(`O e-mail ${row.email} já pertence a outra organização; nada foi alterado nessa conta.`);
    }
    out.set(row.email, toSeeded(row));
  }
  return out;
}

type StructureState = {
  importCommitted: boolean;
  company: Lookup;
  lawFirm: Lookup;
  units: Record<DemoUnitKey, Lookup>;
  accounts: Map<string, SeededUser>;
};

async function loadState(organizationId: string): Promise<StructureState> {
  return {
    importCommitted: (await committedDemoBatch(organizationId)) !== null,
    company: await namedRecord(organizationId, companies, "company.create", V2_COMPANY_NAME),
    lawFirm: await namedRecord(organizationId, lawFirms, "law_firm.create", V2_LAW_FIRM.name),
    units: await demoUnits(organizationId),
    accounts: await demoAccounts(organizationId),
  };
}

function planFrom(state: StructureState): StructurePlan {
  const once = !state.importCommitted;
  return {
    company: once && !state.company.recorded,
    lawFirm: once && !state.lawFirm.recorded,
    units: once ? V2_UNITS.filter((u) => !state.units[u.key].recorded).map((u) => u.key) : [],
    accounts: Object.keys(AURORA_V2_USERS)
      .map((e) => e.toLowerCase())
      .filter((e) => !state.accounts.has(e)),
  };
}

/** What the structure step still creates (reads only). */
export async function structurePlan(organizationId: string): Promise<StructurePlan> {
  return planFrom(await loadState(organizationId));
}

export function structurePending(plan: StructurePlan): boolean {
  return plan.company || plan.lawFirm || plan.units.length > 0 || plan.accounts.length > 0;
}

/** Names a rule had in this seed (current and earlier versions). */
function ruleNames(r: RuleSeed): string[] {
  return [r.name, ...(r.legacyNames ?? [])];
}

/** Distribution rules the seed still creates (reads only): none once the demo import is committed. */
export async function rulesPlan(organizationId: string): Promise<RuleSeed[]> {
  if (await committedDemoBatch(organizationId)) return [];
  const existing = await getDb()
    .select({ name: distributionRules.name })
    .from(distributionRules)
    .where(eq(distributionRules.organizationId, organizationId));
  const names = new Set(existing.map((r) => r.name));
  const created = await createdInAudit(organizationId, "distribution_rule.create", "name", V2_RULES.flatMap(ruleNames));
  for (const e of created) names.add(e.value);
  return V2_RULES.filter((r) => !ruleNames(r).some((n) => names.has(n)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Creates what `structurePlan` lists (company and firm through the
 * organization service and the units through the admin service, as the
 * administrator; accounts by direct insert with the demo password, like the
 * v1 seed) and returns the ids the next steps use.
 */
export async function ensureStructure(organizationId: string, v1: Record<UserKey, SeededUser>): Promise<StructureResult> {
  const state = await loadState(organizationId);
  const plan = planFrom(state);
  const admin = userContext(v1.admin);
  const created: StructureResult["created"] = { company: false, lawFirm: false, units: [], accounts: 0, teamMembers: 0 };

  let companyId = state.company.id;
  if (plan.company) {
    companyId = (await createCompany(admin, { name: V2_COMPANY_NAME, document: null })).id;
    created.company = true;
  }
  let lawFirmId = state.lawFirm.id;
  if (plan.lawFirm) {
    lawFirmId = (
      await createLawFirm(admin, {
        name: V2_LAW_FIRM.name,
        document: null,
        contactName: V2_LAW_FIRM.contactName,
        contactEmail: V2_LAW_FIRM.contactEmail,
      })
    ).id;
    created.lawFirm = true;
  }
  const unitIds = Object.fromEntries(Object.entries(state.units).map(([k, v]) => [k, v.id])) as Record<DemoUnitKey, string | null>;
  for (const key of plan.units) {
    const u = V2_UNITS.find((x) => x.key === key)!;
    unitIds[key] = (await createUnit(admin, { name: u.name, code: u.code })).id;
    created.units.push(u.name);
  }

  const people = { ...v1 } as DemoPeople;
  for (const [email, meta] of Object.entries(AURORA_V2_USERS)) {
    const found = state.accounts.get(email.toLowerCase());
    if (found) people[meta.key] = found;
  }
  if (plan.accounts.length > 0) {
    const hashes = new Map<string, string>();
    for (const email of plan.accounts) hashes.set(email, await hashPassword(DEMO_PASSWORD));
    await getDb().transaction(async (tx) => {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.organizationId, organizationId), eq(teams.name, V2_TEAM.name)))
        .limit(1);
      for (const email of plan.accounts) {
        const meta = Object.entries(AURORA_V2_USERS).find(([e]) => e.toLowerCase() === email)![1];
        const account = DEMO_ACCOUNTS.find((a) => a.email === email);
        if (!account) throw new Error(`Conta ${email} ausente de DEMO_ACCOUNTS.`);
        const [row] = await tx
          .insert(users)
          .values({
            organizationId,
            name: account.name,
            email,
            passwordHash: hashes.get(email)!,
            role: account.role,
            unitId: meta.unit ? unitIds[meta.unit] : null,
            lawFirmId: meta.lawFirm ? lawFirmId : null,
            jobTitle: meta.jobTitle,
          })
          .returning();
        people[meta.key] = toSeeded(row);
        created.accounts++;
        // Joins the team only when the account is created: a later removal by a person stands.
        if (team && V2_TEAM.members.includes(meta.key)) {
          await tx.insert(teamMembers).values({ teamId: team.id, userId: row.id, organizationId }).onConflictDoNothing();
          created.teamMembers++;
        }
      }
    });
  }

  return { structure: { people, companyId, lawFirmId, units: unitIds }, created };
}

/**
 * Creates, as the legal manager, the rules `rulesPlan` lists. A rule whose
 * unit or firm a person removed is created without it.
 */
export async function ensureRules(gestor: AuthContext, structure: DemoStructure): Promise<number> {
  const missing = await rulesPlan(gestor.organizationId);
  for (const r of missing) {
    await createRule(gestor, {
      name: r.name,
      description: r.description,
      priority: r.priority,
      courts: r.courts,
      instances: r.instances,
      method: r.method,
      userIds: r.users.map((k) => structure.people[k].id),
      lawFirmId: r.lawFirm ? structure.lawFirmId : null,
      assignUnitId: r.unit ? structure.units[r.unit] : null,
    });
  }
  return missing.length;
}

