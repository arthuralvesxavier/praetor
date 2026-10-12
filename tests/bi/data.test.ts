/**
 * Governed BI layer (schema "bi"): values preserved as stored (null is not
 * zero), apurado and estimado in separate columns computed exactly like
 * @/domain/contingency, closed months only, counts of pending items, and the
 * access table (bi.acesso) equal to processWhere(ctx) for every role.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { netExposure, percentToBp, provisionFor } from "@/domain/contingency";
import { upsertAlert } from "@/modules/alerts/service";
import { biUserKey, refreshBiAccess } from "@/modules/bi/access";
import { syncBiLabels } from "@/modules/bi/labels";
import { BI_DB_ROLE, biSetupStatements } from "@/modules/bi/setup-sql";
import type { AuthContext } from "@/server/auth/context";
import { canViewScopedRecord, processWhere } from "@/server/auth/access";
import {
  biSettings,
  DEFAULT_ORGANIZATION_SETTINGS,
  deadlines,
  legalProcesses,
  organizations,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processGuarantees,
  processParties,
  processValuations,
  users,
} from "@/server/db/schema";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

let f: Fixture;
const p: Record<string, string> = {};

type Row = Record<string, unknown>;

async function query(q: ReturnType<typeof sql>): Promise<Row[]> {
  const res = (await f.db.execute(q)) as unknown as { rows: Row[] };
  return res.rows;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** Reais (numeric) -> cents, keeping null. */
const cents = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 100));

async function setValues(
  id: string,
  v: { liquidated?: number | null; riskBp?: number | null; loss?: "remote" | "possible" | "probable" | null },
) {
  await f.db
    .update(legalProcesses)
    .set({
      ...(v.liquidated !== undefined ? { liquidatedAmountCents: v.liquidated } : {}),
      ...(v.riskBp !== undefined ? { riskPercentageBp: v.riskBp } : {}),
      ...(v.loss !== undefined ? { lossProbability: v.loss } : {}),
    })
    .where(eq(legalProcesses.id, id));
}

async function guarantee(processId: string, amountCents: number, status: "linked" | "released_to_plaintiff" = "linked", deleted = false) {
  await f.db.insert(processGuarantees).values({
    organizationId: f.orgA,
    processId,
    kind: "judicial_deposit",
    amountCents,
    status,
    deletedAt: deleted ? new Date() : null,
  });
}

beforeAll(async () => {
  f = await setupFixture("bidata");
  const a = f.ctx.admin;
  await syncBiLabels();

  p.estimate = await makeProcess(a, { unitId: f.unitSp, claimAmountCents: 100_000_00, companyId: f.companyA });
  p.zero = await makeProcess(a, { unitId: f.unitSp, claimAmountCents: 200_000_00 });
  p.liquidated = await makeProcess(a, { unitId: f.unitRe });
  p.empty = await makeProcess(a, { unitId: f.unitSp });
  p.negative = await makeProcess(a, { unitId: f.unitSp });
  p.rounding = await makeProcess(a, { unitId: f.unitSp, claimAmountCents: 333_33 });
  p.confidential = await makeProcess(a, { unitId: f.unitSp, isConfidential: true });
  p.firm = await makeProcess(a, { unitId: f.unitRe, lawFirmId: f.lawFirmA, isConfidential: true });
  p.responsibleRe = await makeProcess(a, { unitId: f.unitRe, responsibleId: f.ctx.lawyer.userId });
  p.deleted = await makeProcess(a, { unitId: f.unitSp, claimAmountCents: 1_00 });
  p.orgB = await makeProcess(f.ctx.adminB, { unitId: f.unitB });

  await setValues(p.estimate, { riskBp: 5000, loss: "possible" });
  await guarantee(p.estimate, 10_000_00);
  await setValues(p.zero, { liquidated: 0, riskBp: 10_000, loss: "probable" });
  // No percentage mirror: the classification's percentage comes from the organization settings (100%).
  await setValues(p.liquidated, { liquidated: 80_000_00, riskBp: null, loss: "probable" });
  await guarantee(p.liquidated, 30_000_00);
  await guarantee(p.liquidated, 50_000_00, "released_to_plaintiff");
  await guarantee(p.liquidated, 1_000_00, "linked", true);
  await setValues(p.negative, { liquidated: 1_000_00, riskBp: 5000, loss: "possible" });
  await guarantee(p.negative, 5_000_00);
  await setValues(p.rounding, { riskBp: 3333, loss: "possible" });
  await f.db.update(legalProcesses).set({ deletedAt: new Date() }).where(eq(legalProcesses.id, p.deleted));

  await f.db.insert(processParties).values({
    organizationId: f.orgA,
    processId: p.estimate,
    name: "Fulano Fictício da Silva",
    role: "plaintiff",
    documentNumber: "123.456.789-09",
  });
}, 240_000);

