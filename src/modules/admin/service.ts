import { and, asc, count, desc, eq, gte, ilike, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { EntityRef, Page, Paginated } from "@/domain/entities";
import { normalizePage } from "@/domain/entities";
import { ROLE_LABELS, ROUTINE_TYPE_LABELS, ROUTINE_TYPES, type EntityType, type Role, type RoutineType } from "@/domain/enums";
import { addDaysISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import {
  analysisWhere,
  contractWhere,
  deadlineWhere,
  documentWhere,
  occurrenceWhere,
  processWhere,
  taskWhere,
} from "@/server/auth/access";
import { hashPassword, passwordPolicyError } from "@/server/auth/password";
import { assertCan, can, type Permission } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  aiAnalyses,
  auditLogs,
  companies,
  contracts,
  deadlines,
  documents,
  lawFirms,
  legalProcesses,
  occurrences,
  organizations,
  scheduledRoutines,
  tasks,
  teamMembers,
  teams,
  units,
  users,
  type OrganizationSettings,
} from "@/server/db/schema";
import { mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import { enqueueJob } from "@/server/jobs/queue";
import { ensureDefaultRoutines } from "@/server/jobs/routines";
import { processPendingJobs } from "@/server/jobs/worker";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { revokeUserSessions } from "@/server/services/auth";
import {
  auditFiltersSchema,
  contingencySettingsSchema,
  createUserSchema,
  emailIntakeSettingsSchema,
  listFiltersSchema,
  organizationSettingsSchema,
  resetPasswordSchema,
  routineUpdateSchema,
  teamSchema,
  unitSchema,
  updateUserSchema,
  userFiltersSchema,
  type AuditFilters,
  type ContingencySettingsInput,
  type CreateUserInput,
  type EmailIntakeSettingsInput,
  type OrganizationSettingsInput,
  type ResetPasswordInput,
  type RoutineUpdateInput,
  type TeamInput,
  type UnitInput,
  type UpdateUserInput,
  type UserFilters,
} from "./schemas";

/**
 * Administration: users, teams, units, organization settings, routines,
 * audit queries, shared lookups (user/unit options) and entity history.
 *
 * Every function takes `ctx` first, checks its permission and scopes every
 * query to `ctx.organizationId`. Foreign ids received in input are verified to
 * belong to the organization before being stored.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Changes = Record<string, { from: unknown; to: unknown }>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isGuid(value: unknown): value is string {
  return typeof value === "string" && GUID.test(value);
}

/** Ids that are not uuid-shaped can never match a row: treat as not found (never hit the DB with them). */
function requireId(id: string): string {
  if (!isGuid(id)) throw new NotFoundError();
  return id;
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(undefined, z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  }
  return result.data;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505") return true;
    e = typeof e === "object" && e !== null ? (e as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

async function assertUnitUsable(db: DbOrTx, ctx: AuthContext, unitId: string, field = "unitId"): Promise<void> {
  const [unit] = await db
    .select({ id: units.id, isActive: units.isActive })
    .from(units)
    .where(and(eq(units.id, unitId), eq(units.organizationId, ctx.organizationId)))
    .limit(1);
  if (!unit) throw new ValidationError(undefined, { [field]: ["Unidade não encontrada nesta organização."] });
  if (!unit.isActive) throw new ValidationError(undefined, { [field]: ["Esta unidade está desativada."] });
}

/** A law firm newly assigned to a user must belong to the organization and be active. */
async function assertLawFirmUsable(db: DbOrTx, ctx: AuthContext, lawFirmId: string): Promise<void> {
  const [firm] = await db
    .select({ id: lawFirms.id, isActive: lawFirms.isActive })
    .from(lawFirms)
    .where(and(eq(lawFirms.id, lawFirmId), eq(lawFirms.organizationId, ctx.organizationId)))
    .limit(1);
  if (!firm) throw new ValidationError(undefined, { lawFirmId: ["Escritório não encontrado nesta organização."] });
  if (!firm.isActive) throw new ValidationError(undefined, { lawFirmId: ["Este escritório está desativado."] });
}

async function assertTeamsInOrg(db: DbOrTx, ctx: AuthContext, teamIds: readonly string[]): Promise<void> {
  if (teamIds.length === 0) return;
  const found = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(inArray(teams.id, [...teamIds]), eq(teams.organizationId, ctx.organizationId)));
  if (found.length !== new Set(teamIds).size) {
    throw new ValidationError(undefined, { teamIds: ["Uma ou mais equipes não pertencem a esta organização."] });
  }
}

/** Every id must be a user of the organization; `activeIds` (new additions) must also be active. */
async function assertUsersInOrg(
  db: DbOrTx,
  ctx: AuthContext,
  userIds: readonly string[],
  field: string,
  activeIds: readonly string[] = userIds,
): Promise<void> {
  if (userIds.length === 0) return;
  const found = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(and(inArray(users.id, [...userIds]), eq(users.organizationId, ctx.organizationId)));
  if (found.length !== new Set(userIds).size) {
    throw new ValidationError(undefined, { [field]: ["Usuário não encontrado nesta organização."] });
  }
  const inactive = found.filter((u) => !u.isActive && activeIds.includes(u.id));
  if (inactive.length > 0) {
    throw new ValidationError(undefined, { [field]: ["Usuários inativos não podem ser incluídos."] });
  }
}

// ---------------------------------------------------------------------------
// Shared lookups (contract)
// ---------------------------------------------------------------------------

/** Active users of the organization (for "responsável" selects and filters). */
export async function listUserOptions(
  ctx: AuthContext,
): Promise<{ id: string; name: string; role: Role; unitId: string | null }[]> {
  return getDb()
    .select({ id: users.id, name: users.name, role: users.role, unitId: users.unitId })
    .from(users)
    .where(and(eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)))
    .orderBy(asc(users.name));
}

/** Active units of the organization. */
export async function listUnitOptions(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  return getDb()
    .select({ id: units.id, name: units.name })
    .from(units)
    .where(and(eq(units.organizationId, ctx.organizationId), eq(units.isActive, true)))
    .orderBy(asc(units.name));
}

/** Teams of the organization (user form). */
export async function listTeamOptions(ctx: AuthContext): Promise<{ id: string; name: string }[]> {
  assertCan(ctx, "admin:users");
  return getDb()
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.organizationId, ctx.organizationId))
    .orderBy(asc(teams.name));
}

/** Every unit of the organization, including inactive ones (filters and edit forms). */
export async function listAllUnitOptions(ctx: AuthContext): Promise<{ id: string; name: string; isActive: boolean }[]> {
  assertCan(ctx, "admin:users");
  return getDb()
    .select({ id: units.id, name: units.name, isActive: units.isActive })
    .from(units)
    .where(eq(units.organizationId, ctx.organizationId))
    .orderBy(desc(units.isActive), asc(units.name));
}

