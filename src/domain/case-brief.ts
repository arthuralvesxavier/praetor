import { z } from "zod";

/**
 * Contract of the PRELIMINARY CASE ANALYSIS ("análise preliminar") produced
 * when a process arrives. Same rules as src/domain/analysis.ts: the schema is
 * used as the structured-output format for a future live provider, to
 * validate whatever any provider returns before storing it, and to type the
 * UI. No regex/min/max constraints; `nullable()` instead of `optional()`.
 *
 * EVERY item carries its provenance, so the UI can always separate:
 *   extracted    — read from a document of the case; MUST cite ref + page + excerpt
 *   record       — taken from the system record (cadastro / imported spreadsheet); cites "REG"
 *   illustrative — content produced by the simulation as an example (theses,
 *                  next steps...). It is NOT a fact of the case.
 *   missing      — a gap: information that was looked for and not found
 *   reviewer     — written or changed by the reviewing lawyer (never by a provider;
 *                  providers must not emit it — the service rejects it on generation)
 *
 * Citations use the refs of the sources sent to the provider: "REG" for the
 * process record and "D1", "D2"... for document versions. Refs that do not
 * match a source are discarded by the service. Dates are never computed from
 * procedural rules: `possibleDeadlines` are hints for the lawyer to verify and
 * only become deadlines through an explicit user action (pending validation).
 */

export const PROVENANCES = ["extracted", "record", "illustrative", "missing", "reviewer"] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  extracted: "Extraído de documento",
  record: "Dado do cadastro / planilha",
  illustrative: "Ilustrativo (simulação)",
  missing: "Lacuna",
  reviewer: "Incluído/editado pelo advogado",
};

export const PROVENANCE_DESCRIPTIONS: Record<Provenance, string> = {
  extracted: "Trecho lido em um documento do processo, com página e citação literal.",
  record: "Informação que já estava no cadastro do processo ou na planilha importada.",
  illustrative: "Exemplo gerado pela simulação para demonstrar o recurso. Não é fato do processo.",
  missing: "Informação procurada e não encontrada nos documentos. Precisa ser obtida.",
  reviewer: "Conteúdo escrito ou alterado pelo advogado na revisão (registrado no histórico de revisões).",
};

export const briefCitationSchema = z.object({
  /** "REG" or "D1", "D2"... */
  ref: z.string(),
  /** 1-based page of the document, when known. */
  page: z.number().nullable(),
  /** Short literal quote from the source. */
  excerpt: z.string().nullable(),
});
export type BriefCitation = z.infer<typeof briefCitationSchema>;

const provenanceFields = {
  provenance: z.enum(PROVENANCES),
  citations: z.array(briefCitationSchema),
  /** Caveat for the lawyer (e.g. "conferir na planilha de cálculos"). */
  note: z.string().nullable(),
};

export const briefTextItemSchema = z.object({ text: z.string(), ...provenanceFields });
export type BriefTextItem = z.infer<typeof briefTextItemSchema>;

export const briefFieldSchema = z.object({
  /** Stable key, see CASE_BRIEF_IDENTIFICATION_KEYS. */
  key: z.string(),
  label: z.string(),
  value: z.string().nullable(),
  ...provenanceFields,
});
export type BriefField = z.infer<typeof briefFieldSchema>;

export const briefTimelineEventSchema = z.object({
  /** YYYY-MM-DD as written in the source; null when the source has no exact date. */
  date: z.string().nullable(),
  description: z.string(),
  ...provenanceFields,
});
export type BriefTimelineEvent = z.infer<typeof briefTimelineEventSchema>;

export const briefClaimSchema = z.object({
  description: z.string(),
  /** Amount attributed to the claim in the source, in cents; null when not stated. */
  amountCents: z.number().nullable(),
  ...provenanceFields,
});
export type BriefClaim = z.infer<typeof briefClaimSchema>;

export const briefAmountSchema = z.object({
  label: z.string(),
  amountCents: z.number().nullable(),
  ...provenanceFields,
});
export type BriefAmount = z.infer<typeof briefAmountSchema>;

export const EVIDENCE_HOLDERS = ["plaintiff", "defendant", "court", "third_party", "unknown"] as const;
export const EVIDENCE_HOLDER_LABELS: Record<(typeof EVIDENCE_HOLDERS)[number], string> = {
  plaintiff: "Apresentada pelo autor",
  defendant: "Da empresa / defesa",
  court: "Produzida em juízo",
  third_party: "De terceiros",
  unknown: "Origem não identificada",
};

export const briefEvidenceSchema = z.object({
  description: z.string(),
  holder: z.enum(EVIDENCE_HOLDERS),
  ...provenanceFields,
});
export type BriefEvidence = z.infer<typeof briefEvidenceSchema>;

export const briefRiskSchema = z.object({
  description: z.string(),
  level: z.enum(["low", "medium", "high", "critical"]),
  ...provenanceFields,
});
export type BriefRisk = z.infer<typeof briefRiskSchema>;

export const briefNextStepSchema = z.object({
  description: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  ...provenanceFields,
});
export type BriefNextStep = z.infer<typeof briefNextStepSchema>;

