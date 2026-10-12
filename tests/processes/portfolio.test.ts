/**
 * v2 portfolio (carteira) rules: v2 fields with tenant checks, valor da causa
 * history (RF-09), RN-01 number normalization, list filters / summary / sort,
 * export (RN-02 / RN-03), RN-12 closure, verification flag, instances,
 * confidential access log (TE-10), visibility of the new roles and
 * organization isolation.
 */
import { and, asc, eq } from "drizzle-orm";
import readXlsxFile from "read-excel-file/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCnjCheckDigit } from "@/domain/cnj";
import { todayISO } from "@/lib/format";
import { buildProcessCsv, buildProcessXlsx, PROCESS_EXPORT_HEADERS } from "@/modules/processes/export";
import { processFiltersFromSearchParams } from "@/modules/processes/filters";
import { cnjCheck, normalizeProcessNumber, type ProcessSort } from "@/modules/processes/schemas";
import {
  addParty,
  addProcessEvent,
  addProcessInstance,
  closeProcess,
  exportProcesses,
  flagProcessForVerification,
  getProcess,
  getProcessFilterOptions,
  listProcesses,
  reactivateProcess,
  recordConfidentialProcessView,
  removeProcessInstance,
  resolveProcessVerification,
  summarizeProcesses,
  updateProcess,
  updateProcessInstance,
} from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import {
  auditLogs,
  companies,
  lawFirms,
  legalProcesses,
  processInstances,
  processValuations,
} from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

let f: Fixture;
let seq = 500;
/** Unique CNJ-shaped numbers (check digit not necessarily valid). */
const num = () => `${String(++seq).padStart(7, "0")}-00.2025.5.10.0001`;

function validCnj(sequence: string): string {
  const parts = { sequence, year: 2024, segment: "5", tribunal: "10", origin: "0801" };
  const dd = computeCnjCheckDigit(parts);
  return `${sequence}-${dd}.2024.5.10.0801`;
}

async function fieldErrorOf(promise: Promise<unknown>): Promise<Record<string, string[]>> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).fieldErrors ?? {};
}

async function audits(entityId: string, action: string) {
  return f.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action)))
    .orderBy(asc(auditLogs.createdAt));
}

async function setLiquidated(id: string, cents: number | null) {
  // Mirror maintained by the contingency module (written directly here, as the import commit may do).
  await f.db.update(legalProcesses).set({ liquidatedAmountCents: cents }).where(eq(legalProcesses.id, id));
}

