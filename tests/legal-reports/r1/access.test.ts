/**
 * R1 (Relatório de Processo): permissões e visibilidade. Escritório externo
 * (consulta e baixa o R1 só dos processos do próprio escritório; não gera nem
 * aprova; o R1 do processo do escritório é gerado pelo sistema quando ele aprova a
 * análise preliminar), outra unidade, outra organização, documento sensível só
 * referenciado e só para perfis autorizados, conteúdo de módulos fora das
 * permissões de quem olha, e o cartão do R1 na ficha do processo.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
}));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(),
  requireActionContext: vi.fn(),
  getCurrentUser: vi.fn(),
}));

import { and, eq } from "drizzle-orm";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LegalReportPage from "@/app/(app)/relatorios-juridicos/[id]/page";
import LegalReportsPage from "@/app/(app)/relatorios-juridicos/page";
import { approveCaseBrief, requestCaseBrief } from "@/modules/briefs/service";
import { ProcessReportCard } from "@/modules/legal-reports/components/process-report-card";
import {
  approveLegalReport,
  currentProcessReport,
  generateProcessReport,
  getLegalReport,
  getProcessReportPanel,
  listLegalReports,
  openLegalReportPdf,
} from "@/modules/legal-reports/service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { auditLogs, legalReportItems } from "@/server/db/schema";
import { ForbiddenError, NotFoundError } from "@/server/lib/errors";
import { makeProcess, runJobs, setupFixture, type Fixture } from "../../helpers/fixtures";
import { pageTexts } from "../pdf-inspect";
import { buildR1World, type R1World } from "./world";

let fx: Fixture;
let world: R1World;
let reportId: string;

async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    const out = await (el.type as (p: unknown) => Promise<ReactNode>)(el.props);
    return resolveTree(out);
  }
  const props = { ...el.props };
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (key === "children" || isValidElement(v) || Array.isArray(v)) props[key] = await resolveTree(v as ReactNode);
  }
  return { ...el, props } as ReactElement;
}

async function renderCard(ctx: AuthContext): Promise<string> {
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(createElement(ProcessReportCard, { ctx, processId: world.processId }))));
}

type AnyPage = (props: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>;

async function renderPage(ctx: AuthContext, page: AnyPage, params: Record<string, string> = {}): Promise<string> {
  vi.mocked(requirePageContext).mockResolvedValue(ctx as never);
  const tree = await page({ params: Promise.resolve(params), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree)));
}

beforeAll(async () => {
  fx = await setupFixture("r1access");
  // Processo patrocinado pelo escritório externo da organização A.
  world = await buildR1World(fx, { lawFirmId: fx.lawFirmA });
  // O escritório externo revisa e aprova a análise preliminar do processo do escritório.
  await approveCaseBrief(fx.ctx.externalCounsel, world.briefId, { note: "Conferido pelo escritório (teste)." });
  await runJobs();
  const current = await currentProcessReport(fx.orgA, world.processId);
  reportId = current!.id;
}, 600_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("R1: permissões e visibilidade", () => {
  it("a aprovação da análise pelo escritório externo gera o R1 do processo do escritório (sistema)", async () => {
    const { view } = await getLegalReport(fx.ctx.manager, reportId);
    expect(view.status).toBe("pending_review");
    expect(view.generatedById).toBeNull();
    expect(view.processId).toBe(world.processId);
  });

  it("escritório externo: consulta e baixa o R1 dos processos do seu escritório, sem gerar nem aprovar", async () => {
    const ext = fx.ctx.externalCounsel;
    // Só a permissão dos relatórios jurídicos: relatórios gerenciais e Power BI (organização inteira) continuam fechados.
    expect(can(ext, "legal_report:read")).toBe(true);
    expect(can(ext, "report:read")).toBe(false);
    expect(can(ext, "report:generate")).toBe(false);
    const list = await listLegalReports(ext, { pageSize: 100 });
    expect(list.items.map((r) => r.id)).toEqual([reportId]);
    const { view, permissions } = await getLegalReport(ext, reportId);
    expect(view.processId).toBe(world.processId);
    expect(permissions.canApprove).toBe(false);
    expect(permissions.canRegenerate).toBe(false);
    const pdf = await openLegalReportPdf(ext, reportId);
    expect(pdf.sha256).toBe(view.pdfSha256);
    const [download] = await fx.db
      .select({ actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, reportId), eq(auditLogs.action, "legal_report.download"), eq(auditLogs.actorId, ext.userId!)));
    expect(download).toBeTruthy();
    await expect(generateProcessReport(ext, { processId: world.processId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveLegalReport(ext, reportId)).rejects.toBeInstanceOf(ForbiddenError);
    const card = await renderCard(ext);
    expect(card).toContain("Relatório de Processo (R1)");
    expect(card).toContain("Baixar PDF");
    expect(card).not.toContain("Gerar");
    const page = await renderPage(ext, LegalReportsPage as unknown as AnyPage);
    expect(page).not.toContain("Gerar R1");
  });

  it("escritório externo não vê o R1 de processo que não é do seu escritório", async () => {
    const ext = fx.ctx.externalCounsel;
    // Processo da unidade, sem escritório externo, com R1 gerado pelo gestor.
    const other = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 1_000_000 });
    const r = await generateProcessReport(fx.ctx.manager, { processId: other });
    await expect(getLegalReport(ext, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openLegalReportPdf(ext, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProcessReportPanel(ext, other)).rejects.toBeInstanceOf(NotFoundError);
    const list = await listLegalReports(ext, { pageSize: 100 });
    expect(list.items.some((i) => i.id === r.id)).toBe(false);
    expect(list.items.every((i) => i.processId === world.processId)).toBe(true);
    // O gestor vê os dois.
    await expect(getLegalReport(fx.ctx.manager, r.id)).resolves.toBeTruthy();
  });

  it("conteúdo fora das permissões de quem olha: R1 com análise preliminar ou prazos não aparece para quem não os vê", async () => {
    // Processo sem documento sensível, com análise preliminar e prazos lidos na geração.
    const pid = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId, claimAmountCents: 2_500_000 });
    await requestCaseBrief(fx.ctx.lawyer, pid, { inline: true });
    await runJobs();
    const r = await generateProcessReport(fx.ctx.manager, { processId: pid });
    const { view } = await getLegalReport(fx.ctx.manager, r.id);
    expect(view.parameters.requiredPermissions).toEqual(expect.arrayContaining(["brief:read", "contingency:read", "deadline:read", "process:read"]));
    // Diretoria (sem brief:read) e contabilidade (sem brief:read nem deadline:read) não veem; auditoria (com as duas) vê.
    await expect(getLegalReport(fx.ctx.executive, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLegalReport(fx.ctx.accountant, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openLegalReportPdf(fx.ctx.executive, r.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listLegalReports(fx.ctx.executive, { pageSize: 100 })).items.some((i) => i.id === r.id)).toBe(false);
    await expect(getLegalReport(fx.ctx.auditor, r.id)).resolves.toBeTruthy();
    const panel = await getProcessReportPanel(fx.ctx.executive, pid);
    expect(panel.current).toBeNull();
    expect(panel.hiddenCurrent).toBe(true);
  }, 120_000);

  it("outra unidade e outra organização não veem nem geram o R1", async () => {
    await expect(getLegalReport(fx.ctx.lawyerRe, reportId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(generateProcessReport(fx.ctx.lawyerRe, { processId: world.processId })).rejects.toBeInstanceOf(NotFoundError);
    const reList = await listLegalReports(fx.ctx.lawyerRe, { pageSize: 100 });
    expect(reList.items.some((r) => r.id === reportId)).toBe(false);
    await expect(getLegalReport(fx.ctx.adminB, reportId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openLegalReportPdf(fx.ctx.adminB, reportId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(generateProcessReport(fx.ctx.adminB, { processId: world.processId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProcessReportPanel(fx.ctx.adminB, world.processId)).rejects.toBeInstanceOf(NotFoundError);
    // Pelo número também não acha processo de outra organização.
    await expect(generateProcessReport(fx.ctx.adminB, { processNumber: world.number })).rejects.toThrow(/não encontrado/);
  });

  it("documento sensível: só referenciado (sem trecho gravado nem transcrito) e o R1 só aparece para quem vê o documento", async () => {
    const items = await fx.db
      .select()
      .from(legalReportItems)
      .where(and(eq(legalReportItems.reportId, reportId), eq(legalReportItems.documentId, world.sensitiveDocumentId)));
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(item.origin).toBe("documented");
      expect(item.excerpt).toBeNull();
      expect(item.content).toContain("documento de saúde (dado sensível): apenas referenciado, sem transcrição");
      expect(item.content).not.toMatch(/quinze dias/i);
      expect(JSON.stringify(item.data)).not.toMatch(/quinze dias/i);
    }
    const { view } = await getLegalReport(fx.ctx.manager, reportId);
    expect(view.sources.some((s) => s.sensitive && s.confirmed)).toBe(true);
    expect(view.parameters.methodology.join(" ")).toContain("1 sensível, apenas referenciado");
    const text = (await pageTexts((await openLegalReportPdf(fx.ctx.manager, reportId)).bytes)).join(" ");
    expect(world.sensitiveExcerpt.length).toBeGreaterThan(20);
    expect(text).not.toContain(world.sensitiveExcerpt.slice(0, 30));
    expect(text).not.toMatch(/quinze dias/i);
    expect(text).toContain("documento sensível: apenas referenciado, sem transcrição");
    // Diretoria e contabilidade veem a carteira, mas não o atestado: o R1 que o cita fica fora do alcance delas.
    await expect(getLegalReport(fx.ctx.executive, reportId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLegalReport(fx.ctx.accountant, reportId)).rejects.toBeInstanceOf(NotFoundError);
    // O advogado responsável e o gestor veem.
    await expect(getLegalReport(fx.ctx.lawyer, reportId)).resolves.toBeTruthy();
    await expect(getLegalReport(fx.ctx.admin, reportId)).resolves.toBeTruthy();
  });

  it("cartão do R1 na ficha: gestor vê o R1 e gera nova versão; diretoria não vê o R1 com documento sensível nem gera", async () => {
    const asManager = await renderCard(fx.ctx.manager);
    expect(asManager).toContain("Relatório de Processo (R1)");
    expect(asManager).toMatch(/R1-\d{4}-0001 · versão 1/);
    expect(asManager).toContain("Baixar PDF");
    expect(asManager).toContain("Gerar nova versão do R1");
    const asExecutive = await renderCard(fx.ctx.executive);
    expect(asExecutive).toContain("cita documentos ou traz conteúdo (análise preliminar, prazos ou valores) que seu");
    expect(asExecutive).not.toContain("Gerar");
    const panel = await getProcessReportPanel(fx.ctx.executive, world.processId);
    expect(panel.current).toBeNull();
    expect(panel.hiddenCurrent).toBe(true);
    expect(panel.canGenerate).toBe(false);
  });

  it("telas: detalhe do R1 na ordem do relatório e formulário \"Gerar R1\" na lista", async () => {
    const html = await renderPage(fx.ctx.manager, LegalReportPage as unknown as AnyPage, { id: reportId });
    for (const text of [
      "Capa de identificação",
      "Nota metodológica",
      "Síntese executiva",
      "Linha do tempo",
      "Quadro de pedidos e valores",
      "Garantias e exposição líquida",
      "Matriz de cenários",
      "Pontos de atenção e próximos atos",
      "Auditoria de fontes: verificado",
      "Auditoria de fontes: não confirmado",
      "Pendências do relatório",
      "Elaborado por",
      "Revisado por",
      "Os cenários são estimativas condicionais à data-base deste relatório e não constituem prognóstico de resultado.",
    ]) {
      expect(html).toContain(text);
    }
    expect(html.indexOf("Capa de identificação")).toBeLessThan(html.indexOf("Nota metodológica"));
    // A parte "Pendências do relatório" (seção 10) vem depois da auditoria de fontes (seção 9).
    expect(html.indexOf("Auditoria de fontes: verificado")).toBeLessThan(html.lastIndexOf("Pendências do relatório"));
    expect(html).not.toMatch(/[\u2013\u2014]/);
    const list = await renderPage(fx.ctx.manager, LegalReportsPage as unknown as AnyPage);
    expect(list).toContain("Gerar R1");
    expect(list).toContain("Relatório de Processo (R1)");
    const asExecutive = await renderPage(fx.ctx.executive, LegalReportsPage as unknown as AnyPage);
    expect(asExecutive).not.toContain("Gerar R1");
  });
});
