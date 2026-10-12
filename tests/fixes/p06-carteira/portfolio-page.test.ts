/**
 * P0.6 "carteira": the `/processos` list page rendered on the server (session
 * mocked, real services, PGlite data).
 *   - one line per process (CNJ, autor +N, tribunal · instância, cidade/UF, fase,
 *     valor da causa, valor apurado, responsável) and one card per process on
 *     narrow screens; the title line and the vara are tooltips only;
 *   - compact totals strip (4 numbers), "Mais filtros" collapsed by default;
 *   - external counsel: no "Unidade" / "Escritório externo" filters, no option
 *     lists of the internal structure; a unit or firm in the URL (a dashboard
 *     drill-down) is applied visibly (callout + link that removes it), and the
 *     list, the totals and the export agree;
 *   - the company column only when the organization has more than one active company;
 *   - deferred finding 15: every dashboard drill-down into `/processos` lists
 *     exactly the processes the dashboard counted (admin, lawyer and external
 *     counsel, with and without dashboard filters).
 *   - the Cidade/UF and Empresa values stay visible from 1280 px (a muted second
 *     line while their own column is hidden).
 * With P06_SHOTS=1 the rendered pages are also written to .data/p06-shots/carteira
 * (HTML inside a copy of the shell layout) for the screenshots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

import { eq } from "drizzle-orm";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProcessesPage from "@/app/(app)/processos/page";
import ProcessesLoading from "@/app/(app)/processos/loading";
import type { LegalArea, ProcessInstance, ProcessPhase, ProcessStatus } from "@/domain/enums";
import { parseBiFilters, processesHref } from "@/modules/dashboard/bi-filters";
import { getBiData } from "@/modules/dashboard/bi-service";
import { getPortfolioPanel } from "@/modules/dashboard/portfolio-service";
import { loadProcessFormOptions } from "@/modules/processes/form-data";
import { processFiltersFromSearchParams } from "@/modules/processes/filters";
import { exportProcesses, summarizeProcesses } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import { companies, legalProcesses, processParties } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;

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

/** Rendered page, with the non-breaking spaces of the pt-BR money formats as plain spaces. */
async function render(ctx: AuthContext, searchParams: Record<string, string> = {}): Promise<string> {
  session.current = ctx;
  const tree = await ProcessesPage({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree))).replace(/ /g, " ");
}

const section = (out: string, label: string) =>
  out.match(new RegExp(`<section aria-label="${label}"[^>]*>(?:(?!</section>).)*</section>`, "s"))?.[0] ?? "";
/** The wide-screen table (`<table aria-label="Carteira de processos">…</table>`). */
const table = (out: string) => out.match(/<table[^>]*aria-label="Carteira de processos"[^>]*>[\s\S]*?<\/table>/)?.[0] ?? "";
/** The narrow-screen cards (`<ul aria-label="Carteira de processos">…</ul>`). */
const cards = (out: string) => out.match(/<ul aria-label="Carteira de processos"[^>]*>[\s\S]*?<\/ul>/)?.[0] ?? "";
/** Visible text only (tags and attribute values removed). */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
/** The "N processos encontrados" count of the rendered page. */
const found = (out: string) => Number(out.match(/([\d.]+) processos? encontrados?/)?.[1].replace(/\./g, "") ?? "-1");
/** The search params of an href (as rendered: `&amp;` unescaped). */
function spOf(href: string): { pathname: string; sp: Record<string, string> } {
  const url = new URL(href.replace(/&amp;/g, "&"), "http://praetor.test");
  const sp: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (sp[k] = v));
  return { pathname: url.pathname, sp };
}

// ---------------------------------------------------------------------------
// Fixture: fictitious processes (names and numbers invented for the test)
// ---------------------------------------------------------------------------

