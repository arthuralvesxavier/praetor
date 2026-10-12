import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIntegrations, getIntegrationsOverview } from "@/modules/admin/integrations";
import { caseBriefs, emailMessages, importBatches, jobs, legalProcesses } from "@/server/db/schema";
import { ForbiddenError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

let fx: Fixture;
const NOW = new Date("2026-10-11T15:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeAll(async () => {
  fx = await setupFixture("integ");
  const a = fx.orgA;
  await fx.db.insert(jobs).values([
    { organizationId: a, type: "document.extract_text", status: "queued", createdAt: minutesAgo(90), runAt: minutesAgo(90) },
    { organizationId: a, type: "document.extract_text", status: "queued", createdAt: minutesAgo(5), runAt: minutesAgo(5) },
    {
      organizationId: a,
      type: "case_brief.generate",
      status: "dead",
      attempts: 3,
      maxAttempts: 3,
      lastError: "Erro interno (Error).",
      createdAt: minutesAgo(300),
      completedAt: minutesAgo(200),
    },
    {
      organizationId: a,
      type: "routine.run",
      status: "queued",
      attempts: 1,
      lastError: "Execução interrompida; tarefa devolvida à fila.",
      createdAt: minutesAgo(30),
      runAt: minutesAgo(-10),
    },
    { organizationId: a, type: "analysis.run", status: "succeeded", createdAt: minutesAgo(1000), completedAt: minutesAgo(999) },
    // Organization B must never be counted for A.
    { organizationId: fx.orgB, type: "document.extract_text", status: "dead", lastError: "x", createdAt: minutesAgo(10_000) },
    { organizationId: fx.orgB, type: "document.extract_text", status: "queued", createdAt: minutesAgo(10_000) },
  ]);
  await fx.db.insert(importBatches).values([
    {
      organizationId: a,
      fileName: "Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx",
      fileSha256: "a".repeat(64),
      sizeBytes: 1000,
      status: "committed",
      stats: {
        rowsRead: 1166,
        processesDetected: 950,
        toCreate: 950,
        toUpdate: 0,
        unchanged: 0,
        instanceLinks: 216,
        errors: 3,
        warnings: 40,
        duplicatesInSheet: 0,
        divergences: 12,
        ignoredRows: 5,
      },
    },
    { organizationId: fx.orgB, fileName: "outra-organizacao.xlsx", fileSha256: "b".repeat(64), sizeBytes: 10, status: "failed" },
  ]);
  const [p] = await fx.db
    .insert(legalProcesses)
    .values({ organizationId: a, number: "0000100-00.2026.5.10.0001", title: "Processo fictício", court: "TRT10", area: "labor", phase: "knowledge" })
    .returning();
  const brief = {
    organizationId: a,
    processId: p.id,
    mode: "demo" as const,
    provider: "simulated",
    model: "regras",
    promptVersion: "v1",
    inputHash: "h",
  };
  await fx.db.insert(caseBriefs).values([
    { ...brief, version: 1, status: "approved" },
    { ...brief, version: 2, status: "ready_for_review" },
  ]);
  const email = {
    organizationId: a,
    mode: "simulated" as const,
    provider: "simulated",
    toName: "Destinatário fictício",
    toAddress: "destinatario@empresa.test",
    fromName: "Praetor (simulação)",
    fromAddress: "nao-responda@praetor.invalid",
    subject: "[Simulação] Assunto",
    bodyText: "corpo",
    bodyHtml: "<p>corpo</p>",
  };
  await fx.db.insert(emailMessages).values([
    { ...email, template: "case_brief_ready", status: "simulated", createdAt: minutesAgo(60) },
    { ...email, template: "case_brief_ready", status: "simulated", createdAt: minutesAgo(120) },
    { ...email, template: "intake_assigned", status: "failed", createdAt: minutesAgo(60) },
    // Older than 7 days: not counted.
    { ...email, template: "daily_digest", status: "simulated", createdAt: minutesAgo(8 * 24 * 60) },
    { ...email, organizationId: fx.orgB, template: "daily_digest", status: "simulated", createdAt: minutesAgo(10) },
  ]);
});

afterAll(async () => fx.teardown());

describe("integrations catalog (honest status)", () => {
  it("lists tribunal integrations as not integrated and AI/e-mail as simulations", () => {
    const items = describeIntegrations();
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    for (const key of ["datajud", "mni", "pje-acervo", "trt-consulta", "diario"]) {
      expect(byKey[key].status).toBe("not_integrated");
      expect(byKey[key].statusText).toBe("Não integrado nesta versão");
    }
    expect(byKey["case-brief-ai"].status).toBe("demo");
    expect(byKey["case-brief-ai"].statusText).toBe("Simulação demonstrativa");
    expect(byKey.email).toMatchObject({ status: "simulated", statusText: "Simulado" });
    expect(byKey["text-extraction"].statusText).toMatch(/sem OCR/);
    // AI_PROVIDER=demo in the fixture: the Central de IA runs in demonstrative mode.
    expect(byKey["analysis-ai"].status).toBe("demo");
    expect(byKey.storage.status).toBe("operational");
  });
});

describe("getIntegrationsOverview", () => {
  it("requires admin:organization", async () => {
    for (const c of [fx.ctx.manager, fx.ctx.auditor, fx.ctx.executive, fx.ctx.lawyer]) {
      await expect(getIntegrationsOverview(c, { now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("reports queue, routines, imports, briefs and simulated e-mails of the organization only", async () => {
    const data = await getIntegrationsOverview(fx.ctx.admin, { now: NOW });

    expect(data.queue.byStatus).toEqual({ queued: 3, running: 0, succeeded: 1, failed: 0, dead: 1 });
    const extract = data.queue.byType.find((t) => t.type === "document.extract_text");
    expect(extract?.byStatus.queued).toBe(2);
    expect(extract?.byStatus.dead).toBe(0);
    expect(data.queue.oldestQueued).toMatchObject({ type: "document.extract_text", ageMinutes: 90 });
    expect(data.queue.issues.map((i) => i.type).sort()).toEqual(["case_brief.generate", "routine.run"]);
    expect(data.queue.issues.find((i) => i.status === "dead")?.lastError).toBe("Erro interno (Error).");

    expect(data.routines.length).toBeGreaterThan(0);
    expect(data.importBatches.map((b) => b.fileName)).toEqual(["Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx"]);
    expect(data.importBatches[0].stats?.divergences).toBe(12);

    expect(data.briefs.total).toBe(2);
    expect(data.briefs.byStatus.ready_for_review).toBe(1);
    expect(data.briefs.byStatus.approved).toBe(1);

    expect(data.emails.last7Days).toBe(3);
    expect(data.emails.failedLast7Days).toBe(1);
    expect(data.emails.byTemplate).toEqual([
      { template: "case_brief_ready", count: 2 },
      { template: "intake_assigned", count: 1 },
    ]);

    const b = await getIntegrationsOverview(fx.ctx.adminB, { now: NOW });
    expect(b.queue.byStatus).toEqual({ queued: 1, running: 0, succeeded: 0, failed: 0, dead: 1 });
    expect(b.importBatches.map((x) => x.fileName)).toEqual(["outra-organizacao.xlsx"]);
    expect(b.briefs.total).toBe(0);
    expect(b.emails.last7Days).toBe(1);
  });
});
