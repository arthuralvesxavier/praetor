import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cnpjChars, formatCnpj, isValidCnpj } from "@/modules/organization/schemas";
import {
  createCompany,
  createLawFirm,
  deleteCompany,
  deleteLawFirm,
  getCompany,
  getLawFirm,
  listCompanies,
  listCompanyOptions,
  listLawFirmOptions,
  listLawFirms,
  setCompanyActive,
  updateCompany,
  updateLawFirm,
} from "@/modules/organization/service";
import { auditLogs, companies, lawFirms, legalProcesses } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let fx: Fixture;

beforeAll(async () => {
  fx = await setupFixture("orgadm");
});

afterAll(async () => fx.teardown());

async function fieldErrorsOf(promise: Promise<unknown>): Promise<Record<string, string[]>> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as ValidationError).fieldErrors ?? {};
  }
  throw new Error("expected a ValidationError");
}

describe("CNPJ (pure)", () => {
  it("validates numeric and alphanumeric CNPJs by their check digits", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("11222333000181")).toBe(true);
    expect(isValidCnpj("12.ABC.345/01DE-35")).toBe(true); // alfanumérico (IN RFB 2.229/2024)
    expect(isValidCnpj("12.abc.345/01de-35")).toBe(true);
    expect(isValidCnpj("11.222.333/0001-82")).toBe(false);
    expect(isValidCnpj("11.111.111/1111-11")).toBe(false);
    expect(isValidCnpj("123")).toBe(false);
    expect(cnpjChars(" 11.222.333/0001-81 ")).toBe("11222333000181");
    expect(formatCnpj("12abc34501de35")).toBe("12.ABC.345/01DE-35");
  });
});

