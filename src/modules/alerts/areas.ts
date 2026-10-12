import type { AlertType } from "@/domain/enums";

/**
 * Areas of the "painel de pendências" (TE-05): every alert type belongs to
 * exactly one area. Client-safe.
 */
export const ALERT_AREAS = [
  "hearings",
  "deadlines",
  "intake",
  "values",
  "settlements",
  "verification",
  "briefs",
  "contracts",
  "analyses",
] as const;
export type AlertArea = (typeof ALERT_AREAS)[number];

export const ALERT_AREA_LABELS: Record<AlertArea, string> = {
  hearings: "Audiências e pauta",
  deadlines: "Prazos",
  intake: "Entrada de processos",
  values: "Valores e garantias",
  settlements: "Acordos",
  verification: "Verificações",
  briefs: "Análises preliminares",
  contracts: "Contratos e obrigações",
  analyses: "Análises de IA e sinais de risco",
};

export const ALERT_AREA_DESCRIPTIONS: Record<AlertArea, string> = {
  hearings: "Audiências designadas dentro da janela de aviso configurada.",
  deadlines: "Prazos vencidos, próximos e sugestões aguardando validação humana.",
  intake: "Processos recebidos e entradas ainda sem responsável.",
  values: "Valores aguardando conferência, execuções sem valor apurado e depósitos parados.",
  settlements: "Parcelas de acordos próximas do vencimento.",
  verification: "Processos marcados para verificação na carteira.",
  briefs: "Análises preliminares (simulação) aguardando revisão do advogado.",
  contracts: "Contratos próximos do vencimento e obrigações contratuais.",
  analyses: "Sinais de risco, análises desatualizadas e falhas em análises de IA.",
};

/** URL value (`?area=`) of each area. */
export const ALERT_AREA_PARAMS: Record<AlertArea, string> = {
  hearings: "audiencias",
  deadlines: "prazos",
  intake: "entrada",
  values: "valores",
  settlements: "acordos",
  verification: "verificacoes",
  briefs: "analises-preliminares",
  contracts: "contratos",
  analyses: "analises-ia",
};

const AREA_BY_PARAM = new Map<string, AlertArea>(ALERT_AREAS.map((a) => [ALERT_AREA_PARAMS[a], a]));

/** Area of a `?area=` value, or undefined for anything else. */
export function alertAreaFromParam(value: string | null | undefined): AlertArea | undefined {
  return value ? AREA_BY_PARAM.get(value) : undefined;
}

export const ALERT_TYPES_BY_AREA: Record<AlertArea, readonly AlertType[]> = {
  hearings: ["hearing_upcoming"],
  deadlines: ["deadline_overdue", "deadline_upcoming", "deadline_pending_validation"],
  intake: ["intake_unassigned", "new_process_received"],
  values: ["valuation_pending_review", "enforcement_without_value", "guarantee_idle"],
  settlements: ["settlement_installment_due"],
  verification: ["process_needs_verification"],
  briefs: ["brief_pending_review"],
  contracts: ["contract_expiring", "obligation_due"],
  analyses: ["risk_signal", "analysis_stale", "analysis_failed"],
};

const AREA_OF_TYPE = new Map<AlertType, AlertArea>(
  ALERT_AREAS.flatMap((area) => ALERT_TYPES_BY_AREA[area].map((t) => [t, area] as const)),
);

export function alertAreaOf(type: AlertType): AlertArea {
  return AREA_OF_TYPE.get(type) ?? "analyses";
}

/** Alert types ordered by area (for the "tipo" filter). */
export const ALERT_TYPES_IN_AREA_ORDER: AlertType[] = ALERT_AREAS.flatMap((a) => [...ALERT_TYPES_BY_AREA[a]]);

/** `?situacao=` values of the alerts center. */
export const ALERT_SITUATION_PARAMS = ["abertos", "resolvidos"] as const;
export type AlertSituationParam = (typeof ALERT_SITUATION_PARAMS)[number];