const VARA = "VARA DO TRABALHO DE FORMOSA";
const PLAINTIFFS = [
  "GISELE RIBEIRO GOMES",
  "Maria Exemplo dos Santos",
  "CAMILA SOUZA CARVALHO",
  "Rafaela Andrade Rodrigues",
  "HUGO MENDES GOMES",
  "Karina Pinheiro Santos",
  "Sicrano Demonstração Souza",
  "Diego Ramos Fonseca",
  "Wesley Campos Prado",
  "Juliana Freitas Rodrigues",
  "Ulisses Andrade Rodrigues de Albuquerque Neto",
  "Priscila Barbosa Araujo",
];
const CITIES: [string, string][] = [
  ["Palmas", "TO"],
  ["Brasília", "DF"],
  ["Feira de Santana", "BA"],
  ["São Bernardo do Campo", "SP"],
  ["Formosa", "GO"],
];

type Row = typeof legalProcesses.$inferInsert;

function cnj(i: number): string {
  return `${String(7_000_100 + i).padStart(7, "0")}-${String(10 + (i % 80)).padStart(2, "0")}.2025.5.10.${String(1 + (i % 9)).padStart(4, "0")}`;
}

beforeAll(async () => {
  f = await setupFixture("p06cart");
  const base = { organizationId: f.orgA, area: "labor" as LegalArea, lossProbability: "possible" as const };
  const rows: Row[] = [];
  const phases: ProcessPhase[] = ["knowledge", "liquidation", "enforcement"];
  const instances: (ProcessInstance | null)[] = ["first", "second", "first", "superior", null];
  for (let i = 0; i < PLAINTIFFS.length; i++) {
    const [city, state] = CITIES[i % CITIES.length];
    rows.push({
      ...base,
      number: cnj(i),
      title: `${PLAINTIFFS[i]} x Empresa Fictícia A Ltda.`,
      court: i % 3 === 0 ? "TRT10" : i % 3 === 1 ? "TRT-5" : "TJSP",
      courtDivision: i % 2 === 0 ? VARA : `${i + 1}ª Vara do Trabalho de ${city}`,
      city,
      state,
      instance: instances[i % instances.length],
      phase: phases[i % phases.length],
      phaseDetail: i === 1 ? "Aguardando cálculos do perito" : null,
      companyId: f.companyA,
      unitId: i % 2 === 0 ? f.unitSp : f.unitRe,
      lawFirmId: i < 6 ? f.lawFirmA : null,
      responsibleId: i % 4 === 3 ? null : i % 2 === 0 ? f.ctx.lawyer.userId : f.ctx.lawyerRe.userId,
      claimAmountCents: i === 4 ? null : i === 0 ? 1_234_567_890 : 1_500_000 + i * 2_345_678,
      liquidatedAmountCents: i % 3 === 0 ? null : 600_000 + i * 1_111_111,
      isConfidential: i === 2,
      needsVerification: i === 1 || i === 5,
      status: (i === 7 ? "suspended" : "active") as ProcessStatus,
    });
  }
  // Outside the active portfolio.
  rows.push({
    ...base,
    number: "0007900-10.2020.5.10.0001",
    title: "Processo fictício encerrado",
    court: "TRT10",
    instance: "first",
    phase: "enforcement",
    status: "closed",
    closureReason: "settlement_fulfilled",
    closedAt: "2026-03-01",
    companyId: f.companyA,
    claimAmountCents: 800_000,
    liquidatedAmountCents: 500_000,
  });
  // Number outside the CNJ shape, nothing else informed.
  rows.push({
    ...base,
    number: "123/2020",
    title: "Processo fictício antigo",
    court: "",
    phase: "knowledge",
    companyId: null,
    claimAmountCents: null,
    liquidatedAmountCents: null,
  });
  const inserted = await f.db.insert(legalProcesses).values(rows).returning({ id: legalProcesses.id, number: legalProcesses.number });
  const byNumber = new Map(inserted.map((r) => [r.number, r.id]));
  const parties: (typeof processParties.$inferInsert)[] = [];
  PLAINTIFFS.forEach((name, i) => {
    const processId = byNumber.get(cnj(i))!;
    parties.push({ organizationId: f.orgA, processId, name, role: "plaintiff" });
    if (i === 0) {
      parties.push({ organizationId: f.orgA, processId, name: "Segunda Autora Fictícia", role: "plaintiff" });
      parties.push({ organizationId: f.orgA, processId, name: "Terceiro Autor Fictício", role: "plaintiff" });
    }
    parties.push({ organizationId: f.orgA, processId, name: "Empresa Fictícia A Ltda.", role: "defendant", isClient: true });
  });
  await f.db.insert(processParties).values(parties);

  if (process.env.P06_SHOTS === "1") await writeShots();
});

