import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Page, Paginated } from "@/domain/entities";
import { normalizePage } from "@/domain/entities";
import { isExternalCounsel } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  caseIntakes,
  companies,
  distributionRules,
  importBatches,
  lawFirms,
  legalProcesses,
  portfolioSnapshotItems,
  users,
} from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { diffChanges, recordAudit } from "@/server/services/audit";
import {
  companySchema,
  lawFirmSchema,
  organizationListFiltersSchema,
  type CompanyInput,
  type LawFirmInput,
  type OrganizationListFilters,
} from "./schemas";

/**
 * Companies (empresas do grupo) and external law firms (escritórios externos)
 * of the organization. Option lists are available to any authenticated user
 * (names only, used in filters and forms; external counsel only sees their own
 * firm); CRUD requires `admin:organization`.
 *
 * Companies and law firms are organization-level records: every query is
 * bound to `ctx.organizationId`. A referenced record is never deleted — it is
 * deactivated, so processes, imports, monthly closings and users keep their
 * history.
 */

export type CompanyOption = { id: string; name: string };
export type LawFirmOption = { id: string; name: string };

export async function listCompanyOptions(ctx: AuthContext): Promise<CompanyOption[]> {
  return getDb()
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.organizationId, ctx.organizationId), eq(companies.isActive, true)))
    .orderBy(asc(companies.name));
}

/**
 * Active law firms of the organization. External counsel only receives their
 * own firm (access.ts rule 10): the names of the other firms the organization
 * works with are not shown to a third party.
 */
export async function listLawFirmOptions(ctx: AuthContext): Promise<LawFirmOption[]> {
  if (isExternalCounsel(ctx) && !ctx.lawFirmId) return [];
  return getDb()
    .select({ id: lawFirms.id, name: lawFirms.name })
    .from(lawFirms)
    .where(
      and(
        eq(lawFirms.organizationId, ctx.organizationId),
        isExternalCounsel(ctx) && ctx.lawFirmId ? eq(lawFirms.id, ctx.lawFirmId) : eq(lawFirms.isActive, true),
      ),
    )
    .orderBy(asc(lawFirms.name));
}

/** Tenant check for a company id received in input (field error on `companyId`). */
export async function assertCompanyInOrg(ctx: AuthContext, companyId: string, db: DbOrTx = getDb()): Promise<void> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new ValidationError("Empresa inválida.", { companyId: ["Selecione uma empresa válida."] });
}

