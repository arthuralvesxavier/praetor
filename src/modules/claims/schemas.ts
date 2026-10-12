import { z } from "zod";
import { CLAIM_CATEGORIES, CORRECTION_INDEXES, LOSS_PROBABILITIES, PROCESS_INSTANCES } from "@/domain/enums";

/** zod input contracts of the claims module (client-safe, no server imports). */

const MAX_CENTS = 100_000_000_000_000; // R$ 1 trilhão
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export const claimIdSchema = z.guid({ error: "Pedido inválido." });

const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, { error: message })
    .nullish()
    .transform((v) => (v ? v : null));

const optionalDate = (message: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isValidIsoDate(v), { error: message });

const requiredDate = (required: string, invalid: string) =>
  z
    .string({ error: required })
    .trim()
    .min(1, { error: required })
    .refine((v) => isValidIsoDate(v), { error: invalid });

const amount = z
  .number({ error: "Valor inválido. Use o formato 1.234,56." })
  .refine((v) => Number.isFinite(v), { error: "Valor inválido. Use o formato 1.234,56." })
  .refine((v) => Number.isInteger(v), { error: "Valor inválido. Use no máximo duas casas decimais." })
  .refine((v) => v >= 0, { error: "O valor não pode ser negativo." })
  .refine((v) => v <= MAX_CENTS, { error: "Valor acima do limite permitido." });

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z
    .union([z.enum(values, { error: message }), z.literal("")])
    .nullish()
    .transform((v) => (v ? v : null));

/** Fields of a claim (create, edit, confirm). */
export const claimSchema = z
  .object({
    description: z
      .string({ error: "Descreva o pedido (verba pleiteada)." })
      .trim()
      .min(3, { error: "Descreva o pedido (verba pleiteada)." })
      .max(500, { error: "A descrição deve ter no máximo 500 caracteres." }),
    category: optionalEnum(CLAIM_CATEGORIES, "Categoria inválida."),
    claimedAmountCents: amount.nullish().transform((v) => (v === undefined ? null : v)),
    amountBaseDate: optionalDate("Data-base inválida."),
    correctionIndex: optionalEnum(CORRECTION_INDEXES, "Índice de atualização inválido."),
    instance: optionalEnum(PROCESS_INSTANCES, "Instância inválida."),
  })
  .superRefine((v, ctx) => {
    if (v.claimedAmountCents !== null && !v.amountBaseDate) {
      ctx.addIssue({ code: "custom", path: ["amountBaseDate"], message: "Informe a data-base do valor do pedido." });
    }
    if (v.claimedAmountCents === null && (v.amountBaseDate || v.correctionIndex)) {
      ctx.addIssue({ code: "custom", path: ["claimedAmountCents"], message: "Data-base e índice exigem o valor do pedido." });
    }
  });
export type ClaimInput = z.input<typeof claimSchema>;
export type ClaimData = z.output<typeof claimSchema>;

const percentage = z
  .number({ error: "Percentual inválido." })
  .refine((v) => Number.isFinite(v), { error: "Percentual inválido." })
  .refine((v) => v >= 0 && v <= 100, { error: "O percentual deve estar entre 0 e 100." })
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, { error: "Use no máximo duas casas decimais." })
  .nullish()
  .transform((v) => (v === undefined ? null : v));

/**
 * Assessment of one claim. `baseAmountCents`: undefined = the claim value
 * (with its base date); null = not quantified; a number = another base
 * (base date required).
 */
export const claimAssessmentSchema = z
  .object({
    classification: z.enum(LOSS_PROBABILITIES, { error: "Selecione a classificação do pedido." }),
    /** Whole percentage 0 to 100; null = organization parameter of the classification. */
    percentage,
    baseAmountCents: amount.nullable().optional(),
    baseDate: optionalDate("Data-base inválida."),
    /** Index of the base; ignored when the base is the claim value (the claim index is used). */
    correctionIndex: optionalEnum(CORRECTION_INDEXES, "Índice de atualização inválido."),
    opinion: z
      .string({ error: "Registre o parecer que fundamenta a avaliação." })
      .trim()
      .min(10, { error: "O parecer deve ter pelo menos 10 caracteres." })
      .max(2000, { error: "O parecer deve ter no máximo 2.000 caracteres." }),
    effectiveFrom: requiredDate("Informe o início da vigência.", "Data de vigência inválida."),
  })
  .superRefine((v, ctx) => {
    if (v.baseAmountCents !== undefined && v.baseAmountCents !== null && !v.baseDate) {
      ctx.addIssue({ code: "custom", path: ["baseDate"], message: "Informe a data-base da base de cálculo." });
    }
  });
export type ClaimAssessmentInput = z.input<typeof claimAssessmentSchema>;

/** Manual process classification different from the derived one (justification required). */
export const riskOverrideSchema = z.object({
  classification: z.enum(LOSS_PROBABILITIES, { error: "Selecione a classificação do processo." }),
  percentage,
  justification: z
    .string({ error: "Justifique por que a classificação difere da derivada dos pedidos." })
    .trim()
    .min(20, { error: "A justificativa deve ter pelo menos 20 caracteres." })
    .max(2000, { error: "A justificativa deve ter no máximo 2.000 caracteres." }),
});
export type RiskOverrideInput = z.input<typeof riskOverrideSchema>;

export const removeClaimSchema = z.object({
  reason: z
    .string({ error: "Informe o motivo da exclusão." })
    .trim()
    .min(5, { error: "Informe o motivo da exclusão." })
    .max(500, { error: "O motivo deve ter no máximo 500 caracteres." }),
});

export const dismissClaimSchema = z.object({
  reason: optionalText(500, "O motivo deve ter no máximo 500 caracteres."),
});