beforeAll(async () => {
  f = await setupFixture("portfolio");
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

describe("v2 fields and tenant checks", () => {
  it("persists the v2 fields, creates the current instance link and resolves names", async () => {
    const id = await makeProcess(f.ctx.manager, {
      number: num(),
      court: "TRT10",
      area: "labor",
      companyId: f.companyA,
      lawFirmId: f.lawFirmA,
      instance: "first",
      processClass: "ATOrd",
      city: "Palmas",
      state: "to",
      phaseDetail: "Conhecimento — aguardando audiência (fictício)",
      filedAt: "2026-01-10",
      lastMovementAt: "2026-05-02",
    });
    const d = await getProcess(f.ctx.manager, id);
    expect(d).toMatchObject({
      companyId: f.companyA,
      companyName: "Empresa Fictícia A Ltda.",
      lawFirmId: f.lawFirmA,
      lawFirmName: "Escritório Fictício A Advogados",
      instance: "first",
      processClass: "ATOrd",
      city: "Palmas",
      state: "TO",
      phaseDetail: "Conhecimento — aguardando audiência (fictício)",
      lastMovementAt: "2026-05-02",
      needsVerification: false,
      closureReason: null,
    });
    expect(d.instances).toHaveLength(1);
    expect(d.instances[0]).toMatchObject({ instance: "first", court: "TRT10", isCurrent: true, origin: "manual", city: "Palmas" });
  });

  it("rejects companies and law firms of another organization", async () => {
    const [companyB] = await f.db.insert(companies).values({ organizationId: f.orgB, name: "Empresa B (fictícia)" }).returning();
    const [firmB] = await f.db.insert(lawFirms).values({ organizationId: f.orgB, name: "Escritório B (fictício)" }).returning();
    expect((await fieldErrorOf(makeProcess(f.ctx.manager, { companyId: companyB.id }))).companyId).toBeDefined();
    expect((await fieldErrorOf(makeProcess(f.ctx.manager, { lawFirmId: firmB.id }))).lawFirmId).toBeDefined();
    expect((await fieldErrorOf(makeProcess(f.ctx.adminB, { companyId: f.companyA }))).companyId).toBeDefined();

    const id = await makeProcess(f.ctx.manager, { number: num() });
    expect((await fieldErrorOf(updateProcess(f.ctx.manager, id, { companyId: companyB.id }))).companyId).toBeDefined();
    expect((await fieldErrorOf(updateProcess(f.ctx.manager, id, { lawFirmId: firmB.id }))).lawFirmId).toBeDefined();
  });

  it("ignores the contingency mirrors (provision, loss probability) on create and update", async () => {
    const id = await makeProcess(f.ctx.manager, {
      number: num(),
      provisionAmountCents: 9_999_00,
      lossProbability: "probable",
    });
    await updateProcess(f.ctx.manager, id, { provisionAmountCents: 1_00, lossProbability: "remote" });
    const d = await getProcess(f.ctx.manager, id);
    expect(d.provisionAmountCents).toBeNull();
    expect(d.lossProbability).toBeNull();
    expect(await audits(id, "legal_process.update")).toHaveLength(0);
  });

  it("normalizes 20-digit numbers to the CNJ format (RN-01) and verifies the check digit", async () => {
    expect(normalizeProcessNumber("00012345620245020001")).toBe("0001234-56.2024.5.02.0001");
    expect(normalizeProcessNumber(" 0001234 56 2024 5 02 0001 ")).toBe("0001234-56.2024.5.02.0001");
    expect(normalizeProcessNumber("Proc. adm. 12/2024")).toBe("Proc. adm. 12/2024");

    const valid = validCnj("0004321");
    const invalid = valid.replace(/-(\d{2})\./, (_m, dd: string) => `-${String((Number(dd) + 1) % 100).padStart(2, "0")}.`);
    expect(cnjCheck(valid)).toBe("valid");
    expect(cnjCheck(invalid)).toBe("invalid_check_digit");
    expect(cnjCheck("Proc. adm. 12/2024")).toBe("not_cnj");

    const id = await makeProcess(f.ctx.manager, { number: valid.replace(/\D/g, "") });
    const d = await getProcess(f.ctx.manager, id);
    expect(d.number).toBe(valid);
    expect(d.cnjCheck).toBe("valid");
    // Same CNJ typed with punctuation: duplicate.
    await expect(makeProcess(f.ctx.manager, { number: valid })).rejects.toBeInstanceOf(ConflictError);
    // Invalid check digit is a warning, never a blocker.
    const other = await makeProcess(f.ctx.manager, { number: invalid });
    expect((await getProcess(f.ctx.manager, other)).cnjCheck).toBe("invalid_check_digit");
  });
});

describe("valor da causa history (RF-09)", () => {
  // P0.6 (deferred finding 2): only an approver (contingency:approve) makes the claim official; see
  // tests/fixes/p06-ficha/claim-valuation.test.ts for the proposals of lawyers, external counsel and analysts.
  it("records an official claim valuation on create and supersedes it on change (approver)", async () => {
    const lawyer = f.ctx.manager;
    const id = await makeProcess(lawyer, { number: num(), unitId: f.unitSp, instance: "first", claimAmountCents: 100_000_00 });
    const byProcess = () =>
      f.db.select().from(processValuations).where(eq(processValuations.processId, id)).orderBy(asc(processValuations.createdAt));

    let vals = await byProcess();
    expect(vals).toHaveLength(1);
    expect(vals[0]).toMatchObject({
      organizationId: f.orgA,
      kind: "claim",
      amountCents: 100_000_00,
      status: "official",
      source: "manual",
      instance: "first",
      baseDate: todayISO(),
      createdById: lawyer.userId,
      reviewedById: lawyer.userId,
      isEstimate: false,
    });
    expect(vals[0].reviewedAt).toBeInstanceOf(Date);
    const create = await audits(id, "legal_process.create");
    expect(create[0].metadata).toMatchObject({ claimValuationId: vals[0].id });

    await updateProcess(lawyer, id, { claimAmountCents: 150_000_00 });
    vals = await byProcess();
    expect(vals.map((v) => [v.amountCents, v.status])).toEqual([
      [100_000_00, "superseded"],
      [150_000_00, "official"],
    ]);
    expect(vals[1].supersedesId).toBe(vals[0].id);
    const update = await audits(id, "legal_process.update");
    expect(update.at(-1)?.metadata).toMatchObject({ claimValuationId: vals[1].id, supersededValuationIds: [vals[0].id] });

    // Unrelated changes and same value: no new valuation.
    await updateProcess(lawyer, id, { title: "Título alterado (fictício)" });
    await updateProcess(lawyer, id, { claimAmountCents: 150_000_00 });
    expect(await byProcess()).toHaveLength(2);

    // Removing the value supersedes the official one (no zero is invented, RN-03) and dates the removal.
    await updateProcess(lawyer, id, { claimAmountCents: null });
    vals = await byProcess();
    expect(vals).toHaveLength(2);
    expect(vals.every((v) => v.status === "superseded")).toBe(true);
    expect(vals.map((v) => v.clearedOn)).toEqual([null, todayISO()]);
  });

  it("does not create valuations when no valor da causa is informed", async () => {
    const id = await makeProcess(f.ctx.manager, { number: num() });
    const vals = await f.db.select().from(processValuations).where(eq(processValuations.processId, id));
    expect(vals).toHaveLength(0);
  });
});

describe("portfolio list: filters, summary, sort and options", () => {
  let companyF: string;
  const p: Record<string, string> = {};

  beforeAll(async () => {
    const [c] = await f.db.insert(companies).values({ organizationId: f.orgA, name: "Empresa Filtros (fictícia)" }).returning();
    companyF = c.id;
    const m = f.ctx.manager;
    const common = { companyId: companyF, area: "labor" as const };
    p.p1 = await makeProcess(m, { ...common, number: "0000101-00.2025.5.10.0001", court: "TRT10", instance: "first", city: "Palmas", state: "TO", processClass: "ATOrd", claimAmountCents: 100_000_00, lawFirmId: f.lawFirmA });
    p.p2 = await makeProcess(m, { ...common, number: "0000102-00.2025.5.10.0001", court: "TRT10", instance: "second", city: "Palmas", state: "TO", processClass: "ROT", claimAmountCents: 50_000_00 });
    p.p3 = await makeProcess(m, { ...common, number: "0000103-00.2025.5.00.0000", court: "TST", instance: "superior", processClass: "AIRR" });
    p.p4 = await makeProcess(m, { ...common, number: "0000104-00.2025.5.10.0002", court: "TRT10", instance: "first", city: "Araguaína", state: "TO", processClass: "ATSum", claimAmountCents: 200_000_00 });
    p.p5 = await makeProcess(m, { ...common, number: "0000105-00.2025.5.02.0001", court: "TRT2", city: "São Paulo", state: "SP", claimAmountCents: 10_000_00, status: "suspended" });
    await setLiquidated(p.p1, 40_000_00);
    await setLiquidated(p.p3, 0); // zero is a value (paid off), not "não apurado"
    await setLiquidated(p.p4, 10_000_00);
    await flagProcessForVerification(m, p.p2, { note: "Conferir se saiu do acervo (fictício)." });
    await closeProcess(m, p.p4, { closureReason: "lost_patronage" });
    await addParty(m, p.p1, { name: "Autora Fictícia Um", role: "plaintiff", documentNumber: "123.456.789-09" });
    await addParty(m, p.p1, { name: "Autor Fictício Dois", role: "plaintiff" });
    await addParty(m, p.p1, { name: "=HYPERLINK(\"http://x\")", role: "defendant", isClient: true });
  });

  const ids = async (ctx: AuthContext, filters: Parameters<typeof listProcesses>[1]) =>
    (await listProcesses(ctx, { companyId: companyF, pageSize: 100, ...filters })).items.map((i) => i.id).sort();
  const sorted = (...keys: string[]) => keys.map((k) => p[k]).sort();

  it("filters by every v2 criterion", async () => {
    const m = f.ctx.manager;
    expect(await ids(m, {})).toEqual(sorted("p1", "p2", "p3", "p4", "p5"));
    expect(await ids(m, { portfolio: "active" })).toEqual(sorted("p1", "p2", "p3", "p5"));
    expect(await ids(m, { portfolio: "closed" })).toEqual(sorted("p4"));
    expect(await ids(m, { court: "TRT10" })).toEqual(sorted("p1", "p2", "p4"));
    expect(await ids(m, { instance: "first" })).toEqual(sorted("p1", "p4"));
    expect(await ids(m, { city: "Palmas" })).toEqual(sorted("p1", "p2"));
    expect(await ids(m, { state: "to" })).toEqual(sorted("p1", "p2", "p4"));
    expect(await ids(m, { processClass: "AIRR" })).toEqual(sorted("p3"));
    expect(await ids(m, { lawFirmId: f.lawFirmA })).toEqual(sorted("p1"));
    expect(await ids(m, { claimMinCents: 50_000_00 })).toEqual(sorted("p1", "p2", "p4"));
    expect(await ids(m, { claimMaxCents: 50_000_00 })).toEqual(sorted("p2", "p5"));
    expect(await ids(m, { liquidated: "with" })).toEqual(sorted("p1", "p3", "p4"));
    expect(await ids(m, { liquidated: "without" })).toEqual(sorted("p2", "p5"));
    expect(await ids(m, { needsVerification: true })).toEqual(sorted("p2"));
    expect(await ids(m, { q: "Autora Fictícia" })).toEqual(sorted("p1"));
  });

  it("sorts with nulls last", async () => {
    const order = async (sort: ProcessSort) =>
      (await listProcesses(f.ctx.manager, { companyId: companyF, pageSize: 100, sort })).items.map((i) => i.id);
    expect(await order("claim_desc")).toEqual([p.p4, p.p1, p.p2, p.p5, p.p3]);
    expect(await order("liquidated_asc")).toEqual([p.p3, p.p4, p.p1, p.p2, p.p5]);
    expect(await order("number_asc")).toEqual([p.p1, p.p2, p.p3, p.p4, p.p5]);
  });

  it("shows parties, flags and both values side by side in the list", async () => {
    const list = await listProcesses(f.ctx.manager, { companyId: companyF, pageSize: 100 });
    const p1 = list.items.find((i) => i.id === p.p1);
    expect(p1).toMatchObject({
      plaintiffName: "Autora Fictícia Um",
      plaintiffCount: 2,
      defendantName: "=HYPERLINK(\"http://x\")",
      defendantCount: 1,
      claimAmountCents: 100_000_00,
      liquidatedAmountCents: 40_000_00,
      companyName: "Empresa Filtros (fictícia)",
      lawFirmName: "Escritório Fictício A Advogados",
      instance: "first",
    });
    const p2 = list.items.find((i) => i.id === p.p2);
    expect(p2).toMatchObject({ liquidatedAmountCents: null, needsVerification: true, plaintiffName: null, plaintiffCount: 0 });
    const p4 = list.items.find((i) => i.id === p.p4);
    expect(p4).toMatchObject({ status: "closed", closureReason: "lost_patronage" });
  });

  it("summarizes the filtered set without adding causa and liquidado (RN-02/RN-03)", async () => {
    const s = await summarizeProcesses(f.ctx.manager, { companyId: companyF, portfolio: "active" });
    expect(s).toEqual({
      count: 4,
      claimCents: 160_000_00,
      claimUnknown: 1,
      liquidatedCents: 40_000_00,
      liquidatedUnknown: 2,
      needsVerification: 1,
    });
    const closed = await summarizeProcesses(f.ctx.manager, { companyId: companyF, portfolio: "closed" });
    expect(closed).toMatchObject({ count: 1, claimCents: 200_000_00, liquidatedCents: 10_000_00, liquidatedUnknown: 0 });
  });

  it("offers distinct values of the visible portfolio only", async () => {
    const options = await getProcessFilterOptions(f.ctx.manager);
    expect(options.courts).toEqual(expect.arrayContaining(["TRT10", "TST", "TRT2"]));
    expect(options.cities).toEqual(expect.arrayContaining(["Palmas", "Araguaína", "São Paulo"]));
    expect(options.states).toEqual(expect.arrayContaining(["TO", "SP"]));
    expect(options.classes).toEqual(expect.arrayContaining(["ATOrd", "ROT", "AIRR", "ATSum"]));
    const b = await getProcessFilterOptions(f.ctx.adminB);
    expect(b.courts).not.toContain("TRT10");
    expect(b.cities).not.toContain("Palmas");
  });

  it("maps URL params to filters (reais to cents, defaults, invalid values dropped)", () => {
    const parsed = processFiltersFromSearchParams({
      tribunal: "TRT10",
      instancia: "first",
      cidade: "Palmas",
      uf: "to",
      classe: "ATOrd",
      valor_min: "50.000",
      valor_max: "abc",
      liquidado: "sem",
      verificar: "1",
      carteira: "encerrada",
      ordem: "causa_maior",
      empresa: "not-a-uuid",
      pagina: "3",
    });
    expect(parsed).toMatchObject({
      court: "TRT10",
      instance: "first",
      city: "Palmas",
      state: "TO",
      processClass: "ATOrd",
      claimMinCents: 50_000_00,
      claimMaxCents: undefined,
      liquidated: "without",
      needsVerification: true,
      portfolio: "closed",
      sort: "claim_desc",
      companyId: undefined,
      page: 3,
    });
    expect(processFiltersFromSearchParams({})).toMatchObject({ portfolio: "active", sort: "updated_desc", page: 1 });
    // Dashboard deep links such as ?status=closed widen the view to every status.
    expect(processFiltersFromSearchParams({ status: "closed" }).portfolio).toBe("all");
    expect(processFiltersFromSearchParams({ status: "closed", carteira: "ativa" }).portfolio).toBe("active");
  });

  it("exports CSV with BOM, ';', decimal comma, empty cells for null and masked documents", async () => {
    const data = await exportProcesses(f.ctx.manager, { companyId: companyF, sort: "number_asc" }, "csv");
    expect(data.processes.map((r) => r.id)).toEqual([p.p1, p.p2, p.p3, p.p4, p.p5]);
    const csv = buildProcessCsv(data);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe(PROCESS_EXPORT_HEADERS.join(";"));
    expect(lines).toHaveLength(6);
    const col = (name: string) => PROCESS_EXPORT_HEADERS.indexOf(name);
    const row = (number: string) => lines.find((l) => l.includes(number))!.split(";");

    const r1 = row("0000101-00.2025.5.10.0001");
    expect(r1[col("Instância")]).toBe("1º Grau");
    expect(r1[col("Valor da Causa (R$)")]).toBe("100000,00");
    expect(r1[col("Valor Liquidado/Apurado (R$)")]).toBe("40000,00");
    expect(r1[col("Parte Autora")]).toBe("Autora Fictícia Um (e outros)");
    // Spreadsheet formula injection is neutralized (and quotes are escaped).
    expect(r1[col("Parte Ré")]).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(r1[col("CPF/CNPJ Parte Autora (mascarado)")]).toBe("***.456.789-**");
    expect(csv).not.toContain("12345678909");

    expect(row("0000102-00.2025.5.10.0001")[col("Valor Liquidado/Apurado (R$)")]).toBe(""); // null = não apurado
    const r3 = row("0000103-00.2025.5.00.0000");
    expect(r3[col("Valor Liquidado/Apurado (R$)")]).toBe("0,00"); // zero is not null
    expect(r3[col("Valor da Causa (R$)")]).toBe("");
    expect(row("0000104-00.2025.5.10.0002")[col("Situação")]).toBe("Encerrado: Saída do acervo / perda do patrocínio");

    const [audit] = (
      await f.db.select().from(auditLogs).where(eq(auditLogs.action, "legal_process.export")).orderBy(asc(auditLogs.createdAt))
    ).slice(-1);
    expect(audit).toMatchObject({ entityType: "legal_process", entityId: null, actorId: f.ctx.manager.userId });
    expect(audit.metadata).toMatchObject({ format: "csv", count: 5, filters: { companyId: companyF, sort: "number_asc" } });
  });

  it("does not record search terms in the export audit", async () => {
    await exportProcesses(f.ctx.manager, { companyId: companyF, q: "Autora Fictícia" }, "csv");
    const rows = await f.db.select().from(auditLogs).where(eq(auditLogs.action, "legal_process.export"));
    const last = rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)!;
    expect(last.metadata).toMatchObject({ count: 1, filters: { textSearch: true } });
    expect(JSON.stringify(last)).not.toContain("Autora Fictícia");
  });

  it("exports XLSX with the consolidated sheet and one sheet per instance", async () => {
    // P1 also went through the 2º grau (instance-level values differ from the process ones).
    await addProcessInstance(f.ctx.manager, p.p1, {
      instance: "second",
      court: "TRT10",
      courtDivision: "2ª Turma",
      processClass: "ROT",
      claimAmountCents: 90_000_00,
    });
    const data = await exportProcesses(f.ctx.manager, { companyId: companyF, sort: "number_asc" }, "xlsx");
    const buffer = await buildProcessXlsx(data);
    const sheets = await readXlsxFile(buffer);
    expect(sheets.map((s) => s.sheet)).toEqual(["Consolidado Geral", "1º Grau", "2º Grau", "3º Grau"]);

    const sheet = (name: string) => sheets.find((s) => s.sheet === name)!.data;
    const header = sheet("Consolidado Geral")[0];
    expect(header.slice(0, 3)).toEqual(["Instância", "TRT/Tribunal", "Nº do Processo"]);
    const c = (name: string) => header.indexOf(name);
    const consolidated = sheet("Consolidado Geral").slice(1);
    expect(consolidated).toHaveLength(5); // one row per CNJ, instances never add rows
    const x1 = consolidated.find((r) => r[c("Nº do Processo")] === "0000101-00.2025.5.10.0001")!;
    expect(x1[c("Valor da Causa (R$)")]).toBe(100000);
    expect(x1[c("Valor Liquidado/Apurado (R$)")]).toBe(40000);
    const x2 = consolidated.find((r) => r[c("Nº do Processo")] === "0000102-00.2025.5.10.0001")!;
    expect(x2[c("Valor Liquidado/Apurado (R$)")]).toBeNull();

    const numbersIn = (name: string) => sheet(name).slice(1).map((r) => r[c("Nº do Processo")]);
    expect(numbersIn("1º Grau")).toEqual(["0000101-00.2025.5.10.0001", "0000104-00.2025.5.10.0002"]);
    expect(numbersIn("2º Grau")).toEqual(["0000101-00.2025.5.10.0001", "0000102-00.2025.5.10.0001"]);
    expect(numbersIn("3º Grau")).toEqual(["0000103-00.2025.5.00.0000"]);
    const secondOfP1 = sheet("2º Grau").find((r) => r[c("Nº do Processo")] === "0000101-00.2025.5.10.0001")!;
    expect(secondOfP1[c("Valor da Causa (R$)")]).toBe(90000);
    expect(secondOfP1[c("Vara / Órgão Julgador / Turma")]).toBe("2ª Turma");
  });
});

describe("RN-12: active portfolio, closure and reactivation", () => {
  it("closes with a reason (lost patronage), keeps history and reactivates", async () => {
    const m = f.ctx.manager;
    const id = await makeProcess(m, { number: num(), filedAt: "2025-02-01" });
    await expect(closeProcess(m, id, { closureReason: "" as never })).rejects.toBeInstanceOf(ValidationError);
    expect((await fieldErrorOf(closeProcess(m, id, { closureReason: "lost_patronage", closedAt: "2099-01-01" }))).closedAt).toBeDefined();
    expect((await fieldErrorOf(closeProcess(m, id, { closureReason: "lost_patronage", closedAt: "2025-01-01" }))).closedAt).toBeDefined();

    await closeProcess(m, id, { closureReason: "lost_patronage", note: "Cliente transferiu o patrocínio (fictício)." });
    let d = await getProcess(m, id);
    expect(d).toMatchObject({ status: "closed", closureReason: "lost_patronage", closedAt: todayISO() });
    const [closeAudit] = await audits(id, "legal_process.close");
    expect(closeAudit.changes).toMatchObject({ status: { from: "active", to: "closed" }, closureReason: { from: null, to: "lost_patronage" } });
    expect(closeAudit.summary).toContain("perda do patrocínio");

    const active = await listProcesses(m, { portfolio: "active", pageSize: 100 });
    expect(active.items.map((i) => i.id)).not.toContain(id);
    const closed = await listProcesses(m, { portfolio: "closed", pageSize: 100 });
    expect(closed.items.map((i) => i.id)).toContain(id);

    await expect(closeProcess(m, id, { closureReason: "archived" })).rejects.toBeInstanceOf(ConflictError);
    await reactivateProcess(m, id, { note: "Patrocínio retomado (fictício)." });
    d = await getProcess(m, id);
    expect(d).toMatchObject({ status: "active", closureReason: null, closedAt: null });
    expect(await audits(id, "legal_process.reactivate")).toHaveLength(1);
    await expect(reactivateProcess(m, id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("requires a closure reason when the status leaves the active portfolio through an update", async () => {
    const m = f.ctx.manager;
    const id = await makeProcess(m, { number: num() });
    expect((await fieldErrorOf(updateProcess(m, id, { status: "archived" }))).closureReason).toBeDefined();
    expect((await fieldErrorOf(updateProcess(m, id, { closureReason: "archived" }))).closureReason).toBeDefined();
    await updateProcess(m, id, { status: "archived", closureReason: "archived" });
    expect(await getProcess(m, id)).toMatchObject({ status: "archived", closureReason: "archived", closedAt: todayISO() });
    // Back to the active portfolio: the reason is cleared.
    await updateProcess(m, id, { status: "active" });
    expect(await getProcess(m, id)).toMatchObject({ status: "active", closureReason: null, closedAt: null });
  });

  it("forbids lifecycle changes without process:write", async () => {
    const id = await makeProcess(f.ctx.manager, { number: num() });
    for (const ctx of [f.ctx.executive, f.ctx.accountant, f.ctx.auditor]) {
      await expect(closeProcess(ctx, id, { closureReason: "archived" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(flagProcessForVerification(ctx, id, { note: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("verification flag", () => {
  it("flags with a note and concludes, both audited", async () => {
    const m = f.ctx.manager;
    const id = await makeProcess(m, { number: num() });
    expect((await fieldErrorOf(flagProcessForVerification(m, id, { note: "  " }))).note).toBeDefined();
    await expect(resolveProcessVerification(m, id)).rejects.toBeInstanceOf(ConflictError);

    await flagProcessForVerification(m, id, { note: "Valores divergentes entre abas (fictício)." });
    expect(await getProcess(m, id)).toMatchObject({ needsVerification: true, verificationNote: "Valores divergentes entre abas (fictício)." });
    await resolveProcessVerification(m, id, { note: "Conferido com a planilha de cálculos." });
    expect(await getProcess(m, id)).toMatchObject({ needsVerification: false, verificationNote: null });
    expect(await audits(id, "legal_process.verification_flag")).toHaveLength(1);
    const [resolved] = await audits(id, "legal_process.verification_resolve");
    expect(resolved.summary).toContain("Conferido com a planilha");
  });
});

describe("instances (RN-01/RN-09)", () => {
  it("adds, updates (current instance) and removes links; imported links are preserved", async () => {
    const m = f.ctx.manager;
    const id = await makeProcess(m, { number: num(), court: "TRT10", instance: "first", unitId: f.unitSp });
    const { id: second } = await addProcessInstance(m, id, { instance: "second", court: "TRT10", courtDivision: "1ª Turma" });
    await expect(addProcessInstance(m, id, { instance: "second", court: "TRT10" })).rejects.toBeInstanceOf(ConflictError);
    expect((await fieldErrorOf(addProcessInstance(m, id, { instance: "superior", court: "" }))).court).toBeDefined();

    await updateProcessInstance(m, second, {
      instance: "second",
      court: "TRT10",
      courtDivision: "1ª Turma",
      claimAmountCents: 80_000_00,
      liquidatedAmountCents: null,
      isCurrent: true,
    });
    let d = await getProcess(m, id);
    expect(d.instance).toBe("second");
    expect(d.instances.map((i) => [i.instance, i.isCurrent])).toEqual([
      ["first", false],
      ["second", true],
    ]);
    expect(d.instances[1]).toMatchObject({ claimAmountCents: 80_000_00, liquidatedAmountCents: null });
    // Counted once in the portfolio regardless of the instances.
    expect((await summarizeProcesses(m, { q: d.number })).count).toBe(1);

    const [imported] = await f.db
      .insert(processInstances)
      .values({ organizationId: f.orgA, processId: id, instance: "superior", court: "TST", origin: "imported", sourceSheet: "3º Grau (TST)", sourceRow: 12 })
      .returning();
    d = await getProcess(m, id);
    expect(d.instances.find((i) => i.id === imported.id)).toMatchObject({ removable: false, sourceSheet: "3º Grau (TST)", sourceRow: 12 });
    await expect(removeProcessInstance(m, imported.id)).rejects.toBeInstanceOf(ConflictError);

    await removeProcessInstance(m, second);
    d = await getProcess(m, id);
    expect(d.instances.map((i) => i.instance)).toEqual(["first", "superior"]);
    const actions = (await f.db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["legal_process.instance_add", "legal_process.instance_update", "legal_process.instance_remove"]),
    );

    await expect(updateProcessInstance(f.ctx.adminB, imported.id, { instance: "superior", court: "X" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeProcessInstance(f.ctx.lawyerRe, imported.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("current instance changed in the process form", () => {
  it("creates the link of the new current instance and moves the current flag", async () => {
    const m = f.ctx.manager;
    const id = await makeProcess(m, { number: num(), court: "TRT10", instance: "first", city: "Gurupi", state: "TO" });
    await updateProcess(m, id, { instance: "second", courtDivision: "3ª Turma" });
    let d = await getProcess(m, id);
    expect(d.instances.map((i) => [i.instance, i.isCurrent])).toEqual([
      ["first", false],
      ["second", true],
    ]);
    expect(d.instances[1]).toMatchObject({ court: "TRT10", courtDivision: "3ª Turma", origin: "manual" });
    const [update] = await audits(id, "legal_process.update");
    expect(update.metadata).toMatchObject({ createdInstanceId: d.instances[1].id });

    // Back to the 1º grau: the existing link is reused, no duplicate.
    await updateProcess(m, id, { instance: "first" });
    d = await getProcess(m, id);
    expect(d.instances.map((i) => [i.instance, i.isCurrent])).toEqual([
      ["first", true],
      ["second", false],
    ]);
    // Instance cleared: no link is "current" any more.
    await updateProcess(m, id, { instance: null });
    d = await getProcess(m, id);
    expect(d.instances.every((i) => !i.isCurrent)).toBe(true);
  });
});

describe("parties and movements (v2 fields)", () => {
  it("accepts the liability nature only for defendants and the public prosecutor role", async () => {
    const m = f.ctx.manager;
    const id = await makeProcess(m, { number: num() });
    expect(
      (await fieldErrorOf(addParty(m, id, { name: "Autor (fictício)", role: "plaintiff", liabilityNature: "joint" }))).liabilityNature,
    ).toBeDefined();
    await addParty(m, id, { name: "Empresa Ré (fictícia)", role: "defendant", liabilityNature: "subsidiary", isClient: true });
    await addParty(m, id, { name: "Ministério Público do Trabalho", role: "public_prosecutor" });
    const d = await getProcess(m, id);
    expect(d.parties.map((x) => [x.role, x.liabilityNature])).toEqual(
      expect.arrayContaining([
        ["defendant", "subsidiary"],
        ["public_prosecutor", null],
      ]),
    );
  });

  it("stores instance and CNJ movement code informed by a person and updates the last movement", async () => {
    const m = f.ctx.manager;
    const id = await makeProcess(m, { number: num(), lastMovementAt: "2026-01-05" });
    expect((await fieldErrorOf(addProcessEvent(m, id, { occurredAt: "2026-02-01", type: "decision", title: "x", cnjMovementCode: 1.5 }))).cnjMovementCode).toBeDefined();
    await addProcessEvent(m, id, { occurredAt: "2026-02-01", type: "decision", title: "Sentença publicada", instance: "first", cnjMovementCode: 22 });
    await addProcessEvent(m, id, { occurredAt: "2026-03-01", type: "note", title: "Anotação interna" });
    const d = await getProcess(m, id);
    expect(d.events.find((e) => e.title === "Sentença publicada")).toMatchObject({ instance: "first", cnjMovementCode: 22 });
    // Internal notes are not court movements.
    expect(d.lastMovementAt).toBe("2026-02-01");
  });
});

describe("confidential access log (TE-10)", () => {
  it("records at most one view per user per process per hour", async () => {
    const id = await makeProcess(f.ctx.manager, { number: num(), isConfidential: true, lawFirmId: f.lawFirmA });
    const plain = await makeProcess(f.ctx.manager, { number: num() });

    expect(await recordConfidentialProcessView(f.ctx.manager, id)).toBe(true);
    expect(await recordConfidentialProcessView(f.ctx.manager, id)).toBe(false);
    expect(await recordConfidentialProcessView(f.ctx.admin, id)).toBe(true);
    expect(await recordConfidentialProcessView(f.ctx.externalCounsel, id)).toBe(true); // patron firm sees it
    expect(await recordConfidentialProcessView(f.ctx.manager, plain)).toBe(false);
    let views = await audits(id, "legal_process.view_confidential");
    expect(views.map((v) => v.actorId).sort()).toEqual(
      [f.ctx.manager.userId, f.ctx.admin.userId, f.ctx.externalCounsel.userId].sort(),
    );
    expect(await audits(plain, "legal_process.view_confidential")).toHaveLength(0);

    // After an hour a new view is recorded again.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await f.db
      .update(auditLogs)
      .set({ createdAt: twoHoursAgo })
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.actorId, f.ctx.manager.userId!)));
    expect(await recordConfidentialProcessView(f.ctx.manager, id)).toBe(true);
    views = await audits(id, "legal_process.view_confidential");
    expect(views).toHaveLength(4);

    // Users who cannot see the process get NotFound (nothing is logged).
    await expect(recordConfidentialProcessView(f.ctx.accountant, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordConfidentialProcessView(f.ctx.adminB, id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("visibility of the v2 roles", () => {
  let firmConfidential: string;
  let firmPlain: string;
  let noFirm: string;

  beforeAll(async () => {
    firmConfidential = await makeProcess(f.ctx.manager, { number: num(), lawFirmId: f.lawFirmA, isConfidential: true });
    firmPlain = await makeProcess(f.ctx.manager, { number: num(), lawFirmId: f.lawFirmA, unitId: f.unitRe });
    noFirm = await makeProcess(f.ctx.manager, { number: num(), unitId: f.unitSp });
  });

  it("external counsel only sees and edits processes of their law firm", async () => {
    const ec = f.ctx.externalCounsel;
    const list = await listProcesses(ec, { pageSize: 100 });
    const seen = list.items.map((i) => i.id);
    expect(seen).toEqual(expect.arrayContaining([firmConfidential, firmPlain]));
    expect(seen).not.toContain(noFirm);
    expect(list.items.every((i) => i.lawFirmId === f.lawFirmA)).toBe(true);
    await expect(getProcess(ec, noFirm)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateProcess(ec, noFirm, { title: "Invasão" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(closeProcess(ec, noFirm, { closureReason: "archived" })).rejects.toBeInstanceOf(NotFoundError);

    await updateProcess(ec, firmPlain, { phaseDetail: "Atualizado pelo escritório (fictício)", lawFirmId: f.lawFirmA });
    expect((await getProcess(ec, firmPlain)).phaseDetail).toBe("Atualizado pelo escritório (fictício)");
    // Cannot move the case out of the firm.
    expect((await fieldErrorOf(updateProcess(ec, firmPlain, { lawFirmId: null }))).lawFirmId).toBeDefined();

    // New processes are always of their firm.
    const own = await makeProcess(ec, { number: num() });
    expect((await getProcess(ec, own)).lawFirmId).toBe(f.lawFirmA);
    const [otherFirm] = await f.db.insert(lawFirms).values({ organizationId: f.orgA, name: "Outro Escritório (fictício)" }).returning();
    expect((await fieldErrorOf(makeProcess(ec, { number: num(), lawFirmId: otherFirm.id }))).lawFirmId).toBeDefined();

    const exported = await exportProcesses(ec, {}, "csv");
    expect(exported.processes.every((r) => r.lawFirmName === "Escritório Fictício A Advogados")).toBe(true);
    const summary = await summarizeProcesses(ec, {});
    expect(summary.count).toBe((await listProcesses(ec, { pageSize: 100 })).total);
    expect(summary.count).toBe(exported.processes.length);
  });

  it("accountant and auditor read the non-confidential portfolio and cannot write", async () => {
    for (const ctx of [f.ctx.accountant, f.ctx.auditor]) {
      const seen = (await listProcesses(ctx, { pageSize: 100 })).items.map((i) => i.id);
      expect(seen).toEqual(expect.arrayContaining([firmPlain, noFirm]));
      expect(seen).not.toContain(firmConfidential);
      await expect(getProcess(ctx, firmConfidential)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateProcess(ctx, noFirm, { title: "x" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addProcessInstance(ctx, noFirm, { instance: "second", court: "X" })).rejects.toBeInstanceOf(ForbiddenError);
      const exported = await exportProcesses(ctx, {}, "csv");
      expect(exported.processes.some((r) => r.id === firmConfidential)).toBe(false);
    }
  });

  it("isolates organizations in every new operation", async () => {
    const b = f.ctx.adminB;
    await expect(getProcess(b, noFirm)).rejects.toBeInstanceOf(NotFoundError);
    await expect(closeProcess(b, noFirm, { closureReason: "archived" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reactivateProcess(b, noFirm)).rejects.toBeInstanceOf(NotFoundError);
    await expect(flagProcessForVerification(b, noFirm, { note: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addProcessInstance(b, noFirm, { instance: "second", court: "X" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listProcesses(b, { pageSize: 100 })).items).toHaveLength(0);
    expect((await summarizeProcesses(b, {})).count).toBe(0);
    expect((await exportProcesses(b, {}, "csv")).processes).toHaveLength(0);
  });
});

describe("registration gaps filter (pendencia=)", () => {
  const g: Record<string, string> = {};
  /** Scopes every query of this block to its own processes. */
  const MARK = "PEND";

  beforeAll(async () => {
    const m = f.ctx.manager;
    const [company] = await f.db.insert(companies).values({ organizationId: f.orgA, name: "Empresa Pendências (fictícia)" }).returning();
    const base = { processClass: MARK, area: "labor" as const, court: "TRT10" };
    g.full = await makeProcess(m, { ...base, number: num(), instance: "first", city: "Palmas", unitId: f.unitSp, companyId: company.id });
    g.noInstance = await makeProcess(m, { ...base, number: num(), city: "Palmas", unitId: f.unitSp, companyId: company.id });
    g.blankCity = await makeProcess(m, { ...base, number: num(), instance: "second", unitId: f.unitRe, companyId: company.id });
    g.noUnitNoCompany = await makeProcess(m, { ...base, number: num(), instance: "first", city: "Recife", isConfidential: true });
    g.blankCourt = await makeProcess(m, { ...base, number: num(), instance: "first", city: "Recife", unitId: f.unitRe, companyId: company.id });
    g.closedNoInstance = await makeProcess(m, { ...base, number: num(), city: "Palmas", unitId: f.unitSp, companyId: company.id });
    // Blank text is a gap too (imports may store it); written directly, as the form trims it to null.
    await f.db.update(legalProcesses).set({ city: "   " }).where(eq(legalProcesses.id, g.blankCity));
    await f.db.update(legalProcesses).set({ court: " " }).where(eq(legalProcesses.id, g.blankCourt));
    await closeProcess(m, g.closedNoInstance, { closureReason: "archived" });
  });

  const ids = async (ctx: AuthContext, filters: Parameters<typeof listProcesses>[1]) =>
    (await listProcesses(ctx, { processClass: MARK, portfolio: "active", pageSize: 100, ...filters })).items.map((i) => i.id).sort();
  const sorted = (...keys: string[]) => keys.map((k) => g[k]).sort();

  it("returns exactly the processes whose field is empty (null or blank), within the active portfolio", async () => {
    const m = f.ctx.manager;
    expect(await ids(m, { missingField: "instance" })).toEqual(sorted("noInstance"));
    expect(await ids(m, { missingField: "instance", portfolio: "all" })).toEqual(sorted("noInstance", "closedNoInstance"));
    expect(await ids(m, { missingField: "city" })).toEqual(sorted("blankCity"));
    expect(await ids(m, { missingField: "court" })).toEqual(sorted("blankCourt"));
    expect(await ids(m, { missingField: "unit" })).toEqual(sorted("noUnitNoCompany"));
    expect(await ids(m, { missingField: "company" })).toEqual(sorted("noUnitNoCompany"));
    // The phase is required on every process: no gap is possible.
    expect(await ids(m, { missingField: "phase" })).toEqual([]);
    // Without the filter, every process of the block (the gaps are a subset, never extra rows).
    expect(await ids(m, {})).toEqual(sorted("full", "noInstance", "blankCity", "noUnitNoCompany", "blankCourt"));
    // Summary and export use the same WHERE.
    expect((await summarizeProcesses(m, { processClass: MARK, portfolio: "active", missingField: "city" })).count).toBe(1);
    const exported = await exportProcesses(m, { processClass: MARK, portfolio: "active", missingField: "instance" }, "csv");
    expect(exported.processes.map((r) => r.id)).toEqual([g.noInstance]);
  });

  it("keeps row visibility and organization isolation", async () => {
    // Confidential process without unit: hidden from the executive, visible to the manager.
    expect(await ids(f.ctx.executive, { missingField: "unit" })).toEqual([]);
    // Lawyer of unit RE: sees RE and unit-less processes only.
    expect(await ids(f.ctx.lawyerRe, { missingField: "city" })).toEqual(sorted("blankCity"));
    expect(await ids(f.ctx.lawyerRe, { missingField: "instance" })).toEqual([]);
    expect(await ids(f.ctx.adminB, { missingField: "court" })).toEqual([]);
  });

  it("maps the URL param (pt-BR values) and drops unknown ones", () => {
    expect(processFiltersFromSearchParams({ pendencia: "instancia" }).missingField).toBe("instance");
    expect(processFiltersFromSearchParams({ pendencia: "cidade" }).missingField).toBe("city");
    expect(processFiltersFromSearchParams({ pendencia: "tribunal" }).missingField).toBe("court");
    expect(processFiltersFromSearchParams({ pendencia: "empresa" }).missingField).toBe("company");
    expect(processFiltersFromSearchParams({ pendencia: "unidade" }).missingField).toBe("unit");
    expect(processFiltersFromSearchParams({ pendencia: "fase" }).missingField).toBe("phase");
    expect(processFiltersFromSearchParams({ pendencia: "instance" }).missingField).toBeUndefined();
    expect(processFiltersFromSearchParams({ pendencia: "x" }).missingField).toBeUndefined();
  });
});
