import { SEVERITIES } from "@/domain/analysis";
import {
  ANALYSIS_TYPE_LABELS,
  type AnalysisSubjectType,
  type AnalysisType,
  type RiskLevel,
} from "@/domain/enums";
import type { Option } from "@/lib/options";
import { RISK_TONES, type Tone } from "@/lib/tones";

/** Client-safe labels and option lists used by the AI analysis UI. */

export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABELS: Record<Severity, string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  critical: "Crítica",
};

export const SEVERITY_TONES: Record<Severity, Tone> = RISK_TONES satisfies Record<RiskLevel, Tone>;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Sort key: most severe first, findings without severity last. */
export function severityRank(severity: Severity | null): number {
  return severity ? SEVERITY_RANK[severity] : 4;
}

/** Subject types a user can pick in the AI center request form (organization = only questions). */
export const RECORD_SUBJECT_TYPES = ["legal_process", "occurrence", "contract", "document"] as const;
export type RecordSubjectType = (typeof RECORD_SUBJECT_TYPES)[number];

export const SUBJECT_TYPE_LABELS: Record<AnalysisSubjectType, string> = {
  legal_process: "Processo",
  occurrence: "Ocorrência preventiva",
  contract: "Contrato",
  document: "Documento",
  organization: "Base da organização",
};

/** Analysis types that make sense for each subject (question/answer has its own flow). */
export const ANALYSIS_TYPES_BY_SUBJECT: Record<RecordSubjectType, readonly AnalysisType[]> = {
  legal_process: ["summary", "extraction", "risk_signals", "inconsistencies", "preventive_actions"],
  occurrence: ["summary", "extraction", "risk_signals", "inconsistencies", "preventive_actions"],
  contract: ["summary", "extraction", "risk_signals", "inconsistencies", "preventive_actions"],
  document: ["summary", "extraction", "risk_signals", "inconsistencies"],
};

export function analysisTypeOptions(subjectType: RecordSubjectType): Option[] {
  return ANALYSIS_TYPES_BY_SUBJECT[subjectType].map((t) => ({ value: t, label: ANALYSIS_TYPE_LABELS[t] }));
}

export function isRecordSubjectType(value: string): value is RecordSubjectType {
  return (RECORD_SUBJECT_TYPES as readonly string[]).includes(value);
}

/** Labels for `ai_analysis_sources.source_type`. */
export function sourceTypeLabel(sourceType: string): string {
  switch (sourceType) {
    case "document_version":
      return "Documento";
    case "legal_process":
      return "Cadastro do processo";
    case "occurrence":
      return "Cadastro da ocorrência";
    case "contract":
      return "Cadastro do contrato";
    default:
      return "Registro";
  }
}

/** HTML id of a source in the "Fontes utilizadas" list (anchor target for "S1" chips). */
export function sourceAnchorId(analysisId: string, ref: string): string {
  return `fonte-${analysisId.slice(0, 8)}-${ref.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** Roles that may see token usage and costs of individual analyses. */
export const COST_VISIBLE_ROLES = ["admin", "legal_manager"] as const;

/** Formats an amount in micro-dollars as "US$ 0,0123". */
export function formatMicroUsd(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return "Não informado";
  const usd = micro / 1_000_000;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: usd > 0 && usd < 1 ? 4 : 2,
  }).format(usd);
}