/** Every user of the organization, including inactive ones (audit filter, team members). */
export async function listAllUserOptions(
  ctx: AuthContext,
): Promise<{ id: string; name: string; role: Role; isActive: boolean }[]> {
  if (!can(ctx, "audit:read") && !can(ctx, "admin:users")) throw new ForbiddenError();
  return getDb()
    .select({ id: users.id, name: users.name, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.organizationId, ctx.organizationId))
    .orderBy(asc(users.name));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type UserListItem = {
  id: string;
  name: string;
  email: string;
  role: Role;
  unitId: string | null;
  unitName: string | null;
  /** Law firm of an external-counsel user (null for every other role). */
  lawFirmId: string | null;
  lawFirmName: string | null;
  jobTitle: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  teams: { id: string; name: string }[];
};

export type UserDetail = UserListItem & { teamIds: string[]; isSelf: boolean };

const userColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  unitId: users.unitId,
  unitName: units.name,
  lawFirmId: users.lawFirmId,
  lawFirmName: lawFirms.name,
  jobTitle: users.jobTitle,
  isActive: users.isActive,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

async function teamsByUser(ctx: AuthContext, userIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
  const map = new Map<string, { id: string; name: string }[]>();
  if (userIds.length === 0) return map;
  const rows = await getDb()
    .select({ userId: teamMembers.userId, id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(inArray(teamMembers.userId, userIds), eq(teams.organizationId, ctx.organizationId)))
    .orderBy(asc(teams.name));
  for (const r of rows) {
    const list = map.get(r.userId) ?? [];
    list.push({ id: r.id, name: r.name });
    map.set(r.userId, list);
  }
  return map;
}

export async function listUsers(ctx: AuthContext, filters: UserFilters = {}): Promise<Paginated<UserListItem>> {
  assertCan(ctx, "admin:users");
  const f = parse(userFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const conds: (SQL | undefined)[] = [eq(users.organizationId, ctx.organizationId)];
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    conds.push(or(ilike(users.name, like), ilike(users.email, like), ilike(users.jobTitle, like)));
  }
  if (f.role) conds.push(eq(users.role, f.role));
  if (f.unitId) conds.push(eq(users.unitId, f.unitId));
  if (f.lawFirmId) conds.push(eq(users.lawFirmId, f.lawFirmId));
  if (f.active !== undefined) conds.push(eq(users.isActive, f.active));
  const where = and(...conds);

  const db = getDb();
  const rows = await db
    .select(userColumns)
    .from(users)
    .leftJoin(units, and(eq(units.id, users.unitId), eq(units.organizationId, ctx.organizationId)))
    .leftJoin(lawFirms, and(eq(lawFirms.id, users.lawFirmId), eq(lawFirms.organizationId, ctx.organizationId)))
    .where(where)
    .orderBy(desc(users.isActive), asc(users.name), asc(users.id))
    .limit(pageSize)
    .offset(offset);
  const [{ total }] = await db.select({ total: count() }).from(users).where(where);
  const teamMap = await teamsByUser(ctx, rows.map((r) => r.id));
  return {
    items: rows.map((r) => ({ ...r, teams: teamMap.get(r.id) ?? [] })),
    total,
    page,
    pageSize,
  };
}

export async function getUser(ctx: AuthContext, id: string): Promise<UserDetail> {
  assertCan(ctx, "admin:users");
  requireId(id);
  const [row] = await getDb()
    .select(userColumns)
    .from(users)
    .leftJoin(units, and(eq(units.id, users.unitId), eq(units.organizationId, ctx.organizationId)))
    .leftJoin(lawFirms, and(eq(lawFirms.id, users.lawFirmId), eq(lawFirms.organizationId, ctx.organizationId)))
    .where(and(eq(users.id, id), eq(users.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  const userTeams = (await teamsByUser(ctx, [row.id])).get(row.id) ?? [];
  return { ...row, teams: userTeams, teamIds: userTeams.map((t) => t.id), isSelf: ctx.userId === row.id };
}

export async function createUser(ctx: AuthContext, input: CreateUserInput): Promise<{ id: string }> {
  assertCan(ctx, "admin:users");
  const data = parse(createUserSchema, input);
  const policyError = passwordPolicyError(data.password);
  if (policyError) throw new ValidationError(undefined, { password: [policyError] });
  const passwordHash = await hashPassword(data.password);

  try {
    return await getDb().transaction(async (tx) => {
      if (data.unitId) await assertUnitUsable(tx, ctx, data.unitId);
      if (data.lawFirmId) await assertLawFirmUsable(tx, ctx, data.lawFirmId);
      await assertTeamsInOrg(tx, ctx, data.teamIds);
      // E-mail is unique across the installation (login is by e-mail).
      const [duplicate] = await tx.select({ id: users.id }).from(users).where(eq(users.email, data.email)).limit(1);
      if (duplicate) throw new ConflictError("Já existe um usuário cadastrado com este e-mail.");

      const [created] = await tx
        .insert(users)
        .values({
          organizationId: ctx.organizationId,
          name: data.name,
          email: data.email,
          passwordHash,
          role: data.role,
          unitId: data.unitId ?? null,
          lawFirmId: data.lawFirmId,
          jobTitle: data.jobTitle,
          isActive: true,
        })
        .returning({ id: users.id });

      if (data.teamIds.length > 0) {
        await tx
          .insert(teamMembers)
          .values(data.teamIds.map((teamId) => ({ teamId, userId: created.id, organizationId: ctx.organizationId })));
      }

      await recordAudit(
        ctx,
        {
          action: "user.create",
          entityType: "user",
          entityId: created.id,
          summary: `Usuário ${data.name} criado com o perfil ${ROLE_LABELS[data.role]}`,
          changes: diffChanges(null, {
            name: data.name,
            email: data.email,
            role: data.role,
            unitId: data.unitId ?? null,
            lawFirmId: data.lawFirmId,
            jobTitle: data.jobTitle,
            isActive: true,
            teamIds: sortedIds(data.teamIds),
          }),
        },
        tx,
      );
      return { id: created.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe um usuário cadastrado com este e-mail.");
    throw err;
  }
}

/** Ensures at least one other active admin remains (rows are locked to serialize concurrent demotions). */
async function assertAnotherActiveAdmin(tx: DbOrTx, ctx: AuthContext, userId: string): Promise<void> {
  const others = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, ctx.organizationId),
        eq(users.role, "admin"),
        eq(users.isActive, true),
        ne(users.id, userId),
      ),
    )
    .for("update");
  if (others.length === 0) {
    throw new ConflictError("A organização precisa manter pelo menos um administrador ativo.");
  }
}

export async function updateUser(ctx: AuthContext, id: string, input: UpdateUserInput): Promise<void> {
  assertCan(ctx, "admin:users");
  requireId(id);
  const data = parse(updateUserSchema, input);
  const isSelf = ctx.userId === id;

  const revoke = await getDb().transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.organizationId, ctx.organizationId)))
      .for("update");
    if (!before) throw new NotFoundError();

    if (isSelf && !data.isActive) throw new ConflictError("Você não pode desativar o seu próprio usuário.");
    if (isSelf && data.role !== before.role) throw new ConflictError("Você não pode alterar o seu próprio perfil.");
    const losesAdmin = before.role === "admin" && before.isActive && (data.role !== "admin" || !data.isActive);
    if (losesAdmin) await assertAnotherActiveAdmin(tx, ctx, id);

    const unitId = data.unitId ?? null;
    if (unitId && unitId !== before.unitId) await assertUnitUsable(tx, ctx, unitId);
    const lawFirmId = data.lawFirmId;
    if (lawFirmId && lawFirmId !== before.lawFirmId) await assertLawFirmUsable(tx, ctx, lawFirmId);
    await assertTeamsInOrg(tx, ctx, data.teamIds);

    const currentTeams = await tx
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, id), eq(teamMembers.organizationId, ctx.organizationId)));

    const after = {
      name: data.name,
      role: data.role,
      unitId,
      lawFirmId,
      jobTitle: data.jobTitle,
      isActive: data.isActive,
      teamIds: sortedIds(data.teamIds),
    };
    const changes = diffChanges({ ...before, teamIds: sortedIds(currentTeams.map((t) => t.teamId)) }, after);
    if (!changes) return false;

    await tx
      .update(users)
      .set({
        name: after.name,
        role: after.role,
        unitId: after.unitId,
        lawFirmId: after.lawFirmId,
        jobTitle: after.jobTitle,
        isActive: after.isActive,
      })
      .where(and(eq(users.id, id), eq(users.organizationId, ctx.organizationId)));

    if (changes.teamIds) {
      await tx.delete(teamMembers).where(and(eq(teamMembers.userId, id), eq(teamMembers.organizationId, ctx.organizationId)));
      if (after.teamIds.length > 0) {
        await tx
          .insert(teamMembers)
          .values(after.teamIds.map((teamId) => ({ teamId, userId: id, organizationId: ctx.organizationId })));
      }
    }

    // Role, unit, law firm or activation changes alter what the user may see: end their sessions.
    // (Your own role/activation cannot change here; your own unit change applies on the next request.)
    const sessionsRevoked =
      !isSelf && Boolean(changes.role || changes.unitId || changes.lawFirmId || (changes.isActive && !after.isActive));
    const summary = changes.isActive
      ? `Usuário ${after.name} ${after.isActive ? "reativado" : "desativado"}`
      : `Usuário ${after.name} alterado`;
    await recordAudit(
      ctx,
      { action: "user.update", entityType: "user", entityId: id, summary, changes, metadata: { sessionsRevoked } },
      tx,
    );
    return sessionsRevoked;
  });

  if (revoke) await revokeUserSessions(id);
}