afterAll(async () => {
  await f?.teardown();
});

describe("bi.processos", () => {
  it("keeps null as null (não apurado) and zero as zero", async () => {
    const rows = await query(sql`select * from bi.processos where process_id in (${p.empty}, ${p.zero}, ${p.estimate})`);
    const byId = new Map(rows.map((r) => [r.process_id as string, r]));
    const empty = byId.get(p.empty)!;
    expect(empty.valor_da_causa).toBeNull();
    expect(empty.valor_apurado).toBeNull();
    expect(empty.exposicao_apurada).toBeNull();
    expect(empty.exposicao_estimada).toBeNull();
    expect(empty.provisao_apurada).toBeNull();
    expect(empty.provisao_estimada).toBeNull();
    expect(empty.percentual).toBeNull();
    expect(num(empty.garantias_vinculadas)).toBe(0);

    const zero = byId.get(p.zero)!;
    expect(num(zero.valor_apurado)).toBe(0);
    expect(num(zero.exposicao_apurada)).toBe(0);
    expect(zero.exposicao_estimada).toBeNull();

    const estimate = byId.get(p.estimate)!;
    expect(estimate.valor_apurado).toBeNull();
    expect(cents(estimate.valor_da_causa)).toBe(100_000_00);
    expect(estimate.exposicao_apurada).toBeNull();
    expect(cents(estimate.exposicao_estimada)).toBe(40_000_00);
    expect(estimate.provisao_apurada).toBeNull();
    expect(cents(estimate.provisao_estimada)).toBe(50_000_00);
    expect(estimate.empresa).toBe("Empresa Fictícia A Ltda.");
    expect(estimate.fase_rotulo).toBeTruthy();
    expect(estimate.classificacao_rotulo).toBe("Possível");
  });

  it("computes exposure and provision exactly like @/domain/contingency", async () => {
    const ids = [p.estimate, p.zero, p.liquidated, p.empty, p.negative, p.rounding];
    const rows = await query(sql`select * from bi.processos where process_id in ${sql.raw(`('${ids.join("','")}')`)}`);
    expect(rows).toHaveLength(ids.length);
    const procs = await f.db.select().from(legalProcesses).where(inArray(legalProcesses.id, ids));
    const guarantees = await f.db
      .select()
      .from(processGuarantees)
      .where(inArray(processGuarantees.processId, ids));
    const pct = DEFAULT_ORGANIZATION_SETTINGS.contingency.riskPercentages;
    for (const proc of procs) {
      const linked = guarantees
        .filter((g) => g.processId === proc.id && g.status === "linked" && !g.deletedAt)
        .reduce((s, g) => s + g.amountCents, 0);
      const riskBp = proc.riskPercentageBp ?? (proc.lossProbability ? percentToBp(pct[proc.lossProbability]) : null);
      const input = {
        liquidatedCents: proc.liquidatedAmountCents,
        linkedGuaranteesCents: linked,
        claimCents: proc.claimAmountCents,
        riskPercentageBp: riskBp,
      };
      const exposure = netExposure(input);
      const provision = provisionFor(input);
      const row = rows.find((r) => r.process_id === proc.id)!;
      expect(cents(row.garantias_vinculadas)).toBe(linked);
      expect(cents(row.exposicao_apurada)).toBe(exposure.isEstimate ? null : exposure.exposureCents);
      expect(cents(row.exposicao_estimada)).toBe(exposure.isEstimate ? exposure.exposureCents : null);
      expect(cents(row.provisao_apurada)).toBe(provision.isEstimate ? null : provision.provisionCents);
      expect(cents(row.provisao_estimada)).toBe(provision.isEstimate ? provision.provisionCents : null);
      expect(num(row.percentual)).toBe(riskBp === null ? null : riskBp / 100);
    }
    const liquidated = rows.find((r) => r.process_id === p.liquidated)!;
    expect(cents(liquidated.exposicao_apurada)).toBe(50_000_00); // 80k − 30k linked (released and deleted ignored)
    expect(cents(rows.find((r) => r.process_id === p.negative)!.exposicao_apurada)).toBe(0); // never negative
    expect(cents(rows.find((r) => r.process_id === p.rounding)!.provisao_estimada)).toBe(111_10); // 33333 × 33,33% = 11109,89
  });

  it("lists every non-deleted process and no personal data or titles", async () => {
    const rows = await query(sql`select * from bi.processos where organization_id = ${f.orgA}`);
    const ids = rows.map((r) => r.process_id);
    expect(ids).not.toContain(p.deleted);
    expect(ids).toContain(p.confidential);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("Fulano");
    expect(text).not.toContain("123.456.789-09");
    expect(text).not.toContain("Processo de teste");
    expect(rows.find((r) => r.process_id === p.confidential)!.sigiloso).toBe(true);
  });
});