afterAll(async () => {
  await f?.teardown();
});

// ---------------------------------------------------------------------------
// One line per process
// ---------------------------------------------------------------------------

describe("/processos list rows", () => {
  it("shows CNJ, autor +N, tribunal · instância, cidade/UF, fase, both values and the responsible on one line", async () => {
    const out = await render(f.ctx.admin);
    const t = table(out);
    expect(t).toContain('class="w-full caption-bottom border-collapse table-fixed text-xs"');
    const headers = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).trim());
    expect(headers.map((h) => h.replace(/\s*\..*$/, ""))).toEqual([
      "Processo (CNJ)",
      "Autor",
      "Tribunal · instância Cidade/UF", // second line while the Cidade/UF column is hidden (below 1440 px)
      "Cidade/UF",
      "Fase",
      "Valor da causa",
      "Valor apurado",
      "Responsável",
    ]);
    const first = t.match(new RegExp(`<tr[^>]*>(?:(?!</tr>).)*${cnj(0).replace(/\./g, "\\.")}(?:(?!</tr>).)*</tr>`, "s"))?.[0] ?? "";
    const cells = text(first);
    expect(cells).toContain(cnj(0));
    expect(cells).toContain("GISELE RIBEIRO GOMES +2"); // registered as all caps: kept as is
    expect(cells).toContain("TRT10 · 1º grau");
    expect(cells).toContain("Palmas/TO");
    expect(cells).toContain("Conhecimento");
    expect(cells).toContain("R$ 12.345.678,90");
    expect(cells).toContain("Não apurado");
    expect(cells).toContain("Laura Advogada SP");
    // Not apurado is muted text, never R$ 0,00.
    expect(first).toContain('<span class="text-muted-foreground">Não apurado</span>');
    expect(first).not.toContain("R$ 0,00");
    // The title line and the vara are not repeated as visible text (tooltips only).
    expect(cells).not.toContain("x Empresa Fictícia A Ltda.");
    expect(cells).not.toContain(VARA);
    expect(first).toContain(`title="Vara: ${VARA}. Cidade: Palmas/TO"`);
    // A link to the process, in monospace.
    const link = first.match(new RegExp(`<a [^>]*>${cnj(0).replace(/\./g, "\\.")}</a>`))?.[0] ?? "";
    expect(link).toMatch(/href="\/processos\/[0-9a-f-]{36}"/);
    expect(link).toContain("font-mono");
  });

  it("marks sigiloso, pendente de conferência and numbers outside the CNJ shape with labelled icons", async () => {
    const t = table(await render(f.ctx.admin));
    expect(t).toContain('title="Sigiloso"');
    expect(t).toContain('<span class="sr-only">Pendente de conferência</span>');
    expect(t).toContain('<span class="sr-only">Fora do padrão CNJ</span>');
    // Empty values read "Não informado" (muted), never a dash.
    expect(t).toContain('<span class="text-muted-foreground">Não informado</span>');
    expect(t).not.toContain("—");
    expect(t).not.toContain(" – ");
  });

  it("shows the status instead of the phase outside the active portfolio (phase and reason in the tooltip)", async () => {
    const t = table(await render(f.ctx.admin, { carteira: "todas" }));
    expect(t).toContain('title="Fase: Execução. Motivo: Acordo cumprido">Encerrado</span>');
    expect(t).toContain('<span class="sr-only">Suspenso, </span>');
  });

  it("renders a card per process for narrow screens with both values and the responsible", async () => {
    const out = await render(f.ctx.admin);
    const c = cards(out);
    expect(c).toContain('class="divide-y divide-border xl:hidden"');
    expect(out).toContain('class="relative w-full overflow-x-auto hidden xl:block"');
    const items = c.split("<li ").slice(1);
    expect(items.length).toBe(13); // 12 active + the number outside the CNJ shape
    const firstCard = text(items.find((i) => i.includes(cnj(0)))!);
    expect(firstCard).toContain("Valor da causa R$ 12.345.678,90");
    expect(firstCard).toContain("Valor apurado Não apurado");
    expect(firstCard).toContain("TRT10 · 1º grau · Palmas/TO");
    expect(firstCard).not.toContain(VARA);
  });

  it("keeps the '+N' of extra plaintiffs visible: only the name is truncated (table and cards)", async () => {
    const out = await render(f.ctx.admin);
    // The name and the "+N" are siblings in a flex line; the "+N" never shrinks.
    const plaintiffLine =
      '<span class="flex min-w-0 items-baseline"><span class="min-w-0 truncate">GISELE RIBEIRO GOMES</span>' +
      '<span class="ml-1 shrink-0 font-normal text-muted-foreground"><span class="sr-only"> </span>+2</span></span>';
    expect(table(out)).toContain(plaintiffLine);
    expect(cards(out)).toContain(plaintiffLine);
    // The "+N" is never inside the truncated span.
    expect(out).not.toMatch(/<span class="[^"]*truncate[^"]*">[^<]*GISELE RIBEIRO GOMES<span/);
  });

  it("sorts by the money columns from the headers (filters kept, aria-sort on the active one)", async () => {
    const out = await render(f.ctx.admin, { tribunal: "TRT10", ordem: "causa_maior" });
    const t = table(out);
    expect(t).toMatch(/<th[^>]*aria-sort="descending"[^>]*><a [^>]*href="\/processos\?tribunal=TRT10&amp;ordem=causa_menor"/);
    expect(t).toContain('href="/processos?tribunal=TRT10&amp;ordem=liquidado_maior"');
    expect(out).toContain("ordenados por maior valor da causa");
  });

  it("calls the sort by the valor apurado column by the same name as the column and the strip", async () => {
    const out = await render(f.ctx.admin, { ordem: "liquidado_maior" });
    expect(out).toContain("ordenados por maior valor apurado");
    expect(out).toContain('<option value="liquidado_maior" selected="">Maior valor apurado</option>');
    expect(out).toContain('<option value="liquidado_menor">Menor valor apurado</option>');
    expect(text(out)).not.toMatch(/liquidado/i);
  });

  it("keeps cidade/UF visible from 1280 px: a muted second line under the tribunal while its column is hidden", async () => {
    const t = table(await render(f.ctx.admin));
    expect(t).toContain('<th scope="col" class="h-9 text-left align-middle text-xs font-semibold whitespace-nowrap text-slate-600 first:pl-5 last:pr-5 w-28 px-2 hidden min-[1440px]:table-cell">Cidade/UF</th>');
    expect(t).toContain('<span class="block truncate font-normal text-muted-foreground min-[1440px]:hidden">Cidade/UF</span>');
    expect(t).toContain('<span class="block truncate font-normal text-muted-foreground min-[1440px]:hidden">Palmas/TO</span>');
    // No company line with a single active company.
    expect(t).not.toContain(">Empresa<");
    expect(t).not.toContain("Empresa Fictícia A Ltda.</span>");
  });
});

