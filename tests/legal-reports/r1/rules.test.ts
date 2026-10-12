/**
 * R1 (Relatório de Processo): regras do produto que bloqueiam ou protegem a emissão.
 * (1) item sem origem bloqueia a emissão; (2) lacuna é "[DADO NÃO LOCALIZADO]", nunca
 * zero nem vazio (texto do PDF via unpdf); (3) valor da causa e valor apurado nunca são
 * somados; (4) R1 aprovado não muda: só é substituído por nova versão, com PDF e hash
 * da anterior preservados.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAP_MARKER, totalOf } from "@/domain/legal-reports";
import { formatMoneyCents } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { buildProcessReportDraft, PROCESS_REPORT_SECTIONS } from "@/modules/legal-reports/process-report";
import {
  approveLegalReport,
  generateProcessReport,
  getLegalReport,
  issueLegalReport,
  openLegalReportPdf,
} from "@/modules/legal-reports/service";
import { validateDraft } from "@/modules/legal-reports/validation";
import { legalProcesses, legalReportSequences, legalReports } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";
import { pageTexts } from "../pdf-inspect";
import { buildR1World, officialValue, type R1World } from "./world";

let fx: Fixture;
let world: R1World;

beforeAll(async () => {
  fx = await setupFixture("r1rules");
  world = await buildR1World(fx);
}, 600_000);

afterAll(async () => {
  await fx?.teardown();
});

/** "85.432,10" (só os algarismos do valor: o símbolo pode vir com espaço inseparável). */
function digits(cents: number): string {
  return formatMoneyCents(cents, "").replace(/[^\d.,]/g, "");
}

async function reportCount(): Promise<number> {
  const [r] = await fx.db.select({ n: count() }).from(legalReports).where(eq(legalReports.organizationId, fx.orgA));
  return Number(r.n);
}

describe("R1: item sem origem bloqueia a emissão", () => {
  it("o rascunho real do R1 com um item sem origem não é emitido: nada gravado, número não consumido", async () => {
    const { settings } = await loadOrganization(fx.orgA);
    const draft = await buildProcessReportDraft(fx.ctx.manager, { processId: world.processId }, settings);
    expect(validateDraft(draft)).toEqual([]);
    // Todo item do rascunho tem origem declarada.
    expect(draft.items.every((i) => !!i.origin)).toBe(true);
    const before = await reportCount();
    const broken = { ...draft, items: draft.items.map((i, n) => (n === 3 ? { ...i, origin: undefined } : i)) };
    const issues = validateDraft(broken);
    expect(issues.map((i) => i.code)).toContain("missing_origin");
    await expect(issueLegalReport(fx.ctx.manager, broken, { settings })).rejects.toBeInstanceOf(ValidationError);
    await expect(issueLegalReport(fx.ctx.manager, broken, { settings })).rejects.toThrow(/sem origem/);
    expect(await reportCount()).toBe(before);
    const seq = await fx.db
      .select()
      .from(legalReportSequences)
      .where(and(eq(legalReportSequences.organizationId, fx.orgA), eq(legalReportSequences.type, "process_report")));
    expect(seq).toHaveLength(0);
  }, 120_000);
});