describe("bi.competencias", () => {
  it("returns only closed months, read as stored, with apurado and estimado apart", async () => {
    const [closed] = await f.db
      .insert(portfolioSnapshots)
      .values({
        organizationId: f.orgA,
        period: "2026-07",
        referenceDate: "2026-07-31",
        status: "closed",
        metrics: {} as never,
        params: { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 3, confidenceThreshold: 85 },
        closedAt: new Date(),
        closedById: f.ctx.accountant.userId,
      })
      .returning();
    const [preview] = await f.db
      .insert(portfolioSnapshots)
      .values({
        organizationId: f.orgA,
        period: "2026-08",
        referenceDate: "2026-08-31",
        status: "preview",
        metrics: {} as never,
        params: { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 3, confidenceThreshold: 85 },
      })
      .returning();
    const base = { organizationId: f.orgA, number: "0000001-00.2026.5.10.0001", guaranteesCents: 0 };
    await f.db.insert(portfolioSnapshotItems).values([
      { ...base, snapshotId: closed.id, processId: p.estimate, claimAmountCents: 100_000_00, liquidatedAmountCents: null, exposureCents: 123_45, exposureIsEstimate: true, provisionCents: 99_99, provisionIsEstimate: true, percentageBp: 5000, classification: "possible" },
      { ...base, snapshotId: closed.id, processId: p.zero, claimAmountCents: 200_000_00, liquidatedAmountCents: 0, exposureCents: 0, exposureIsEstimate: false, provisionCents: 0, provisionIsEstimate: false },
      { ...base, snapshotId: preview.id, processId: p.estimate, claimAmountCents: 1, liquidatedAmountCents: 1, exposureCents: 1, provisionCents: 1 },
    ]);

    const rows = await query(sql`select * from bi.competencias where organization_id = ${f.orgA} order by numero_cnj, process_id`);
    expect(rows.map((r) => r.competencia)).toEqual(["2026-07", "2026-07"]);
    const est = rows.find((r) => r.process_id === p.estimate)!;
    expect(est.valor_apurado).toBeNull();
    expect(est.exposicao_apurada).toBeNull();
    expect(cents(est.exposicao_estimada)).toBe(123_45);
    expect(cents(est.provisao_estimada)).toBe(99_99);
    expect(num(est.versao_regras)).toBe(3);
    const zero = rows.find((r) => r.process_id === p.zero)!;
    expect(num(zero.valor_apurado)).toBe(0);
    expect(num(zero.exposicao_apurada)).toBe(0);
    expect(zero.exposicao_estimada).toBeNull();
  });
});

