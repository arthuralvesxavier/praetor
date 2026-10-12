import { z } from "zod";
import { LEGAL_REPORT_STATUSES, LEGAL_REPORT_TYPES, PROBABILITY_BANDS } from "@/domain/enums";

/** Contratos de entrada do módulo (client-safe). */

export const idSchema = z.guid({ error: "Identificador inválido." });

export const listLegalReportsSchema = z.object({
  type: z.enum(LEGAL_REPORT_TYPES).optional(),
  status: z.enum(LEGAL_REPORT_STATUSES).optional(),
  processId: z.guid().optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export type ListLegalReportsInput = z.infer<typeof listLegalReportsSchema>;

export const generateSampleSchema = z
  .object({
    processId: z.guid({ error: "Processo inválido." }).optional(),
    processNumber: z.string().trim().max(40, { error: "Número de processo inválido." }).optional(),
  })
  .refine((v) => !!v.processId || !!v.processNumber, {
    error: "Informe o processo.",
    path: ["processNumber"],
  });
export type GenerateSampleInput = z.infer<typeof generateSampleSchema>;

/** "Gerar R1": processo escolhido na lista ou informado pelo número (com ou sem pontuação). */
export const generateProcessReportSchema = z
  .object({
    processId: z.guid({ error: "Processo inválido." }).optional(),
    processNumber: z.string().trim().max(40, { error: "Número de processo inválido." }).optional(),
  })
  .refine((v) => !!v.processId || !!v.processNumber, {
    error: "Informe o processo.",
    path: ["processNumber"],
  });
export type GenerateProcessReportInput = z.infer<typeof generateProcessReportSchema>;

const percent = z
  .number({ error: "Informe um percentual inteiro de 0 a 100." })
  .int({ error: "Informe um percentual inteiro de 0 a 100." })
  .min(0, { error: "Informe um percentual inteiro de 0 a 100." })
  .max(100, { error: "Informe um percentual inteiro de 0 a 100." });

const bandRange = z.object({ min: percent, max: percent }).refine((r) => r.min <= r.max, {
  error: "O mínimo não pode ser maior que o máximo.",
});

export const legalReportSettingsSchema = z
  .object({
    confidenceThreshold: percent,
    bands: z.object({
      very_high: bandRange,
      high: bandRange,
      moderate: bandRange,
      low: bandRange,
      very_low: bandRange,
    }),
    legalBasisText: z
      .string()
      .trim()
      .min(10, { error: "Descreva a base legal (mínimo de 10 caracteres)." })
      .max(500, { error: "Use no máximo 500 caracteres." }),
  })
  .superRefine((v, c) => {
    // Faixas em ordem decrescente e sem sobreposição (limites podem se tocar).
    for (let i = 0; i < PROBABILITY_BANDS.length - 1; i += 1) {
      const upper = v.bands[PROBABILITY_BANDS[i]];
      const lower = v.bands[PROBABILITY_BANDS[i + 1]];
      if (lower.max > upper.min) {
        c.addIssue({
          code: "custom",
          path: ["bands", PROBABILITY_BANDS[i + 1]],
          message: "As faixas devem ficar em ordem (da mais alta para a mais baixa) sem se sobrepor.",
        });
      }
    }
  });
export type LegalReportSettingsInput = z.infer<typeof legalReportSettingsSchema>;

export const addScenarioSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(5, { error: "Descreva o cenário (mínimo de 5 caracteres)." })
      .max(1000, { error: "Use no máximo 1000 caracteres." }),
    probabilityBand: z.enum(PROBABILITY_BANDS, { error: "Escolha a faixa de probabilidade." }),
    percentMin: percent.optional(),
    percentMax: percent.optional(),
    comment: z.string().trim().max(2000, { error: "Use no máximo 2000 caracteres." }).optional().nullable(),
  })
  .refine((v) => v.percentMin === undefined || v.percentMax === undefined || v.percentMin <= v.percentMax, {
    error: "O mínimo não pode ser maior que o máximo.",
    path: ["percentMax"],
  });
export type AddScenarioInput = z.infer<typeof addScenarioSchema>;
