/**
 * Power BI front: /paineis-bi setup state, GET /api/bi/embed-token (auth,
 * report:read, RLS identity = Praetor user key, no secrets in the response,
 * audit), the settings validation, and the automatic refresh (routine
 * bi_access_refresh + job bi.refresh) with a fake Power BI. The session is
 * mocked; the database is PGlite with every migration.
 */
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { biUserKey } from "@/modules/bi/access";
import { embedErrorText } from "@/modules/bi/components/power-bi-embed";
import { getBiAdminOverview, requestBiRefresh, updateBiSettings } from "@/modules/bi/service";
import type { AuthContext } from "@/server/auth/context";
import {
  auditLogs,
  biProcessAccess,
  biReaderRoles,
  biRefreshRuns,
  biSettings,
  importBatches,
  jobs,
  legalProcesses,
  portfolioSnapshots,
  scheduledRoutines,
} from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { setPowerBiFetchForTesting } from "@/server/integrations/powerbi";
import { ensureDefaultRoutines, runRoutine } from "@/server/jobs/routines";
import { processPendingJobs } from "@/server/jobs/worker";
import { ValidationError, ForbiddenError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({ current: null as AuthContext | null }));
vi.mock("@/server/auth/session", () => ({
  getCurrentUser: async () => session.current,
  requirePageContext: async () => session.current,
  requireActionContext: async () => session.current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { GET } = await import("@/app/api/bi/embed-token/route");
const { default: BiPanelsPage } = await import("@/app/(app)/paineis-bi/page");
const { default: PowerBiSettingsPage } = await import("@/app/(app)/admin/integracoes/power-bi/page");

const WORKSPACE = "11111111-2222-3333-4444-555555555555";
const REPORT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DATASET = "99999999-8888-7777-6666-555555555555";
const SECRET = "client-secret-SUPER-SENSIVEL";
const AAD_TOKEN = "aad-access-token-NAO-PODE-SAIR";
const EMBED_TOKEN = "embed-token-curto-prazo";

type Call = { url: string; method: string; body: string | null };
let calls: Call[] = [];
let refreshStatus = 202;
let lastRefresh: { requestId: string; status: string } | null = null;

function fakePowerBi(input: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : null;
  calls.push({ url: input, method, body });
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } }));
  if (input.includes("/oauth2/v2.0/token")) return json({ access_token: AAD_TOKEN, expires_in: 3600 });
  if (input.endsWith(`/groups/${WORKSPACE}/reports/${REPORT}`)) {
    return json({ id: REPORT, name: "Carteira", embedUrl: `https://app.powerbi.com/reportEmbed?reportId=${REPORT}`, datasetId: DATASET });
  }
  if (input.endsWith(`/groups/${WORKSPACE}/reports`)) {
    return json({ value: [{ id: REPORT, name: "Carteira", embedUrl: "https://app.powerbi.com/reportEmbed", datasetId: DATASET }] });
  }
  if (input.endsWith("/GenerateToken")) {
    return json({ token: EMBED_TOKEN, tokenId: "tok-1", expiration: new Date(Date.now() + 20 * 60_000).toISOString() });
  }
  if (input.includes(`/datasets/${DATASET}/refreshes`) && method === "POST") {
    if (refreshStatus !== 202) return json({ error: { code: "PowerBINotAuthorizedException" } }, refreshStatus);
    return Promise.resolve(new Response(null, { status: 202, headers: { RequestId: "req-123" } }));
  }
  if (input.includes(`/datasets/${DATASET}/refreshes?$top=1`)) {
    return json({ value: lastRefresh ? [{ ...lastRefresh, endTime: new Date().toISOString() }] : [] });
  }
  return json({ error: { code: "NotFound" } }, 404);
}

function withCredentials(on: boolean) {
  if (on) {
    process.env.POWERBI_TENANT_ID = "tenant-ficticio";
    process.env.POWERBI_CLIENT_ID = "client-ficticio";
    process.env.POWERBI_CLIENT_SECRET = SECRET;
  } else {
    delete process.env.POWERBI_TENANT_ID;
    delete process.env.POWERBI_CLIENT_ID;
    delete process.env.POWERBI_CLIENT_SECRET;
  }
  resetEnvCache();
  setPowerBiFetchForTesting(fakePowerBi);
}