export const briefDeadlineSchema = z.object({
  description: z.string(),
  /** Date literally stated in a source (YYYY-MM-DD) or null. Never computed. */
  date: z.string().nullable(),
  /** What the hint is based on, in pt-BR (quote or explanation). */
  basis: z.string(),
  ...provenanceFields,
});
export type BriefDeadline = z.infer<typeof briefDeadlineSchema>;

/** What a case-brief provider must return. */
export const caseBriefSchema = z.object({
  /** One-paragraph overview for the e-mail and the top of the page. */
  headline: z.string(),
  identification: z.array(briefFieldSchema),
  factsSummary: z.array(briefTextItemSchema),
  timeline: z.array(briefTimelineEventSchema),
  claims: z.array(briefClaimSchema),
  amounts: z.array(briefAmountSchema),
  evidence: z.array(briefEvidenceSchema),
  plaintiffArguments: z.array(briefTextItemSchema),
  defendantArguments: z.array(briefTextItemSchema),
  contradictions: z.array(briefTextItemSchema),
  missingDocuments: z.array(briefTextItemSchema),
  theses: z.array(briefTextItemSchema),
  risks: z.array(briefRiskSchema),
  urgencies: z.array(briefTextItemSchema),
  nextSteps: z.array(briefNextStepSchema),
  possibleDeadlines: z.array(briefDeadlineSchema),
  gaps: z.array(briefTextItemSchema),
  limitations: z.array(z.string()),
  promptInjectionSuspected: z.boolean(),
});
export type CaseBrief = z.infer<typeof caseBriefSchema>;

/** What is stored (provider output + fixed notices added by the system, never by the provider). */
export type StoredCaseBrief = CaseBrief & { systemNotices: string[] };

export const CASE_BRIEF_IDENTIFICATION_KEYS = [
  "process_number",
  "plaintiffs",
  "defendants",
  "company",
  "court",
  "court_division",
  "city",
  "legal_area",
  "instance",
  "process_class",
  "phase",
  "filed_at",
  "claim_amount",
  "liquidated_amount",
  "responsible",
] as const;
export type CaseBriefIdentificationKey = (typeof CASE_BRIEF_IDENTIFICATION_KEYS)[number];

/**
 * Fixed sentences of the simulated provider for gaps about one datum of the process record (they cite "REG"),
 * by identification key: `gaps` texts and `amounts` labels. A consumer that reads the record directly (the R1)
 * recognizes only these exact texts as "the same datum"; any other text (live provider, reviewer edit) is a gap
 * of its own. The simulated provider uses these constants, so they cannot drift apart.
 */
export const SIMULATED_RECORD_GAP_TEXTS = {
  process_number: "O número do processo no cadastro não passa na validação do dígito verificador (padrão CNJ).",
  responsible: "Processo sem advogado responsável no cadastro.",
  company: "Empresa do grupo não identificada no cadastro.",
  filed_at: "Data de ajuizamento não informada no cadastro.",
  claim_amount: "Valor da causa não informado no cadastro.",
  liquidated_amount: "Valor liquidado não apurado no cadastro (não é zero).",
} as const satisfies Partial<Record<CaseBriefIdentificationKey, string>>;

export const SIMULATED_RECORD_AMOUNT_LABELS = {
  claim_amount: "Valor da causa no cadastro",
  liquidated_amount: "Valor liquidado / apurado no cadastro",
} as const satisfies Partial<Record<CaseBriefIdentificationKey, string>>;

/** Sections in display order (keys of CaseBrief). */
export const CASE_BRIEF_SECTIONS = [
  { key: "identification", label: "Identificação" },
  { key: "factsSummary", label: "Resumo dos fatos" },
  { key: "timeline", label: "Linha do tempo" },
  { key: "claims", label: "Pedidos" },
  { key: "amounts", label: "Valores" },
  { key: "evidence", label: "Provas disponíveis" },
  { key: "plaintiffArguments", label: "Argumentos do autor" },
  { key: "defendantArguments", label: "Argumentos da defesa" },
  { key: "contradictions", label: "Contradições" },
  { key: "missingDocuments", label: "Documentos faltantes" },
  { key: "theses", label: "Possíveis teses" },
  { key: "risks", label: "Riscos" },
  { key: "urgencies", label: "Urgências" },
  { key: "nextSteps", label: "Próximos passos" },
  { key: "possibleDeadlines", label: "Possíveis prazos (conferir)" },
  { key: "gaps", label: "Lacunas de informação" },
] as const satisfies readonly { key: keyof CaseBrief; label: string }[];

export type CaseBriefSectionKey = (typeof CASE_BRIEF_SECTIONS)[number]["key"];

export const CASE_BRIEF_DISCLAIMER =
  "Análise preliminar para apoio ao advogado responsável. Não substitui a leitura dos autos, não é parecer jurídico " +
  "e pode conter erros ou omissões. Os prazos indicados são possíveis prazos a conferir: nada é contado " +
  "automaticamente e nenhum prazo é criado sem validação humana.";

export const CASE_BRIEF_DEMO_NOTICE =
  "ANÁLISE DEMONSTRATIVA: gerada por uma simulação (regras determinísticas), sem inteligência artificial real. " +
  "Itens marcados como “Ilustrativo” são exemplos e não fatos do processo; itens “Extraído” vêm de documentos " +
  "fictícios de demonstração; itens “Cadastro” vêm da planilha de dados fictícios. Revise tudo antes de usar.";
