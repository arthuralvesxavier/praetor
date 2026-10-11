import { z } from "zod";
import { ANALYSIS_STATUSES, ANALYSIS_SUBJECT_TYPES, ANALYSIS_TRIGGERS, ANALYSIS_TYPES } from "@/domain/enums";

/** zod input contracts for the analyses module (client-safe). */

export const requestAnalysisSchema = z
  .object({
    type: z.enum(ANALYSIS_TYPES, { error: "Selecione o tipo de análise." }),
    subjectType: z.enum(ANALYSIS_SUBJECT_TYPES, { error: "Selecione o objeto da análise." }),
    subjectId: z.uuid({ error: "Registro inválido." }).nullish(),
    question: z
      .string()
      .trim()
      .max(2000, { error: "A pergunta deve ter no máximo 2.000 caracteres." })
      .nullish()
      .transform((v) => (v ? v : null)),
    trigger: z.enum(ANALYSIS_TRIGGERS).default("manual"),
    /** Bypasses reuse of a succeeded, non-stale analysis with the same input (never bypasses in-flight dedupe). */
    force: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.subjectType === "organization") {
      if (v.type !== "question_answer") {
        ctx.addIssue({ code: "custom", path: ["type"], message: "Consultas gerais à base aceitam apenas perguntas." });
      }
      if (v.subjectId) {
        ctx.addIssue({ code: "custom", path: ["subjectId"], message: "Consultas gerais não se referem a um registro." });
      }
    } else if (!v.subjectId) {
      ctx.addIssue({ code: "custom", path: ["subjectId"], message: "Informe o registro a ser analisado." });
    }
    if (v.type === "question_answer") {
      if (!v.question || v.question.length < 5) {
        ctx.addIssue({ code: "custom", path: ["question"], message: "Digite uma pergunta com pelo menos 5 caracteres." });
      }
    } else if (v.question) {
      ctx.addIssue({ code: "custom", path: ["question"], message: "Perguntas só são aceitas no tipo pergunta e resposta." });
    }
  });
export type RequestAnalysisInput = z.input<typeof requestAnalysisSchema>;

export const listAnalysesSchema = z.object({
  subjectType: z.enum(ANALYSIS_SUBJECT_TYPES).optional(),
  subjectId: z.uuid().optional(),
  status: z.enum(ANALYSIS_STATUSES).optional(),
  type: z.enum(ANALYSIS_TYPES).optional(),
  staleOnly: z.boolean().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

export const reviewAnalysisSchema = z.object({
  decision: z.enum(["reviewed", "dismissed"], { error: "Selecione a decisão da revisão." }),
  note: z
    .string()
    .trim()
    .max(2000, { error: "A observação deve ter no máximo 2.000 caracteres." })
    .nullish()
    .transform((v) => (v ? v : null)),
});
export type ReviewAnalysisInput = z.input<typeof reviewAnalysisSchema>;

export const suggestionIndexSchema = z.object({
  analysisId: z.uuid({ error: "Análise inválida." }),
  index: z.number().int().min(0).max(500),
});

export const staleInputSchema = z.object({
  organizationId: z.uuid(),
  entityId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

export const textReadyInputSchema = z.object({
  organizationId: z.uuid(),
  documentId: z.uuid(),
  versionId: z.uuid(),
});
