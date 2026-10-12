/**
 * Close gate of the monthly close (P1.9): pure, client-safe constants and pt-BR
 * messages shared by the snapshot service and the provision page.
 *
 * A competência closes without reservation only when every process active on
 * the reference date has an OFFICIAL risk classification in force on that date
 * (`process_risk_assessments`, status `official`, `effective_from <= data-base`;
 * classifications derived from the claims are recorded there too). Otherwise
 * it closes only with a written justification, stored with the list of
 * unclassified processes (`snapshot_close_overrides`).
 *
 * The gate is evaluated on the items of the preview (the population that the
 * close freezes), and the close is refused while the preview is stale
 * (`PreviewStaleness`): the override list is then always a subset of the
 * closed items, and no phase/instance older than the process record (or of the
 * model before P0.5) is frozen into a closed competência.
 */
import { z } from "zod";

/** Minimum length of the justification (the database checks the same). */
export const CLOSE_JUSTIFICATION_MIN_LENGTH = 20;
export const CLOSE_JUSTIFICATION_MAX_LENGTH = 2000;

export const closeJustificationSchema = z.object({
  justification: z
    .string({ error: "Informe a justificativa do fechamento." })
    .trim()
    .min(
      CLOSE_JUSTIFICATION_MIN_LENGTH,
      `Descreva a justificativa com pelo menos ${CLOSE_JUSTIFICATION_MIN_LENGTH} caracteres.`,
    )
    .max(CLOSE_JUSTIFICATION_MAX_LENGTH, `Use no máximo ${CLOSE_JUSTIFICATION_MAX_LENGTH} caracteres.`),
});

/** Alert type raised by the monthly routine (one open alert per process). */
export const CLOSE_BLOCKED_ALERT_TYPE = "snapshot_close_blocked" as const;
export const closeBlockedAlertKey = (processId: string) => `${CLOSE_BLOCKED_ALERT_TYPE}:${processId}`;

/** How many process numbers an error message lists before "e mais N". */
const MESSAGE_LIST_LIMIT = 10;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Message of a close refused because of unclassified processes. `numbers` are
 * the ones the person may see; `hiddenCount` the others (never named).
 */
export function closeBlockedMessage(input: {
  periodLabel: string;
  referenceDateLabel: string;
  total: number;
  numbers: readonly string[];
  hiddenCount: number;
}): string {
  const { total, numbers, hiddenCount } = input;
  const shown = numbers.slice(0, MESSAGE_LIST_LIMIT);
  const rest = numbers.length - shown.length;
  const parts: string[] = [];
  if (shown.length) parts.push(shown.join(", ") + (rest > 0 ? ` e mais ${rest}` : ""));
  if (hiddenCount > 0) parts.push(`${hiddenCount} ${plural(hiddenCount, "sigiloso não listado", "sigilosos não listados")}`);
  return (
    `Fechamento de ${input.periodLabel} bloqueado: ${total} ${plural(total, "processo ativo", "processos ativos")} sem ` +
    `classificação de risco oficial em vigor em ${input.referenceDateLabel}` +
    (parts.length ? ` (${parts.join("; ")})` : "") +
    ". Registre a classificação com parecer, vigente até a data-base, ou feche com justificativa."
  );
}

/**
 * Why a preview no longer matches what would be frozen (org-wide counts). The
 * close always freezes the STORED items, so it is refused until the preview
 * is recalculated when any of these is not zero.
 */
export type PreviewStaleness = {
  /**
   * Items whose official classification in force on the reference date was
   * recorded or reviewed after the preview, or differs from the stored one.
   */
  classified: number;
  /** Processes active on the reference date that are not in the preview (registered or changed afterwards). */
  added: number;
  /** Items no longer active on the reference date (deleted, closed before it or filed after it). */
  removed: number;
  /**
   * Items whose stored phase or instance no longer matches the process (changed after the preview),
   * including a phase of the previous model (preview calculated before the P0.5 migration).
   */
  changed: number;
};

export function isPreviewStale(s: PreviewStaleness): boolean {
  return s.classified > 0 || s.added > 0 || s.removed > 0 || s.changed > 0;
}

/** pt-BR reasons of a stale preview, one per non-zero count. */
export function stalePreviewReasons(s: PreviewStaleness): string[] {
  const reasons: string[] = [];
  if (s.classified > 0) {
    reasons.push(
      `${s.classified} ${plural(s.classified, "processo teve a classificação de risco oficial registrada", "processos tiveram a classificação de risco oficial registrada")} ` +
        "depois do cálculo, com vigência até a data-base",
    );
  }
  if (s.added > 0) {
    reasons.push(
      `${s.added} ${plural(s.added, "processo ativo na data-base não está na prévia", "processos ativos na data-base não estão na prévia")} ` +
        "(cadastrado ou alterado depois do cálculo)",
    );
  }
  if (s.removed > 0) {
    reasons.push(
      `${s.removed} ${plural(s.removed, "processo da prévia não está mais ativo", "processos da prévia não estão mais ativos")} ` +
        "na data-base (excluído, encerrado antes dela ou com ajuizamento posterior)",
    );
  }
  if (s.changed > 0) {
    reasons.push(
      `${s.changed} ${plural(s.changed, "processo da prévia teve a fase ou a instância alterada", "processos da prévia tiveram a fase ou a instância alterada")} ` +
        "depois do cálculo (inclui a separação entre fase e instância)",
    );
  }
  return reasons;
}

/** Message of a close refused because the preview no longer matches the portfolio or the classifications. */
export function stalePreviewMessage(periodLabel: string, s: PreviewStaleness): string {
  return (
    `A prévia de ${periodLabel} está desatualizada: ${stalePreviewReasons(s).join("; ")}. ` +
    "Recalcule a prévia antes de fechar, para que a competência fechada reflita a carteira e as classificações em vigor na data-base."
  );
}

/** Banner of a competência closed with a justification. */
export function overrideSummary(count: number, hiddenNote: boolean): string {
  return (
    `Fechada com ${count} ${plural(count, "processo", "processos")} sem classificação de risco oficial na data-base` +
    (hiddenNote ? " (inclui sigilosos não listados)" : "")
  );
}
