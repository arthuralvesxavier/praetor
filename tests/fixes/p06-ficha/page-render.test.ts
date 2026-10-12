/**
 * P0.6: server render of `/processos/[id]` (session mocked, real services on PGlite).
 * Six tabs, old `?aba=` keys open the merged tab, the clean header ("Mais ações"), the
 * compact cover, the unified timeline with the DataJud source, the sensitive downloads
 * log and the permission gates. With P06_SHOTS=1 the markup is also written to
 * `.data/p06-shots/ficha/html/` for the visual check (screenshots).
 */
import { and, eq } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Client components that refresh the page call useRouter: no app router is mounted in a plain server render.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
  usePathname: () => "/processos",
  useSearchParams: () => new URLSearchParams(),
}));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

import ProcessDetailPage from "@/app/(app)/processos/[id]/page";
import { addDaysISO, todayISO } from "@/lib/format";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { reviewValuation } from "@/modules/contingency/service";
import { buildSimulatedCnj } from "@/modules/intake/simulation";
import { DATAJUD_SOURCE_LABEL } from "@/modules/court-sync/mapping";
import { openDocumentVersion } from "@/modules/documents/service";
import { scrollActiveTabIntoView } from "@/modules/processes/components/active-tab-scroller";
import {
  addParty,
  addProcessEvent,
  addProcessInstance,
  createProcess,
  flagProcessForVerification,
  resolveProcessVerification,
  updateProcess,
} from "@/modules/processes/service";
import { PROCESS_TAB_KEYS, PROCESS_TAB_LABELS } from "@/modules/processes/tabs";
import type { AuthContext } from "@/server/auth/context";
import { processEvents, processValuations } from "@/server/db/schema";
import { makeDeadline, makeProcess, makeTextDocument, setupFixture, type Fixture } from "../../helpers/fixtures";

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
    if (key === "children" || key === "aside" || isValidElement(v) || Array.isArray(v)) props[key] = await resolveTree(v as ReactNode);
  }
  return { ...el, props } as ReactElement;
}

async function render(ctx: AuthContext, processId: string, sp: Record<string, string> = {}): Promise<string> {
  session.current = ctx;
  const tree = await ProcessDetailPage({
    params: Promise.resolve({ id: processId }),
    searchParams: Promise.resolve(sp),
  } as never);
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree as ReactNode)));
}

/** Visible text (tags removed). */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");

/** Key of the tab marked aria-current. */
function activeTab(html: string): string | null {
  const m = /<a[^>]*aria-current="page"[^>]*href="[^"]*?(?:\?aba=([a-z-]+))?"/.exec(html) ?? /<a[^>]*href="[^"]*?(?:\?aba=([a-z-]+))?"[^>]*aria-current="page"/.exec(html);
  if (!m) return null;
  return m[1] ?? "resumo";
}

const SHOTS = process.env.P06_SHOTS === "1";
const SHOTS_DIR = path.resolve(".data/p06-shots/ficha/html");
/**
 * Static page for the screenshots. No React runtime runs there, so the effect of
 * `ActiveTabScroller` is reproduced by running the same `scrollActiveTabIntoView`
 * source on the tab bar after load (what the hydrated page does).
 */
function shot(name: string, markup: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  const scroller = `<script>window.addEventListener("load",function(){var nav=document.querySelector('nav[aria-label="Seções do processo"]');if(nav)(${scrollActiveTabIntoView.toString()})(nav.parentElement);});</script>`;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title><link rel="stylesheet" href="app.css"><style>:root{--font-inter:"Inter","Segoe UI",system-ui,sans-serif;--font-cormorant:"Cormorant Garamond",serif;}</style></head><body class="min-h-dvh bg-canvas font-sans text-foreground antialiased"><div class="flex min-h-dvh"><aside class="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:flex"></aside><div class="flex min-w-0 flex-1 flex-col"><header class="sticky top-0 z-30 flex h-14 shrink-0 items-center border-b border-border bg-surface px-3 sm:px-6"></header><main id="conteudo" class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">${markup}</main></div></div>${scroller}</body></html>`;
  writeFileSync(path.join(SHOTS_DIR, `${name}.html`), html);
}

/** Occurrences of `needle` in the visible text. */
const occurrences = (html: string, needle: string) => text(html).split(needle).length - 1;

const NUMBER = buildSimulatedCnj({ seed: 4321, year: 2026, tribunal: "10", origin: "0001" });
let f: Fixture;
let P: string;
let bare: string;
let proposedOnCreate: string;

