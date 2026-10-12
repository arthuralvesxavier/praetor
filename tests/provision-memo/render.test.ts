/**
 * P1.10: server render of /contingencias/provisao with the downloads of the
 * memória de cálculo (session mocked, PGlite).
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
// PDF row limit, lowered in one test (the real limit needs thousands of processes).
const pdfLimit = vi.hoisted(() => ({ rows: null as number | null }));
vi.mock("@/modules/provision-memo/memo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/provision-memo/memo")>();
  return {
    ...actual,
    get PROVISION_MEMO_PDF_ROW_LIMIT() {
      return pdfLimit.rows ?? actual.PROVISION_MEMO_PDF_ROW_LIMIT;
    },
  };
});

import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { previousPeriod } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { periodOf } from "@/modules/contingency/rules";
import { generateSnapshot } from "@/modules/contingency/snapshot-service";
import { legalProcesses } from "@/server/db/schema";
import { setupFixture, type Fixture } from "../helpers/fixtures";
import ProvisionPage from "@/app/(app)/contingencias/provisao/page";

let f: Fixture;
const current = periodOf(todayISO());
const previous = previousPeriod(current);
const older = previousPeriod(previous);

function html(el: unknown): string {
  return renderToString(el as ReactElement).replaceAll("<!-- -->", "");
}

const sp = (params: Record<string, string>) => ({ searchParams: Promise.resolve(params) });

beforeAll(async () => {
  f = await setupFixture("pmemorender");
  await f.db.insert(legalProcesses).values({
    organizationId: f.orgA,
    number: "4200001-11.2025.5.10.0009",
    title: "Processo fictício da memória",
    court: "TRT-10",
    area: "labor",
    phase: "knowledge",
    filedAt: "2024-01-10",
    unitId: f.unitSp,
    claimAmountCents: 1_000_000,
  });
  await generateSnapshot(f.ctx.accountant, previous);
});

afterAll(async () => {
  await f?.teardown();
});

describe("provision page: memória de cálculo downloads", () => {
  it("offers the XLSX and the PDF of the calculated competência (preview labeled)", async () => {
    for (const ctx of [f.ctx.accountant, f.ctx.lawyer, f.ctx.executive]) {
      session.current = ctx;
      const out = html(await ProvisionPage(sp({ competencia: previous })));
      expect(out).toContain(`href="/api/provision-memo/${previous}?formato=xlsx"`);
      expect(out).toContain(`href="/api/provision-memo/${previous}?formato=pdf"`);
      expect(out).toContain("Memória em XLSX");
      expect(out).toContain("Memória em PDF");
      expect(out).toContain("Baixar a memória de cálculo em PDF (prévia, sujeita a alteração)");
    }
  });

  it("above the PDF row limit offers only the XLSX and says why", async () => {
    session.current = f.ctx.accountant;
    pdfLimit.rows = 0;
    try {
      const out = html(await ProvisionPage(sp({ competencia: previous })));
      expect(out).toContain(`href="/api/provision-memo/${previous}?formato=xlsx"`);
      expect(out).not.toContain(`href="/api/provision-memo/${previous}?formato=pdf"`);
      expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="provision-memo-pdf-limit"/);
      expect(out).toContain("O PDF da memória é gerado até 0 processos. Esta competência tem 1: baixe o XLSX.");
    } finally {
      pdfLimit.rows = null;
    }
  });

  it("offers nothing for a competência that was never calculated", async () => {
    session.current = f.ctx.accountant;
    const out = html(await ProvisionPage(sp({ competencia: older })));
    expect(out).not.toContain("/api/provision-memo/");
  });
});
