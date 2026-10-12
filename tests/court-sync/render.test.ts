/**
 * Server-render smoke test of the new screens (session mocked, PGlite):
 * /consulta-datajud, /admin/integracoes/datajud, /admin/integracoes/api,
 * /admin/integracoes (real DataJud status) and the <CourtSyncPanel> of a
 * process, with the collection inactive and active. Checks the honest labels
 * ("Coleta inativa", what the DataJud does not provide) and the absence of
 * the em dash in the text written by these screens.
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
import ConsultaPage from "@/app/(app)/consulta-datajud/page";
import DataJudHealthPage from "@/app/(app)/admin/integracoes/datajud/page";
import ApiPage from "@/app/(app)/admin/integracoes/api/page";
import IntegrationsPage from "@/app/(app)/admin/integracoes/page";
import { CourtSyncPanel } from "@/modules/court-sync/components/court-sync-panel";
import { runCourtSync } from "@/modules/court-sync/service";
import { createApiKey } from "@/modules/api-keys/service";
import { inboundRequests } from "@/server/db/schema";
import { FakeCourtProvider } from "@/server/integrations/courts/fake";
import { setCourtProviderForTesting } from "@/server/integrations/courts";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";
import { cnjNumber, emGrauDeRecurso, hearing, mv, rec } from "./helpers";

let f: Fixture;
let processId: string;
const number = cnjNumber({ seq: 501, tribunal: "10" });
const fake = new FakeCourtProvider();

function props(params: Record<string, string> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(params) } as never;
}
async function page(component: (p: never) => Promise<unknown>, params: Record<string, string> = {}): Promise<string> {
  return renderToString((await component(props(params))) as ReactElement);
}
/** Visible text written by the new screens (the shared DescriptionList renders "—" for empty values). */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

beforeAll(async () => {
  f = await setupFixture("csr");
  processId = await makeProcess(f.ctx.admin, { number, court: "TRT10", area: "labor", phase: "knowledge" });
  fake.add(
    "trt10",
    rec(number, {
      movements: [mv(26, "Distribuição", "2026-01-10"), mv(12747, "Inicial", "2026-01-11", [hearing("designada")]), mv(123, "Remessa", "2026-09-01", [emGrauDeRecurso])],
    }),
  );
  const key = await createApiKey(f.ctx.admin, { name: "ERP Fictício", scopes: ["intake:create"] });
  await f.db.insert(inboundRequests).values({
    organizationId: f.orgA,
    apiKeyId: key.id,
    endpoint: "POST /api/v1/processos",
    status: "rejected",
    httpStatus: 429,
    errorCode: "rate_limited",
  });
  // A tribunal with processes and no run yet (TRT3).
  await makeProcess(f.ctx.admin, { number: cnjNumber({ seq: 503, tribunal: "03" }), court: "TRT3", area: "labor", phase: "knowledge" });
});

afterAll(async () => {
  setCourtProviderForTesting(undefined);
  await f?.teardown();
});

describe("collection inactive (no DATAJUD_API_KEY)", () => {
  it("every screen says so and nothing breaks", async () => {
    setCourtProviderForTesting(null);
    session.current = f.ctx.admin;
    const consulta = await page(ConsultaPage, { numero: number });
    expect(consulta).toContain("Coleta inativa: configure DATAJUD_API_KEY.");
    const health = await page(DataJudHealthPage);
    expect(health).toContain("Coleta inativa: configure DATAJUD_API_KEY.");
    const integrations = await page(IntegrationsPage);
    expect(integrations).toContain("Coleta inativa");
    expect(integrations).toContain("/admin/integracoes/datajud");
    expect(integrations).toContain("/admin/integracoes/api");
    const panel = renderToString((await CourtSyncPanel({ ctx: f.ctx.lawyer, processId })) as ReactElement);
    expect(panel).toContain("Coleta inativa: configure DATAJUD_API_KEY.");
    expect(panel).not.toContain("Sincronizar agora");
  });
});

describe("collection active", () => {
  it("lookup page shows the official data without saving and offers the intake prefill", async () => {
    setCourtProviderForTesting(fake);
    session.current = f.ctx.lawyer;
    const other = cnjNumber({ seq: 502, tribunal: "10" });
    fake.add("trt10", rec(other, { movements: [mv(26, "Distribuição", "2026-02-01")] }));
    const html = await page(ConsultaPage, { numero: other });
    expect(html).toContain("Ação Trabalhista - Rito Sumaríssimo");
    expect(html).toContain("O DataJud não informa partes, valores, documentos nem a data das audiências.");
    expect(html).toContain("Registrar como processo recebido");
    expect(html).toContain("/entrada/nova?numero=");
    expect(text(html)).not.toMatch(/—|–/);
    const existing = await page(ConsultaPage, { numero: number });
    expect(existing).toContain("Abrir o processo na carteira");
  });

  it("process panel, health page and API page render after a sync", async () => {
    setCourtProviderForTesting(fake);
    await runCourtSync(f.orgA, { trigger: "manual", processIds: [processId] });
    const panel = renderToString((await CourtSyncPanel({ ctx: f.ctx.lawyer, processId })) as ReactElement);
    expect(panel).toContain("Acompanhamento no DataJud (CNJ)");
    expect(panel).toContain("Encontrado no DataJud");
    expect(panel).toContain("Sincronizar agora");
    expect(text(panel)).not.toMatch(/—|–/);
    // Executive (no court_sync:run): panel without the button.
    const execPanel = renderToString((await CourtSyncPanel({ ctx: f.ctx.executive, processId })) as ReactElement);
    expect(execPanel).not.toContain("Sincronizar agora");
    // Another organization: renders nothing.
    expect(await CourtSyncPanel({ ctx: f.ctx.adminB, processId })).toBeNull();

    session.current = f.ctx.admin;
    const health = await page(DataJudHealthPage);
    expect(health).toContain("TRT10");
    expect(health).toContain("Sincronizar a carteira agora");
    // A tribunal that never ran shows that there is no result, not zeros.
    const trt3Row = text(health).split("TRT3")[1]?.split("TRT10")[0] ?? "";
    expect(trt3Row).toContain("Sem execução");
    expect(trt3Row).not.toMatch(/(^|\s)0(\s|$)/);
    expect(health).toContain("Rotina de acompanhamento");
    expect(health).toContain("Parâmetros");
    const api = await page(ApiPage);
    expect(api).toContain("ERP Fictício");
    expect(api).toContain("/api/v1/openapi.json");
    // Error codes are shown in pt-BR, never raw.
    expect(api).toContain("limite de requisições por minuto atingido");
    expect(text(api)).not.toContain("rate_limited");
    expect(text(api)).not.toMatch(/—|–/);
    const integrations = await page(IntegrationsPage);
    expect(integrations).toContain("Operacional (API pública do CNJ)");
  });
});