beforeAll(async () => {
  f = await setupFixture("p06page");
  const m = f.ctx.manager;
  P = await makeProcess(m, {
    number: NUMBER,
    title: "Reclamação trabalhista de horas extras (fictícia)",
    court: "TRT10",
    area: "labor",
    phase: "knowledge",
    instance: "first",
    city: "Palmas",
    state: "TO",
    processClass: "ATOrd",
    companyId: f.companyA,
    unitId: f.unitSp,
    responsibleId: f.ctx.lawyer.userId,
    claimAmountCents: 85_000_00,
    description: "Pedido de horas extras e reflexos. Dados fictícios para a demonstração da ficha.",
  });
  await addParty(m, P, { name: "Maria Aparecida Fictícia", role: "plaintiff" });
  await addParty(m, P, { name: "Empresa Fictícia A Ltda.", role: "defendant", isClient: true });
  await addProcessInstance(m, P, { instance: "second", court: "TRT10", courtDivision: "2ª Turma", isCurrent: false });
  await addProcessEvent(m, P, { occurredAt: addDaysISO(todayISO(), -20), type: "filing", title: "Distribuição da reclamação (fictícia)", instance: "first" });
  await f.db.insert(processEvents).values({
    organizationId: f.orgA,
    processId: P,
    occurredAt: addDaysISO(todayISO(), -2),
    type: "other",
    title: "Remetidos os autos para órgão jurisdicional competente",
    origin: "imported",
    externalSource: DATAJUD_SOURCE_LABEL,
    externalId: "123|2026-10-10T10:00:00|G2",
    cnjMovementCode: 123,
    instance: "second",
  });
  await makeDeadline(m, { processId: P, kind: "procedural", dueDate: addDaysISO(todayISO(), 3), title: "Prazo de recurso (fictício)" });
  await addRiskAssessment(m, P, { classification: "possible", opinion: "Parecer fictício.", effectiveFrom: todayISO() });
  // A lawyer's change of the valor da causa waits in the review queue ("Valor aguardando conferência").
  await updateProcess(f.ctx.lawyer, P, { claimAmountCents: 92_000_00 });
  const doc = await makeTextDocument(m, { processId: P, title: "Atestado médico (fictício)", text: "Texto fictício.", category: "sensitive_health" });
  const opened = await openDocumentVersion(m, doc.documentId, doc.versionId);
  await opened.stream.cancel();

  bare = await makeProcess(m, { number: "0004321-00.2026.5.10.0001", title: "Cadastro mínimo (fictício)", court: "TRT10", area: "labor", phase: "knowledge" });
  // Created by the lawyer with a valor da causa: only a proposal, the record stays without it.
  ({ id: proposedOnCreate } = await createProcess(f.ctx.lawyer, {
    number: "0004322-00.2026.5.10.0001",
    title: "Valor da causa proposto no cadastro (fictício)",
    court: "TRT10",
    area: "labor",
    phase: "knowledge",
    instance: "first",
    unitId: f.unitSp,
    claimAmountCents: 80_000_00,
  }));
}, 120_000);

afterAll(async () => f?.teardown());

describe("process detail: six tabs and the old keys", () => {
  it("lists the six tabs in order and opens the summary by default", async () => {
    const html = await render(f.ctx.manager, P);
    shot("resumo-gestor", html);
    const labels = PROCESS_TAB_KEYS.map((k) => PROCESS_TAB_LABELS[k]);
    let at = -1;
    for (const label of labels) {
      const next = html.indexOf(`>${label}</a>`);
      expect(next, label).toBeGreaterThan(at);
      at = next;
    }
    expect(activeTab(html)).toBe("resumo");
    // The tab bar has exactly six links.
    const nav = html.split('aria-label="Seções do processo"')[1]?.split("</nav>")[0] ?? "";
    expect(nav.match(/<a /g)).toHaveLength(6);
  });

  it.each([
    ["visao-geral", "resumo"],
    ["partes", "partes-e-andamento"],
    ["instancias", "partes-e-andamento"],
    ["movimentacoes", "partes-e-andamento"],
    ["valores", "valores-e-acordos"],
    ["acordos", "valores-e-acordos"],
    ["audiencias", "prazos-e-audiencias"],
    ["analise-preliminar", "documentos-e-analises"],
    ["documentos", "documentos-e-analises"],
    ["prazos", "prazos-e-audiencias"],
    ["emails", "historico"],
    ["ia", "documentos-e-analises"],
    ["comentarios", "historico"],
    ["historico", "historico"],
  ])("?aba=%s opens %s", async (old, expected) => {
    const html = await render(f.ctx.manager, P, { aba: old });
    expect(activeTab(html)).toBe(expected);
  });
});