describe("R1: lacuna nunca vira zero nem vazio", () => {
  it("processo sem pedidos, sem valores, sem partes: lacunas literais no relatório e no PDF", async () => {
    const bare = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId });
    const r = await generateProcessReport(fx.ctx.manager, { processId: bare });
    const { view } = await getLegalReport(fx.ctx.manager, r.id);
    expect(view.parameters.layout).toBe("process_report");
    expect(view.sections.map((s) => s.title)).toEqual(PROCESS_REPORT_SECTIONS.map((s) => s.title));
    const all = [...view.sections.flatMap((s) => s.items), ...view.pendingItems];
    const gaps = all.filter((i) => i.origin === "gap");
    expect(gaps.length).toBeGreaterThanOrEqual(5);
    for (const g of gaps) {
      expect(g.content.trim().length).toBeGreaterThan(0);
      expect(g.displayText).toContain(GAP_MARKER);
      expect(g.data).toBeNull();
    }
    const labels = gaps.map((g) => g.displayText);
    expect(labels).toContain(`Quadro de pedidos do processo (nenhum pedido confirmado): ${GAP_MARKER}`);
    expect(labels).toContain(`Valor apurado vigente: ${GAP_MARKER}`);
    expect(labels).toContain(`Valor da causa: ${GAP_MARKER}`);
    expect(labels).toContain(`Partes do processo: ${GAP_MARKER}`);

    const text = (await pageTexts((await openLegalReportPdf(fx.ctx.manager, r.id)).bytes)).join(" ");
    expect(text).toContain(`Valor apurado vigente: ${GAP_MARKER}`);
    expect(text).toContain(`Quadro de pedidos do processo (nenhum pedido confirmado): ${GAP_MARKER}`);
    expect(text).toContain(`valor apurado ${GAP_MARKER}`);
    // Um valor ausente nunca aparece como zero.
    expect(text).not.toContain("R$ 0,00");
    expect(text).toContain("Exposição líquida: não calculada");
    // A lista de dados não localizados das pendências repete cada lacuna.
    expect(text).toContain("DADOS NÃO LOCALIZADOS");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  }, 120_000);
});

describe("R1: valor da causa e valor apurado nunca são somados", () => {
  it("itens, tabelas e PDF trazem os dois valores separados e nenhum total que os combine", async () => {
    const claim = await officialValue(fx, world.processId, "claim");
    const liquidated = await officialValue(fx, world.processId, "liquidated");
    const sum = digits(claim + liquidated);
    const r = await generateProcessReport(fx.ctx.manager, { processId: world.processId });
    const { view } = await getLegalReport(fx.ctx.manager, r.id);
    const all = [...view.sections.flatMap((s) => s.items), ...view.pendingItems];
    const synthesis = all.find((i) => i.section === "synthesis" && i.content.startsWith("Valores vigentes"));
    expect(synthesis?.content).toContain(digits(claim));
    expect(synthesis?.content).toContain(digits(liquidated));
    expect(synthesis?.content).toContain("não são somadas");
    for (const item of all) {
      expect(item.content).not.toContain(sum);
      if (item.data?.kind === "table") {
        // Nenhuma tabela do R1 tem linha de totais misturando grandezas.
        expect(item.data.totals).toBeNull();
        expect(JSON.stringify(item.data)).not.toContain(sum);
      }
    }
    const claimsTable = all.find((i) => i.section === "claims" && i.data?.kind === "table");
    const headers = claimsTable?.data?.kind === "table" ? claimsTable.data.columns.map((c) => c.header) : [];
    expect(headers).toEqual(expect.arrayContaining(["Valor pleiteado (original)", "Valor apurado"]));
    const text = (await pageTexts((await openLegalReportPdf(fx.ctx.manager, r.id)).bytes)).join(" ");
    expect(text).not.toContain(sum);
    const flat = text.replace(/\u00a0/g, " ");
    expect(flat).toContain(`Valor da causa: R$ ${digits(claim)}`);
    expect(flat).toContain(`Valor apurado vigente: R$ ${digits(liquidated)}`);
    // A regra de domínio recusa somar grandezas diferentes.
    expect(() =>
      totalOf(
        [
          { quantity: "claim", cents: claim },
          { quantity: "liquidated", cents: liquidated },
        ],
        "claim",
      ),
    ).toThrow(/Grandezas diferentes/);
  }, 120_000);
});