/** Activates or deactivates a user keeping the other attributes. */
export async function setUserActive(ctx: AuthContext, id: string, active: boolean): Promise<void> {
  const user = await getUser(ctx, id);
  await updateUser(ctx, id, {
    name: user.name,
    role: user.role,
    unitId: user.unitId,
    lawFirmId: user.lawFirmId,
    jobTitle: user.jobTitle,
    isActive: active,
    teamIds: user.teamIds,
  });
}

export async function resetUserPassword(ctx: AuthContext, id: string, input: ResetPasswordInput): Promise<void> {
  assertCan(ctx, "admin:users");
  requireId(id);
  const data = parse(resetPasswordSchema, input);
  const policyError = passwordPolicyError(data.password);
  if (policyError) throw new ValidationError(undefined, { password: [policyError] });
  const passwordHash = await hashPassword(data.password);

  await getDb().transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, id), eq(users.organizationId, ctx.organizationId)))
      .limit(1);
    if (!user) throw new NotFoundError();
    await tx
      .update(users)
      .set({ passwordHash })
      .where(and(eq(users.id, id), eq(users.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "user.password_reset",
        entityType: "user",
        entityId: id,
        summary: `Senha do usuário ${user.name} redefinida por um administrador`,
        metadata: { sessionsRevoked: true },
      },
      tx,
    );
  });
  await revokeUserSessions(id);
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export type TeamListItem = {
  id: string;
  name: string;
  description: string | null;
  unitId: string | null;
  unitName: string | null;
  leaderId: string | null;
  leaderName: string | null;
  memberCount: number;
};

export type TeamDetail = TeamListItem & {
  members: { id: string; name: string; email: string; role: Role; isActive: boolean }[];
  memberIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

const leaders = alias(users, "leader");

function teamSelect() {
  const memberCount = sql<number>`(select count(*)::int from ${teamMembers} where ${teamMembers.teamId} = ${teams.id})`;
  return getDb()
    .select({
      id: teams.id,
      name: teams.name,
      description: teams.description,
      unitId: teams.unitId,
      unitName: units.name,
      leaderId: teams.leaderId,
      leaderName: leaders.name,
      memberCount,
      createdAt: teams.createdAt,
      updatedAt: teams.updatedAt,
    })
    .from(teams)
    .leftJoin(units, eq(units.id, teams.unitId))
    .leftJoin(leaders, eq(leaders.id, teams.leaderId));
}

export async function listTeams(
  ctx: AuthContext,
  filters: { q?: string } & Page = {},
): Promise<Paginated<TeamListItem>> {
  assertCan(ctx, "admin:users");
  const f = parse(listFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const conds: (SQL | undefined)[] = [eq(teams.organizationId, ctx.organizationId)];
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    conds.push(or(ilike(teams.name, like), ilike(teams.description, like)));
  }
  const where = and(...conds);
  const rows = await teamSelect().where(where).orderBy(asc(teams.name)).limit(pageSize).offset(offset);
  const [{ total }] = await getDb().select({ total: count() }).from(teams).where(where);
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      unitId: r.unitId,
      unitName: r.unitName,
      leaderId: r.leaderId,
      leaderName: r.leaderName,
      memberCount: Number(r.memberCount),
    })),
    total,
    page,
    pageSize,
  };
}