function request(query: string): NextRequest {
  return { nextUrl: new URL(`http://localhost/api/bi/embed-token?${query}`) } as unknown as NextRequest;
}

/** Replaces async function components by their output (react-dom/server does not run them). */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveTree(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  }
  const props = { ...el.props };
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (key === "children" || isValidElement(v) || Array.isArray(v)) props[key] = await resolveTree(v as ReactNode);
  }
  return { ...el, props } as ReactElement;
}

async function render(page: (props: never) => Promise<ReactNode>, ctx: AuthContext, sp: Record<string, string> = {}) {
  session.current = ctx;
  const tree = await (page as (p: unknown) => Promise<ReactNode>)({ params: Promise.resolve({}), searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup(createElement(Fragment, null, await resolveTree(tree)));
}

let f: Fixture;
let processId: string;

beforeAll(async () => {
  f = await setupFixture("biint");
  processId = await makeProcess(f.ctx.admin, { unitId: f.unitSp });
  withCredentials(false);
}, 240_000);

afterAll(async () => {
  withCredentials(false);
  setPowerBiFetchForTesting(null);
  await f?.teardown();
});

beforeEach(() => {
  calls = [];
  refreshStatus = 202;
  lastRefresh = null;
});

describe("/paineis-bi without configuration", () => {
  it("renders the setup state (no errors) for an executive", async () => {
    const html = await render(BiPanelsPage, f.ctx.executive);
    expect(html).toContain("Painéis Power BI ainda não configurados");
    expect(html).toContain("Peça ao administrador do Praetor");
    expect(html).toContain("docs/POWER_BI.md");
    expect(html).not.toContain("/admin/integracoes/power-bi");
    expect(html).not.toMatch(/[\u2013\u2014]/);
    expect(calls).toEqual([]);
  });

  it("links the administrator to the configuration page", async () => {
    const html = await render(BiPanelsPage, f.ctx.admin);
    expect(html).toContain('href="/admin/integracoes/power-bi"');
  });

  it("renders the administration page with the pending credentials", async () => {
    const html = await render(PowerBiSettingsPage, f.ctx.admin);
    expect(html).toContain("Credenciais do aplicativo pendentes");
    expect(html).toContain("POWERBI_CLIENT_SECRET");
    expect(html).toContain("Histórico de atualizações do Power BI");
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("settings", () => {
  it("validates ids and requires admin:organization", async () => {
    await expect(
      updateBiSettings(f.ctx.admin, {
        workspaceId: WORKSPACE,
        rlsRole: "AcessoPraetor",
        autoRefresh: true,
        reports: [{ name: "Carteira", id: "nao-e-guid", datasetId: DATASET }],
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ValidationError && Boolean(e.fieldErrors?.["reports.0.id"]));
    await expect(
      updateBiSettings(f.ctx.manager, { workspaceId: WORKSPACE, rlsRole: "AcessoPraetor", autoRefresh: true, reports: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("saves the configuration with an audit entry and never stores secrets", async () => {
    const r = await updateBiSettings(f.ctx.admin, {
      workspaceId: WORKSPACE,
      rlsRole: "AcessoPraetor",
      autoRefresh: true,
      reports: [{ name: "Carteira", id: REPORT.toUpperCase(), datasetId: DATASET }],
    });
    expect(r.changed).toBe(true);
    const [row] = await f.db.select().from(biSettings).where(eq(biSettings.organizationId, f.orgA));
    expect(row.reports).toEqual([{ name: "Carteira", id: REPORT, datasetId: DATASET }]);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    const [audit] = await f.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "organization.bi_settings_update"))
      .orderBy(desc(auditLogs.createdAt));
    expect(audit.actorId).toBe(f.ctx.admin.userId);
  });
});

describe("GET /api/bi/embed-token", () => {
  it("requires a session and report:read", async () => {
    session.current = null;
    expect((await GET(request(`report=${REPORT}`))).status).toBe(401);
    session.current = f.ctx.externalCounsel; // no report:read
    expect((await GET(request(`report=${REPORT}`))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("answers 503 (not configured) without credentials and 400/404 for bad reports", async () => {
    withCredentials(false);
    session.current = f.ctx.lawyer;
    const res = await GET(request(`report=${REPORT}`));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("ainda não foram configurados");
    withCredentials(true);
    expect((await GET(request("report=xyz"))).status).toBe(400);
    expect((await GET(request("report=12345678-1234-1234-1234-123456789012"))).status).toBe(404);
  });

  it("returns a short-lived embed token with the user's RLS identity and no secrets", async () => {
    withCredentials(true);
    session.current = f.ctx.lawyer;
    const res = await GET(request(`report=${REPORT}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(AAD_TOKEN);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ reportId: REPORT, token: EMBED_TOKEN, reportName: "Carteira" });
    expect(body.embedUrl).toContain("app.powerbi.com");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    const generate = calls.find((c) => c.url.endsWith("/GenerateToken"))!;
    const sent = JSON.parse(generate.body!);
    expect(sent.identities).toEqual([{ username: biUserKey(f.ctx.lawyer.userId!), roles: ["AcessoPraetor"], datasets: [DATASET] }]);
    expect(sent.identities[0].username).toBe(f.ctx.lawyer.userId);
    expect(sent.reports).toEqual([{ id: REPORT, allowEdit: false }]);
    expect(sent.lifetimeInMinutes).toBeLessThanOrEqual(30);
    // View only: targetWorkspaces would let the token create or save reports in the workspace.
    expect(sent).not.toHaveProperty("targetWorkspaces");
    expect(Object.keys(sent).sort()).toEqual(["datasets", "identities", "lifetimeInMinutes", "reports"]);
    expect(sent.datasets).toEqual([{ id: DATASET, xmlaPermissions: "Off" }]);

    // Renewal does not create a second audit entry within the hour.
    expect((await GET(request(`report=${REPORT}`))).status).toBe(200);
    const audits = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "bi.embed_view"), eq(auditLogs.actorId, f.ctx.lawyer.userId!)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain(EMBED_TOKEN);
    expect(audits[0].metadata).toMatchObject({ reportId: REPORT, datasetId: DATASET });
  });

  it("maps Power BI refusals to 502 with a pt-BR message", async () => {
    withCredentials(true);
    setPowerBiFetchForTesting((url, init) =>
      url.includes("/oauth2/") ? Promise.resolve(new Response(JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret" }), { status: 401 })) : fakePowerBi(url, init),
    );
    session.current = f.ctx.executive;
    const res = await GET(request(`report=${REPORT}`));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("AADSTS7000215");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    setPowerBiFetchForTesting(fakePowerBi);
  });
});

describe("automatic refresh", () => {
  async function routineId(): Promise<string> {
    await ensureDefaultRoutines(f.orgA);
    const [r] = await f.db
      .select({ id: scheduledRoutines.id })
      .from(scheduledRoutines)
      .where(and(eq(scheduledRoutines.organizationId, f.orgA), eq(scheduledRoutines.type, "bi_access_refresh")));
    return r.id;
  }
  const refreshJobs = () => f.db.select().from(jobs).where(eq(jobs.type, "bi.refresh"));
  const runs = () => f.db.select().from(biRefreshRuns).where(eq(biRefreshRuns.organizationId, f.orgA)).orderBy(desc(biRefreshRuns.createdAt));

  it("without credentials only rebuilds the access table (nothing breaks, no call)", async () => {
    withCredentials(false);
    const out = await runRoutine(await routineId());
    expect(out?.status).toContain("Acessos recalculados");
    expect(out?.status).toContain("inativa");
    expect(out?.status).not.toMatch(/[\u2013\u2014]/);
    expect(await refreshJobs()).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("a manual request without credentials is recorded as not executed", async () => {
    withCredentials(false);
    await requestBiRefresh(f.ctx.admin);
    await processPendingJobs({ organizationId: f.orgA });
    const [last] = await runs();
    expect(last.status).toBe("skipped");
    expect(last.trigger).toBe("manual");
    expect(last.message).toContain("POWERBI_CLIENT_SECRET");
    expect(last.message).not.toContain(SECRET);
  });

  it("refreshes the dataset after a committed import and records the outcome", async () => {
    withCredentials(true);
    // First run: the access table built by the earlier runs was never sent to Power BI.
    let out = await runRoutine(await routineId());
    expect(out?.status).toContain("enfileirada");
    await processPendingJobs({ organizationId: f.orgA });
    let [last] = await runs();
    expect(last.status).toBe("requested");
    expect(last.trigger).toBe("access_change");
    expect(last.requestId).toBe("req-123");
    expect(calls.some((c) => c.method === "POST" && c.url.includes(`/datasets/${DATASET}/refreshes`))).toBe(true);

    // Power BI reports completion: the next run concludes the request; nothing new to refresh.
    lastRefresh = { requestId: "req-123", status: "Completed" };
    out = await runRoutine(await routineId());
    expect(out?.status).toContain("conferida");
    expect(out?.status).toContain("Sem novidades");
    [last] = await runs();
    expect(last.status).toBe("succeeded");

    // A committed import after that is news, but the minimum interval holds it back...
    await f.db.insert(importBatches).values({
      organizationId: f.orgA,
      fileName: "planilha-ficticia.xlsx",
      fileSha256: "0".repeat(64),
      sizeBytes: 10,
      status: "committed",
      committedAt: new Date(),
      committedById: f.ctx.admin.userId,
    });
    out = await runRoutine(await routineId());
    expect(out?.status).toContain("aguarda o intervalo mínimo");

    // ...until the interval has passed.
    await f.db.update(biRefreshRuns).set({ createdAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(biRefreshRuns.organizationId, f.orgA));
    out = await runRoutine(await routineId());
    expect(out?.status).toContain("importação");
    await processPendingJobs({ organizationId: f.orgA });
    [last] = await runs();
    expect(last.trigger).toBe("import_batch");
    expect(last.status).toBe("requested");
    const [settings] = await f.db.select().from(biSettings).where(eq(biSettings.organizationId, f.orgA));
    expect(settings.sourceWatermarkAt).not.toBeNull();
  });

  it("records a refused refresh as failed (shown to the admin) and keeps the change pending", async () => {
    withCredentials(true);
    await f.db.update(biRefreshRuns).set({ createdAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(biRefreshRuns.organizationId, f.orgA));
    await f.db.insert(portfolioSnapshots).values({
      organizationId: f.orgA,
      period: "2026-09",
      referenceDate: "2026-09-30",
      status: "closed",
      metrics: {} as never,
      params: { riskPercentages: { remote: 0, possible: 50, probable: 100 }, rulesVersion: 1, confidenceThreshold: 85 },
      closedAt: new Date(),
      closedById: f.ctx.accountant.userId,
    });
    const [before] = await f.db.select().from(biSettings).where(eq(biSettings.organizationId, f.orgA));
    refreshStatus = 403;
    const out = await runRoutine(await routineId());
    expect(out?.status).toContain("competência mensal fechada");
    await processPendingJobs({ organizationId: f.orgA });
    const [last] = await runs();
    expect(last.status).toBe("failed");
    expect(last.trigger).toBe("snapshot_closed");
    expect(last.message).toContain("negou o acesso");
    const [after] = await f.db.select().from(biSettings).where(eq(biSettings.organizationId, f.orgA));
    expect(after.sourceWatermarkAt?.getTime()).toBe(before.sourceWatermarkAt?.getTime());

    const overview = await getBiAdminOverview(f.ctx.admin);
    expect(overview.runs[0]).toMatchObject({ status: "failed", datasetName: "Carteira" });
    expect(JSON.stringify(overview)).not.toContain(SECRET);
    expect(overview.readerRoles).toEqual([]);
    const html = await render(PowerBiSettingsPage, f.ctx.admin);
    expect(html).toContain("negou o acesso");
    expect(html).toContain("Nenhum registrado.");

    // The reader role registered for this organization is shown (only its name), never another organization's.
    await f.db.insert(biReaderRoles).values([
      { roleName: "praetor_bi_teste_a", organizationId: f.orgA },
      { roleName: "praetor_bi_teste_b", organizationId: f.orgB },
    ]);
    try {
      expect((await getBiAdminOverview(f.ctx.admin)).readerRoles).toEqual(["praetor_bi_teste_a"]);
      const withReader = await render(PowerBiSettingsPage, f.ctx.admin);
      expect(withReader).toContain("praetor_bi_teste_a");
      expect(withReader).not.toContain("praetor_bi_teste_b");
    } finally {
      await f.db.delete(biReaderRoles).where(inArray(biReaderRoles.roleName, ["praetor_bi_teste_a", "praetor_bi_teste_b"]));
    }
  });

  const pastTheMinimumInterval = () =>
    f.db.update(biRefreshRuns).set({ createdAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(biRefreshRuns.organizationId, f.orgA));

  it("a manual refresh covers the pending news, so the routine does not spend another one", async () => {
    withCredentials(true);
    await pastTheMinimumInterval();
    const [closed] = await f.db.select().from(portfolioSnapshots).where(eq(portfolioSnapshots.organizationId, f.orgA));
    await requestBiRefresh(f.ctx.admin);
    await processPendingJobs({ organizationId: f.orgA });
    const [last] = await runs();
    expect(last).toMatchObject({ trigger: "manual", status: "requested" });
    const [settings] = await f.db.select().from(biSettings).where(eq(biSettings.organizationId, f.orgA));
    expect(settings.sourceWatermarkAt!.getTime()).toBeGreaterThanOrEqual(closed.closedAt!.getTime());

    await pastTheMinimumInterval();
    const out = await runRoutine(await routineId());
    expect(out?.status).toContain("Sem novidades");
    expect(await f.db.select().from(jobs).where(and(eq(jobs.type, "bi.refresh"), eq(jobs.status, "queued")))).toHaveLength(0);
  });

  it("a revoked access (process made confidential) is a refresh reason by itself", async () => {
    withCredentials(true);
    await pastTheMinimumInterval();
    const lawyerLinks = () =>
      f.db
        .select({ processId: biProcessAccess.processId })
        .from(biProcessAccess)
        .where(eq(biProcessAccess.userKey, biUserKey(f.ctx.lawyer.userId!)));
    expect((await lawyerLinks()).map((r) => r.processId)).toContain(processId);

    await f.db.update(legalProcesses).set({ isConfidential: true }).where(eq(legalProcesses.id, processId));
    let out = await runRoutine(await routineId());
    expect(out?.status).toContain("retirado(s)");
    expect(out?.status).toContain("mudança nos acessos");
    expect(out?.status).toContain("enfileirada");
    expect(out?.status).not.toMatch(/[\u2013\u2014]/);
    expect((await lawyerLinks()).map((r) => r.processId)).not.toContain(processId);
    await processPendingJobs({ organizationId: f.orgA });
    const [last] = await runs();
    expect(last).toMatchObject({ trigger: "access_change", status: "requested" });

    // Held back by the minimum interval, the change stays pending instead of being lost.
    await f.db.update(legalProcesses).set({ isConfidential: false }).where(eq(legalProcesses.id, processId));
    out = await runRoutine(await routineId());
    expect(out?.status).toContain("aguarda o intervalo mínimo");
    out = await runRoutine(await routineId());
    expect(out?.status).toContain("sem mudanças");
    expect(out?.status).toContain("aguarda o intervalo mínimo");
    await pastTheMinimumInterval();
    out = await runRoutine(await routineId());
    expect(out?.status).toContain("enfileirada");
    await processPendingJobs({ organizationId: f.orgA });
    expect((await runs())[0]).toMatchObject({ trigger: "access_change", status: "requested" });
  });
});

describe("embed errors", () => {
  it("are explained in pt-BR, showing only a short code from Power BI", () => {
    expect(embedErrorText({ message: "LoadReportFailed", level: 6 })).toContain("(código LoadReportFailed)");
    expect(embedErrorText({ message: "Fail", errorCode: "PowerBIEntityNotFound" })).toContain("(código PowerBIEntityNotFound)");
    const long = embedErrorText({ message: "This content <b>is not</b> available" });
    expect(long).not.toContain("<b>");
    expect(long).not.toContain("código");
    expect(embedErrorText(undefined)).toContain("quadro abaixo");
    expect(embedErrorText(undefined)).not.toMatch(/[\u2013\u2014]/);
  });
});