describe("bi.valoracoes and bi.pendencias", () => {
  it("lists the value history with source, status and review, labeling simulations", async () => {
    await f.db.insert(processValuations).values({
      organizationId: f.orgA,
      processId: p.estimate,
      kind: "liquidated",
      amountCents: 45_000_00,
      baseDate: "2026-09-30",
      source: "simulation",
      status: "proposed",
      confidence: 70,
      reason: "Trecho com nome de parte que não pode aparecer",
    });
    const rows = await query(sql`select * from bi.valoracoes where process_id = ${p.estimate} order by registrado_em`);
    const claim = rows.find((r) => r.tipo === "claim")!;
    expect(claim.situacao).toBe("official");
    expect(cents(claim.valor)).toBe(100_000_00);
    const sim = rows.find((r) => r.tipo === "liquidated")!;
    expect(sim.simulacao).toBe(true);
    expect(sim.conferido).toBe(false);
    expect(sim.origem_rotulo).toBe("Extração simulada (demonstração)");
    expect(String(sim.situacao_rotulo)).not.toMatch(/[\u2013\u2014]/);
    expect(JSON.stringify(rows)).not.toContain("nome de parte");
  });

  it("counts open alerts by type, deadlines awaiting validation and proposed values per process", async () => {
    await upsertAlert({
      organizationId: f.orgA,
      type: "process_needs_verification",
      severity: "warning",
      title: "Verificar (fictício)",
      message: "Mensagem fictícia.",
      entityType: "legal_process",
      entityId: p.estimate,
      dedupeKey: `process_needs_verification:${p.estimate}`,
    });
    const [g] = await f.db.select({ id: processGuarantees.id }).from(processGuarantees).where(eq(processGuarantees.processId, p.estimate));
    await upsertAlert({
      organizationId: f.orgA,
      type: "guarantee_idle",
      severity: "warning",
      title: "Garantia parada (fictício)",
      message: "Mensagem fictícia.",
      entityType: "guarantee",
      entityId: g.id,
      dedupeKey: `guarantee_idle:${g.id}`,
    });
    await f.db.insert(deadlines).values({
      organizationId: f.orgA,
      title: "Prazo sugerido (fictício)",
      dueDate: "2026-12-01",
      kind: "procedural",
      origin: "ai_suggested",
      validationStatus: "pending_validation",
      processId: p.estimate,
    });
    const rows = await query(sql`select * from bi.pendencias where process_id = ${p.estimate} order by categoria, tipo`);
    const pick = (cat: string, tipo: string) => rows.find((r) => r.categoria === cat && r.tipo === tipo);
    expect(num(pick("alerta", "process_needs_verification")?.quantidade)).toBe(1);
    expect(num(pick("alerta", "guarantee_idle")?.quantidade)).toBe(1);
    expect(num(pick("prazo", "pending_validation")?.quantidade)).toBe(1);
    expect(num(pick("valor", "proposed")?.quantidade)).toBe(1);
    expect(pick("alerta", "guarantee_idle")?.rotulo).toBeTruthy();
  });
});

