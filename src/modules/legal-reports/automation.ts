import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveStaleAlerts } from "@/modules/alerts/service";
import { getDb } from "@/server/db/client";
import { legalProcesses } from "@/server/db/schema";
import { legalReports } from "@/server/db/schema/legal-reports";
import type { RoutineContext } from "@/server/jobs/routines";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { PROCESS_REPORT_GENERATOR } from "./process-report";
import { outdatedProcessReportAlertKey, refreshProcessReportAsSystem, type ProcessReportRefreshOutcome } from "./service";

/**
 * Automação do R1 (Relatório de Processo), sempre com o contexto de sistema:
 * - job `legal_report.generate` (enfileirado depois que uma análise preliminar é
 *   aprovada): cria o R1 do processo, ou a versão seguinte do R1 pendente quando
 *   há dado novo; um R1 aprovado nunca é substituído (alerta);
 * - rotina diária `legal_reports_refresh`: para cada processo com R1 vigente,
 *   compara a impressão digital dos dados com a gravada no R1; pendente de
 *   revisão e com dado novo, gera a versão seguinte; aprovado e com dado novo,
 *   abre o alerta `legal_report_outdated` para uma pessoa gerar a nova versão.
 *   Alertas de R1 que voltaram a refletir a base (ou foram substituídos) são encerrados.
 */

/** Versões novas geradas por execução da rotina (cada uma renderiza um PDF); o restante fica para a próxima. */
export const REFRESH_MAX_NEW_VERSIONS_PER_RUN = 40;

export const PROCESS_REPORT_JOB_TRIGGERS = ["brief_approved"] as const;

const jobPayloadSchema = z.object({
  processId: z.guid(),
  trigger: z.enum(PROCESS_REPORT_JOB_TRIGGERS),
});

/** Dedupe do job de geração do R1 de um processo (um pendente por processo). */
export function processReportJobKey(processId: string): string {
  return `legal_report.generate:${processId}`;
}

/** Corpo do job `legal_report.generate`. Payload inválido devolve false (o handler trata como falha permanente). */
export async function runProcessReportJob(organizationId: string, payload: unknown): Promise<boolean> {
  const p = jobPayloadSchema.safeParse(payload);
  if (!p.success) return false;
  const result = await refreshProcessReportAsSystem(organizationId, p.data.processId, { createIfMissing: true });
  logger.info("legal_report_job_done", { processId: p.data.processId, trigger: p.data.trigger, outcome: result.outcome });
  return true;
}

/** Processos da organização com R1 vigente (pendente ou aprovado), gerados pelo gerador do R1. */
async function processesWithCurrentReport(organizationId: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ processId: legalReports.processId })
    .from(legalReports)
    .innerJoin(legalProcesses, eq(legalProcesses.id, legalReports.processId))
    .where(
      and(
        eq(legalReports.organizationId, organizationId),
        eq(legalReports.type, "process_report"),
        eq(legalReports.isSample, false),
        inArray(legalReports.status, ["pending_review", "approved"]),
        sql`${legalReports.parameters}->>'generator' = ${PROCESS_REPORT_GENERATOR}`,
        isNull(legalProcesses.deletedAt),
      ),
    );
  return rows.map((r) => r.processId).filter((id): id is string => !!id);
}

export async function runLegalReportsRefreshRoutine(rc: RoutineContext): Promise<string> {
  const processIds = await processesWithCurrentReport(rc.organizationId);
  const tally: Record<ProcessReportRefreshOutcome | "failed", number> = {
    created: 0,
    new_version: 0,
    unchanged: 0,
    outdated_alert: 0,
    deferred: 0,
    process_not_found: 0,
    failed: 0,
  };
  const keep: string[] = [];
  let generated = 0;
  for (const processId of processIds) {
    try {
      const { outcome } = await refreshProcessReportAsSystem(rc.organizationId, processId, {
        createIfMissing: false,
        allowNewVersion: generated < REFRESH_MAX_NEW_VERSIONS_PER_RUN,
        isDemo: rc.isDemo,
      });
      tally[outcome] += 1;
      if (outcome === "new_version") generated += 1;
      if (outcome === "outdated_alert") keep.push(outdatedProcessReportAlertKey(processId));
    } catch (err) {
      tally.failed += 1;
      // Nunca o conteúdo: só o tipo do erro (mensagens de banco trazem parâmetros).
      logger.warn("legal_report_refresh_failed", {
        processId,
        errorName: err instanceof Error ? err.name : typeof err,
        code: err instanceof AppError ? err.code : undefined,
      });
    }
  }
  // R1 aprovados que voltaram a refletir a base (ou já ganharam nova versão) não ficam com alerta aberto.
  const resolved = tally.failed === 0 ? await resolveStaleAlerts(rc.organizationId, ["legal_report_outdated"], keep) : 0;
  return (
    `${processIds.length} processo(s) com Relatório de Processo (R1) vigente: ${tally.new_version} nova(s) versão(ões) pendente(s) de revisão, ` +
    `${tally.outdated_alert} R1 aprovado(s) desatualizado(s) com alerta, ${tally.unchanged} sem dado novo` +
    (tally.deferred ? `, ${tally.deferred} adiado(s) para a próxima execução` : "") +
    (tally.failed ? `, ${tally.failed} com falha (repetido na próxima execução)` : "") +
    `; ${resolved} alerta(s) encerrado(s) automaticamente.`
  );
}
