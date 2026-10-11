import { and, asc, eq } from "drizzle-orm";
import type { AuthContext } from "@/server/auth/context";
import { getDb, type DbOrTx } from "@/server/db/client";
import { companies, lawFirms } from "@/server/db/schema";
import { ValidationError } from "@/server/lib/errors";

/**
 * Companies (empresas do grupo) and external law firms (escritórios externos)
 * of the organization. Option lists are available to any authenticated user
 * (names only, used in filters and forms); CRUD lives in the admin screens.
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

export async function listLawFirmOptions(ctx: AuthContext): Promise<LawFirmOption[]> {
  return getDb()
    .select({ id: lawFirms.id, name: lawFirms.name })
    .from(lawFirms)
    .where(and(eq(lawFirms.organizationId, ctx.organizationId), eq(lawFirms.isActive, true)))
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
