import { sql } from "drizzle-orm";
import {
  ALERT_TYPE_LABELS,
  CLOSURE_REASON_LABELS,
  LEGAL_AREA_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_DISPLAY_LABELS,
  PROCESS_STATUS_LABELS,
  RISK_LEVEL_LABELS,
  VALUATION_KIND_LABELS,
  VALUATION_SOURCE_LABELS,
  VALUATION_STATUS_LABELS,
} from "@/domain/enums";
import { getDb, type DbOrTx } from "@/server/db/client";
import { biLabels } from "@/server/db/schema";

/**
 * Rótulos pt-BR copiados de `@/domain/enums` para a tabela `bi_labels`
 * (view `bi.rotulos` e colunas `*_rotulo` das views). Idempotente; chamada pela
 * rotina `bi_access_refresh` e por scripts/bi-setup.ts. Códigos que saíram dos
 * enums continuam com o último rótulo conhecido (dados antigos ainda os usam).
 */
export const BI_LABEL_DOMAINS: Record<string, Record<string, string>> = {
  legal_area: LEGAL_AREA_LABELS,
  process_instance: PROCESS_INSTANCE_LABELS,
  // Current phases plus those of the previous model (closed competências keep them, RN-10).
  process_phase: PROCESS_PHASE_DISPLAY_LABELS,
  process_status: PROCESS_STATUS_LABELS,
  closure_reason: CLOSURE_REASON_LABELS,
  loss_probability: LOSS_PROBABILITY_LABELS,
  risk_level: RISK_LEVEL_LABELS,
  valuation_kind: VALUATION_KIND_LABELS,
  valuation_status: VALUATION_STATUS_LABELS,
  valuation_source: VALUATION_SOURCE_LABELS,
  alert_type: ALERT_TYPE_LABELS,
};

/** Report text never carries long dashes: "Proposto \u2014 aguardando" becomes "Proposto: aguardando". */
export function biLabelText(label: string): string {
  return label.replace(/\s+[\u2014\u2013]\s+/g, ": ").replace(/[\u2014\u2013]/g, "-");
}

export function biLabelRows(): { domain: string; code: string; label: string }[] {
  return Object.entries(BI_LABEL_DOMAINS).flatMap(([domain, map]) =>
    Object.entries(map).map(([code, label]) => ({ domain, code, label: biLabelText(label) })),
  );
}

export async function syncBiLabels(db: DbOrTx = getDb()): Promise<number> {
  const rows = biLabelRows();
  await db
    .insert(biLabels)
    .values(rows)
    .onConflictDoUpdate({
      target: [biLabels.domain, biLabels.code],
      set: { label: sql`excluded.label`, updatedAt: sql`now()` },
      setWhere: sql`${biLabels.label} is distinct from excluded.label`,
    });
  return rows.length;
}
