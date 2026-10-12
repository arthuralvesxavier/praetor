/**
 * Visual check of the text sweep (no em dash, "Não informado" placeholders, "apurada"
 * labels, "pendente de conferência"): the touched screens rendered on the server with a
 * mocked session and PGlite data, written as static HTML for the compiled Tailwind CSS and
 * headless Chrome. Runs only with VARREDURA_SHOTS=1 (output in .data/p06-shots/varredura).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

const ENABLED = process.env.VARREDURA_SHOTS === "1";
const OUT = path.resolve(".data/p06-shots/varredura");

type PageFn = (props: never) => Promise<ReactNode>;

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

function writeShot(name: string, body: string) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${name}.fragment.html`), body, "utf8");
}

describe.runIf(ENABLED)("text sweep screenshots", () => {
  // Imports stay inside the block so a normal run does not load the pages.
  let fx: import("../helpers/fixtures").Fixture;
  const ids: Record<string, string> = {};

  async function render(ctx: unknown, page: PageFn, params: Record<string, string> = {}, sp: Record<string, string> = {}) {
    session.current = ctx;
    const tree = await page({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) } as never);
    return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree)));
  }

  beforeAll(async () => {
    const { setupFixture, makeContract, makeOccurrence } = await import("../helpers/fixtures");
    const { todayISO, addDaysISO } = await import("@/lib/format");
    const { legalProcesses, caseBriefs, importBatches } = await import("@/server/db/schema");
    const { addValuation } = await import("@/modules/contingency/service");
    const { addRiskAssessment } = await import("@/modules/contingency/risk-service");
    const { generateSnapshot } = await import("@/modules/contingency/snapshot-service");
    const { renewContract } = await import("@/modules/contracts/service");
    fx = await setupFixture("varredura");
    const today = todayISO();
    let seq = 0;
    const proc = async (key: string, values: Partial<typeof legalProcesses.$inferInsert>) => {
      seq += 1;
      const [p] = await fx.db
        .insert(legalProcesses)
        .values({
          organizationId: fx.orgA,
          number: `${String(2_000_100 + seq * 41).padStart(7, "0")}-12.2025.5.10.0001`,
          title: `Reclamação trabalhista ${key} (fictícia)`,
          court: "TRT10",
          area: "labor",
          phase: "knowledge",
          instance: "first",
          city: "Palmas",
          companyId: fx.companyA,
          unitId: fx.unitSp,
          ...values,
        })
        .returning();
      ids[key] = p.id;
    };
    await proc("P1", { responsibleId: fx.ctx.lawyer.userId!, phase: "enforcement" });
    await proc("P2", { needsVerification: true, verificationNote: "Planilha pede conferência: \"VERIFICAR\" (fictício)." });
    await proc("P3", {});
    const m = fx.ctx.manager;
    await addValuation(m, { processId: ids.P1, kind: "claim", amountCents: 48_000_000, baseDate: addDaysISO(today, -200) });
    await addValuation(m, { processId: ids.P1, kind: "liquidated", amountCents: 31_250_075, baseDate: addDaysISO(today, -20) });
    await addValuation(m, { processId: ids.P2, kind: "claim", amountCents: 12_000_000, baseDate: addDaysISO(today, -90) });
    await addRiskAssessment(m, ids.P1, { classification: "probable", opinion: "Parecer fictício.", effectiveFrom: today });
    await addRiskAssessment(m, ids.P2, { classification: "possible", opinion: "Parecer fictício.", effectiveFrom: today });
    await fx.db.insert(caseBriefs).values({
      organizationId: fx.orgA,
      processId: ids.P3,
      version: 1,
      status: "failed",
      mode: "demo",
      provider: "simulação",
      model: "regras",
      promptVersion: "v1",
      inputHash: "varredura",
      errorMessage: "Falha fictícia na geração.",
    } as typeof caseBriefs.$inferInsert);
    await makeContract(fx.ctx.admin, { title: "Contrato de prestação de serviços (fictício)", startDate: addDaysISO(today, -300), endDate: addDaysISO(today, 60) });
    await makeContract(fx.ctx.admin, { title: "Contrato sem início informado (fictício)", startDate: null, endDate: addDaysISO(today, 200) });
    // Renewed contract without a start date: "Início não informado a dd/mm/aaaa" and the renewal history.
    ids.renewed = await makeContract(fx.ctx.admin, {
      title: "Contrato renovado sem início informado (fictício)",
      status: "active",
      startDate: null,
      endDate: addDaysISO(today, 60),
    });
    await renewContract(fx.ctx.admin, ids.renewed, { newEndDate: addDaysISO(today, 365), note: "Aditivo fictício." });
    await makeContract(fx.ctx.admin, { title: "Contrato por prazo indeterminado (fictício)", startDate: addDaysISO(today, -30), endDate: null });
    await makeOccurrence(fx.ctx.admin, { title: "Ocorrência sem exposição estimada (fictícia)" });
    // A batch whose analysis failed has no counts: "Contagens não calculadas", never "Não informado".
    await fx.db.insert(importBatches).values({
      organizationId: fx.orgA,
      fileName: "carteira-ficticia-com-falha.xlsx",
      fileSha256: "varredura-falha",
      sizeBytes: 1024,
      status: "failed",
      errorMessage: "Falha fictícia na leitura da planilha.",
      createdById: fx.ctx.admin.userId!,
    } as typeof importBatches.$inferInsert);
    // A preview competência, so /contingencias/provisao shows the apurada/estimada labels with data.
    await generateSnapshot(fx.ctx.admin, today.slice(0, 7));
  });

  afterAll(async () => {
    await fx?.teardown();
  });

  it("renders the touched screens", async () => {
    const admin = fx.ctx.admin;
    const pages: [string, unknown, () => Promise<{ default: PageFn }>, Record<string, string>, Record<string, string>][] = [
      ["dashboard", admin, () => import("@/app/(app)/dashboard/page"), {}, {}],
      ["contingencias", admin, () => import("@/app/(app)/contingencias/page"), {}, {}],
      ["provisao", admin, () => import("@/app/(app)/contingencias/provisao/page"), {}, {}],
      ["relatorio-exposicao", admin, () => import("@/app/(app)/relatorios/page"), {}, { tipo: "exposicao" }],
      ["relatorio-carteira", admin, () => import("@/app/(app)/relatorios/page"), {}, { tipo: "carteira" }],
      ["contrato-renovado", admin, () => import("@/app/(app)/contratos/[id]/page"), { id: ids.renewed }, {}],
      ["busca-contratos", admin, () => import("@/app/(app)/busca/page"), {}, { q: "contrato" }],
      ["importacoes", admin, () => import("@/app/(app)/importacoes/page"), {}, {}],
      ["preventivo", admin, () => import("@/app/(app)/preventivo/page"), {}, {}],
      ["analises-preliminares", admin, () => import("@/app/(app)/analises-preliminares/page"), {}, {}],
      ["contratos", admin, () => import("@/app/(app)/contratos/page"), {}, {}],
      ["processo-valores", admin, () => import("@/app/(app)/processos/[id]/page"), { id: ids.P1 }, { aba: "valores-e-acordos" }],
      ["processo-conferencia", admin, () => import("@/app/(app)/processos/[id]/page"), { id: ids.P2 }, {}],
      ["integracoes", admin, () => import("@/app/(app)/admin/integracoes/page"), {}, {}],
    ];
    for (const [name, ctx, load, params, sp] of pages) {
      const { default: page } = await load();
      const html = await render(ctx, page, params, sp);
      writeShot(name, html);
      const visible = html.replace(/<[^>]+>/g, " ");
      expect(visible, name).not.toMatch(/[—–]/);
    }
  });
});

describe.runIf(ENABLED)("comparison screenshots (two closed competências)", () => {
  let fx: import("../helpers/fixtures").Fixture;
  let last = "";

  async function render(page: PageFn, sp: Record<string, string> = {}) {
    session.current = fx.ctx.admin;
    const tree = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(sp) } as never);
    return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree)));
  }

  beforeAll(async () => {
    const { setupFixture } = await import("../helpers/fixtures");
    const { buildComparisonScenario } = await import("./comparison-scenario");
    fx = await setupFixture("varredura-comp");
    ({ last } = await buildComparisonScenario(fx));
  }, 120_000);

  afterAll(async () => {
    await fx?.teardown();
  });

  it("renders the provision and exposure reports and /contingencias/provisao with a comparison", async () => {
    const reports = (await import("@/app/(app)/relatorios/page")).default as unknown as PageFn;
    const provision = (await import("@/app/(app)/contingencias/provisao/page")).default as unknown as PageFn;
    const shots: [string, PageFn, Record<string, string>][] = [
      ["relatorio-provisao-comparacao", reports, { tipo: "provisao" }],
      ["relatorio-exposicao-comparacao", reports, { tipo: "exposicao" }],
      ["provisao-comparacao", provision, { competencia: last }],
    ];
    for (const [name, page, sp] of shots) {
      const html = await render(page, sp);
      writeShot(name, html);
      const visible = html.replace(/<[^>]+>/g, " ");
      expect(visible, name).not.toMatch(/[—–]/);
    }
  }, 120_000);
});