export async function getTeam(ctx: AuthContext, id: string): Promise<TeamDetail> {
  assertCan(ctx, "admin:users");
  requireId(id);
  const [row] = await teamSelect()
    .where(and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  const members = await getDb()
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      and(
        eq(teamMembers.teamId, id),
        eq(teamMembers.organizationId, ctx.organizationId),
        eq(users.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(asc(users.name));
  return { ...row, memberCount: Number(row.memberCount), members, memberIds: members.map((m) => m.id) };
}

async function validateTeamRefs(
  tx: DbOrTx,
  ctx: AuthContext,
  data: z.output<typeof teamSchema>,
  before?: { unitId: string | null; leaderId: string | null; memberIds: string[] },
): Promise<void> {
  if (data.unitId && data.unitId !== before?.unitId) await assertUnitUsable(tx, ctx, data.unitId);
  if (data.leaderId && data.leaderId !== before?.leaderId) await assertUsersInOrg(tx, ctx, [data.leaderId], "leaderId");
  const newMembers = data.memberIds.filter((m) => !before?.memberIds.includes(m));
  await assertUsersInOrg(tx, ctx, data.memberIds, "memberIds", newMembers);
}

async function assertTeamNameFree(tx: DbOrTx, ctx: AuthContext, name: string, exceptId?: string): Promise<void> {
  const [dup] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.organizationId, ctx.organizationId),
        sql`lower(${teams.name}) = lower(${name})`,
        exceptId ? ne(teams.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (dup) throw new ConflictError("Já existe uma equipe com este nome.");
}

export async function createTeam(ctx: AuthContext, input: TeamInput): Promise<{ id: string }> {
  assertCan(ctx, "admin:users");
  const data = parse(teamSchema, input);
  try {
    return await getDb().transaction(async (tx) => {
      await validateTeamRefs(tx, ctx, data);
      await assertTeamNameFree(tx, ctx, data.name);
      const [created] = await tx
        .insert(teams)
        .values({
          organizationId: ctx.organizationId,
          name: data.name,
          description: data.description,
          unitId: data.unitId ?? null,
          leaderId: data.leaderId ?? null,
        })
        .returning({ id: teams.id });
      if (data.memberIds.length > 0) {
        await tx
          .insert(teamMembers)
          .values(data.memberIds.map((userId) => ({ teamId: created.id, userId, organizationId: ctx.organizationId })));
      }
      await recordAudit(
        ctx,
        {
          action: "team.create",
          entityType: "team",
          entityId: created.id,
          summary: `Equipe ${data.name} criada`,
          changes: diffChanges(null, {
            name: data.name,
            description: data.description,
            unitId: data.unitId ?? null,
            leaderId: data.leaderId ?? null,
            memberIds: sortedIds(data.memberIds),
          }),
        },
        tx,
      );
      return { id: created.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe uma equipe com este nome.");
    throw err;
  }
}

export async function updateTeam(ctx: AuthContext, id: string, input: TeamInput): Promise<void> {
  assertCan(ctx, "admin:users");
  requireId(id);
  const data = parse(teamSchema, input);
  try {
    await getDb().transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(teams)
        .where(and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)))
        .for("update");
      if (!before) throw new NotFoundError();
      const currentMembers = (
        await tx
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, id), eq(teamMembers.organizationId, ctx.organizationId)))
      ).map((m) => m.userId);

      await validateTeamRefs(tx, ctx, data, { unitId: before.unitId, leaderId: before.leaderId, memberIds: currentMembers });
      if (data.name.toLowerCase() !== before.name.toLowerCase()) await assertTeamNameFree(tx, ctx, data.name, id);

      const after = {
        name: data.name,
        description: data.description,
        unitId: data.unitId ?? null,
        leaderId: data.leaderId ?? null,
        memberIds: sortedIds(data.memberIds),
      };
      const changes = diffChanges({ ...before, memberIds: sortedIds(currentMembers) }, after);
      if (!changes) return;

      await tx
        .update(teams)
        .set({ name: after.name, description: after.description, unitId: after.unitId, leaderId: after.leaderId })
        .where(and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)));
      if (changes.memberIds) {
        await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, id), eq(teamMembers.organizationId, ctx.organizationId)));
        if (after.memberIds.length > 0) {
          await tx
            .insert(teamMembers)
            .values(after.memberIds.map((userId) => ({ teamId: id, userId, organizationId: ctx.organizationId })));
        }
      }
      await recordAudit(
        ctx,
        { action: "team.update", entityType: "team", entityId: id, summary: `Equipe ${after.name} alterada`, changes },
        tx,
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe uma equipe com este nome.");
    throw err;
  }
}

export async function deleteTeam(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "admin:users");
  requireId(id);
  await getDb().transaction(async (tx) => {
    const [team] = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)))
      .limit(1);
    if (!team) throw new NotFoundError();
    await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, id), eq(teamMembers.organizationId, ctx.organizationId)));
    await tx.delete(teams).where(and(eq(teams.id, id), eq(teams.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      { action: "team.delete", entityType: "team", entityId: id, summary: `Equipe ${team.name} excluída` },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export type UnitListItem = {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
  userCount: number;
  teamCount: number;
};

export type UnitDetail = UnitListItem & {
  createdAt: Date;
  updatedAt: Date;
  references: { users: number; teams: number; records: number };
};

function unitSelect() {
  return getDb()
    .select({
      id: units.id,
      name: units.name,
      code: units.code,
      isActive: units.isActive,
      createdAt: units.createdAt,
      updatedAt: units.updatedAt,
    })
    .from(units);
}

/**
 * Users and teams per unit. Grouped queries instead of correlated subqueries:
 * drizzle renders columns of a single-table select without the table name,
 * which silently broke the correlation (counts always 0).
 */
async function unitCounts(ctx: AuthContext, unitIds: string[]) {
  const usersByUnit = new Map<string, number>();
  const teamsByUnit = new Map<string, number>();
  if (unitIds.length === 0) return { usersByUnit, teamsByUnit };
  const db = getDb();
  const [u, t] = await Promise.all([
    db
      .select({ id: users.unitId, n: count() })
      .from(users)
      .where(and(eq(users.organizationId, ctx.organizationId), inArray(users.unitId, unitIds)))
      .groupBy(users.unitId),
    db
      .select({ id: teams.unitId, n: count() })
      .from(teams)
      .where(and(eq(teams.organizationId, ctx.organizationId), inArray(teams.unitId, unitIds)))
      .groupBy(teams.unitId),
  ]);
  for (const r of u) if (r.id) usersByUnit.set(r.id, r.n);
  for (const r of t) if (r.id) teamsByUnit.set(r.id, r.n);
  return { usersByUnit, teamsByUnit };
}

export async function listUnits(
  ctx: AuthContext,
  filters: { q?: string; active?: boolean } & Page = {},
): Promise<Paginated<UnitListItem>> {
  assertCan(ctx, "admin:users");
  const f = parse(listFiltersSchema.extend({ active: z.boolean().optional() }), filters);
  const { page, pageSize, offset } = normalizePage(f);
  const conds: (SQL | undefined)[] = [eq(units.organizationId, ctx.organizationId)];
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    conds.push(or(ilike(units.name, like), ilike(units.code, like)));
  }
  if (f.active !== undefined) conds.push(eq(units.isActive, f.active));
  const where = and(...conds);
  const rows = await unitSelect().where(where).orderBy(desc(units.isActive), asc(units.name)).limit(pageSize).offset(offset);
  const [{ total }] = await getDb().select({ total: count() }).from(units).where(where);
  const { usersByUnit, teamsByUnit } = await unitCounts(ctx, rows.map((r) => r.id));
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      isActive: r.isActive,
      userCount: usersByUnit.get(r.id) ?? 0,
      teamCount: teamsByUnit.get(r.id) ?? 0,
    })),
    total,
    page,
    pageSize,
  };
}

/** Rows (any state, including soft-deleted) that reference the unit through a foreign key. */
async function countUnitRecordReferences(db: DbOrTx, unitId: string): Promise<number> {
  const tables = [legalProcesses, occurrences, contracts, tasks, deadlines] as const;
  let total = 0;
  for (const t of tables) {
    const [{ n }] = await db.select({ n: count() }).from(t).where(eq(t.unitId, unitId));
    total += n;
  }
  return total;
}