describe("bi.acesso", () => {
  async function expectedIds(ctx: AuthContext): Promise<string[]> {
    const rows = await f.db.select({ id: legalProcesses.id }).from(legalProcesses).where(processWhere(ctx));
    return rows.map((r) => r.id).sort();
  }
  async function accessIds(ctx: AuthContext): Promise<string[]> {
    const rows = await query(sql`select process_id from bi.acesso where user_key = ${biUserKey(ctx.userId!)}`);
    return rows.map((r) => r.process_id as string).sort();
  }

  it("matches processWhere for every role, including lawyer, external counsel and executive", async () => {
    const result = await refreshBiAccess(f.orgA);
    expect(result.users).toBe(10);
    for (const role of ["lawyer", "lawyerRe", "analyst", "externalCounsel", "executive", "accountant", "auditor", "admin", "manager"] as const) {
      const ctx = f.ctx[role];
      expect(await accessIds(ctx), role).toEqual(await expectedIds(ctx));
    }
    const lawyer = await accessIds(f.ctx.lawyer);
    expect(lawyer).toContain(p.responsibleRe); // responsible, other unit
    expect(lawyer).not.toContain(p.confidential);
    expect(lawyer).not.toContain(p.liquidated); // unit RE
    const firm = await accessIds(f.ctx.externalCounsel);
    expect(firm).toEqual([p.firm]); // only the firm's process (confidential included)
    const exec = await accessIds(f.ctx.executive);
    expect(exec).not.toContain(p.confidential);
    expect(exec).not.toContain(p.firm);
    expect(exec).toContain(p.liquidated);
    expect(exec).not.toContain(p.deleted);
    expect(exec).not.toContain(p.orgB);
  });

  it("drops inactive users, keeps organizations apart and is idempotent", async () => {
    const [before] = await f.db.select().from(biSettings).where(eq(biSettings.organizationId, f.orgA));
    const unchanged = await refreshBiAccess(f.orgA);
    expect(unchanged.changes).toBe(0);
    const [still] = await f.db.select().from(biSettings).where(eq(biSettings.organizationId, f.orgA));
    expect(still.accessChangedAt?.getTime()).toBe(before.accessChangedAt?.getTime());

    const analystReLinks = (await accessIds(f.ctx.analystRe)).length;
    expect(analystReLinks).toBeGreaterThan(0);
    await f.db.update(users).set({ isActive: false }).where(eq(users.id, f.ctx.analystRe.userId!));
    const first = await refreshBiAccess(f.orgA);
    expect(first.changes).toBe(analystReLinks); // only the deactivated user's links went away
    const second = await refreshBiAccess(f.orgA);
    expect(second.changes).toBe(0);
    expect(second.rows).toBe(first.rows);
    expect(second.users).toBe(9);
    expect(await accessIds(f.ctx.analystRe)).toEqual([]);
    const [after] = await f.db.select().from(biSettings).where(eq(biSettings.organizationId, f.orgA));
    expect(after.accessChangedAt).not.toBeNull();
    expect(after.accessChangedAt!.getTime()).toBeGreaterThanOrEqual(before.accessChangedAt?.getTime() ?? 0);
    await refreshBiAccess(f.orgB);
    expect(await accessIds(f.ctx.adminB)).toEqual([p.orgB]);
    const crossOrg = await query(
      sql`select count(*)::int as n from bi.acesso a join bi.processos p on p.process_id = a.process_id where a.organization_id <> p.organization_id`,
    );
    expect(num(crossOrg[0].n)).toBe(0);
    const [state] = await query(sql`select * from bi.atualizacao where organization_id = ${f.orgA}`);
    expect(state.acessos_atualizados_em).toBeTruthy();
    expect(state.acessos_alterados_em).toBeTruthy();
    expect(Object.keys(state).sort()).toEqual(["acessos_alterados_em", "acessos_atualizados_em", "organization_id"]);
    const rowsOfOrg = await f.db.select({ n: sql<number>`count(*)` }).from(legalProcesses).where(and(eq(legalProcesses.organizationId, f.orgA)));
    expect(Number(rowsOfOrg[0].n)).toBeGreaterThan(0);
  });
});