describe("header", () => {
  it("CNJ as the title, 'Autor × Empresa' below, only Editar visible plus 'Mais ações'", async () => {
    const html = await render(f.ctx.manager, P);
    const h1 = /<h1[^>]*>(.*?)<\/h1>/.exec(html)?.[1] ?? "";
    expect(text(h1).trim()).toBe(NUMBER);
    expect(html).not.toContain("Dígito verificador não confere");
    expect(html).toContain("Maria Aparecida Fictícia × Empresa Fictícia A Ltda.");
    expect(html).toContain(">Editar</a>");
    expect(html).toContain("Mais ações");
    // The lifecycle actions live in the closed menu (not rendered until it opens).
    for (const hidden of ["Retirar da carteira ativa", "Marcar para conferência", "Excluir"]) {
      expect(text(html.split("</header>")[0])).not.toContain(hidden);
    }
  });

  it("read-only profiles get neither Editar nor 'Mais ações'", async () => {
    const html = await render(f.ctx.auditor, P);
    expect(html).not.toContain(">Editar</a>");
    expect(html).not.toContain("Mais ações");
  });

  it("a valor da causa sent to the review queue is announced after the save, true for an update and a create", async () => {
    // Update: the record keeps the value already in force.
    const updated = await render(f.ctx.lawyer, P, { valor_causa: "em_conferencia" });
    expect(updated).toContain("Valor da causa enviado para conferência");
    expect(text(updated)).toMatch(/Até lá, continua valendo o valor da causa atual \(R\$\s85\.000,00\)\./);
    // Create: there was no previous value, the record stays "não informado".
    const created = await render(f.ctx.lawyer, proposedOnCreate, { valor_causa: "em_conferencia" });
    expect(text(created)).toContain("Até lá, o valor da causa do processo fica como não informado.");
    expect(text(created)).not.toContain("valor da causa anterior");
  });

  it("the flag is called 'conferência' on the badge too", async () => {
    await flagProcessForVerification(f.ctx.manager, bare, { note: "Conferir a vara (fictício)." });
    try {
      const html = await render(f.ctx.manager, bare);
      shot("resumo-pendente-conferencia", html);
      expect(html).not.toContain(">Verificar<");
      // Header badge and band pendência use the same term.
      expect(occurrences(html, "Pendente de conferência")).toBe(2);
    } finally {
      await resolveProcessVerification(f.ctx.manager, bare, {});
    }
  });
});

describe("Resumo", () => {
  it("decision band, compact cover without empty fields and one 'Completar cadastro' link", async () => {
    const html = await render(f.ctx.manager, P);
    expect(html).toContain("Exige decisão agora");
    expect(html).toContain("Valor aguardando conferência");
    expect(html).toContain("Capa do processo");
    // Missing: vara/órgão julgador and data de ajuizamento.
    expect(html).toContain(`href="/processos/${P}/editar"`);
    expect(text(html)).toContain("Completar cadastro (2 campos)");
    expect(text(html)).toContain("Não informados: Vara ou órgão julgador, Data de ajuizamento.");
    // ONE registration-gap entry on the tab: the band does not repeat it.
    expect(occurrences(html, "Completar cadastro")).toBe(1);
    expect(text(html)).not.toContain("Cadastro incompleto");
    // Values side by side, the record keeps the official value until the review; the proposal is shown apart.
    expect(text(html)).toMatch(/R\$\s85\.000,00/);
    expect(text(html)).toMatch(/R\$\s92\.000,00 proposto, aguardando conferência/);
    expect(text(html)).toContain("Não apurado");
    // No empty AI card on the summary.
    expect(html).not.toContain("Análises de IA");
    // Text written by the summary has no em/en dash and no internal codes.
    const summary = text(html.split('aria-label="Seções do processo"')[1] ?? "");
    expect(summary).not.toMatch(/—| – /);
    expect(summary).not.toMatch(/\b(RN|RF|TE)-\d/);
  });

  it("a minimal record lists every gap; without process:write the gaps are only listed", async () => {
    const html = await render(f.ctx.manager, bare);
    shot("resumo-cadastro-minimo", html);
    expect(text(html)).toContain("Completar cadastro (9 campos)");
    expect(occurrences(html, "Completar cadastro")).toBe(1);
    expect(text(html)).not.toContain("Cadastro incompleto");
    const auditor = await render(f.ctx.auditor, bare);
    expect(text(auditor)).toContain("Cadastro incompleto (9 campos)");
    expect(occurrences(auditor, "Cadastro incompleto")).toBe(1);
    expect(auditor).not.toContain(`/processos/${bare}/editar`);
  });

  it("a valor da causa proposed on create: 'Não informado' plus the proposal, not listed as a gap", async () => {
    const html = await render(f.ctx.lawyer, proposedOnCreate);
    shot("resumo-proposto-no-cadastro", html);
    const cover = text(html.split('id="capa-titulo"')[1] ?? "");
    expect(cover).toMatch(/Valor da causa\s+Não informado\s+R\$\s80\.000,00 proposto, aguardando conferência/);
    expect(cover).not.toMatch(/Não informados:[^.]*Valor da causa/);
  });
});