export async function getUnit(ctx: AuthContext, id: string): Promise<UnitDetail> {
  assertCan(ctx, "admin:users");
  requireId(id);
  const [row] = await unitSelect()
    .where(and(eq(units.id, id), eq(units.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  const records = await countUnitRecordReferences(getDb(), id);
  const { usersByUnit, teamsByUnit } = await unitCounts(ctx, [id]);
  const userCount = usersByUnit.get(id) ?? 0;
  const teamCount = teamsByUnit.get(id) ?? 0;
  return { ...row, userCount, teamCount, references: { users: userCount, teams: teamCount, records } };
}

async function assertUnitNameFree(tx: DbOrTx, ctx: AuthContext, name: string, exceptId?: string): Promise<void> {
  const [dup] = await tx
    .select({ id: units.id })
    .from(units)
    .where(
      and(
        eq(units.organizationId, ctx.organizationId),
        sql`lower(${units.name}) = lower(${name})`,
        exceptId ? ne(units.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (dup) throw new ConflictError("Já existe uma unidade com este nome.");
}

export async function createUnit(ctx: AuthContext, input: UnitInput): Promise<{ id: string }> {
  assertCan(ctx, "admin:users");
  const data = parse(unitSchema, input);
  try {
    return await getDb().transaction(async (tx) => {
      await assertUnitNameFree(tx, ctx, data.name);
      const [created] = await tx
        .insert(units)
        .values({ organizationId: ctx.organizationId, name: data.name, code: data.code, isActive: data.isActive ?? true })
        .returning({ id: units.id });
      await recordAudit(
        ctx,
        {
          action: "unit.create",
          entityType: "unit",
          entityId: created.id,
          summary: `Unidade ${data.name} criada`,
          changes: diffChanges(null, { name: data.name, code: data.code, isActive: data.isActive ?? true }),
        },
        tx,
      );
      return { id: created.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe uma unidade com este nome.");
    throw err;
  }
}

export async function updateUnit(ctx: AuthContext, id: string, input: UnitInput): Promise<void> {
  assertCan(ctx, "admin:users");
  requireId(id);
  const data = parse(unitSchema, input);
  try {
    await getDb().transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(units)
        .where(and(eq(units.id, id), eq(units.organizationId, ctx.organizationId)))
        .for("update");
      if (!before) throw new NotFoundError();
      if (data.name.toLowerCase() !== before.name.toLowerCase()) await assertUnitNameFree(tx, ctx, data.name, id);
      const after = { name: data.name, code: data.code, isActive: data.isActive ?? before.isActive };
      const changes = diffChanges(before, after);
      if (!changes) return;
      await tx.update(units).set(after).where(and(eq(units.id, id), eq(units.organizationId, ctx.organizationId)));
      const summary = changes.isActive
        ? `Unidade ${after.name} ${after.isActive ? "reativada" : "desativada"}`
        : `Unidade ${after.name} alterada`;
      await recordAudit(ctx, { action: "unit.update", entityType: "unit", entityId: id, summary, changes }, tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe uma unidade com este nome.");
    throw err;
  }
}

/** Activates or deactivates a unit keeping its other attributes. */
export async function setUnitActive(ctx: AuthContext, id: string, active: boolean): Promise<void> {
  const unit = await getUnit(ctx, id);
  await updateUnit(ctx, id, { name: unit.name, code: unit.code, isActive: active });
}

/**
 * Deletes a unit that nothing references. When users, teams or records still
 * point to it, the unit is deactivated instead (history stays consistent).
 */
export async function deleteUnit(ctx: AuthContext, id: string): Promise<{ outcome: "deleted" | "deactivated" }> {
  assertCan(ctx, "admin:users");
  requireId(id);
  return getDb().transaction(async (tx) => {
    const [unit] = await tx
      .select()
      .from(units)
      .where(and(eq(units.id, id), eq(units.organizationId, ctx.organizationId)))
      .for("update");
    if (!unit) throw new NotFoundError();
    const [{ n: userRefs }] = await tx.select({ n: count() }).from(users).where(eq(users.unitId, id));
    const [{ n: teamRefs }] = await tx.select({ n: count() }).from(teams).where(eq(teams.unitId, id));
    const recordRefs = await countUnitRecordReferences(tx, id);
    const referenced = userRefs + teamRefs + recordRefs > 0;

    if (referenced) {
      if (unit.isActive) {
        await tx.update(units).set({ isActive: false }).where(and(eq(units.id, id), eq(units.organizationId, ctx.organizationId)));
      }
      await recordAudit(
        ctx,
        {
          action: "unit.deactivate",
          entityType: "unit",
          entityId: id,
          summary: `Unidade ${unit.name} desativada (possui vínculos e não pode ser excluída)`,
          changes: unit.isActive ? { isActive: { from: true, to: false } } : null,
          metadata: { userRefs, teamRefs, recordRefs },
        },
        tx,
      );
      return { outcome: "deactivated" as const };
    }

    await tx.delete(units).where(and(eq(units.id, id), eq(units.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      { action: "unit.delete", entityType: "unit", entityId: id, summary: `Unidade ${unit.name} excluída` },
      tx,
    );
    return { outcome: "deleted" as const };
  });
}

// ---------------------------------------------------------------------------
// Organization settings
// ---------------------------------------------------------------------------

const mergeSettings = mergeOrganizationSettings;

function flattenSettings(name: string, s: OrganizationSettings) {
  return {
    name,
    monthlyTokenBudget: s.ai.monthlyTokenBudget,
    maxInputChars: s.ai.maxInputChars,
    autoAnalyzeOnUpload: s.ai.autoAnalyzeOnUpload,
    upcomingDeadlineDays: s.alerts.upcomingDeadlineDays,
    contractExpirationDays: s.alerts.contractExpirationDays,
    upcomingHearingDays: s.alerts.upcomingHearingDays,
    installmentDueDays: s.alerts.installmentDueDays,
    closedRecordRetentionDays: s.retention.closedRecordRetentionDays,
    auditLogRetentionDays: s.retention.auditLogRetentionDays,
  };
}

export type OrganizationSettingsView = {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
  settings: OrganizationSettings;
  updatedAt: Date;
};

export async function getOrganizationSettings(ctx: AuthContext): Promise<OrganizationSettingsView> {
  assertCan(ctx, "admin:organization");
  const [org] = await getDb().select().from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1);
  if (!org) throw new NotFoundError("Organização não encontrada.");
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    isDemo: org.isDemo,
    settings: mergeSettings(org.settings),
    updatedAt: org.updatedAt,
  };
}

export async function updateOrganizationSettings(ctx: AuthContext, input: OrganizationSettingsInput): Promise<void> {
  assertCan(ctx, "admin:organization");
  const data = parse(organizationSettingsSchema, input);
  await getDb().transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId))
      .for("update");
    if (!org) throw new NotFoundError("Organização não encontrada.");
    const current = mergeSettings(org.settings);
    const next: OrganizationSettings = {
      ai: {
        monthlyTokenBudget: data.monthlyTokenBudget,
        maxInputChars: data.maxInputChars,
        autoAnalyzeOnUpload: data.autoAnalyzeOnUpload,
      },
      alerts: {
        ...current.alerts,
        upcomingDeadlineDays: data.upcomingDeadlineDays,
        contractExpirationDays: data.contractExpirationDays,
        upcomingHearingDays: data.upcomingHearingDays ?? current.alerts.upcomingHearingDays,
        installmentDueDays: data.installmentDueDays ?? current.alerts.installmentDueDays,
      },
      retention: {
        closedRecordRetentionDays: data.closedRecordRetentionDays,
        auditLogRetentionDays: data.auditLogRetentionDays,
      },
      contingency: current.contingency,
      email: current.email,
      intake: current.intake,
    };
    const changes = diffChanges(flattenSettings(org.name, current), flattenSettings(data.name, next));
    if (!changes) return;
    await tx
      .update(organizations)
      .set({ name: data.name, settings: next })
      .where(eq(organizations.id, ctx.organizationId));
    await recordAudit(
      ctx,
      {
        action: "organization.settings_update",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: "Configurações da organização alteradas",
        changes,
      },
      tx,
    );
  });
}

/** Locks the organization row and returns its merged settings (inside a transaction). */
async function lockOrganization(tx: DbOrTx, ctx: AuthContext) {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.organizationId)).for("update");
  if (!org) throw new NotFoundError("Organização não encontrada.");
  return { org, current: mergeSettings(org.settings) };
}

function flattenContingency(c: OrganizationSettings["contingency"]) {
  return {
    riskPercentRemote: c.riskPercentages.remote,
    riskPercentPossible: c.riskPercentages.possible,
    riskPercentProbable: c.riskPercentages.probable,
    confidenceThreshold: c.confidenceThreshold,
    idleGuaranteeDays: c.idleGuaranteeDays,
    rulesVersion: c.rulesVersion,
  };
}

/**
 * Contingency parameters (RN-04, RN-05, RN-11). Any change to a risk
 * percentage increments `rulesVersion` (RNF-14): risk assessments and monthly
 * closings record the version they used, so earlier reports stay
 * reproducible. Audited with before/after values.
 */
export async function updateContingencySettings(
  ctx: AuthContext,
  input: ContingencySettingsInput,
): Promise<{ rulesVersion: number; rulesVersionChanged: boolean }> {
  assertCan(ctx, "admin:organization");
  const data = parse(contingencySettingsSchema, input);
  return getDb().transaction(async (tx) => {
    const { current } = await lockOrganization(tx, ctx);
    const before = current.contingency;
    const riskPercentages = { remote: data.riskRemote, possible: data.riskPossible, probable: data.riskProbable };
    const percentagesChanged =
      riskPercentages.remote !== before.riskPercentages.remote ||
      riskPercentages.possible !== before.riskPercentages.possible ||
      riskPercentages.probable !== before.riskPercentages.probable;
    const next: OrganizationSettings["contingency"] = {
      riskPercentages,
      confidenceThreshold: data.confidenceThreshold,
      idleGuaranteeDays: data.idleGuaranteeDays,
      rulesVersion: percentagesChanged ? before.rulesVersion + 1 : before.rulesVersion,
    };
    const changes = diffChanges(flattenContingency(before), flattenContingency(next));
    if (!changes) return { rulesVersion: before.rulesVersion, rulesVersionChanged: false };
    await tx
      .update(organizations)
      .set({ settings: { ...current, contingency: next } })
      .where(eq(organizations.id, ctx.organizationId));
    await recordAudit(
      ctx,
      {
        action: "organization.contingency_settings_update",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: percentagesChanged
          ? `Parâmetros de contingência alterados — percentuais de risco na versão ${next.rulesVersion} das regras`
          : "Parâmetros de contingência alterados",
        changes,
        metadata: {
          rulesVersionBefore: before.rulesVersion,
          rulesVersionAfter: next.rulesVersion,
          riskPercentagesBefore: before.riskPercentages,
          riskPercentagesAfter: next.riskPercentages,
        },
      },
      tx,
    );
    return { rulesVersion: next.rulesVersion, rulesVersionChanged: percentagesChanged };
  });
}

function flattenEmailIntake(s: Pick<OrganizationSettings, "email" | "intake">) {
  return {
    senderName: s.email.senderName,
    senderAddress: s.email.senderAddress,
    notifyOnBriefReady: s.email.notifyOnBriefReady,
    notifyOnAssignment: s.email.notifyOnAssignment,
    autoAssign: s.intake.autoAssign,
    autoGenerateBrief: s.intake.autoGenerateBrief,
    autoNotify: s.intake.autoNotify,
  };
}

/**
 * Simulated e-mail (sender shown in simulations, which notifications are
 * generated) and the process intake pipeline switches. The e-mail mode is
 * fixed to `simulated` in this version and cannot be changed here.
 */
export async function updateEmailIntakeSettings(ctx: AuthContext, input: EmailIntakeSettingsInput): Promise<void> {
  assertCan(ctx, "admin:organization");
  const data = parse(emailIntakeSettingsSchema, input);
  await getDb().transaction(async (tx) => {
    const { current } = await lockOrganization(tx, ctx);
    const next: Pick<OrganizationSettings, "email" | "intake"> = {
      email: {
        mode: "simulated",
        senderName: data.senderName,
        senderAddress: data.senderAddress,
        notifyOnBriefReady: data.notifyOnBriefReady,
        notifyOnAssignment: data.notifyOnAssignment,
      },
      intake: { autoAssign: data.autoAssign, autoGenerateBrief: data.autoGenerateBrief, autoNotify: data.autoNotify },
    };
    const changes = diffChanges(flattenEmailIntake(current), flattenEmailIntake(next));
    if (!changes) return;
    await tx
      .update(organizations)
      .set({ settings: { ...current, ...next } })
      .where(eq(organizations.id, ctx.organizationId));
    await recordAudit(
      ctx,
      {
        action: "organization.email_intake_settings_update",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: "Configurações de e-mail (simulado) e de entrada de processos alteradas",
        changes,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export type RoutineItem = {
  id: string;
  type: RoutineType;
  enabled: boolean;
  intervalMinutes: number;
  config: { autoRefresh?: boolean; maxPerRun?: number };
  lastRunAt: Date | null;
  nextRunAt: Date;
  lastStatus: string | null;
  lastError: string | null;
};

function routineConfig(raw: Record<string, unknown> | null | undefined): RoutineItem["config"] {
  const out: RoutineItem["config"] = {};
  if (typeof raw?.autoRefresh === "boolean") out.autoRefresh = raw.autoRefresh;
  if (typeof raw?.maxPerRun === "number") out.maxPerRun = raw.maxPerRun;
  return out;
}

export async function listRoutines(ctx: AuthContext): Promise<RoutineItem[]> {
  assertCan(ctx, "admin:organization");
  const db = getDb();
  const load = () =>
    db.select().from(scheduledRoutines).where(eq(scheduledRoutines.organizationId, ctx.organizationId));
  let rows = await load();
  if (rows.length < ROUTINE_TYPES.length) {
    await ensureDefaultRoutines(ctx.organizationId);
    rows = await load();
  }
  return rows
    .filter((r) => (ROUTINE_TYPES as readonly string[]).includes(r.type))
    .sort((a, b) => ROUTINE_TYPES.indexOf(a.type) - ROUTINE_TYPES.indexOf(b.type))
    .map((r) => ({
      id: r.id,
      type: r.type,
      enabled: r.enabled,
      intervalMinutes: r.intervalMinutes,
      config: routineConfig(r.config),
      lastRunAt: r.lastRunAt,
      nextRunAt: r.nextRunAt,
      lastStatus: r.lastStatus,
      lastError: r.lastError,
    }));
}

export async function updateRoutine(ctx: AuthContext, id: string, input: RoutineUpdateInput): Promise<void> {
  assertCan(ctx, "admin:organization");
  requireId(id);
  const data = parse(routineUpdateSchema, input);
  await getDb().transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(scheduledRoutines)
      .where(and(eq(scheduledRoutines.id, id), eq(scheduledRoutines.organizationId, ctx.organizationId)))
      .for("update");
    if (!before) throw new NotFoundError();

    const config: Record<string, unknown> = { ...(before.config ?? {}) };
    if (before.type === "stale_analysis_refresh") {
      if (data.autoRefresh !== undefined) config.autoRefresh = data.autoRefresh;
      if (data.maxPerRun !== undefined) config.maxPerRun = data.maxPerRun;
    }
    const beforeConfig = routineConfig(before.config);
    const afterConfig = routineConfig(config);
    const changes = diffChanges(
      { enabled: before.enabled, intervalMinutes: before.intervalMinutes, ...beforeConfig },
      { enabled: data.enabled, intervalMinutes: data.intervalMinutes, ...afterConfig },
    );
    if (!changes) return;

    // Re-plan the next run when the schedule changed: last run + new interval (never in the past).
    let nextRunAt = before.nextRunAt;
    if (changes.intervalMinutes || (changes.enabled && data.enabled)) {
      const now = Date.now();
      const planned = before.lastRunAt ? before.lastRunAt.getTime() + data.intervalMinutes * 60_000 : now;
      nextRunAt = new Date(Math.max(now, planned));
    }

    await tx
      .update(scheduledRoutines)
      .set({ enabled: data.enabled, intervalMinutes: data.intervalMinutes, config, nextRunAt })
      .where(and(eq(scheduledRoutines.id, id), eq(scheduledRoutines.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "routine.update",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: `Rotina "${ROUTINE_TYPE_LABELS[before.type]}" alterada`,
        changes,
        metadata: { routineId: id, routineType: before.type },
      },
      tx,
    );
  });
}

/** Queues an immediate execution of a routine (processed by the worker or by "Processar fila agora"). */
export async function runRoutineNow(ctx: AuthContext, id: string): Promise<{ deduplicated: boolean }> {
  assertCan(ctx, "admin:organization");
  requireId(id);
  return getDb().transaction(async (tx) => {
    const [routine] = await tx
      .select({ id: scheduledRoutines.id, type: scheduledRoutines.type, enabled: scheduledRoutines.enabled })
      .from(scheduledRoutines)
      .where(and(eq(scheduledRoutines.id, id), eq(scheduledRoutines.organizationId, ctx.organizationId)))
      .limit(1);
    if (!routine) throw new NotFoundError();
    if (!routine.enabled) throw new ConflictError("Ative a rotina antes de executá-la.");
    const job = await enqueueJob(
      {
        type: "routine.run",
        organizationId: ctx.organizationId,
        payload: { routineId: routine.id },
        dedupeKey: `routine-now:${routine.id}`,
      },
      tx,
    );
    await recordAudit(
      ctx,
      {
        action: "routine.run_requested",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: `Execução imediata da rotina "${ROUTINE_TYPE_LABELS[routine.type]}" solicitada`,
        metadata: { routineId: routine.id, routineType: routine.type, jobId: job.id, deduplicated: job.deduplicated },
      },
      tx,
    );
    return { deduplicated: job.deduplicated };
  });
}

/**
 * Runs the caller organization's queued jobs inline (useful in demos without
 * a worker process). Jobs of other organizations are left to the worker.
 */
export async function processQueueNow(ctx: AuthContext): Promise<{ processed: number }> {
  assertCan(ctx, "admin:organization");
  const result = await processPendingJobs({ limit: 20, organizationId: ctx.organizationId });
  await recordAudit(ctx, {
    action: "jobs.process_requested",
    entityType: "organization",
    entityId: ctx.organizationId,
    summary: "Processamento manual da fila de tarefas em segundo plano",
    metadata: { processed: result.processed },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Audit queries
// ---------------------------------------------------------------------------

export type AuditLogItem = {
  id: string;
  createdAt: Date;
  action: string;
  entityType: EntityType;
  entityId: string | null;
  summary: string;
  changes: Changes | null;
  ipAddress: string | null;
  actorId: string | null;
  actorName: string | null;
  /** Names of users/units/teams whose ids appear in `changes`. */
  refNames: Record<string, string>;
};

/** Brazil has no DST since 2019: calendar days in the app zone start at 00:00-03:00. */
function startOfDay(iso: string): Date {
  return new Date(`${iso}T00:00:00-03:00`);
}

/** Resolves ids that appear in diffs to user/unit/team/company/law firm names of the same organization. */
async function resolveReferenceNames(
  ctx: AuthContext,
  changesList: (Changes | null)[],
  maxIds = 500,
): Promise<Record<string, string>> {
  const ids = new Set<string>();
  const collect = (v: unknown) => {
    if (isGuid(v)) ids.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
  };
  for (const changes of changesList) {
    if (!changes) continue;
    for (const c of Object.values(changes)) {
      collect(c.from);
      collect(c.to);
    }
  }
  if (ids.size === 0) return {};
  const list = [...ids].slice(0, maxIds);
  const db = getDb();
  const [u, un, t, co, lf] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(inArray(users.id, list), eq(users.organizationId, ctx.organizationId))),
    db
      .select({ id: units.id, name: units.name })
      .from(units)
      .where(and(inArray(units.id, list), eq(units.organizationId, ctx.organizationId))),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(and(inArray(teams.id, list), eq(teams.organizationId, ctx.organizationId))),
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(inArray(companies.id, list), eq(companies.organizationId, ctx.organizationId))),
    db
      .select({ id: lawFirms.id, name: lawFirms.name })
      .from(lawFirms)
      .where(and(inArray(lawFirms.id, list), eq(lawFirms.organizationId, ctx.organizationId))),
  ]);
  const names: Record<string, string> = {};
  for (const r of [...u, ...un, ...t, ...co, ...lf]) names[r.id] = r.name;
  return names;
}

function auditWhere(ctx: AuthContext, f: z.output<typeof auditFiltersSchema>): SQL | undefined {
  const conds: (SQL | undefined)[] = [eq(auditLogs.organizationId, ctx.organizationId)];
  if (f.action) conds.push(eq(auditLogs.action, f.action));
  if (f.entityType) conds.push(eq(auditLogs.entityType, f.entityType));
  if (f.actorId) conds.push(eq(auditLogs.actorId, f.actorId));
  if (f.entityId) conds.push(eq(auditLogs.entityId, f.entityId));
  if (f.from) conds.push(gte(auditLogs.createdAt, startOfDay(f.from)));
  if (f.to) conds.push(lt(auditLogs.createdAt, startOfDay(addDaysISO(f.to, 1))));
  return and(...conds);
}

function auditSelect() {
  return getDb()
    .select({
      id: auditLogs.id,
      createdAt: auditLogs.createdAt,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      summary: auditLogs.summary,
      changes: auditLogs.changes,
      ipAddress: auditLogs.ipAddress,
      actorId: auditLogs.actorId,
      actorName: users.name,
    })
    .from(auditLogs);
}

export async function listAuditLogs(ctx: AuthContext, filters: AuditFilters = {}): Promise<Paginated<AuditLogItem>> {
  assertCan(ctx, "audit:read");
  const f = parse(auditFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const where = auditWhere(ctx, f);

  const rows = await auditSelect()
    .leftJoin(users, and(eq(users.id, auditLogs.actorId), eq(users.organizationId, ctx.organizationId)))
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(pageSize)
    .offset(offset);
  const [{ total }] = await getDb().select({ total: count() }).from(auditLogs).where(where);
  const refNames = await resolveReferenceNames(ctx, rows.map((r) => r.changes));
  return { items: rows.map((r) => ({ ...r, refNames })), total, page, pageSize };
}

/** Max rows of one CSV export (the export says when the trail was cut). */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/**
 * Filtered audit trail for the CSV export (RF-22), newest first, capped at
 * AUDIT_EXPORT_MAX_ROWS. The export itself is audited (`audit.export`, with
 * the filters and row count — never the exported content).
 */
export async function exportAuditLogs(
  ctx: AuthContext,
  filters: Omit<AuditFilters, "page" | "pageSize"> = {},
): Promise<{ items: AuditLogItem[]; total: number; truncated: boolean }> {
  assertCan(ctx, "audit:read");
  const f = parse(auditFiltersSchema, { ...filters, page: undefined, pageSize: undefined });
  const where = auditWhere(ctx, f);
  const rows = await auditSelect()
    .leftJoin(users, and(eq(users.id, auditLogs.actorId), eq(users.organizationId, ctx.organizationId)))
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(AUDIT_EXPORT_MAX_ROWS);
  const [{ total }] = await getDb().select({ total: count() }).from(auditLogs).where(where);
  const refNames = await resolveReferenceNames(ctx, rows.map((r) => r.changes), 5_000);
  await recordAudit(ctx, {
    action: "audit.export",
    entityType: "organization",
    entityId: ctx.organizationId,
    summary: `Trilha de auditoria exportada em CSV (${rows.length.toLocaleString("pt-BR")} ${rows.length === 1 ? "registro" : "registros"})`,
    metadata: {
      filters: { action: f.action ?? null, entityType: f.entityType ?? null, actorId: f.actorId ?? null, from: f.from ?? null, to: f.to ?? null },
      rows: rows.length,
      total,
    },
  });
  return { items: rows.map((r) => ({ ...r, refNames })), total, truncated: total > rows.length };
}

/** Distinct action ids recorded in the organization (audit filter). */
export async function listAuditActions(ctx: AuthContext): Promise<string[]> {
  assertCan(ctx, "audit:read");
  const rows = await getDb()
    .selectDistinct({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, ctx.organizationId))
    .orderBy(asc(auditLogs.action))
    .limit(300);
  return rows.map((r) => r.action);
}

// ---------------------------------------------------------------------------
// Entity history (contract)
// ---------------------------------------------------------------------------

export type EntityHistoryItem = {
  id: string;
  action: string;
  summary: string;
  actorName: string | null;
  changes: Changes | null;
  createdAt: Date;
  /** Names of users/units/teams whose ids appear in `changes`. */
  refNames: Record<string, string>;
};

const ENTITY_READ_PERMISSION: Record<EntityRef["type"], Permission> = {
  legal_process: "process:read",
  occurrence: "occurrence:read",
  contract: "contract:read",
  document: "document:read",
  task: "task:read",
  deadline: "deadline:read",
  analysis: "analysis:read",
};

async function isEntityVisible(ctx: AuthContext, entity: EntityRef): Promise<boolean> {
  const db = getDb();
  const one = async (rows: Promise<{ id: string }[]>) => (await rows).length > 0;
  switch (entity.type) {
    case "legal_process":
      return one(db.select({ id: legalProcesses.id }).from(legalProcesses).where(and(eq(legalProcesses.id, entity.id), processWhere(ctx))).limit(1));
    case "occurrence":
      return one(db.select({ id: occurrences.id }).from(occurrences).where(and(eq(occurrences.id, entity.id), occurrenceWhere(ctx))).limit(1));
    case "contract":
      return one(db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, entity.id), contractWhere(ctx))).limit(1));
    case "document":
      return one(db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, entity.id), documentWhere(ctx))).limit(1));
    case "task":
      return one(db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, entity.id), taskWhere(ctx))).limit(1));
    case "deadline":
      return one(db.select({ id: deadlines.id }).from(deadlines).where(and(eq(deadlines.id, entity.id), deadlineWhere(ctx))).limit(1));
    case "analysis":
      return one(db.select({ id: aiAnalyses.id }).from(aiAnalyses).where(and(eq(aiAnalyses.id, entity.id), analysisWhere(ctx))).limit(1));
    default:
      return false;
  }
}

