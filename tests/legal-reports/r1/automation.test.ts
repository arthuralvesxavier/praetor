/**
 * Automação do R1 (Relatório de Processo): aprovação da análise preliminar gera o
 * R1 pendente (sistema); a rotina diária só cria versão nova quando os dados do
 * processo mudam; um R1 aprovado nunca é substituído pelo sistema: vira alerta
 * para uma pessoa gerar a nova versão.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertHref } from "@/modules/alerts/service";
import { createGuarantee } from "@/modules/contingency/guarantee-service";
import { addProcessScenario } from "@/modules/legal-reports/scenarios";
import {
  approveLegalReport,
  currentProcessReport,
  generateProcessReport,
  getLegalReport,
  openLegalReportPdf,
  outdatedProcessReportAlertKey,
} from "@/modules/legal-reports/service";
import { alerts, auditLogs, legalReports, processScenarios, scheduledRoutines } from "@/server/db/schema";
import { ensureDefaultRoutines, runRoutine } from "@/server/jobs/routines";
import { runJobs, setupFixture, type Fixture } from "../../helpers/fixtures";
import { buildR1World, type R1World } from "./world";

let fx: Fixture;
let world: R1World;
let routineId: string;

async function refreshRoutine(): Promise<string> {
  const result = await runRoutine(routineId);
  return result?.status ?? "";
}

async function versionsOf(processId: string) {
  return fx.db
    .select({ id: legalReports.id, version: legalReports.version, status: legalReports.status, pdfSha256: legalReports.pdfSha256 })
    .from(legalReports)
    .where(and(eq(legalReports.processId, processId), eq(legalReports.type, "process_report"), eq(legalReports.isSample, false)))
    .orderBy(legalReports.version);
}

async function openOutdatedAlerts(processId: string) {
  return fx.db
    .select({ id: alerts.id, type: alerts.type, entityType: alerts.entityType, entityId: alerts.entityId })
    .from(alerts)
    .where(and(eq(alerts.dedupeKey, outdatedProcessReportAlertKey(processId)), isNull(alerts.resolvedAt)));
}

beforeAll(async () => {
  fx = await setupFixture("r1auto");
  world = await buildR1World(fx, { approveBrief: false });
  await ensureDefaultRoutines(fx.orgA);
  const [routine] = await fx.db
    .select({ id: scheduledRoutines.id })
    .from(scheduledRoutines)
    .where(and(eq(scheduledRoutines.organizationId, fx.orgA), eq(scheduledRoutines.type, "legal_reports_refresh")));
  routineId = routine.id;
}, 600_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("R1 automático", () => {
  it("sem R1, a rotina não cria nenhum (só processos que já têm R1)", async () => {
    const status = await refreshRoutine();
    expect(status).toContain("0 processo(s)");
    expect(await versionsOf(world.processId)).toHaveLength(0);
  });

  it("aprovar a análise preliminar gera o R1 pendente de revisão pelo sistema (em segundo plano)", async () => {
    const { approveCaseBrief } = await import("@/modules/briefs/service");
    await approveCaseBrief(fx.ctx.lawyer, world.briefId, { note: "Conferido (teste da automação do R1)." });
    // A aprovação só enfileira: nada é gerado dentro da transação da análise.
    expect(await versionsOf(world.processId)).toHaveLength(0);
    await runJobs();
    const versions = await versionsOf(world.processId);
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe("pending_review");
    const { view } = await getLegalReport(fx.ctx.manager, versions[0].id);
    expect(view.generatedById).toBeNull();
    expect(view.parameters.dataFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Geração auditada (ator: sistema).
    const [audit] = await fx.db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, versions[0].id), eq(auditLogs.action, "legal_report.generate")));
    expect(Number(audit.n)).toBe(1);
    // Sem cenário registrado, o sistema propôs cenários a partir dos pedidos avaliados (origem sistema, sem autor).
    const scenarios = await fx.db.select().from(processScenarios).where(eq(processScenarios.processId, world.processId));
    expect(scenarios.length).toBe(3);
    expect(scenarios.every((s) => s.origin === "system" && s.authorId === null)).toBe(true);
  }, 120_000);

  it("rotina sem dado novo não cria versão; com dado novo cria a versão seguinte pendente e preserva a anterior", async () => {
    let status = await refreshRoutine();
    expect(status).toContain("1 processo(s)");
    expect(status).toContain("0 nova(s) versão(ões)");
    let versions = await versionsOf(world.processId);
    expect(versions).toHaveLength(1);
    const v1 = versions[0];

    await createGuarantee(fx.ctx.manager, world.processId, {
      kind: "seizure",
      amountCents: 250_000,
      depositedAt: "2026-09-30",
      description: "Penhora (fictícia, teste da rotina)",
    });
    status = await refreshRoutine();
    expect(status).toContain("1 nova(s) versão(ões)");
    versions = await versionsOf(world.processId);
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [1, "superseded"],
      [2, "pending_review"],
    ]);
    expect(versions[0].pdfSha256).toBe(v1.pdfSha256);
    expect((await openLegalReportPdf(fx.ctx.manager, v1.id)).sha256).toBe(v1.pdfSha256);

    // Sem nova mudança, a rotina seguinte não gera de novo.
    status = await refreshRoutine();
    expect(status).toContain("0 nova(s) versão(ões)");
    expect(await versionsOf(world.processId)).toHaveLength(2);
  }, 180_000);

  it("R1 aprovado e desatualizado: a rotina não o substitui, abre o alerta; uma pessoa gera a nova versão e o alerta é encerrado", async () => {
    const current = await currentProcessReport(fx.orgA, world.processId);
    expect(current?.status).toBe("pending_review");
    await approveLegalReport(fx.ctx.manager, current!.id);

    // Aprovado e sem dado novo: nada acontece.
    let status = await refreshRoutine();
    expect(status).toContain("0 R1 aprovado(s) desatualizado(s)");
    expect(await openOutdatedAlerts(world.processId)).toHaveLength(0);

    await addProcessScenario(fx.ctx.manager, world.processId, {
      description: "Acordo na fase recursal (cenário fictício).",
      probabilityBand: "low",
    });
    status = await refreshRoutine();
    expect(status).toContain("1 R1 aprovado(s) desatualizado(s) com alerta");
    const versions = await versionsOf(world.processId);
    expect(versions.map((v) => v.status)).toEqual(["superseded", "approved"]);
    const open = await openOutdatedAlerts(world.processId);
    expect(open).toHaveLength(1);
    expect(open[0].type).toBe("legal_report_outdated");
    expect(open[0].entityType).toBe("legal_process");
    expect(alertHref("legal_process", world.processId, "legal_report_outdated")).toBe(
      `/processos/${world.processId}?aba=documentos-e-analises#relatorio-do-processo`,
    );
    // Rodar de novo não duplica o alerta nem gera versão.
    await refreshRoutine();
    expect(await openOutdatedAlerts(world.processId)).toHaveLength(1);
    expect(await versionsOf(world.processId)).toHaveLength(2);

    // A pessoa que pode aprovar gera a nova versão: o alerta é encerrado na mesma transação.
    const next = await generateProcessReport(fx.ctx.manager, { processId: world.processId });
    expect(next.version).toBe(3);
    expect(await openOutdatedAlerts(world.processId)).toHaveLength(0);
    status = await refreshRoutine();
    expect(status).toContain("0 nova(s) versão(ões)");
    expect(await versionsOf(world.processId)).toHaveLength(3);
  }, 180_000);

  it("análise preliminar aprovada com R1 aprovado vigente: o sistema não substitui, só alerta", async () => {
    const current = await currentProcessReport(fx.orgA, world.processId);
    await approveLegalReport(fx.ctx.manager, current!.id);
    const { regenerateCaseBrief, approveCaseBrief } = await import("@/modules/briefs/service");
    const { briefId } = await regenerateCaseBrief(fx.ctx.lawyer, world.briefId);
    await runJobs();
    await approveCaseBrief(fx.ctx.lawyer, briefId);
    await runJobs();
    const versions = await versionsOf(world.processId);
    expect(versions.at(-1)?.status).toBe("approved");
    expect(versions).toHaveLength(3);
    expect(await openOutdatedAlerts(world.processId)).toHaveLength(1);
  }, 180_000);
});
