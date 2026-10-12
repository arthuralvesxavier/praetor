/**
 * Server-render smoke test of the import screens and route handlers (session
 * mocked, real services and PGlite). The spreadsheet reader is replaced by
 * synthetic sheets to keep it fast; the parser, plan and service run for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RawSheet } from "@/modules/imports/parser";

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
const sheets = vi.hoisted(() => ({ current: [] as RawSheet[] }));
vi.mock("@/modules/imports/xlsx", () => ({
  readWorkbook: vi.fn(async () => sheets.current),
  hasZipSignature: () => true,
  UnreadableWorkbookError: class UnreadableWorkbookError extends Error {},
}));

import { NextRequest } from "next/server";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ImportBatchPage from "@/app/(app)/importacoes/[id]/page";
import NewImportPage from "@/app/(app)/importacoes/nova/page";
import ImportBatchesPage from "@/app/(app)/importacoes/page";
import { GET as fileRoute } from "@/app/api/imports/[id]/file/route";
import { GET as issuesRoute } from "@/app/api/imports/[id]/issues/route";
import { POST as uploadRoute } from "@/app/api/imports/upload/route";
import { commitImportAction } from "@/modules/imports/actions";
import { companies } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import { DEMO_CLIENT, row, sheet, validCnj } from "./helpers";

let fx: Fixture;
let companyDemo: string;
let batchId: string;

/** Replaces async function components by their output (react-dom/server does not run them). */
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

async function uploadRequest(fields: Record<string, string>, origin = "http://localhost:3000"): Promise<NextRequest> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], "carteira-ficticia.xlsx"));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  return new NextRequest("http://localhost:3000/api/imports/upload", {
    method: "POST",
    body,
    headers: {
      origin,
      host: "localhost:3000",
      "content-type": encoded.headers.get("content-type")!,
      "content-length": String(body.byteLength),
    },
  });
}

beforeAll(async () => {
  fx = await setupFixture("impr");
  const [c] = await fx.db.insert(companies).values({ organizationId: fx.orgA, name: DEMO_CLIENT }).returning();
  companyDemo = c.id;
  const repeated = validCnj(901);
  sheets.current = [
    { name: "Dashboard", rows: [["PAINEL FICTÍCIO"], ["TOTAL GERAL"]] },
    sheet("Consolidado Geral", [
      row({ number: repeated, instance: "1º Grau", city: "Palmas - TO", claim: 1000.5, liquidated: null, phase: "Execução" }),
      row({ number: repeated, instance: "2º Grau", claim: 1000.5, phase: "Recurso decidido — baixou do 2º grau (à origem/TST)" }),
      row({ number: validCnj(902), city: "Cejusc Digital", claim: 0, liquidated: 0, phase: "PAGO/EXTINTO — arquivado def. 2026-06-25" }),
      ["TOTAL", null, null, null, null, null, null, null, null, 3000, 0],
      row({ number: "123", phase: "Conhecimento" }),
    ]),
    sheet("1º Grau", [row({ number: repeated, instance: "1º Grau", claim: 2000, liquidated: 15, phase: "Execução" })]),
    { name: "Atualização Geral (29-07-2026)", rows: [["Registro narrativo fictício"]] },
  ];
});

afterAll(async () => {
  await fx?.teardown();
});

