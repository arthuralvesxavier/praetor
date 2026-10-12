/**
 * P0.6 "painel": the dashboard and `/contingencias/garantias` rendered on the server
 * (session mocked, real services and PGlite data). Checks the three blocks of the
 * dashboard, the collapsed "Mais indicadores", the help popover trigger, the links of
 * "Exige decisão agora" and the new idle-guarantee list.
 *
 * With `PAINEL_SHOTS_DIR` set, the rendered pages are also written there as static HTML
 * (used for the visual check with the compiled Tailwind CSS and headless Chrome).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import IdleGuaranteesPage from "@/app/(app)/contingencias/garantias/page";
import DashboardPage from "@/app/(app)/dashboard/page";
import { addDaysISO, todayISO } from "@/lib/format";
import { zonedDateTimeToUtc } from "@/modules/hearings/time";
import type { AuthContext } from "@/server/auth/context";
import {
  alerts,
  caseBriefs,
  caseIntakes,
  deadlines,
  hearings,
  legalProcesses,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processGuarantees,
  processValuations,
  settlementInstallments,
  settlements,
} from "@/server/db/schema";
import { setupFixture, type Fixture } from "../../helpers/fixtures";

let fx: Fixture;
const ids: Record<string, string> = {};
const today = todayISO();
const d = (n: number) => addDaysISO(today, n);
const SHOTS = process.env.PAINEL_SHOTS_DIR;

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

async function render(
  ctx: AuthContext,
  page: (props: never) => Promise<ReactNode>,
  searchParams: Record<string, string> = {},
): Promise<string> {
  session.current = ctx;
  const tree = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree)));
}

/** Writes a full HTML document (app-like frame: sidebar placeholder on desktop + main column). */
function shot(name: string, body: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const doc = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<link rel="stylesheet" href="app.css">
<style>:root{--font-inter:"Inter","Segoe UI",system-ui,sans-serif;--font-cormorant:Georgia,serif;}</style>
</head>
<body class="min-h-dvh bg-canvas font-sans text-foreground antialiased">
<div class="flex min-h-dvh">
<aside class="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:block"></aside>
<div class="flex min-w-0 flex-1 flex-col">
<header class="flex h-14 shrink-0 items-center border-b border-border bg-surface px-3 sm:px-6"><span class="text-sm font-semibold text-slate-900">Praetor (prévia estática)</span></header>
<main id="conteudo" class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">${body}</main>
</div>
</div>
</body>
</html>`;
  writeFileSync(path.join(SHOTS, `${name}.html`), doc, "utf8");
}

beforeAll(async () => {
  fx = await setupFixture("p06pages");
  let seq = 0;
  const proc = async (key: string, values: Partial<typeof legalProcesses.$inferInsert>) => {
    seq += 1;
    const [p] = await fx.db
      .insert(legalProcesses)
      .values({
        organizationId: fx.orgA,
        number: `${String(1_000_100 + seq * 37).padStart(7, "0")}-12.2025.5.10.0001`,
        title: `Reclamação trabalhista ${key} (fictícia)`,
        court: key.startsWith("R") ? "TRT6" : "TRT10",
        area: "labor",
        phase: "knowledge",
        instance: "first",
        city: key.startsWith("R") ? "Recife" : "Palmas",
        companyId: fx.companyA,
        ...values,
      })
      .returning();
    ids[key] = p.id;
  };
  const lawyer = fx.ctx.lawyer.userId!;
  await proc("S1", { unitId: fx.unitSp, responsibleId: lawyer, claimAmountCents: 48_000_000, liquidatedAmountCents: 31_250_075, riskPercentageBp: 10_000, lossProbability: "probable", phase: "enforcement" });
  await proc("S2", { unitId: fx.unitSp, claimAmountCents: 12_000_000, liquidatedAmountCents: 2_500_000, riskPercentageBp: 5_000, lossProbability: "possible" });
  await proc("S3", { unitId: fx.unitSp, claimAmountCents: 9_000_000, riskPercentageBp: 5_000, lossProbability: "possible" });
  await proc("S4", { unitId: fx.unitSp, claimAmountCents: 3_500_000 });
  await proc("R1", { unitId: fx.unitRe, claimAmountCents: 22_000_000, liquidatedAmountCents: 15_800_000, riskPercentageBp: 10_000, lossProbability: "probable" });
  await proc("R2", { unitId: fx.unitRe, claimAmountCents: 6_000_000, liquidatedAmountCents: 900_000, riskPercentageBp: 5_000, lossProbability: "possible", instance: null });
  await proc("C1", { unitId: fx.unitSp, isConfidential: true, claimAmountCents: 80_000_000, liquidatedAmountCents: 60_000_000, riskPercentageBp: 10_000, lossProbability: "probable" });

  await fx.db.insert(processGuarantees).values([
    { organizationId: fx.orgA, processId: ids.S1, kind: "judicial_deposit", amountCents: 8_000_000, depositedAt: d(-420), description: "Depósito para garantia do juízo" },
    { organizationId: fx.orgA, processId: ids.S1, kind: "appeal_deposit", amountCents: 1_242_600, depositedAt: d(-90) },
    { organizationId: fx.orgA, processId: ids.R1, kind: "surety_insurance", amountCents: 5_000_000, depositedAt: d(-300) },
    { organizationId: fx.orgA, processId: ids.R2, kind: "seizure", amountCents: 1_400_000, depositedAt: d(-30) },
    { organizationId: fx.orgA, processId: ids.S3, kind: "bank_guarantee", amountCents: 500_000, depositedAt: d(-200) },
  ]);

  const hearing = (processId: string, date: string, time: string, values: Partial<typeof hearings.$inferInsert> = {}) => ({
    organizationId: fx.orgA,
    processId,
    kind: "instruction" as const,
    mode: "virtual" as const,
    scheduledAt: zonedDateTimeToUtc(date, time),
    ...values,
  });
  await fx.db.insert(hearings).values([
    hearing(ids.S1, today, "00:00", { responsibleId: lawyer }),
    hearing(ids.S2, d(1), "09:30"),
    hearing(ids.R1, d(2), "14:00", { kind: "conciliation" }),
    hearing(ids.S3, d(3), "10:00"),
    hearing(ids.R2, d(5), "15:00"),
    hearing(ids.S4, d(6), "11:00"),
  ]);

  await fx.db.insert(deadlines).values([
    { organizationId: fx.orgA, title: "Contestação (fictícia)", processId: ids.S1, dueDate: d(-1), kind: "procedural" },
    { organizationId: fx.orgA, title: "Recurso ordinário (fictício)", processId: ids.R1, dueDate: d(2), kind: "procedural", responsibleId: lawyer },
    { organizationId: fx.orgA, title: "Manifestação sobre cálculos (fictícia)", processId: ids.S2, dueDate: d(4), kind: "procedural" },
    { organizationId: fx.orgA, title: "Sugestão da análise preliminar (fictícia)", processId: ids.S3, dueDate: d(5), kind: "procedural", origin: "ai_suggested", validationStatus: "pending_validation" },
  ]);

  const [s1] = await fx.db
    .insert(settlements)
    .values({ organizationId: fx.orgA, processId: ids.S2, status: "homologated", totalAmountCents: 1_200_000, installmentsCount: 6 })
    .returning();
  await fx.db.insert(settlementInstallments).values([
    { organizationId: fx.orgA, settlementId: s1.id, number: 2, dueDate: d(-3), amountCents: 200_000 },
    { organizationId: fx.orgA, settlementId: s1.id, number: 3, dueDate: d(7), amountCents: 200_000 },
  ]);

  await fx.db.insert(processValuations).values([
    { organizationId: fx.orgA, processId: ids.S3, kind: "liquidated", amountCents: 4_100_000, baseDate: d(-10), source: "simulation", isEstimate: true, reason: "Extração simulada" },
  ]);

  const brief = { organizationId: fx.orgA, mode: "demo" as const, provider: "simulated", model: "regras", promptVersion: "v1", inputHash: "h" };
  const content = { contradictions: [], missingDocuments: [], urgencies: [] } as never;
  await fx.db.insert(caseBriefs).values([
    { ...brief, processId: ids.S4, version: 1, status: "ready_for_review", content },
    { ...brief, processId: ids.R2, version: 1, status: "in_review", content },
  ]);
  await fx.db.insert(caseIntakes).values([
    { organizationId: fx.orgA, processId: ids.S4, source: "manual", status: "notified" },
    { organizationId: fx.orgA, processId: ids.R2, source: "manual", status: "received" },
  ]);
  await fx.db.insert(alerts).values([
    {
      organizationId: fx.orgA,
      type: "guarantee_idle",
      severity: "warning",
      title: "Garantia sem movimentação (fictícia)",
      message: "Mensagem fictícia",
      entityType: "legal_process",
      entityId: ids.S1,
      dedupeKey: "g1",
    },
  ]);

  const [y, m] = today.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const period = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
  const [snap] = await fx.db
    .insert(portfolioSnapshots)
    .values({
      organizationId: fx.orgA,
      period,
      referenceDate: `${period}-28`,
      status: "closed",
      metrics: {} as never,
      params: { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 1, confidenceThreshold: 85 },
      closedAt: new Date(),
    })
    .returning();
  await fx.db.insert(portfolioSnapshotItems).values([
    { snapshotId: snap.id, organizationId: fx.orgA, processId: ids.S1, number: "x", companyId: fx.companyA, unitId: fx.unitSp, liquidatedAmountCents: 30_000_000, exposureCents: 22_000_000, provisionCents: 22_000_000 },
    { snapshotId: snap.id, organizationId: fx.orgA, processId: ids.R1, number: "y", companyId: fx.companyA, unitId: fx.unitRe, liquidatedAmountCents: 15_800_000, exposureCents: 10_800_000, provisionCents: 10_800_000 },
  ]);
});

afterAll(async () => fx?.teardown());

describe("/dashboard", () => {
  it("shows the three blocks in order: decision band, portfolio (net exposure first), Mais indicadores collapsed", async () => {
    const out = await render(fx.ctx.admin, DashboardPage as never);
    shot("dashboard-admin", out);
    const at = (text: string) => out.indexOf(text);
    expect(at("Exige decisão agora")).toBeGreaterThan(-1);
    expect(at("Exige decisão agora")).toBeLessThan(at("Carteira de passivo"));
    expect(at("Carteira de passivo")).toBeLessThan(at("Exposição líquida da carteira"));
    expect(at("Exposição líquida da carteira")).toBeLessThan(at("Cobertura do valor apurado"));
    expect(at("Cobertura do valor apurado")).toBeLessThan(at("Exposição e processos por dimensão"));
    expect(at("Exposição e processos por dimensão")).toBeLessThan(at('<details id="mais-indicadores"'));
    // Collapsed by default, with the operational charts inside.
    expect(out).toMatch(/<details id="mais-indicadores" class="[^"]*">/);
    expect(out.slice(at('<details id="mais-indicadores"'))).toContain("Contencioso: entradas e encerramentos");
    // No duplicated hearings card; "Como ler" is a help button (popover), not a disclosure in the page.
    expect(out).not.toContain("Próximas audiências");
    expect(out).toMatch(/<button[^>]*aria-label="Como ler este painel"/);
    expect(out).not.toContain("<summary class=\"flex cursor-pointer list-none items-center gap-2 font-medium text-slate-800");
    // Net exposure: S1 31.250,75 mil − 92.426 mil; estimate apart.
    expect(out).toContain("Estimado");
    expect(out).toContain("O que foi abatido");
    // Exact list links of the decision band.
    expect(out).toContain('href="/audiencias?periodo=7d&amp;status=scheduled"');
    expect(out).toContain("Ver lista completa (6)");
    expect(out).toContain('href="/contingencias/garantias"');
    // Operational cards without a list that reproduces them have no link.
    expect(out).not.toMatch(/href="\/processos\?[^"]*"[^>]*>(?:(?!<\/a>)[\s\S])*Processos novos no período/);
  });

  it("opens 'Mais indicadores' when the URL chose a period; the lawyer sees 'Registro sem acesso'", async () => {
    const open = await render(fx.ctx.admin, DashboardPage as never, { periodo: "90d" });
    expect(open).toMatch(/<details id="mais-indicadores" open=""/);
    const lawyer = await render(fx.ctx.lawyer, DashboardPage as never);
    shot("dashboard-lawyer", lawyer);
    // The SP lawyer is responsible for a deadline of an RE process (invisible): never its number.
    // Decision band and "Acompanhamento" (upcoming deadlines) both name the hidden parent "Registro sem acesso".
    expect(lawyer.match(/Registro sem acesso/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(lawyer).not.toContain("Sem processo vinculado");
    const accountant = await render(fx.ctx.accountant, DashboardPage as never);
    shot("dashboard-accountant", accountant);
    expect(accountant).toContain("Exposição líquida da carteira");
  });
});

describe("/contingencias/garantias", () => {
  it("lists the idle guarantees with process links and the configured threshold", async () => {
    const out = await render(fx.ctx.admin, IdleGuaranteesPage as never);
    shot("garantias-admin", out);
    expect(out).toContain("Garantias sem movimentação");
    expect(out).toContain("180 dias ou mais");
    // S1 judicial deposit (420 days), R1 surety (300 days), S3 bank guarantee (200 days): 3 rows, oldest first.
    // Phones get a stacked list and larger screens the table: the same rows, in the same order.
    const links = (html: string) => [...new Set([...html.matchAll(/href="\/processos\/([^"?]+)\?aba=valores"/g)].map((r) => r[1]))];
    expect(links(out)).toEqual([ids.S1, ids.R1, ids.S3]);
    expect(out.match(/href="\/processos\/[^"?]+\?aba=valores"/g)).toHaveLength(6);
    expect(out).toContain("data do depósito");
    expect(out).toContain('href="/admin/configuracoes#contingencias"');
    const lawyerRe = await render(fx.ctx.lawyerRe, IdleGuaranteesPage as never);
    expect(links(lawyerRe)).toEqual([ids.R1]);
    expect(lawyerRe).not.toContain("/admin/configuracoes");
  });

  it("names a blank court as not informed instead of a dangling separator", async () => {
    // `court` is NOT NULL but imports and the empty form default can leave it blank.
    expect(await render(fx.ctx.admin, IdleGuaranteesPage as never)).toContain("TRT10 · 1º grau");
    await fx.db.update(legalProcesses).set({ court: "  " }).where(eq(legalProcesses.id, ids.S3));
    try {
      const out = await render(fx.ctx.admin, IdleGuaranteesPage as never);
      shot("garantias-sem-tribunal", out);
      expect(out).toContain("Tribunal não informado · 1º grau");
      expect(out).not.toMatch(/text-muted-foreground">\s*·/);
      expect(out).not.toContain("—");
    } finally {
      await fx.db.update(legalProcesses).set({ court: "TRT10" }).where(eq(legalProcesses.id, ids.S3));
    }
  });
});
