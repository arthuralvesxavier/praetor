/**
 * Inteligência preventiva (RF-15..RF-18, TE-12) — contracts shared by the
 * service and the UI (client-safe).
 *
 * Three visually separated kinds of content:
 *  1. "Calculado a partir da carteira" — indicators computed from the visible
 *     processes, each with its basis (formula) and the number of processes considered;
 *  2. "Pedidos recorrentes" — aggregated from the preliminary case analyses
 *     (simulated, over FICTITIOUS demo documents), extracted items only;
 *  3. "Sugestão ilustrativa" — generic management measures triggered by an
 *     indicator; never a fact, a legal opinion or a prediction.
 * No sensitive data (health, union membership — PD-06) appears in any indicator.
 */
import type { ClosureReason, ProcessStatus } from "@/domain/enums";

export type PreventiveIntelFilters = {
  companyId?: string;
  /** Tribunal exactly as registered (e.g. "TRT10"). */
  court?: string;
};

export type IndicatorBasis = {
  /** How the indicator is computed, in pt-BR. */
  formula: string;
  /** Population the indicator is computed on. */
  population: string;
  /** Number of processes considered. */
  processCount: number;
};

/** A group of processes; valor da causa and valor liquidado are never added (RN-02). */
export type GroupStat = {
  key: string;
  label: string;
  count: number;
  /** count / population size (0–1). */
  share: number;
  claimCents: number;
  claimUnknown: number;
  liquidatedCents: number;
  liquidatedUnknown: number;
};

export type YearStat = { year: number; count: number; fromCnj: number; fromFiledAt: number };

export type ClosureGroup = "paid" | "no_burden" | "lost_patronage" | "other";
export const CLOSURE_GROUP_LABELS: Record<ClosureGroup, string> = {
  paid: "Pago / extinto com desembolso",
  no_burden: "Extinto ou arquivado sem ônus",
  lost_patronage: "Saída do acervo / perda do patrocínio",
  other: "Outro motivo / não informado",
};

export type ClosureStat = { reason: ClosureReason | "unknown"; label: string; group: ClosureGroup; count: number; share: number };

export type RatioStat = { court: string; processCount: number; claimCents: number; liquidatedCents: number; ratio: number };

export type RiskFactor = {
  key: string;
  title: string;
  /** Computed value, e.g. "62% dos processos ativos". */
  value: string;
  /** How it was computed and the reference threshold. */
  explanation: string;
};

export type CollectiveProcess = { id: string; number: string; title: string; status: ProcessStatus; reason: string };

export type RepeatPlaintiff = { name: string; processCount: number; href: string };

export type ClaimCategoryStat = {
  key: string;
  label: string;
  /** Processes (latest brief of each) with at least one extracted claim in the category. */
  processCount: number;
  /** processCount / processes considered. */
  share: number;
  /** Claims of the category with an amount stated in the source. */
  withAmount: number;
  amountCents: number;
};

export type RecurringClaims = {
  /** Latest brief of each visible process (statuses ready_for_review, in_review, approved). */
  briefsConsidered: number;
  /** Extracted claims read. */
  claimsConsidered: number;
  rows: ClaimCategoryStat[];
  /** Extracted claims that match no category. */
  uncategorized: number;
  /** Claims not aggregated because they refer to sensitive data (health, union — PD-06). */
  excludedSensitive: number;
  /** Claims ignored because they are not extracted from a document (illustrative, record, gaps...). */
  ignoredNotExtracted: number;
};

export type PreventiveSuggestion = {
  /** Stable indicator key, e.g. "jornada" or "conciliacao:trt10" (stored in the occurrence footer). */
  key: string;
  title: string;
  /** Indicator that triggers the suggestion (computed, with numbers). */
  trigger: string;
  /** Section / formula of the trigger. */
  basis: string;
  /** Illustrative measure. */
  measure: string;
  /** Illustrative action plan items (become action_plan tasks on explicit request). */
  planItems: string[];
};

export type ExistingOccurrence = { id: string; title: string; status: string; createdAt: Date };

export type PreventiveIntelligence = {
  generatedAt: Date;
  scope: { orgWide: boolean; includesConfidential: boolean; label: string };
  filterSummary: string;
  totals: { all: number; active: number; closed: number };
  classRecurrence: { basis: IndicatorBasis; rows: GroupStat[] };
  concentration: {
    basis: IndicatorBasis;
    byCourt: GroupStat[];
    byCity: GroupStat[];
    byDivision: GroupStat[];
  };
  filingTrend: { basis: IndicatorBasis; rows: YearStat[]; withoutYear: number };
  phaseDistribution: {
    basis: IndicatorBasis;
    rows: GroupStat[];
    materializedCount: number;
    materializedShare: number;
    materializedLiquidatedCents: number;
    materializedLiquidatedUnknown: number;
  };
  repeatPlaintiffs: {
    basis: IndicatorBasis;
    plaintiffCount: number;
    processCount: number;
    /** Only shown in a drill-down; every listed process is visible to the viewer. */
    names: RepeatPlaintiff[];
  };
  collectiveActions: { basis: IndicatorBasis; count: number; processes: CollectiveProcess[] };
  verification: { basis: IndicatorBasis; count: number; share: number };
  closureOutcomes: { basis: IndicatorBasis; rows: ClosureStat[] };
  liquidatedRatio: { basis: IndicatorBasis; rows: RatioStat[] };
  riskFactors: RiskFactor[];
  recurringClaims: RecurringClaims;
  suggestions: (PreventiveSuggestion & { existingOccurrence: ExistingOccurrence | null })[];
};
