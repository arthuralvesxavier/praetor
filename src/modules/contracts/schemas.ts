import { z } from "zod";
import {
  CONTRACT_STATUSES,
  CONTRACT_TYPES,
  OBLIGATION_STATUSES,
  RENEWAL_TYPES,
  RISK_LEVELS,
} from "@/domain/enums";
import { isRecurrenceId, recurrenceToStored } from "./obligations";

/** zod input contracts for the contracts module (client-safe, no server imports). */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in "YYYY-MM-DD" (rejects 2026-02-30). */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Optional text: trims; empty / missing -> null. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, { error: message })
    .nullish()
    .transform((v) => (v ? v : null));

/** Optional calendar date; empty / missing -> null. */
const optionalDate = (message: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isValidIsoDate(v), { error: message });

/** Optional uuid reference; empty / missing -> null. */
const optionalId = (message: string) =>
  z
    .union([z.guid({ error: message }), z.literal("")])
    .nullish()
    .transform((v) => (v ? v : null));

/**
 * CPF/CNPJ of the counterparty (optional). Stored as digits only; must have 11
 * (CPF) or 14 (CNPJ) digits. Check digits are not verified (fictional demo data).
 */
const counterpartyDocument = z
  .string()
  .trim()
  .max(32, { error: "Documento inválido." })
  .nullish()
  .transform((v) => (v ? v.replace(/\D/g, "") : null))
  .refine((v) => v === null || v.length === 11 || v.length === 14, {
    error: "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).",
  })
  .transform((v) => (v ? v : null));

export const contractInputSchema = z
  .object({
    title: z
      .string({ error: "Informe o título do contrato." })
      .trim()
      .min(3, { error: "O título deve ter pelo menos 3 caracteres." })
      .max(200, { error: "O título deve ter no máximo 200 caracteres." }),
    counterparty: z
      .string({ error: "Informe a contraparte." })
      .trim()
      .min(2, { error: "Informe a contraparte." })
      .max(200, { error: "A contraparte deve ter no máximo 200 caracteres." }),
    counterpartyDocument,
    type: z.enum(CONTRACT_TYPES, { error: "Selecione o tipo de contrato." }),
    status: z.enum(CONTRACT_STATUSES, { error: "Selecione a situação do contrato." }).default("draft"),
    startDate: optionalDate("Data de início inválida."),
    endDate: optionalDate("Data de término inválida."),
    renewalType: z.enum(RENEWAL_TYPES, { error: "Selecione o tipo de renovação." }).default("none"),
    renewalNoticeDays: z
      .number({ error: "Informe um número inteiro de dias." })
      .int({ error: "Informe um número inteiro de dias." })
      .min(0, { error: "A antecedência não pode ser negativa." })
      .max(3650, { error: "A antecedência deve ser de no máximo 3.650 dias." })
      .nullish()
      .transform((v) => v ?? null),
    valueCents: z
      .number({ error: "Valor inválido. Use o formato 1.234,56." })
      .int({ error: "Valor inválido. Use o formato 1.234,56." })
      .min(0, { error: "O valor não pode ser negativo." })
      .max(Number.MAX_SAFE_INTEGER, { error: "Valor muito alto." })
      .nullish()
      .transform((v) => v ?? null),
    riskLevel: z.enum(RISK_LEVELS, { error: "Selecione o nível de risco." }).default("low"),
    unitId: optionalId("Unidade inválida."),
    responsibleId: optionalId("Responsável inválido."),
    linkedProcessId: optionalId("Processo inválido."),
    linkedOccurrenceId: optionalId("Ocorrência inválida."),
    description: optionalText(10_000, "A descrição deve ter no máximo 10.000 caracteres."),
    isConfidential: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "A data de término não pode ser anterior à data de início.",
      });
    }
    if (v.renewalNoticeDays !== null && !v.endDate) {
      ctx.addIssue({
        code: "custom",
        path: ["renewalNoticeDays"],
        message: "Informe a data de término para usar a antecedência de aviso.",
      });
    }
  });
export type ContractInput = z.input<typeof contractInputSchema>;
export type ContractData = z.output<typeof contractInputSchema>;

/**
 * Recurrence: a recurrence id from the form ("monthly", "none"...) becomes the
 * canonical stored text ("mensal" / null); any other text (older rows, API
 * callers) is kept as informed for backward compatibility.
 */
const recurrenceField = z
  .string()
  .trim()
  .max(120, { error: "A recorrência deve ter no máximo 120 caracteres." })
  .nullish()
  .transform((v) => (!v ? null : isRecurrenceId(v) ? recurrenceToStored(v) : v));

/** Required calendar date. */
const requiredDate = (required: string, invalid: string) =>
  z
    .string({ error: required })
    .trim()
    .min(1, { error: required })
    .refine((v) => isValidIsoDate(v), { error: invalid });

export const obligationInputSchema = z.object({
  description: z
    .string({ error: "Descreva a obrigação." })
    .trim()
    .min(3, { error: "A descrição deve ter pelo menos 3 caracteres." })
    .max(2000, { error: "A descrição deve ter no máximo 2.000 caracteres." }),
  responsibleId: optionalId("Responsável inválido."),
  dueDate: optionalDate("Data de vencimento inválida."),
  recurrence: recurrenceField,
  status: z.enum(OBLIGATION_STATUSES, { error: "Selecione a situação da obrigação." }).default("pending"),
});
export type ObligationInput = z.input<typeof obligationInputSchema>;

/** Partial update of an obligation (e.g. `{ status: "fulfilled" }`). */
export const obligationPatchSchema = z
  .object({
    description: obligationInputSchema.shape.description.optional(),
    responsibleId: optionalId("Responsável inválido.").optional(),
    dueDate: optionalDate("Data de vencimento inválida.").optional(),
    recurrence: recurrenceField.optional(),
    status: z.enum(OBLIGATION_STATUSES, { error: "Selecione a situação da obrigação." }).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nenhuma alteração informada." });
export type ObligationPatch = z.input<typeof obligationPatchSchema>;

export const listContractsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
  type: z.enum(CONTRACT_TYPES).optional(),
  responsibleId: z.guid().optional(),
  expiring: z.boolean().optional(),
  /** Active contracts whose renewal/termination notice date is within the window or already reached. */
  noticeSoon: z.boolean().optional(),
  /** Contracts with at least one open obligation past its due date. */
  overdueObligations: z.boolean().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});
export type ListContractsFilters = z.input<typeof listContractsSchema>;

/** "Registrar renovação": new end date (+ optional aditivo document of the contract). */
export const renewContractSchema = z.object({
  newEndDate: requiredDate("Informe a nova data de término.", "Data de término inválida."),
  amendmentDocumentId: optionalId("Documento inválido."),
  note: optionalText(500, "A observação deve ter no máximo 500 caracteres."),
});
export type RenewContractInput = z.input<typeof renewContractSchema>;

/** "Registrar rescisão": effective date (+ optional distrato/notificação document of the contract). */
export const terminateContractSchema = z.object({
  terminationDate: requiredDate("Informe a data da rescisão.", "Data da rescisão inválida."),
  documentId: optionalId("Documento inválido."),
  note: optionalText(500, "A observação deve ter no máximo 500 caracteres."),
});
export type TerminateContractInput = z.input<typeof terminateContractSchema>;

export const idSchema = z.guid({ error: "Registro inválido." });
