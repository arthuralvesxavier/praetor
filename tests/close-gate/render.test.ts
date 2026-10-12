/**
 * P1.9: server render of /contingencias/provisao with the close gate (session
 * mocked, PGlite): the list of unclassified processes before the close, the
 * disabled normal close + "Fechar com justificativa", and the override notice
 * on the closed competência.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/session", () => ({
  requirePageContext: vi.fn(async () => session.current),
  requireActionContext: vi.fn(async () => session.current),
  getCurrentUser: vi.fn(async () => session.current),
}));

import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { closeSnapshotAction } from "@/modules/contingency/actions";
import { periodOf } from "@/modules/contingency/rules";
import { generateSnapshot, getSnapshotStatus } from "@/modules/contingency/snapshot-service";
import { legalProcesses, processRiskAssessments } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import ProvisionPage from "@/app/(app)/contingencias/provisao/page";

let f: Fixture;
const today = todayISO();
const current = periodOf(today);
const previous = previousPeriod(current);
const NUM = { classified: "3200001-11.2025.5.10.0009", open: "3200002-11.2025.5.10.0009", secret: "3200003-11.2025.5.10.0009" };

/** Rendered HTML without React's text separators (`<!-- -->`). */
function html(el: unknown): string {
  return renderToString(el as ReactElement).replaceAll("<!-- -->", "");
}

function sp(params: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(params) };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeAll(async () => {
  f = await setupFixture("closegaterender");
  const base = { organizationId: f.orgA, court: "TRT-10", area: "labor" as const, phase: "knowledge" as const, filedAt: "2025-01-10" };
  const [classified] = await f.db
    .insert(legalProcesses)
    .values({ ...base, number: NUM.classified, title: "Processo fictício classificado", unitId: f.unitSp })
    .returning({ id: legalProcesses.id });
  await f.db.insert(legalProcesses).values({
    ...base,
    number: NUM.open,
    title: "Processo fictício sem classificação",
    unitId: f.unitSp,
    responsibleId: f.ctx.lawyer.userId,
  });
  await f.db.insert(legalProcesses).values({ ...base, number: NUM.secret, title: "Processo sigiloso fictício", isConfidential: true });
  await f.db.insert(processRiskAssessments).values({
    organizationId: f.orgA,
    processId: classified.id,
    classification: "remote",
    percentageBp: 0,
    opinion: "Parecer fictício de teste.",
    effectiveFrom: `${previous}-01`,
    status: "official",
    assessedById: f.ctx.admin.userId,
    reviewedById: f.ctx.admin.userId,
    reviewedAt: new Date(),
  });
  await generateSnapshot(f.ctx.accountant, previous);
});

afterAll(async () => {
  await f?.teardown();
});

describe("/contingencias/provisao close gate", () => {
  it("before the close: lists the unclassified processes, disables the normal close and offers the justified close", async () => {
    session.current = f.ctx.accountant;
    const out = html(await ProvisionPage(sp({ competencia: previous })));
    expect(out).toContain("processo(s) sem classificação de risco oficial em");
    expect(out).toContain(NUM.open);
    expect(out).not.toContain(NUM.secret);
    expect(out).not.toContain(NUM.classified + "</a><span class=\"block max-w-md");
    expect(out).toContain("Laura Advogada SP");
    expect(out).toContain("sigiloso(s) não listado(s) para o seu perfil");
    expect(out).toContain("Fechar com justificativa");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="close-gate-reason"/);
    expect(out).toContain("Classificar");

    session.current = f.ctx.executive;
    const exec = html(await ProvisionPage(sp({ competencia: previous })));
    expect(exec).toContain("Ver risco");
    expect(exec).not.toContain("Fechar com justificativa");
  });

  it("the normal close action is refused with the list; the justified one closes and the closed page shows the override", async () => {
    session.current = f.ctx.accountant;
    const refused = await closeSnapshotAction(null, form({ period: previous }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain(NUM.open);

    const short = await closeSnapshotAction(null, form({ period: previous, mode: "justified", justification: "curta" }));
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.fieldErrors?.justification?.[0]).toContain("20 caracteres");

    const ok = await closeSnapshotAction(
      null,
      form({ period: previous, mode: "justified", justification: "Classificação dos processos novos pendente com o escritório." }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.message).toContain("fechada com justificativa (2 processo(s)");
    expect(await getSnapshotStatus(f.orgA, previous)).toBe("closed");

    const closed = html(await ProvisionPage(sp({ competencia: previous })));
    expect(closed).toContain("Fechada com justificativa");
    expect(closed).toContain("Fechada com 2 processo(s) sem classificação, justificativa:");
    expect(closed).toContain("Classificação dos processos novos pendente com o escritório.");
    expect(closed).toContain("Clara Contadora");
    expect(closed).toContain("1 processo(s) sigiloso(s) não listado(s)");
    expect(closed).not.toContain("Fechar com justificativa");

    // A unit-scoped viewer with none of those processes listed: neutral line, no org-level justification.
    session.current = f.ctx.lawyerRe;
    const other = html(await ProvisionPage(sp({ competencia: previous })));
    expect(other).toContain("Fechada com ressalva");
    expect(other).toContain("Nenhum dos processos que você pode ver estava sem classificação de risco oficial");
    expect(other).not.toContain("Classificação dos processos novos pendente com o escritório.");
    expect(other).not.toContain("Fechada com 0 processo(s)");
  });

  it("a stale preview shows the recalculation reasons and offers no close", async () => {
    session.current = f.ctx.accountant;
    // A new process active on the reference date of the current month, registered after its preview.
    await generateSnapshot(f.ctx.accountant, current);
    await f.db.insert(legalProcesses).values({
      organizationId: f.orgA,
      court: "TRT-10",
      area: "labor",
      phase: "knowledge",
      filedAt: "2025-01-10",
      number: "3200004-11.2025.5.10.0009",
      title: "Processo fictício cadastrado depois da prévia",
      unitId: f.unitSp,
    });
    const out = html(await ProvisionPage(sp({ competencia: current })));
    expect(out).toContain("Recalcule a prévia");
    expect(out).toContain("A prévia está desatualizada em relação à carteira ou às classificações de risco");
    expect(out).toContain("1 processo ativo na data-base não está na prévia (cadastrado ou alterado depois do cálculo).");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="close-gate-reason"/);
    expect(out).not.toContain("Fechar com justificativa");
  });
});
