/**
 * Renderização no servidor das telas de relatórios jurídicos e da rota de
 * download do PDF (sessão simulada, serviços reais e PGlite).
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
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

import { NextRequest } from "next/server";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LegalReportPage from "@/app/(app)/relatorios-juridicos/[id]/page";
import LegalReportsPage from "@/app/(app)/relatorios-juridicos/page";
import LegalReportSettingsPage from "@/app/(app)/relatorios-juridicos/parametros/page";
import { GET as pdfRoute } from "@/app/api/legal-reports/[id]/pdf/route";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { ProcessScenarios } from "@/modules/legal-reports/components/process-scenarios";
import { addProcessScenario } from "@/modules/legal-reports/scenarios";
import { issueLegalReport } from "@/modules/legal-reports/service";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

let fx: Fixture;
let reportId: string;
let reference: string;
let processId: string;

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

type AnyPage = (props: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>;

async function render(page: AnyPage, params: Record<string, string> = {}, searchParams: Record<string, string> = {}): Promise<string> {
  const tree = await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree)));
}

function pdfRequest(id: string) {
  return pdfRoute(new NextRequest(`http://localhost:3000/api/legal-reports/${id}/pdf`), {
    params: Promise.resolve({ id }),
  } as never);
}

beforeAll(async () => {
  fx = await setupFixture("lrrender");
  processId = await makeProcess(fx.ctx.manager, { unitId: fx.unitSp });
  const { settings } = await loadOrganization(fx.orgA);
  const r = await issueLegalReport(
    fx.ctx.manager,
    {
      type: "process_report",
      title: "Relatório de teste de tela",
      subtitle: "Subtítulo de teste",
      scope: { processId },
      scopeLabel: "Processo de teste",
      baseDate: "2026-10-12",
      isSample: false,
      generator: "engine_sample",
      generatorVersion: 1,
      sections: [{ key: "s1", title: "Seção de tela" }],
      methodology: ["Nota de teste."],
      items: [
        {
          key: "a",
          section: "s1",
          content: "Tribunal: TJSP.",
          origin: "record",
          recordSource: {
            table: "legal_processes",
            field: "court",
            recordId: processId,
            label: "Cadastro do processo, campo Tribunal",
            recordedAt: "2026-10-01T12:00:00.000Z",
          },
        },
        { key: "b", section: "s1", content: "Cidade", origin: "gap" },
        { key: "c", section: "s1", content: "Conclusão de baixa confiança.", origin: "inference", derivedFrom: ["a"], confidence: 10 },
      ],
    },
    { settings },
  );
  reportId = r.id;
  reference = r.reference;
}, 240_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("telas", () => {
  it("lista e detalhe com selos, lacuna, pendências e ação de aprovar para o gestor", async () => {
    session.current = fx.ctx.manager;
    const list = await render(LegalReportsPage as unknown as AnyPage);
    expect(list).toContain("Relatórios jurídicos");
    expect(list).toContain(reference);
    expect(list).toContain("Documento de teste do motor");
    expect(list).toContain("Relatório do processo (R1)");

    const detail = await render(LegalReportPage as unknown as AnyPage, { id: reportId });
    expect(detail).toContain(reference);
    expect(detail).toContain("[DADO NÃO LOCALIZADO]");
    expect(detail).toContain("Pendências do relatório");
    expect(detail).toContain("Confiança 10 abaixo do limite de 70");
    expect(detail).toContain("Fontes consultadas");
    expect(detail).toContain("Baixar PDF");
    expect(detail).toContain("Aprovar");
    expect(detail).not.toMatch(/[\u2013\u2014]/);
  });

  it("diretoria vê o relatório, mas não aprova", async () => {
    session.current = fx.ctx.executive;
    const detail = await render(LegalReportPage as unknown as AnyPage, { id: reportId });
    expect(detail).toContain(reference);
    expect(detail).toContain("Seu perfil não aprova este tipo de relatório.");
    expect(detail).not.toContain("Aprovar</button>");
    // Perfil de leitura: sem gerar nova versão nem documento de teste.
    expect(detail).not.toContain("Gerar nova versão");
    const list = await render(LegalReportsPage as unknown as AnyPage);
    expect(list).toContain(reference);
    expect(list).not.toContain("Documento de teste do motor</");
  });

  it("relatório de outra organização: 404", async () => {
    session.current = fx.ctx.adminB;
    await expect(render(LegalReportPage as unknown as AnyPage, { id: reportId })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("parâmetros para o administrador", async () => {
    session.current = fx.ctx.admin;
    const html = await render(LegalReportSettingsPage as unknown as AnyPage);
    expect(html).toContain("Parâmetros dos relatórios jurídicos");
    expect(html).toContain("Muito alta");
    expect(html).toContain("Exercício regular de direitos");
  });
});

describe("cenários na ficha do processo", () => {
  it("lista os cenários e mostra o formulário só para quem lança valores", async () => {
    await addProcessScenario(fx.ctx.manager, processId, { description: "Cenário de tela (teste).", probabilityBand: "high" });
    const asManager = renderToStaticMarkup(
      createElement(Fragment, null, await resolveTree(createElement(ProcessScenarios, { ctx: fx.ctx.manager, processId }))),
    );
    expect(asManager).toContain("Cenário de tela (teste).");
    expect(asManager).toContain("60% a 80%");
    expect(asManager).toContain("Registrar cenário");
    const asExecutive = renderToStaticMarkup(
      createElement(Fragment, null, await resolveTree(createElement(ProcessScenarios, { ctx: fx.ctx.executive, processId }))),
    );
    expect(asExecutive).toContain("Cenário de tela (teste).");
    expect(asExecutive).not.toContain("Registrar cenário");
  });
});

describe("rota de download", () => {
  it("401 sem sessão, 404 para outra organização e para quem não vê o relatório, PDF para quem vê", async () => {
    session.current = null;
    expect((await pdfRequest(reportId)).status).toBe(401);
    session.current = fx.ctx.adminB;
    expect((await pdfRequest(reportId)).status).toBe(404);
    // Escritório externo lê relatórios jurídicos só dos processos do escritório: este não é (e é documento de teste do gestor).
    session.current = fx.ctx.externalCounsel;
    expect((await pdfRequest(reportId)).status).toBe(404);
    session.current = fx.ctx.manager;
    const res = await pdfRequest(reportId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(`${reference}-v1.pdf`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