/** Tenant check for a law firm id received in input (field error on `lawFirmId`). */
export async function assertLawFirmInOrg(ctx: AuthContext, lawFirmId: string, db: DbOrTx = getDb()): Promise<void> {
  const [row] = await db
    .select({ id: lawFirms.id })
    .from(lawFirms)
    .where(and(eq(lawFirms.id, lawFirmId), eq(lawFirms.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new ValidationError("Escritório inválido.", { lawFirmId: ["Selecione um escritório válido."] });
}

/** Every company of the organization, including inactive ones (filters of admin screens, reports). */
export async function listAllCompanyOptions(ctx: AuthContext): Promise<{ id: string; name: string; isActive: boolean }[]> {
  return getDb()
    .select({ id: companies.id, name: companies.name, isActive: companies.isActive })
    .from(companies)
    .where(eq(companies.organizationId, ctx.organizationId))
    .orderBy(desc(companies.isActive), asc(companies.name));
}

/** Every law firm of the organization, including inactive ones (user edit form keeps the current one). */
export async function listAllLawFirmOptions(ctx: AuthContext): Promise<{ id: string; name: string; isActive: boolean }[]> {
  return getDb()
    .select({ id: lawFirms.id, name: lawFirms.name, isActive: lawFirms.isActive })
    .from(lawFirms)
    .where(eq(lawFirms.organizationId, ctx.organizationId))
    .orderBy(desc(lawFirms.isActive), asc(lawFirms.name));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(id: string): string {
  if (!GUID.test(id)) throw new NotFoundError();
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

/**
 * Active-portfolio processes per company / law firm (not deleted, status
 * active or suspended — RN-12: closed ones leave the portfolio). Grouped
 * query instead of a correlated subquery: drizzle renders columns of a
 * single-table select without the table name, which would break correlation.
 */
async function activeProcessCounts(
  ctx: AuthContext,
  column: typeof legalProcesses.companyId | typeof legalProcesses.lawFirmId,
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: column, n: count() })
    .from(legalProcesses)
    .where(
      and(
        eq(legalProcesses.organizationId, ctx.organizationId),
        inArray(column, ids),
        isNull(legalProcesses.deletedAt),
        inArray(legalProcesses.status, ["active", "suspended"]),
      ),
    )
    .groupBy(column);
  return new Map(rows.filter((r) => r.id).map((r) => [r.id as string, r.n]));
}

async function activeUserCounts(ctx: AuthContext, firmIds: string[]): Promise<Map<string, number>> {
  if (firmIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: users.lawFirmId, n: count() })
    .from(users)
    .where(and(eq(users.organizationId, ctx.organizationId), inArray(users.lawFirmId, firmIds), eq(users.isActive, true)))
    .groupBy(users.lawFirmId);
  return new Map(rows.filter((r) => r.id).map((r) => [r.id as string, r.n]));
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export type CompanyListItem = {
  id: string;
  name: string;
  document: string | null;
  isActive: boolean;
  /** Processes of the active portfolio (not deleted, status active/suspended). */
  activeProcessCount: number;
};

export type CompanyReferences = {
  /** Every process row that points to the company (any status, including deleted). */
  processes: number;
  importBatches: number;
  snapshotItems: number;
  distributionRules: number;
};

export type CompanyDetail = CompanyListItem & {
  createdAt: Date;
  updatedAt: Date;
  references: CompanyReferences;
};

function companySelect() {
  return getDb()
    .select({
      id: companies.id,
      name: companies.name,
      document: companies.document,
      isActive: companies.isActive,
      createdAt: companies.createdAt,
      updatedAt: companies.updatedAt,
    })
    .from(companies);
}

export async function listCompanies(
  ctx: AuthContext,
  filters: OrganizationListFilters & Page = {},
): Promise<Paginated<CompanyListItem>> {
  assertCan(ctx, "admin:organization");
  const f = parse(organizationListFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const conds: (SQL | undefined)[] = [eq(companies.organizationId, ctx.organizationId)];
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    conds.push(or(ilike(companies.name, like), ilike(companies.document, like)));
  }
  if (f.active !== undefined) conds.push(eq(companies.isActive, f.active));
  const where = and(...conds);
  const rows = await companySelect()
    .where(where)
    .orderBy(desc(companies.isActive), asc(companies.name), asc(companies.id))
    .limit(pageSize)
    .offset(offset);
  const [{ total }] = await getDb().select({ total: count() }).from(companies).where(where);
  const counts = await activeProcessCounts(ctx, legalProcesses.companyId, rows.map((r) => r.id));
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      document: r.document,
      isActive: r.isActive,
      activeProcessCount: counts.get(r.id) ?? 0,
    })),
    total,
    page,
    pageSize,
  };
}

async function companyReferences(db: DbOrTx, ctx: AuthContext, id: string): Promise<CompanyReferences> {
  const org = ctx.organizationId;
  const [[p], [i], [s], [d]] = await Promise.all([
    db
      .select({ n: count() })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.organizationId, org), eq(legalProcesses.companyId, id))),
    db
      .select({ n: count() })
      .from(importBatches)
      .where(and(eq(importBatches.organizationId, org), eq(importBatches.companyId, id))),
    db
      .select({ n: count() })
      .from(portfolioSnapshotItems)
      .where(and(eq(portfolioSnapshotItems.organizationId, org), eq(portfolioSnapshotItems.companyId, id))),
    db
      .select({ n: count() })
      .from(distributionRules)
      .where(
        and(
          eq(distributionRules.organizationId, org),
          sql`${distributionRules.criteria} @> jsonb_build_object('companyIds', jsonb_build_array(${id}::text))`,
        ),
      ),
  ]);
  return { processes: p.n, importBatches: i.n, snapshotItems: s.n, distributionRules: d.n };
}

