import type { RoutineContext } from "@/server/jobs/routines";
import { enqueueJob } from "@/server/jobs/queue";
import { getPowerBiCredentials } from "@/server/integrations/powerbi";
import { formatNumber } from "@/lib/format";
import { refreshBiAccess } from "./access";
import { loadBiConfig } from "./config";
import { syncBiLabels } from "./labels";
import { checkRequestedRefreshes, decideAutomaticRefresh, refreshBlocker, refreshPolicyFrom, triggerLabel } from "./refresh";

/** Dedupe key of the pending `bi.refresh` job of an organization. */
export function biRefreshDedupeKey(organizationId: string): string {
  return `bi.refresh:${organizationId}`;
}

/**
 * Rotina `bi_access_refresh` (padrão: a cada 60 minutos):
 *  1. sincroniza os rótulos e atualiza a tabela de acessos (`bi.acesso`),
 *     registrando quando ela muda;
 *  2. confere o resultado das atualizações já pedidas ao Power BI;
 *  3. se houver importação confirmada/desfeita, competência fechada, coleta
 *     nos tribunais com novidades ou mudança nos acessos desde a última
 *     atualização (ou se a agenda periódica venceu), enfileira o job
 *     `bi.refresh`, respeitando o intervalo mínimo e o limite diário
 *     (configuração da rotina). Uma mudança de acesso adiada por esse limite
 *     continua pendente até ser atendida (não se perde).
 * Sem credenciais ou sem painéis cadastrados, faz só o passo 1.
 */
export async function runBiAccessRefreshRoutine(rc: RoutineContext): Promise<string> {
  await syncBiLabels();
  const access = await refreshBiAccess(rc.organizationId);
  const parts = [
    `Acessos recalculados: ${formatNumber(access.users)} usuário(s) ativo(s) e ${formatNumber(access.rows)} vínculo(s) entre usuário e processo` +
      (access.changes > 0 ? ` (${formatNumber(access.changes)} vínculo(s) incluído(s) ou retirado(s) nesta execução).` : ", sem mudanças."),
  ];

  const config = await loadBiConfig(rc.organizationId);
  const blocker = refreshBlocker(config, getPowerBiCredentials() !== null);
  if (blocker) {
    parts.push(`Atualização do Power BI inativa: ${blocker}`);
    return parts.join(" ");
  }

  const concluded = await checkRequestedRefreshes(rc.organizationId, config);
  if (concluded > 0) parts.push(`${formatNumber(concluded)} atualização(ões) anterior(es) conferida(s) no Power BI.`);

  if (!config.autoRefresh) {
    parts.push("Atualização automática desligada na configuração dos painéis.");
    return parts.join(" ");
  }

  const decision = await decideAutomaticRefresh(rc.organizationId, config, refreshPolicyFrom(rc.config));
  if (decision.kind === "enqueue") {
    const { deduplicated } = await enqueueJob({
      type: "bi.refresh",
      organizationId: rc.organizationId,
      payload: { trigger: decision.trigger, watermark: decision.watermark ? decision.watermark.toISOString() : null },
      dedupeKey: biRefreshDedupeKey(rc.organizationId),
    });
    parts.push(
      deduplicated
        ? "Já existe uma atualização do Power BI na fila."
        : `Atualização do Power BI enfileirada (motivo: ${triggerLabel(decision.trigger).toLowerCase()}).`,
    );
  } else if (decision.kind === "throttled") {
    parts.push(
      `Há motivo para atualizar (${triggerLabel(decision.trigger).toLowerCase()}), mas a solicitação aguarda o intervalo mínimo ` +
        "ou o limite diário de atualizações.",
    );
  } else {
    parts.push("Sem novidades desde a última atualização do Power BI.");
  }
  return parts.join(" ");
}
