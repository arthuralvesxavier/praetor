import { z } from "zod";

/**
 * Contract for the structured result of an AI analysis.
 *
 * The same schema is used (a) as the structured-output format requested from
 * the live provider, (b) to validate whatever any provider returns before it
 * is stored, and (c) to type the UI. Keep it simple: no regex/min/max
 * constraints (structured outputs support a subset of JSON Schema) and use
 * `nullable()` rather than `optional()`.
 *
 * Every finding must cite at least one source by its `ref` (e.g. "S1"); refs
 * that do not match a source actually sent to the provider are discarded by
 * the analysis service.
 */

export const FINDING_KINDS = [
  "fact",
  "key_date",
  "party",
  "amount",
  "obligation",
  "risk_signal",
  "missing_information",
  "missing_document",
  "inconsistency",
  "pending_obligation",
  "preventive_action",
  "other",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_KIND_LABELS: Record<FindingKind, string> = {
  fact: "Fato relevante",
  key_date: "Data relevante",
  party: "Parte envolvida",
  amount: "Valor",
  obligation: "Obrigação",
  risk_signal: "Sinal de risco",
  missing_information: "Informação faltante",
  missing_document: "Documento faltante",
  inconsistency: "Contradição / inconsistência",
  pending_obligation: "Obrigação pendente",
  preventive_action: "Ação preventiva sugerida",
  other: "Outro",
};

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const analysisFindingSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  title: z.string(),
  detail: z.string(),
  severity: z.enum(SEVERITIES).nullable(),
  /** Source refs ("S1", "S2"...) supporting this finding. */
  sourceRefs: z.array(z.string()),
  /** Short literal quote from the source, when available. */
  excerpt: z.string().nullable(),
});
export type AnalysisFinding = z.infer<typeof analysisFindingSchema>;

/** A date literally mentioned in a source. Becomes a deadline only after human validation. */
export const suggestedDeadlineSchema = z.object({
  title: z.string(),
  /** ISO date YYYY-MM-DD as written/derivable directly from the source text. Never computed from procedural rules. */
  date: z.string(),
  sourceRef: z.string(),
  excerpt: z.string(),
  rationale: z.string(),
});
export type SuggestedDeadline = z.infer<typeof suggestedDeadlineSchema>;

export const suggestedTaskSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  sourceRefs: z.array(z.string()),
});
export type SuggestedTask = z.infer<typeof suggestedTaskSchema>;

/** What the provider must return. */
export const analysisOutputSchema = z.object({
  summary: z.string(),
  /** Direct answer for question_answer analyses; null otherwise. */
  answer: z.string().nullable(),
  findings: z.array(analysisFindingSchema),
  suggestedDeadlines: z.array(suggestedDeadlineSchema),
  suggestedTasks: z.array(suggestedTaskSchema),
  /** What the analysis could not assess (missing sources, unreadable parts, scope limits). */
  limitations: z.array(z.string()),
  /** Points a lawyer must verify before relying on the result. */
  validationPoints: z.array(z.string()),
  /** Set when the source text contained instructions directed at the AI (ignored, but reported). */
  promptInjectionSuspected: z.boolean(),
});
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

/** What is stored in `ai_analyses.result` (provider output + system-added notices). */
export type AnalysisResult = AnalysisOutput & {
  /** Fixed notices added by the system, never by the model (e.g. demo mode, truncation). */
  systemNotices: string[];
};

/** Notice always shown next to any analysis. */
export const ANALYSIS_DISCLAIMER =
  "Conteúdo gerado automaticamente para apoio à análise jurídica. Não substitui a avaliação de um advogado, " +
  "não constitui previsão de resultado e pode conter erros ou omissões. Valide as informações nas fontes indicadas.";

export const DEMO_MODE_NOTICE =
  "MODO DEMONSTRATIVO: este resultado foi gerado por regras simples de demonstração, sem uso de inteligência " +
  "artificial. Não é uma análise real e não deve ser usado para decisões.";