export async function getCompany(ctx: AuthContext, id: string): Promise<CompanyDetail> {
  assertCan(ctx, "admin:organization");
  requireId(id);
  const [row] = await companySelect()
    .where(and(eq(companies.id, id), eq(companies.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  const [references, counts] = await Promise.all([
    companyReferences(getDb(), ctx, id),
    activeProcessCounts(ctx, legalProcesses.companyId, [id]),
  ]);
  return { ...row, activeProcessCount: counts.get(id) ?? 0, references };
}

async function assertCompanyFree(
  tx: DbOrTx,
  ctx: AuthContext,
  data: { name: string; document: string | null },
  exceptId?: string,
): Promise<void> {
  const notSelf = exceptId ? ne(companies.id, exceptId) : undefined;
  const [byName] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.organizationId, ctx.organizationId), sql`lower(${companies.name}) = lower(${data.name})`, notSelf))
    .limit(1);
  if (byName) throw new ConflictError("Já existe uma empresa com este nome.");
  if (data.document) {
    const [byDoc] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.organizationId, ctx.organizationId), eq(companies.document, data.document), notSelf))
      .limit(1);
    if (byDoc) throw new ValidationError(undefined, { document: ["Já existe uma empresa com este CNPJ."] });
  }
}

export async function createCompany(ctx: AuthContext, input: CompanyInput): Promise<{ id: string }> {
  assertCan(ctx, "admin:organization");
  const data = parse(companySchema, input);
  try {
    return await getDb().transaction(async (tx) => {
      await assertCompanyFree(tx, ctx, data);
      const isActive = data.isActive ?? true;
      const [created] = await tx
        .insert(companies)
        .values({ organizationId: ctx.organizationId, name: data.name, document: data.document, isActive })
        .returning({ id: companies.id });
      await recordAudit(
        ctx,
        {
          action: "company.create",
          entityType: "company",
          entityId: created.id,
          summary: `Empresa ${data.name} cadastrada`,
          changes: diffChanges(null, { name: data.name, document: data.document, isActive }),
        },
        tx,
      );
      return { id: created.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe uma empresa com este nome.");
    throw err;
  }
}

export async function updateCompany(ctx: AuthContext, id: string, input: CompanyInput): Promise<void> {
  assertCan(ctx, "admin:organization");
  requireId(id);
  const data = parse(companySchema, input);
  try {
    await getDb().transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(companies)
        .where(and(eq(companies.id, id), eq(companies.organizationId, ctx.organizationId)))
        .for("update");
      if (!before) throw new NotFoundError();
      await assertCompanyFree(tx, ctx, data, id);
      const after = { name: data.name, document: data.document, isActive: data.isActive ?? before.isActive };
      const changes = diffChanges(before, after);
      if (!changes) return;
      await tx
        .update(companies)
        .set(after)
        .where(and(eq(companies.id, id), eq(companies.organizationId, ctx.organizationId)));
      const summary = changes.isActive
        ? `Empresa ${after.name} ${after.isActive ? "reativada" : "desativada"}`
        : `Empresa ${after.name} alterada`;
      await recordAudit(ctx, { action: "company.update", entityType: "company", entityId: id, summary, changes }, tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe uma empresa com este nome.");
    throw err;
  }
}

/** Activates or deactivates a company keeping its other attributes. */
export async function setCompanyActive(ctx: AuthContext, id: string, active: boolean): Promise<void> {
  const company = await getCompany(ctx, id);
  await updateCompany(ctx, id, { name: company.name, document: company.document, isActive: active });
}

/**
 * Deletes a company that nothing references. When processes, imports,
 * monthly closings or distribution rules point to it, the company is
 * deactivated instead (history stays consistent).
 */
export async function deleteCompany(ctx: AuthContext, id: string): Promise<{ outcome: "deleted" | "deactivated" }> {
  assertCan(ctx, "admin:organization");
  requireId(id);
  return getDb().transaction(async (tx) => {
    const [company] = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.organizationId, ctx.organizationId)))
      .for("update");
    if (!company) throw new NotFoundError();
    const refs = await companyReferences(tx, ctx, id);
    const referenced = refs.processes + refs.importBatches + refs.snapshotItems + refs.distributionRules > 0;
    if (referenced) {
      if (company.isActive) {
        await tx
          .update(companies)
          .set({ isActive: false })
          .where(and(eq(companies.id, id), eq(companies.organizationId, ctx.organizationId)));
      }
      await recordAudit(
        ctx,
        {
          action: "company.deactivate",
          entityType: "company",
          entityId: id,
          summary: `Empresa ${company.name} desativada (possui vínculos e não pode ser excluída)`,
          changes: company.isActive ? { isActive: { from: true, to: false } } : null,
          metadata: refs,
        },
        tx,
      );
      return { outcome: "deactivated" as const };
    }
    await tx.delete(companies).where(and(eq(companies.id, id), eq(companies.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      { action: "company.delete", entityType: "company", entityId: id, summary: `Empresa ${company.name} excluída` },
      tx,
    );
    return { outcome: "deleted" as const };
  });
}

// ---------------------------------------------------------------------------
// Law firms
// ---------------------------------------------------------------------------

export type LawFirmListItem = {
  id: string;
  name: string;
  document: string | null;
  contactName: string | null;
  contactEmail: string | null;
  isActive: boolean;
  /** Processes of the active portfolio patrocinados pelo escritório. */
  activeProcessCount: number;
  /** Active external-counsel users of the firm. */
  activeUserCount: number;
};

export type LawFirmReferences = {
  processes: number;
  users: number;
  intakes: number;
  distributionRules: number;
};

export type LawFirmDetail = LawFirmListItem & {
  createdAt: Date;
  updatedAt: Date;
  references: LawFirmReferences;
  users: { id: string; name: string; email: string; isActive: boolean }[];
};

function lawFirmSelect() {
  return getDb()
    .select({
      id: lawFirms.id,
      name: lawFirms.name,
      document: lawFirms.document,
      contactName: lawFirms.contactName,
      contactEmail: lawFirms.contactEmail,
      isActive: lawFirms.isActive,
      createdAt: lawFirms.createdAt,
      updatedAt: lawFirms.updatedAt,
    })
    .from(lawFirms);
}

type LawFirmRow = Omit<LawFirmListItem, "activeProcessCount" | "activeUserCount">;

async function withLawFirmCounts(ctx: AuthContext, rows: LawFirmRow[]): Promise<LawFirmListItem[]> {
  const ids = rows.map((r) => r.id);
  const [processCounts, userCounts] = await Promise.all([
    activeProcessCounts(ctx, legalProcesses.lawFirmId, ids),
    activeUserCounts(ctx, ids),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    document: r.document,
    contactName: r.contactName,
    contactEmail: r.contactEmail,
    isActive: r.isActive,
    activeProcessCount: processCounts.get(r.id) ?? 0,
    activeUserCount: userCounts.get(r.id) ?? 0,
  }));
}

export async function listLawFirms(
  ctx: AuthContext,
  filters: OrganizationListFilters & Page = {},
): Promise<Paginated<LawFirmListItem>> {
  assertCan(ctx, "admin:organization");
  const f = parse(organizationListFiltersSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const conds: (SQL | undefined)[] = [eq(lawFirms.organizationId, ctx.organizationId)];
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    conds.push(or(ilike(lawFirms.name, like), ilike(lawFirms.document, like), ilike(lawFirms.contactName, like)));
  }
  if (f.active !== undefined) conds.push(eq(lawFirms.isActive, f.active));
  const where = and(...conds);
  const rows = await lawFirmSelect()
    .where(where)
    .orderBy(desc(lawFirms.isActive), asc(lawFirms.name), asc(lawFirms.id))
    .limit(pageSize)
    .offset(offset);
  const [{ total }] = await getDb().select({ total: count() }).from(lawFirms).where(where);
  return { items: await withLawFirmCounts(ctx, rows), total, page, pageSize };
}

async function lawFirmReferences(db: DbOrTx, ctx: AuthContext, id: string): Promise<LawFirmReferences> {
  const org = ctx.organizationId;
  const [[p], [u], [i], [d]] = await Promise.all([
    db
      .select({ n: count() })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.organizationId, org), eq(legalProcesses.lawFirmId, id))),
    db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.organizationId, org), eq(users.lawFirmId, id))),
    db
      .select({ n: count() })
      .from(caseIntakes)
      .where(and(eq(caseIntakes.organizationId, org), eq(caseIntakes.assignedLawFirmId, id))),
    db
      .select({ n: count() })
      .from(distributionRules)
      .where(
        and(
          eq(distributionRules.organizationId, org),
          sql`${distributionRules.assignment} @> jsonb_build_object('lawFirmId', ${id}::text)`,
        ),
      ),
  ]);
  return { processes: p.n, users: u.n, intakes: i.n, distributionRules: d.n };
}