// ---------------------------------------------------------------------------
// Company column / subtitle
// ---------------------------------------------------------------------------

describe("/processos company", () => {
  it("puts the only active company in the subtitle (no column, no filter)", async () => {
    const out = await render(f.ctx.admin);
    expect(text(out)).toContain("Passivo judicial de Empresa Fictícia A Ltda. acompanhado pelo jurídico");
    expect(table(out)).not.toContain(">Empresa</th>");
    expect(out).not.toContain('name="empresa"');
  });

  it("shows the company column and filter when the organization has more than one active company", async () => {
    const [second] = await f.db
      .insert(companies)
      .values({ organizationId: f.orgA, name: "Segunda Empresa Fictícia S.A." })
      .returning({ id: companies.id });
    try {
      const out = await render(f.ctx.admin);
      expect(out).toContain('name="empresa"');
      expect(text(out)).not.toContain("Passivo judicial de ");
      // The company is a muted second line under the autor at every width (header "Autor / Empresa"),
      // so it is visible from 1280 px; cidade/UF keeps its own column from 1440 px.
      const t = table(out);
      expect(t).toMatch(/>Autor<span class="block truncate font-normal text-muted-foreground">Empresa<\/span><\/th>/);
      expect(t).toContain('<span class="block truncate font-normal text-muted-foreground">Empresa Fictícia A Ltda.</span>');
      expect(t).toContain('<span class="block truncate font-normal text-muted-foreground min-[1440px]:hidden">Palmas/TO</span>');
      expect(t).toContain('hidden min-[1440px]:table-cell">Cidade/UF</th>');
      // Narrow screens: the company follows the tribunal and the city on the card.
      expect(text(cards(out))).toContain("TRT10 · 1º grau · Palmas/TO · Empresa Fictícia A Ltda.");
    } finally {
      await f.db.delete(companies).where(eq(companies.id, second.id));
    }
  });
});

