import { and, desc, eq } from "drizzle-orm";
import { pluralize } from "@/lib/format";
import { systemContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { caseIntakes } from "@/server/db/schema";
import { COURT_COLLECTION_INACTIVE, aliasLabel, getCourtProvider } from "@/server/integrations/courts";
import { enqueueJob } from "@/server/jobs/queue";
import type { RoutineContext } from "@/server/jobs/routines";
import { logger } from "@/server/lib/logger";
import { aliasesWithPendingSync, courtSyncJobKey, listDueAliases } from "./service";

/**
 * Routine bodies (wired in src/server/jobs/routines.ts).
 *
 * `court_sync` (hourly by default): enqueues one "court_sync.run" job per
 * tribunal of origin with due processes. Each process is due when its own
 * interval (`syncIntervalHours`) or its error backoff has passed, so running
 * the routine often costs one query when nothing is due. The jobs do the
 * DataJud queries (rate limited per tribunal), so a long portfolio never
 * blocks the routine. A tribunal that already has a job queued or running is
 * left for that job.
 *
 * `simulated_feed`: DEMO organizations only, when enabled in the settings: one
 * fictitious incoming case (labeled as simulated everywhere) per interval.
 */
export async function runCourtSyncRoutine(rc: RoutineContext): Promise<string> {
  if (!getCourtProvider()) return COURT_COLLECTION_INACTIVE;
  const settings = rc.settings.integrations.datajud;
  if (!settings.enabled) return "Acompanhamento automático no DataJud desativado nas configurações.";
  const due = await listDueAliases(rc.organizationId, settings);
  if (due.length === 0) return "Nenhum processo da carteira ativa aguardando consulta ao DataJud.";
  const pending = await aliasesWithPendingSync(rc.organizationId);
  const skipped = due.filter((g) => pending.has(g.alias)).length;
  let queued = 0;
  for (const g of due) {
    if (pending.has(g.alias)) continue;
    const r = await enqueueJob({
      type: "court_sync.run",
      organizationId: rc.organizationId,
      payload: { alias: g.alias, trigger: "routine" },
      dedupeKey: courtSyncJobKey(rc.organizationId, g.alias),
      maxAttempts: 2,
    });
    if (!r.deduplicated) queued++;
  }
  const total = due.reduce((s, g) => s + g.processes, 0);
  return (
    `${pluralize(total, "processo aguardando", "processos aguardando")} consulta ao DataJud em ` +
    `${pluralize(due.length, "tribunal", "tribunais")} (${due.map((g) => `${aliasLabel(g.alias)}: ${g.processes}`).join(", ")}); ` +
    `${pluralize(queued, "tarefa enfileirada", "tarefas enfileiradas")}` +
    `${skipped > 0 ? ` (${pluralize(skipped, "tribunal já tinha", "tribunais já tinham")} consulta em andamento)` : ""}.`
  );
}

export async function runSimulatedFeedRoutine(rc: RoutineContext): Promise<string> {
  const feed = rc.settings.integrations.simulatedFeed;
  if (!rc.isDemo) return "Chegada simulada disponível só em organizações de demonstração.";
  if (!feed.enabled) return "Chegada automática simulada desativada nas configurações.";
  const [last] = await getDb()
    .select({ receivedAt: caseIntakes.receivedAt })
    .from(caseIntakes)
    .where(and(eq(caseIntakes.organizationId, rc.organizationId), eq(caseIntakes.source, "simulated_feed")))
    .orderBy(desc(caseIntakes.receivedAt))
    .limit(1);
  const intervalMs = Math.max(5, feed.intervalMinutes) * 60_000;
  if (last && Date.now() - last.receivedAt.getTime() < intervalMs) {
    const minutes = Math.ceil((intervalMs - (Date.now() - last.receivedAt.getTime())) / 60_000);
    return `Próxima chegada simulada em cerca de ${pluralize(minutes, "minuto", "minutos")}.`;
  }
  const { simulateIncomingProcess } = await import("@/modules/intake/service");
  const result = await simulateIncomingProcess(systemContext(rc.organizationId, true));
  logger.info("simulated_feed_arrival", { organizationId: rc.organizationId, intakeId: result.intakeId });
  return `Chegada simulada (dados fictícios): processo ${result.number} recebido e encaminhado ao fluxo de entrada.`;
}