export async function getLawFirm(ctx: AuthContext, id: string): Promise<LawFirmDetail> {
  assertCan(ctx, "admin:organization");
  requireId(id);
  const [row] = await lawFirmSelect()
    .where(and(eq(lawFirms.id, id), eq(lawFirms.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  const db = getDb();
  const [references, members, [item]] = await Promise.all([
    lawFirmReferences(db, ctx, id),
    db
      .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive })
      .from(users)
      .where(and(eq(users.organizationId, ctx.organizationId), eq(users.lawFirmId, id)))
      .orderBy(desc(users.isActive), asc(users.name)),
    withLawFirmCounts(ctx, [row]),
  ]);
  return { ...item, createdAt: row.createdAt, updatedAt: row.updatedAt, references, users: members };
}

async function assertLawFirmFree(
  tx: DbOrTx,
  ctx: AuthContext,
  data: { name: string; document: string | null },
  exceptId?: string,
): Promise<void> {
  const notSelf = exceptId ? ne(lawFirms.id, exceptId) : undefined;
  const [byName] = await tx
    .select({ id: lawFirms.id })
    .from(lawFirms)
    .where(and(eq(lawFirms.organizationId, ctx.organizationId), sql`lower(${lawFirms.name}) = lower(${data.name})`, notSelf))
    .limit(1);
  if (byName) throw new ConflictError("Já existe um escritório com este nome.");
  if (data.document) {
    const [byDoc] = await tx
      .select({ id: lawFirms.id })
      .from(lawFirms)
      .where(and(eq(lawFirms.organizationId, ctx.organizationId), eq(lawFirms.document, data.document), notSelf))
      .limit(1);
    if (byDoc) throw new ValidationError(undefined, { document: ["Já existe um escritório com este CNPJ."] });
  }
}

export async function createLawFirm(ctx: AuthContext, input: LawFirmInput): Promise<{ id: string }> {
  assertCan(ctx, "admin:organization");
  const data = parse(lawFirmSchema, input);
  try {
    return await getDb().transaction(async (tx) => {
      await assertLawFirmFree(tx, ctx, data);
      const values = {
        name: data.name,
        document: data.document,
        contactName: data.contactName,
        contactEmail: data.contactEmail,
        isActive: data.isActive ?? true,
      };
      const [created] = await tx
        .insert(lawFirms)
        .values({ organizationId: ctx.organizationId, ...values })
        .returning({ id: lawFirms.id });
      await recordAudit(
        ctx,
        {
          action: "law_firm.create",
          entityType: "law_firm",
          entityId: created.id,
          summary: `Escritório externo ${data.name} cadastrado`,
          changes: diffChanges(null, values),
        },
        tx,
      );
      return { id: created.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe um escritório com este nome.");
    throw err;
  }
}

export async function updateLawFirm(ctx: AuthContext, id: string, input: LawFirmInput): Promise<void> {
  assertCan(ctx, "admin:organization");
  requireId(id);
  const data = parse(lawFirmSchema, input);
  try {
    await getDb().transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(lawFirms)
        .where(and(eq(lawFirms.id, id), eq(lawFirms.organizationId, ctx.organizationId)))
        .for("update");
      if (!before) throw new NotFoundError();
      await assertLawFirmFree(tx, ctx, data, id);
      const after = {
        name: data.name,
        document: data.document,
        contactName: data.contactName,
        contactEmail: data.contactEmail,
        isActive: data.isActive ?? before.isActive,
      };
      const changes = diffChanges(before, after);
      if (!changes) return;
      await tx
        .update(lawFirms)
        .set(after)
        .where(and(eq(lawFirms.id, id), eq(lawFirms.organizationId, ctx.organizationId)));
      const summary = changes.isActive
        ? `Escritório externo ${after.name} ${after.isActive ? "reativado" : "desativado"}`
        : `Escritório externo ${after.name} alterado`;
      await recordAudit(ctx, { action: "law_firm.update", entityType: "law_firm", entityId: id, summary, changes }, tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Já existe um escritório com este nome.");
    throw err;
  }
}

/** Activates or deactivates a law firm keeping its other attributes. Its users and processes are not changed. */
export async function setLawFirmActive(ctx: AuthContext, id: string, active: boolean): Promise<void> {
  const firm = await getLawFirm(ctx, id);
  await updateLawFirm(ctx, id, {
    name: firm.name,
    document: firm.document,
    contactName: firm.contactName,
    contactEmail: firm.contactEmail,
    isActive: active,
  });
}

/**
 * Deletes a law firm that nothing references. When users, processes, intakes
 * or distribution rules point to it, the firm is deactivated instead.
 */
export async function deleteLawFirm(ctx: AuthContext, id: string): Promise<{ outcome: "deleted" | "deactivated" }> {
  assertCan(ctx, "admin:organization");
  requireId(id);
  return getDb().transaction(async (tx) => {
    const [firm] = await tx
      .select()
      .from(lawFirms)
      .where(and(eq(lawFirms.id, id), eq(lawFirms.organizationId, ctx.organizationId)))
      .for("update");
    if (!firm) throw new NotFoundError();
    const refs = await lawFirmReferences(tx, ctx, id);
    const referenced = refs.processes + refs.users + refs.intakes + refs.distributionRules > 0;
    if (referenced) {
      if (firm.isActive) {
        await tx
          .update(lawFirms)
          .set({ isActive: false })
          .where(and(eq(lawFirms.id, id), eq(lawFirms.organizationId, ctx.organizationId)));
      }
      await recordAudit(
        ctx,
        {
          action: "law_firm.deactivate",
          entityType: "law_firm",
          entityId: id,
          summary: `Escritório externo ${firm.name} desativado (possui vínculos e não pode ser excluído)`,
          changes: firm.isActive ? { isActive: { from: true, to: false } } : null,
          metadata: refs,
        },
        tx,
      );
      return { outcome: "deactivated" as const };
    }
    await tx.delete(lawFirms).where(and(eq(lawFirms.id, id), eq(lawFirms.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      { action: "law_firm.delete", entityType: "law_firm", entityId: id, summary: `Escritório externo ${firm.name} excluído` },
      tx,
    );
    return { outcome: "deleted" as const };
  });
}