// ---------------------------------------------------------------------------
// Totals strip and filters
// ---------------------------------------------------------------------------

describe("/processos totals strip", () => {
  it("has 4 numbers: processos, valor da causa and valor apurado side by side with the não apurados, pendentes de conferência", async () => {
    const strip = section(await render(f.ctx.admin), "Totais do recorte filtrado");
    const labels = [...strip.matchAll(/<span class="block text-xs font-medium text-muted-foreground">(.*?)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Processos (CNJ únicos)", "Valor da causa (soma)", "Valor apurado (soma)", "Pendentes de conferência"]);
    const s = await summarizeProcesses(f.ctx.admin, processFiltersFromSearchParams({}));
    expect(text(strip)).toContain(`${s.liquidatedUnknown} não apurados`);
    expect(strip).toContain(`Valor apurado em ${s.count - s.liquidatedUnknown} de ${s.count} processos`);
    expect(strip).toContain('href="/processos?verificar=1"');
    expect(text(strip)).toContain(`Pendentes de conferência ${s.needsVerification}`);
    expect(strip).not.toContain("R$ 0,00");
  });

  it("never shows R$ 0,00 when nothing is apurado", async () => {
    const strip = section(await render(f.ctx.admin, { liquidado: "sem" }), "Totais do recorte filtrado");
    expect(strip).toContain("Sem valor apurado");
    expect(strip).not.toContain("R$ 0,00");
  });

  it("keeps 'Mais filtros' collapsed by default and opens it when an advanced filter is active", async () => {
    expect(await render(f.ctx.admin)).toMatch(/<details class="group w-full[^"]*">/);
    expect(await render(f.ctx.admin, { ordem: "causa_maior" })).toMatch(/<details class="group w-full[^"]*">/);
    expect(await render(f.ctx.admin, { cidade: "Palmas" })).toMatch(/<details open="" class="group w-full/);
  });

  it("lists UF names without dashes and keeps a URL value missing from the options", async () => {
    const out = await render(f.ctx.admin, { tribunal: "TRT99" });
    expect(out).toContain('<option value="TO">TO (Tocantins)</option>');
    expect(out).toContain('<option value="TRT99" selected="">TRT99</option>');
    expect(out).not.toContain("—");
  });
});

// ---------------------------------------------------------------------------
// External counsel (deferred findings 13 and 22, filters part)
// ---------------------------------------------------------------------------

describe("/processos for external counsel", () => {
  it("has no 'Unidade' / 'Escritório externo' filters and lists no internal structure", async () => {
    const out = await render(f.ctx.externalCounsel);
    expect(out).not.toContain('name="unidade"');
    expect(out).not.toContain('name="escritorio"');
    expect(out).not.toContain(">São Paulo</option>");
    expect(out).not.toContain(">Recife</option>");
    expect(out).not.toContain(">Sem unidade</option>");
    // Their own processes only.
    expect(text(table(out))).toContain(cnj(0));
    expect(text(table(out))).not.toContain(cnj(7));
  });

  it("applies a unit or firm from the URL visibly: callout, link that removes it, same list, totals and export", async () => {
    const ctx = f.ctx.externalCounsel;
    const out = await render(ctx, { unidade: f.unitSp, tribunal: "TRT10" });
    const t = text(out);
    // Visible scope, with a link back to the list without it (other filters kept).
    expect(t).toContain("Recorte por unidade São Paulo");
    expect(out).toContain(`href="/processos?tribunal=TRT10">Remover o recorte</a>`);
    // Still no select and no list of units; the scope survives the next "Filtrar" (hidden field).
    expect(out).not.toContain('id="filtro-unidade"');
    expect(out).not.toContain(">São Paulo</option>");
    expect(out).not.toContain(">Recife</option>");
    expect(out).toContain(`<input type="hidden" name="unidade" value="${f.unitSp}"/>`);
    expect(out).toMatch(/<details class="group w-full[^"]*">/); // nothing of it inside "Mais filtros"
    // List, totals and export apply the same filters.
    const scoped = await summarizeProcesses(ctx, processFiltersFromSearchParams({ unidade: f.unitSp, tribunal: "TRT10" }));
    const all = await summarizeProcesses(ctx, processFiltersFromSearchParams({ tribunal: "TRT10" }));
    expect(scoped.count).toBeGreaterThan(0);
    expect(scoped.count).toBeLessThan(all.count);
    expect(found(out)).toBe(scoped.count);
    const exportHrefs = [...out.matchAll(/href="(\/api\/processes\/export[^"]*)"/g)].map((m) => m[1]);
    expect(exportHrefs).toHaveLength(2);
    for (const href of exportHrefs) {
      const { sp } = spOf(href);
      expect(sp.unidade).toBe(f.unitSp);
      const data = await exportProcesses(ctx, processFiltersFromSearchParams(sp), sp.formato === "xlsx" ? "xlsx" : "csv");
      expect(data.processes.length).toBe(scoped.count);
    }
  });

  it("names the firm of the scope and removes unit and firm together", async () => {
    const out = await render(f.ctx.externalCounsel, { unidade: f.unitRe, escritorio: f.lawFirmA });
    expect(text(out)).toContain("Recorte por unidade Recife e escritório Escritório Fictício A Advogados");
    expect(out).toContain(`href="/processos">Remover o recorte</a>`);
    expect(out).toContain(`<input type="hidden" name="escritorio" value="${f.lawFirmA}"/>`);
    expect(out).not.toContain('id="filtro-escritorio"');
    // Internal users never get the callout (the selects in "Mais filtros" show the value).
    const admin = await render(f.ctx.admin, { unidade: f.unitRe });
    expect(text(admin)).not.toContain("Recorte por");
    expect(admin).toMatch(/<details open="" class="group w-full/);
  });

  it("form options: no unit list (only the process's current unit) and no dash in the user labels", async () => {
    const external = await loadProcessFormOptions(f.ctx.externalCounsel, { unitId: f.unitSp, unitName: "São Paulo" });
    expect(external.units).toEqual([{ value: f.unitSp, label: "São Paulo" }]);
    const internal = await loadProcessFormOptions(f.ctx.admin);
    expect(internal.units.map((u) => u.label).sort()).toEqual(["Recife", "São Paulo"]);
    expect(internal.users.find((u) => u.value === f.ctx.lawyer.userId)?.label).toBe("Laura Advogada SP (Advogado)");
    expect(internal.users.every((u) => !u.label.includes("—"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deferred finding 15 (processos part): the dashboard drill-downs
// ---------------------------------------------------------------------------

describe("dashboard drill-downs into /processos", () => {
  /**
   * Totals of the list `/processos` shows for a dashboard link. For external counsel (whose
   * page once dropped some params) the rendered page's own count is checked too.
   */
  async function listed(ctx: AuthContext, href: string) {
    const { pathname, sp } = spOf(href);
    expect(pathname).toBe("/processos");
    const s = await summarizeProcesses(ctx, processFiltersFromSearchParams(sp));
    if (ctx === f.ctx.externalCounsel) {
      const shown = found(await render(ctx, sp));
      expect({ href, shown }).toEqual({ href, shown: s.count });
    }
    return s;
  }

  it("each portfolio chart bar, registration gap and 'não apurados' link lists exactly the counted processes", async () => {
    const profiles = [f.ctx.admin, f.ctx.lawyer, f.ctx.externalCounsel];
    const biFilters: Record<string, string>[] = [
      {},
      { unidade: f.unitSp },
      { unidade: f.unitRe, area: "labor" },
      { responsavel: f.ctx.lawyer.userId! },
    ];
    let unitBars = 0;
    for (const ctx of profiles) {
      for (const bi of biFilters) {
        const filters = parseBiFilters(bi);
        const panel = await getPortfolioPanel(ctx, filters);
        expect(panel.status).toBe("ok");
        if (panel.status !== "ok") return;
        const checks: { href: string; bucket: { count: number; claimCents: number; liquidatedCents: number; liquidatedUnknown: number } }[] = [];
        for (const d of Object.values(panel.data.dimensions)) {
          for (const r of d.rows) checks.push({ href: r.href, bucket: r.bucket });
          if (d.missing) checks.push({ href: d.missing.href, bucket: d.missing.bucket });
        }
        unitBars += panel.data.dimensions.unit.rows.length;
        for (const c of checks) {
          const s = await listed(ctx, c.href);
          expect({ href: c.href, count: s.count, claim: s.claimCents, liquidated: s.liquidatedCents, unknown: s.liquidatedUnknown }).toEqual({
            href: c.href,
            count: c.bucket.count,
            claim: c.bucket.claimCents,
            liquidated: c.bucket.liquidatedCents,
            unknown: c.bucket.liquidatedUnknown,
          });
        }
        const all = await listed(ctx, processesHref(filters));
        expect({ role: ctx.role, bi, count: all.count }).toEqual({ role: ctx.role, bi, count: panel.data.activeProcesses });
        const notAssessed = await listed(ctx, processesHref(filters, { liquidado: "sem" }));
        expect(notAssessed.count).toBe(panel.data.coverage.total - panel.data.coverage.assessed);
      }
    }
    // The external counsel's unit bars (3 in SP, 3 in RE) were among the checked links.
    expect(unitBars).toBeGreaterThan(0);
  }, 60_000);

  it("the risk bars (status=active&risco=…) list exactly the counted processes", async () => {
    const filters = parseBiFilters({});
    const bi = await getBiData(f.ctx.admin, filters);
    for (const [risk, n] of Object.entries(bi.riskProcesses)) {
      const s = await listed(f.ctx.admin, processesHref(filters, { status: "active", risco: risk as never }));
      expect({ risk, count: s.count }).toEqual({ risk, count: n });
    }
  });
});

// ---------------------------------------------------------------------------
// Static HTML for the screenshots (P06_SHOTS=1)
// ---------------------------------------------------------------------------

/** Same structure and classes as `src/app/(app)/layout.tsx` (sidebar w-64 from lg, main max-w-7xl). */
function shell(body: string): string {
  return `<div class="flex min-h-dvh flex-col"><div class="flex flex-1">
<aside class="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex"></aside>
<div class="flex min-w-0 flex-1 flex-col">
<header class="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/95 px-3 sm:gap-3 sm:px-6"></header>
<main id="conteudo" class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">${body}</main>
</div></div></div>`;
}

async function writeShots() {
  const dir = path.resolve(".data/p06-shots/carteira");
  mkdirSync(dir, { recursive: true });
  const pages: [string, AuthContext, Record<string, string>][] = [
    ["admin-ativa", f.ctx.admin, {}],
    ["admin-todas-filtros", f.ctx.admin, { carteira: "todas", cidade: "Palmas" }],
    ["escritorio", f.ctx.externalCounsel, {}],
    ["escritorio-recorte", f.ctx.externalCounsel, { unidade: f.unitSp }],
    ["admin-ordem-apurado", f.ctx.admin, { ordem: "liquidado_maior" }],
  ];
  for (const [name, ctx, sp] of pages) writeFileSync(path.join(dir, `${name}.fragment.html`), shell(await render(ctx, sp)), "utf8");
  // Two active companies: the company column.
  const [second] = await f.db
    .insert(companies)
    .values({ organizationId: f.orgA, name: "Segunda Empresa Fictícia S.A." })
    .returning({ id: companies.id });
  writeFileSync(path.join(dir, "admin-multiempresa.fragment.html"), shell(await render(f.ctx.admin, {})), "utf8");
  await f.db.delete(companies).where(eq(companies.id, second.id));
  writeFileSync(
    path.join(dir, "loading.fragment.html"),
    shell(renderToStaticMarkup(createElement(ProcessesLoading))),
    "utf8",
  );
}