describe("companies", () => {
  it("requires admin:organization", async () => {
    const { manager, lawyer, auditor } = fx.ctx;
    for (const c of [manager, lawyer, auditor]) {
      await expect(createCompany(c, { name: "Empresa Proibida Ltda." })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listCompanies(c)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("creates with a normalized CNPJ, audits and enforces unique names per organization", async () => {
    const { admin, adminB } = fx.ctx;
    const { id } = await createCompany(admin, { name: "Transportes Fictícios S.A.", document: "11222333000181" });
    const [row] = await fx.db.select().from(companies).where(eq(companies.id, id));
    expect(row.organizationId).toBe(fx.orgA);
    expect(row.document).toBe("11.222.333/0001-81");
    const [audit] = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "company.create")));
    expect(audit.entityType).toBe("company");

    await expect(createCompany(admin, { name: "transportes fictícios s.a." })).rejects.toBeInstanceOf(ConflictError);
    // Same name in another organization is allowed.
    await createCompany(adminB, { name: "Transportes Fictícios S.A." });

    const errs = await fieldErrorsOf(createCompany(admin, { name: "Outra Empresa", document: "11.222.333/0001-82" }));
    expect(errs.document?.[0]).toMatch(/dígitos verificadores/);
    const dup = await fieldErrorsOf(createCompany(admin, { name: "Mesma Empresa Outro Nome", document: "11.222.333/0001-81" }));
    expect(dup.document?.[0]).toMatch(/CNPJ/);
    await createCompany(admin, { name: "Empresa Alfanumérica", document: "12.abc.345/01de-35" });
  });

  it("never exposes companies of another organization", async () => {
    const { admin, adminB } = fx.ctx;
    const listB = await listCompanies(adminB);
    expect(listB.items.map((c) => c.id)).not.toContain(fx.companyA);
    await expect(getCompany(adminB, fx.companyA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateCompany(adminB, fx.companyA, { name: "Invadida" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteCompany(adminB, fx.companyA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCompany(admin, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    expect((await listCompanyOptions(adminB)).map((c) => c.id)).not.toContain(fx.companyA);
  });

  it("deactivates instead of deleting when referenced; deletes when free", async () => {
    const { admin } = fx.ctx;
    await fx.db.insert(legalProcesses).values({
      organizationId: fx.orgA,
      number: "0000001-00.2026.5.10.0001",
      title: "Processo vinculado à empresa",
      court: "TRT10",
      area: "labor",
      phase: "knowledge",
      companyId: fx.companyA,
    });
    const detail = await getCompany(admin, fx.companyA);
    expect(detail.references.processes).toBe(1);
    expect(detail.activeProcessCount).toBe(1);

    expect(await deleteCompany(admin, fx.companyA)).toEqual({ outcome: "deactivated" });
    const [row] = await fx.db.select().from(companies).where(eq(companies.id, fx.companyA));
    expect(row.isActive).toBe(false);
    expect((await listCompanyOptions(admin)).map((c) => c.id)).not.toContain(fx.companyA);
    expect((await listCompanies(admin, { active: false })).items.map((c) => c.id)).toContain(fx.companyA);

    await setCompanyActive(admin, fx.companyA, true);
    expect((await listCompanyOptions(admin)).map((c) => c.id)).toContain(fx.companyA);

    const { id: free } = await createCompany(admin, { name: "Empresa Sem Vínculos" });
    expect(await deleteCompany(admin, free)).toEqual({ outcome: "deleted" });
    expect(await fx.db.select().from(companies).where(eq(companies.id, free))).toHaveLength(0);
    const actions = (await fx.db.select({ a: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, free))).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["company.create", "company.delete"]));
  });

  it("filters the list by name/CNPJ and situation", async () => {
    const { admin } = fx.ctx;
    const byDoc = await listCompanies(admin, { q: "11.222.333" });
    expect(byDoc.items.map((c) => c.name)).toEqual(["Transportes Fictícios S.A."]);
    const inactive = await listCompanies(admin, { active: false });
    expect(inactive.items.every((c) => !c.isActive)).toBe(true);
  });
});

describe("law firms", () => {
  it("creates with contact data and validates the contact e-mail", async () => {
    const { admin, manager } = fx.ctx;
    await expect(createLawFirm(manager, { name: "Escritório Proibido" })).rejects.toBeInstanceOf(ForbiddenError);
    const errs = await fieldErrorsOf(createLawFirm(admin, { name: "Escritório X", contactEmail: "não-é-email" }));
    expect(errs.contactEmail).toBeDefined();

    const { id } = await createLawFirm(admin, {
      name: "Souza & Lima Advogados (fictício)",
      document: "12.345.678/0001-95",
      contactName: "Dra. Fictícia",
      contactEmail: "Contato@Escritorio.TEST",
    });
    const [row] = await fx.db.select().from(lawFirms).where(eq(lawFirms.id, id));
    expect(row.contactEmail).toBe("contato@escritorio.test");
    expect(row.document).toBe("12.345.678/0001-95");

    await expect(createLawFirm(admin, { name: "SOUZA & LIMA ADVOGADOS (FICTÍCIO)" })).rejects.toBeInstanceOf(ConflictError);
    await updateLawFirm(admin, id, { name: "Souza & Lima Advogados (fictício)", contactName: "Outro contato" });
    const [audit] = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "law_firm.update")));
    expect(audit.changes).toMatchObject({ contactName: { from: "Dra. Fictícia", to: "Outro contato" } });

    expect(await deleteLawFirm(admin, id)).toEqual({ outcome: "deleted" });
  });

  it("keeps a firm with users and lists its external counsel; isolated by organization", async () => {
    const { admin, adminB, externalCounsel } = fx.ctx;
    const firm = await getLawFirm(admin, fx.lawFirmA);
    expect(firm.users.map((u) => u.id)).toContain(externalCounsel.userId);
    expect(firm.activeUserCount).toBe(1);

    expect(await deleteLawFirm(admin, fx.lawFirmA)).toEqual({ outcome: "deactivated" });
    expect((await listLawFirmOptions(admin)).map((f) => f.id)).not.toContain(fx.lawFirmA);

    await expect(getLawFirm(adminB, fx.lawFirmA)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listLawFirms(adminB)).items.map((f) => f.id)).not.toContain(fx.lawFirmA);
  });
});