describe("upload route", () => {
  it("authenticates, checks permission and origin, then analyzes", async () => {
    session.current = null;
    expect((await uploadRoute(await uploadRequest({ companyId: companyDemo }))).status).toBe(401);
    session.current = fx.ctx.lawyer;
    expect((await uploadRoute(await uploadRequest({ companyId: companyDemo }))).status).toBe(403);
    session.current = fx.ctx.admin;
    expect((await uploadRoute(await uploadRequest({ companyId: companyDemo }, "https://evil.example"))).status).toBe(403);
    const missingCompany = await uploadRoute(await uploadRequest({}));
    expect(missingCompany.status).toBe(400);
    expect((await missingCompany.json()).fieldErrors.companyId).toBeDefined();

    const res = await uploadRoute(await uploadRequest({ companyId: companyDemo, distributeAfterCommit: "on" }));
    expect(res.status).toBe(201);
    batchId = (await res.json()).batchId;
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("pages", () => {
  it("renders the list and the new import form", async () => {
    session.current = fx.ctx.manager;
    const list = await render(ImportBatchesPage as unknown as AnyPage);
    expect(list).toContain("Importação de planilhas");
    expect(list).toContain("carteira-ficticia.xlsx");
    expect(list).toContain("Analisada, aguardando confirmação");
    const form = await render(NewImportPage as unknown as AnyPage);
    expect(form).toContain("Planilha da carteira");
    expect(form).toContain(DEMO_CLIENT);
    expect(form).toContain("Data-base dos valores");
    expect(form).toContain("Analisar planilha");
  });

  it("renders every tab of an analyzed batch", async () => {
    session.current = fx.ctx.admin;
    const page = ImportBatchPage as unknown as AnyPage;
    const summary = await render(page, { id: batchId });
    expect(summary).toContain("Análise concluída: nada foi gravado na carteira ainda");
    expect(summary).toContain("Confirmar importação");
    expect(summary).toContain("Processos detectados");
    expect(summary).toContain("Abas detectadas");
    expect(summary).toContain("Base consolidada (oficial)");
    expect(summary).toContain("Mapeamento de colunas");
    expect(summary).toContain("Linha de total ignorada");
    expect(summary).toContain("29/07/2026");

    const rows = await render(page, { id: batchId }, { aba: "linhas" });
    expect(rows).toContain("Valor liquidado");
    expect(rows).toContain("Não apurado");
    expect(rows).toContain("Com erro (não importada)");
    const errorsOnly = await render(page, { id: batchId }, { aba: "linhas", nivel: "error" });
    expect(errorsOnly).toContain("Com erro (não importada)");
    expect(errorsOnly).toMatch(/Exibindo <span[^>]*>1<\/span> a <span[^>]*>1<\/span> de <span[^>]*>1<\/span>/);

    const issues = await render(page, { id: batchId }, { aba: "inconsistencias", codigo: "city_non_geographic" });
    expect(issues).toContain("Exportar CSV");
    expect(issues).toContain("não é um município");

    // Audited downloads are plain browser downloads (`download`): a next/link click would request the route twice.
    const fileLink = summary.match(new RegExp(`<a[^>]*href="/api/imports/${batchId}/file"[^>]*>`))?.[0];
    expect(fileLink).toContain('download=""');
    const csvLink = issues.match(new RegExp(`<a[^>]*href="/api/imports/${batchId}/issues[^"]*"[^>]*>`))?.[0];
    expect(csvLink).toContain('download=""');

    const divergences = await render(page, { id: batchId }, { aba: "divergencias" });
    expect(divergences).toContain("A aba consolidada é a base oficial");
    expect(divergences).toContain("Será proposto para conferência");
  });

  it("is unavailable to other roles and other organizations", async () => {
    session.current = fx.ctx.adminB;
    await expect(render(ImportBatchPage as unknown as AnyPage, { id: batchId })).rejects.toThrow(/404/);
  });

  it("confirms through the server action and shows the committed state", async () => {
    session.current = fx.ctx.admin;
    const fd = new FormData();
    fd.set("id", batchId);
    fd.set("baseDate", "2026-07-29");
    await expect(commitImportAction(null, fd)).rejects.toThrow(`NEXT_REDIRECT;/importacoes/${batchId}?confirmado=1`);
    const html = await render(ImportBatchPage as unknown as AnyPage, { id: batchId }, { confirmado: "1" });
    expect(html).toContain("Importação confirmada");
    expect(html).toContain("Desfazer importação");
    expect(html).toContain("Importada");

    const again = await commitImportAction(null, fd);
    expect(again).toMatchObject({ ok: false, error: "Esta importação já foi confirmada." });
  });
});

describe("download routes", () => {
  it("exports the issues as CSV and serves the original file", async () => {
    session.current = fx.ctx.admin;
    const ctx = { params: Promise.resolve({ id: batchId }) };
    const csv = await issuesRoute(new NextRequest(`http://localhost:3000/api/imports/${batchId}/issues?nivel=error`), ctx as never);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const raw = new Uint8Array(await csv.arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM (Excel pt-BR)
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw);
    expect(text.startsWith("﻿Aba;Linha")).toBe(true);
    expect(text).toContain("Número fora do padrão CNJ");

    const file = await fileRoute(new NextRequest(`http://localhost:3000/api/imports/${batchId}/file`), ctx as never);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("carteira-ficticia.xlsx");

    session.current = fx.ctx.adminB;
    expect((await issuesRoute(new NextRequest(`http://localhost:3000/api/imports/${batchId}/issues`), ctx as never)).status).toBe(404);
    session.current = fx.ctx.lawyer;
    expect((await fileRoute(new NextRequest(`http://localhost:3000/api/imports/${batchId}/file`), ctx as never)).status).toBe(403);
  });
});