/**
 * Audit trail of one record, newest first (max 100). Returns an empty list
 * when the record does not exist or is not visible to `ctx` (never reveals
 * existence).
 */
export async function listEntityHistory(ctx: AuthContext, entity: EntityRef): Promise<EntityHistoryItem[]> {
  const permission = ENTITY_READ_PERMISSION[entity.type];
  if (!permission || !isGuid(entity.id) || !can(ctx, permission)) return [];
  if (!(await isEntityVisible(ctx, entity))) return [];

  const rows = await getDb()
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      summary: auditLogs.summary,
      actorName: users.name,
      changes: auditLogs.changes,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, and(eq(users.id, auditLogs.actorId), eq(users.organizationId, ctx.organizationId)))
    .where(
      and(
        eq(auditLogs.organizationId, ctx.organizationId),
        eq(auditLogs.entityType, entity.type),
        eq(auditLogs.entityId, entity.id),
      ),
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(100);
  const refNames = await resolveReferenceNames(ctx, rows.map((r) => r.changes));
  return rows.map((r) => ({ ...r, refNames }));
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export type AdminOverview = {
  users: { active: number; total: number } | null;
  teams: number | null;
  units: { active: number; total: number } | null;
  /** Only with `admin:organization`. */
  companies: { active: number; total: number } | null;
  lawFirms: { active: number; total: number } | null;
  recentAudit: AuditLogItem[] | null;
};

export async function getAdminOverview(ctx: AuthContext): Promise<AdminOverview> {
  const canUsers = can(ctx, "admin:users");
  const canAudit = can(ctx, "audit:read");
  const canOrg = can(ctx, "admin:organization");
  if (!canUsers && !canAudit && !canOrg) throw new ForbiddenError();
  const db = getDb();
  const org = ctx.organizationId;

  let usersStat: AdminOverview["users"] = null;
  let teamsStat: AdminOverview["teams"] = null;
  let unitsStat: AdminOverview["units"] = null;
  if (canUsers) {
    const [u] = await db
      .select({ total: count(), active: sql<number>`count(*) filter (where ${users.isActive})::int` })
      .from(users)
      .where(eq(users.organizationId, org));
    const [t] = await db.select({ total: count() }).from(teams).where(eq(teams.organizationId, org));
    const [un] = await db
      .select({ total: count(), active: sql<number>`count(*) filter (where ${units.isActive})::int` })
      .from(units)
      .where(eq(units.organizationId, org));
    usersStat = { total: u.total, active: Number(u.active) };
    teamsStat = t.total;
    unitsStat = { total: un.total, active: Number(un.active) };
  }
  let companiesStat: AdminOverview["companies"] = null;
  let lawFirmsStat: AdminOverview["lawFirms"] = null;
  if (canOrg) {
    const [c] = await db
      .select({ total: count(), active: sql<number>`count(*) filter (where ${companies.isActive})::int` })
      .from(companies)
      .where(eq(companies.organizationId, org));
    const [f] = await db
      .select({ total: count(), active: sql<number>`count(*) filter (where ${lawFirms.isActive})::int` })
      .from(lawFirms)
      .where(eq(lawFirms.organizationId, org));
    companiesStat = { total: c.total, active: Number(c.active) };
    lawFirmsStat = { total: f.total, active: Number(f.active) };
  }
  const recentAudit = canAudit ? (await listAuditLogs(ctx, { pageSize: 5 })).items : null;
  return {
    users: usersStat,
    teams: teamsStat,
    units: unitsStat,
    companies: companiesStat,
    lawFirms: lawFirmsStat,
    recentAudit,
  };
}