describe("other tabs", () => {
  it("Partes e andamento: parties, instances and ONE timeline with instance and source badges", async () => {
    const html = await render(f.ctx.manager, P, { aba: "partes-e-andamento" });
    shot("partes-e-andamento-gestor", html);
    for (const id of ['id="partes"', 'id="instancias"', 'id="andamento"']) expect(html).toContain(id);
    expect(text(html)).toContain("Linha do tempo única de todas as instâncias");
    expect(text(html)).toContain("DataJud (CNJ)");
    expect(text(html)).toContain("1º grau: 1");
    expect(text(html)).toContain("2º grau: 1");
    expect(text(html)).toContain("Acompanhamento no DataJud (CNJ)");
    // Most recent first: the DataJud movement (2 days ago) before the filing (20 days ago).
    expect(html.indexOf("Remetidos os autos")).toBeLessThan(html.indexOf("Distribuição da reclamação"));
  });

  it("Valores e acordos: values, claims, settlements and scenarios", async () => {
    const html = await render(f.ctx.manager, P, { aba: "valores-e-acordos" });
    shot("valores-e-acordos-gestor", html);
    for (const id of ['id="valores"', 'id="pedidos"', 'id="acordos"', 'id="cenarios"', 'id="classificacao-risco"']) expect(html).toContain(id);
  });

  it("Prazos e audiências: deadlines and the hearings section", async () => {
    const html = await render(f.ctx.manager, P, { aba: "prazos-e-audiencias" });
    shot("prazos-e-audiencias-gestor", html);
    expect(html).toContain("Prazo de recurso (fictício)");
    expect(html).toContain('id="audiencias"');
  });

  it("Documentos e análises: documents, sensitive downloads, preliminary analysis and AI", async () => {
    const html = await render(f.ctx.manager, P, { aba: "documentos-e-analises" });
    shot("documentos-e-analises-gestor", html);
    expect(html).toContain("Downloads de documentos sensíveis");
    expect(text(html)).toContain("Gustavo Gestor");
    expect(html).toContain('id="analise-preliminar"');
    expect(html).toContain('id="analises-ia"');
    // The SP lawyer is the responsible: sees the health document and its download log.
    const lawyer = await render(f.ctx.lawyer, P, { aba: "documentos-e-analises" });
    expect(lawyer).toContain("Downloads de documentos sensíveis");
    // The auditor cannot open the health document: no log, no AI request form (nothing to show).
    const auditor = await render(f.ctx.auditor, P, { aba: "documentos-e-analises" });
    expect(auditor).not.toContain("Downloads de documentos sensíveis");
    expect(auditor).not.toContain('id="analises-ia"');
  });

  it("Histórico: comments, e-mails and the change history", async () => {
    const html = await render(f.ctx.manager, P, { aba: "historico" });
    shot("historico-gestor", html);
    for (const id of ['id="comentarios"', 'id="emails"', 'id="historico-alteracoes"']) expect(html).toContain(id);
  });

  it("other units never see the process", async () => {
    session.current = f.ctx.lawyerRe;
    await expect(
      ProcessDetailPage({ params: Promise.resolve({ id: P }), searchParams: Promise.resolve({}) } as never),
    ).rejects.toThrow();
  });

  it("lawyer summary (mobile screenshot source)", async () => {
    const html = await render(f.ctx.lawyer, P);
    shot("resumo-advogada", html);
    expect(html).toContain("Mais ações");
    expect(html).not.toContain("Excluir processo");
  });
});

describe("valor da causa approved in the review queue after the creation", () => {
  it("the current instance shows the record's value, labeled, instead of 'Não informado'", async () => {
    const [proposal] = await f.db
      .select({ id: processValuations.id })
      .from(processValuations)
      .where(and(eq(processValuations.processId, proposedOnCreate), eq(processValuations.status, "proposed")));
    await reviewValuation(f.ctx.manager, proposal.id, { decision: "approve" });
    const html = await render(f.ctx.manager, proposedOnCreate, { aba: "partes-e-andamento" });
    shot("partes-e-andamento-aprovado-no-cadastro", html);
    const instances = text(html.split('id="instancias"')[1]?.split("</table>")[0] ?? "");
    expect(instances).toMatch(/R\$\s80\.000,00\s+Valor do cadastro do processo/);
    expect(instances).not.toContain("Não informado ");
  });
});