describe("RN-10: a process deleted after its month was closed", () => {
  it("stays in the closed month for whoever would see it, flagged and out of the active portfolio", async () => {
    // p.zero is in the closed 2026-07 competência (bi.competencias test above).
    await f.db.update(legalProcesses).set({ deletedAt: new Date() }).where(eq(legalProcesses.id, p.zero));
    const result = await refreshBiAccess(f.orgA);
    expect(result.changes).toBe(0); // same people still see it in the closed month

    const procs = await query(sql`select * from bi.processos where organization_id = ${f.orgA}`);
    const zero = procs.find((r) => r.process_id === p.zero)!;
    expect(zero.excluido).toBe(true);
    expect(zero.excluido_em).toBeTruthy();
    expect(zero.em_carteira_ativa).toBe(false);
    expect(procs.map((r) => r.process_id)).not.toContain(p.deleted); // deleted and in no closed month
    expect(procs.filter((r) => r.process_id !== p.zero).every((r) => r.excluido === false)).toBe(true);

    const [proc] = await f.db.select().from(legalProcesses).where(eq(legalProcesses.id, p.zero));
    for (const role of ["lawyer", "lawyerRe", "analyst", "externalCounsel", "executive", "accountant", "auditor", "admin", "manager"] as const) {
      const ctx = f.ctx[role];
      const current = (await f.db.select({ id: legalProcesses.id }).from(legalProcesses).where(processWhere(ctx))).map((r) => r.id);
      // Praetor's rule for closed months (snapshot-service loadVisibleItems): current visibility without the soft delete.
      const inClosedMonth = canViewScopedRecord(ctx, { ...proc, deletedAt: null }) ? [p.zero] : [];
      const rows = await query(sql`select process_id from bi.acesso where user_key = ${biUserKey(ctx.userId!)}`);
      expect(rows.map((r) => r.process_id as string).sort(), role).toEqual([...current, ...inClosedMonth].sort());
    }

    // The documented model (acesso -> processos -> competencias) keeps the item in the closed month.
    const chain = (userId: string) =>
      query(sql`
        select c.competencia, c.process_id
        from bi.acesso a
        join bi.processos p on p.process_id = a.process_id
        join bi.competencias c on c.process_id = p.process_id
        where a.user_key = ${biUserKey(userId)} and c.process_id = ${p.zero}
      `);
    expect((await chain(f.ctx.executive.userId!)).map((r) => r.competencia)).toEqual(["2026-07"]);
    expect((await chain(f.ctx.admin.userId!)).map((r) => r.competencia)).toEqual(["2026-07"]);
    expect(await chain(f.ctx.externalCounsel.userId!)).toEqual([]);
  });
});