describe("R1: aprovado é imutável; só nova versão", () => {
  it("aprovação pelo advogado responsável; nova versão substitui sem tocar no PDF e no hash da aprovada", async () => {
    const first = await generateProcessReport(fx.ctx.manager, { processId: world.processId });
    // O R1 do processo já existia (teste anterior): gerar de novo cria a versão seguinte da mesma referência.
    expect(first.version).toBeGreaterThanOrEqual(2);
    // O R1 cita o atestado (documento de saúde): a contabilidade nem vê o relatório; não aprova.
    await expect(approveLegalReport(fx.ctx.accountant, first.id)).rejects.toBeInstanceOf(NotFoundError);
    await approveLegalReport(fx.ctx.lawyer, first.id);
    const approved = await getLegalReport(fx.ctx.manager, first.id);
    expect(approved.view.status).toBe("approved");
    const approvedPdf = await openLegalReportPdf(fx.ctx.manager, first.id);
    expect(approvedPdf.sha256).toBe(approved.view.pdfSha256);
    const pages = await pageTexts(approvedPdf.bytes);
    expect(pages[0]).toContain(`Revisado por`.toLocaleUpperCase("pt-BR"));
    expect(pages[0]).toContain(fx.ctx.lawyer.name);
    for (const t of pages) expect(t).not.toContain("PENDENTE DE REVISÃO");

    // O banco recusa qualquer mudança de conteúdo do aprovado.
    await expect(fx.db.execute(sql`update legal_reports set title = 'x' where id = ${first.id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`update legal_reports set pdf_sha256 = 'x' where id = ${first.id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`update legal_report_items set content = 'x' where report_id = ${first.id}`)).rejects.toThrow();
    await expect(fx.db.execute(sql`delete from legal_reports where id = ${first.id}`)).rejects.toThrow();
    await expect(approveLegalReport(fx.ctx.manager, first.id)).rejects.toBeInstanceOf(ConflictError);

    // Advogado que deixou de ser o responsável: não vê mais o atestado citado, então nem enxerga este R1 (não gera versão nova).
    await fx.db.update(legalProcesses).set({ responsibleId: fx.ctx.manager.userId }).where(eq(legalProcesses.id, world.processId));
    await expect(generateProcessReport(fx.ctx.lawyer, { processId: world.processId })).rejects.toBeInstanceOf(ConflictError);
    await fx.db.update(legalProcesses).set({ responsibleId: fx.ctx.lawyer.userId }).where(eq(legalProcesses.id, world.processId));
    // O advogado responsável (que pode aprovar o R1) gera a nova versão.
    const next = await generateProcessReport(fx.ctx.lawyer, { processId: world.processId });
    expect(next.reference).toBe(first.reference);
    expect(next.version).toBe(first.version + 1);
    const old = await getLegalReport(fx.ctx.manager, first.id);
    expect(old.view.status).toBe("superseded");
    expect(old.view.supersededById).toBe(next.id);
    expect(old.view.pdfSha256).toBe(approved.view.pdfSha256);
    expect(old.view.approvedByName).toBe(fx.ctx.lawyer.name);
    const preserved = await openLegalReportPdf(fx.ctx.manager, first.id);
    expect(preserved.sha256).toBe(approved.view.pdfSha256);
    const fresh = await getLegalReport(fx.ctx.manager, next.id);
    expect(fresh.view.status).toBe("pending_review");
    expect(fresh.versions.map((v) => v.version)).toContain(first.version);
  }, 180_000);

  it("R1 aprovado sem documento sensível: advogado que não é o responsável gera R1, mas não substitui a versão aprovada", async () => {
    const pid = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.manager.userId, claimAmountCents: 2_000_000 });
    const r = await generateProcessReport(fx.ctx.manager, { processId: pid });
    await approveLegalReport(fx.ctx.manager, r.id);
    await expect(generateProcessReport(fx.ctx.lawyer, { processId: pid })).rejects.toBeInstanceOf(ForbiddenError);
    const [row] = await fx.db.select({ status: legalReports.status }).from(legalReports).where(eq(legalReports.id, r.id));
    expect(row.status).toBe("approved");
    // Responsável pelo processo: pode aprovar, então gera a nova versão.
    await fx.db.update(legalProcesses).set({ responsibleId: fx.ctx.lawyer.userId }).where(eq(legalProcesses.id, pid));
    const next = await generateProcessReport(fx.ctx.lawyer, { processId: pid });
    expect(next.version).toBe(2);
    expect(next.reference).toBe(r.reference);
  }, 120_000);

  it("contabilidade e diretoria não geram R1", async () => {
    await expect(generateProcessReport(fx.ctx.accountant, { processId: world.processId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(generateProcessReport(fx.ctx.executive, { processId: world.processId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(generateProcessReport(fx.ctx.auditor, { processId: world.processId })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