describe("organization scope of the read-only database user", () => {
  it("praetor_bi reads only the rows of the organization registered for it", async () => {
    const [{ name }] = await query(sql`select current_database() as name`);
    const statements = biSetupStatements({
      roleExists: false,
      passwordLiteral: "'senha-de-teste-123'",
      databaseIdent: `"${String(name)}"`,
      organizationLiteral: `'${f.orgB}'`,
    });
    for (const statement of statements) await f.db.execute(sql.raw(statement));
    await refreshBiAccess(f.orgB);

    const asReader = async (q: ReturnType<typeof sql>): Promise<Row[]> => {
      await f.db.execute(sql.raw(`SET ROLE ${BI_DB_ROLE}`));
      try {
        return await query(q);
      } finally {
        await f.db.execute(sql.raw("RESET ROLE"));
      }
    };
    for (const view of ["processos", "competencias", "valoracoes", "pendencias", "acesso", "atualizacao"]) {
      const orgs = await asReader(sql.raw(`select distinct organization_id from bi.${view}`));
      expect(orgs.every((r) => r.organization_id === f.orgB), view).toBe(true);
    }
    expect((await asReader(sql`select process_id from bi.processos`)).map((r) => r.process_id)).toEqual([p.orgB]);
    expect((await asReader(sql`select process_id from bi.acesso`)).map((r) => r.process_id)).toEqual([p.orgB]);
    // Praetor itself (the owner) still reads every organization.
    const ownerA = await query(sql`select count(*)::int as n from bi.processos where organization_id = ${f.orgA}`);
    expect(num(ownerA[0].n)).toBeGreaterThan(0);
  });

  it("a function created by praetor_bi cannot see rows of another organization (security_barrier views)", async () => {
    // Runs after the test above: praetor_bi reads only orgB. The probe raises an error (which would carry
    // the value out) whenever the planner evaluates it on a row of another organization. Without
    // security_barrier the planner runs this cheap predicate before the organization filter of the view.
    const probes: Record<string, string> = {
      processos: "numero_cnj",
      competencias: "numero_cnj",
      valoracoes: "valoracao_id::text",
      pendencias: "tipo",
      acesso: "user_key",
      atualizacao: "acessos_atualizados_em::text",
    };
    await refreshBiAccess(f.orgA);
    for (const view of ["processos", "acesso"]) {
      const other = await query(sql.raw(`select count(*)::int as n from bi.${view} where organization_id <> '${f.orgB}'`));
      expect(num(other[0].n), `${view} has rows of another organization`).toBeGreaterThan(0);
    }

    await f.db.execute(sql.raw(`SET ROLE ${BI_DB_ROLE}`));
    try {
      // PostgreSQL grants TEMPORARY on the database to PUBLIC by default: the read-only user can create
      // session functions in pg_temp after turning its read-only default off.
      await f.db.execute(sql.raw("SET default_transaction_read_only = off"));
      await f.db.execute(
        sql.raw(`CREATE FUNCTION pg_temp.bi_probe(org uuid, v text) RETURNS boolean LANGUAGE plpgsql COST 0.0000001 AS $fn$
          BEGIN
            IF org IS DISTINCT FROM '${f.orgB}'::uuid THEN RAISE EXCEPTION 'LEAK org=% value=%', org, v; END IF;
            RETURN true;
          END $fn$`),
      );
      for (const [view, column] of Object.entries(probes)) {
        const seen = await query(sql.raw(`select organization_id from bi.${view} v where pg_temp.bi_probe(v.organization_id, v.${column})`));
        expect(seen.every((r) => r.organization_id === f.orgB), view).toBe(true);
        // Also inside a join condition, which is not pushed into a security_barrier view either.
        await query(
          sql.raw(
            `select 1 from bi.acesso a join bi.${view} v on pg_temp.bi_probe(v.organization_id, v.${column}) and a.organization_id = v.organization_id`,
          ),
        );
      }
    } finally {
      await f.db.execute(sql.raw("RESET ROLE"));
    }
  });

  it("every view of the bi schema is a security barrier (a migration that recreates a view must keep it)", async () => {
    const views = await query(sql`
      select c.relname as name, coalesce('security_barrier=true' = any(c.reloptions), false) as barrier
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'bi' and c.relkind = 'v'
      order by c.relname`);
    expect(views.length).toBeGreaterThanOrEqual(7);
    expect(views.filter((v) => v.barrier !== true).map((v) => v.name)).toEqual([]);
  });
});

describe("default risk percentages", () => {
  it("fall back to DEFAULT_ORGANIZATION_SETTINGS when the organization has none, and custom ones win", async () => {
    await f.db.update(organizations).set({ settings: {} as never }).where(eq(organizations.id, f.orgB));
    await f.db
      .update(legalProcesses)
      .set({ riskPercentageBp: null, claimAmountCents: 100_000_00, liquidatedAmountCents: null })
      .where(eq(legalProcesses.id, p.orgB));
    const pct = DEFAULT_ORGANIZATION_SETTINGS.contingency.riskPercentages;
    for (const loss of ["remote", "possible", "probable"] as const) {
      await f.db.update(legalProcesses).set({ lossProbability: loss }).where(eq(legalProcesses.id, p.orgB));
      const [row] = await query(sql`select percentual, provisao_estimada from bi.processos where process_id = ${p.orgB}`);
      expect(num(row.percentual), loss).toBe(pct[loss]);
      expect(cents(row.provisao_estimada), loss).toBe(Math.round((100_000_00 * percentToBp(pct[loss])) / 10_000));
    }
    await f.db
      .update(organizations)
      .set({ settings: { contingency: { riskPercentages: { possible: 40 } } } as never })
      .where(eq(organizations.id, f.orgB));
    await f.db.update(legalProcesses).set({ lossProbability: "possible" }).where(eq(legalProcesses.id, p.orgB));
    const [custom] = await query(sql`select percentual from bi.processos where process_id = ${p.orgB}`);
    expect(num(custom.percentual)).toBe(40);
  });
});
