import { z } from "zod";
import {
  GUARANTEE_KINDS,
  GUARANTEE_STATUSES,
  LOSS_PROBABILITIES,
  PROCESS_INSTANCES,
  SETTLEMENT_STATUSES,
  VALUATION_KINDS,
  VALUATION_SOURCES,
} from "@/domain/enums";
import { isValidIsoDate, isValidPeriod } from "./rules";

/** zod input contracts for the contingency module (client-safe, no server imports). */

const MAX_CENTS = 100_000_000_000_000; // R$ 1 trilhão

export const idSchema = z.guid({ error: "Registro inválido." });

const requiredId = (message: string) => z.guid({ error: message });

/** Optional uuid reference; empty / missing -> null. */
const optionalId = (message: string) =>
  z
    .union([z.guid({ error: message }), z.literal("")])
    .nullish()
    .transform((v) => (v ? v : null));

/** Optional text: trims; empty / missing -> null. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, { error: message })
    .nullish()
    .transform((v) => (v ? v : null));

const requiredDate = (required: string, invalid: string) =>
  z
    .string({ error: required })
    .trim()
    .min(1, { error: required })
    .refine((v) => isValidIsoDate(v), { error: invalid });

const optionalDate = (message: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isValidIsoDate(v), { error: message });

const amountCents = (required: string) =>
  z
    .number({ error: required })
    .refine((v) => Number.isFinite(v), { error: "Valor inválido. Use o formato 1.234,56." })
    .refine((v) => Number.isInteger(v), { error: "Valor inválido. Use no máximo duas casas decimais." })
    .refine((v) => v >= 0, { error: "O valor não pode ser negativo." })
    .refine((v) => v <= MAX_CENTS, { error: "Valor acima do limite permitido." });

const optionalInstance = z
  .union([z.enum(PROCESS_INSTANCES, { error: "Instância inválida." }), z.literal("")])
  .nullish()
  .transform((v) => (v ? v : null));

const optionalPage = z
  .number({ error: "Informe a página como número inteiro." })
  .int({ error: "Informe a página como número inteiro." })
  .min(1, { error: "A página deve ser maior que zero." })
  .max(100_000, { error: "Página inválida." })
  .nullish()
  .transform((v) => v ?? null);

// ---------------------------------------------------------------------------
// Valuations
// ---------------------------------------------------------------------------

/** Manual entry from the process tab (RF-07): manual value or value read from a document. */
export const addValuationSchema = z
  .object({
    processId: requiredId("Processo inválido."),
    kind: z.enum(VALUATION_KINDS, { error: "Selecione o tipo de valor." }),
    amountCents: amountCents("Informe o valor."),
    baseDate: requiredDate("Informe a data-base do cálculo.", "Data-base inválida."),
    instance: optionalInstance,
    source: z.enum(["manual", "document"], { error: "Selecione a origem do valor." }).default("manual"),
    documentId: optionalId("Documento inválido."),
    page: optionalPage,
    excerpt: optionalText(500, "O trecho deve ter no máximo 500 caracteres."),
    reason: optionalText(1000, "A observação deve ter no máximo 1.000 caracteres."),
  })
  .superRefine((v, ctx) => {
    if (v.source === "document" && !v.documentId) {
      ctx.addIssue({ code: "custom", path: ["documentId"], message: "Selecione o documento de onde o valor foi lido." });
    }
    if (v.source === "manual" && !v.documentId && (v.page !== null || v.excerpt)) {
      ctx.addIssue({ code: "custom", path: ["documentId"], message: "Página e trecho exigem um documento." });
    }
  });
export type AddValuationInput = z.input<typeof addValuationSchema>;
export type AddValuationData = z.output<typeof addValuationSchema>;

/** Contract input of `proposeValuation` (other modules, imports, briefs, simulations). */
export const proposeValuationSchema = z.object({
  processId: requiredId("Processo inválido."),
  kind: z.enum(VALUATION_KINDS, { error: "Tipo de valor inválido." }),
  amountCents: amountCents("Informe o valor."),
  baseDate: requiredDate("Informe a data-base do cálculo.", "Data-base inválida."),
  source: z.enum(VALUATION_SOURCES, { error: "Origem do valor inválida." }),
  instance: optionalInstance,
  documentId: optionalId("Documento inválido."),
  documentVersionId: optionalId("Versão de documento inválida."),
  page: optionalPage,
  excerpt: optionalText(500, "O trecho deve ter no máximo 500 caracteres."),
  confidence: z
    .number({ error: "Confiança inválida." })
    .int({ error: "Confiança inválida." })
    .min(0, { error: "Confiança inválida." })
    .max(100, { error: "Confiança inválida." })
    .nullish()
    .transform((v) => v ?? null),
  reason: optionalText(1000, "A observação deve ter no máximo 1.000 caracteres."),
  briefId: optionalId("Análise preliminar inválida."),
  isEstimate: z.boolean().optional(),
});
export type ProposeValuationData = z.output<typeof proposeValuationSchema>;

export const REVIEW_DECISIONS = ["approve", "correct", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const reviewValuationSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS, { error: "Escolha aprovar, corrigir ou rejeitar." }),
    correctedAmountCents: z
      .number({ error: "Informe o valor corrigido." })
      .nullish()
      .transform((v) => v ?? null),
    note: optionalText(1000, "A observação deve ter no máximo 1.000 caracteres."),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "correct") {
      const amount = v.correctedAmountCents;
      if (amount === null) {
        ctx.addIssue({ code: "custom", path: ["correctedAmountCents"], message: "Informe o valor corrigido." });
      } else if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
        ctx.addIssue({ code: "custom", path: ["correctedAmountCents"], message: "Valor inválido. Use o formato 1.234,56." });
      } else if (amount < 0 || amount > MAX_CENTS) {
        ctx.addIssue({ code: "custom", path: ["correctedAmountCents"], message: "Valor fora do intervalo permitido." });
      }
    }
    if (v.decision === "reject" && !v.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Explique o motivo da rejeição." });
    }
  });
export type ReviewValuationInput = z.input<typeof reviewValuationSchema>;

export const bulkApproveSchema = z.object({
  ids: z
    .array(idSchema, { error: "Selecione os valores a aprovar." })
    .min(1, { error: "Selecione pelo menos um valor." })
    .max(200, { error: "Aprove no máximo 200 valores por vez." }),
});

export const extinctionSchema = z.object({
  baseDate: requiredDate("Informe a data da quitação.", "Data da quitação inválida."),
  documentId: optionalId("Documento inválido."),
  note: optionalText(500, "A observação deve ter no máximo 500 caracteres."),
});
export type ExtinctionInput = z.input<typeof extinctionSchema>;

export const positionAtSchema = z.object({
  date: requiredDate("Informe a data.", "Data inválida."),
});

// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------

export const guaranteeInputSchema = z.object({
  kind: z.enum(GUARANTEE_KINDS, { error: "Selecione o tipo de garantia." }),
  amountCents: amountCents("Informe o valor da garantia."),
  depositedAt: optionalDate("Data do depósito inválida."),
  documentId: optionalId("Documento inválido."),
  description: optionalText(1000, "A descrição deve ter no máximo 1.000 caracteres."),
});
export type GuaranteeInput = z.input<typeof guaranteeInputSchema>;

export const guaranteeStatusSchema = z.object({
  status: z.enum(GUARANTEE_STATUSES, { error: "Selecione a situação da garantia." }),
  statusChangedAt: optionalDate("Data inválida."),
});
export type GuaranteeStatusInput = z.input<typeof guaranteeStatusSchema>;

// ---------------------------------------------------------------------------
// Risk assessments
// ---------------------------------------------------------------------------

export const riskAssessmentSchema = z.object({
  classification: z.enum(LOSS_PROBABILITIES, { error: "Selecione a classificação de risco." }),
  /** Whole percentage 0–100 (up to two decimals). Defaults to the organization parameter of the classification. */
  percentage: z
    .number({ error: "Percentual inválido." })
    .refine((v) => Number.isFinite(v), { error: "Percentual inválido." })
    .refine((v) => v >= 0 && v <= 100, { error: "O percentual deve estar entre 0 e 100." })
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, { error: "Use no máximo duas casas decimais." })
    .nullish()
    .transform((v) => (v === undefined ? null : v)),
  opinion: z
    .string({ error: "Registre o parecer que fundamenta a classificação." })
    .trim()
    .min(10, { error: "O parecer deve ter pelo menos 10 caracteres." })
    .max(2000, { error: "O parecer deve ter no máximo 2.000 caracteres." }),
  effectiveFrom: requiredDate("Informe o início da vigência.", "Data de vigência inválida."),
});
export type RiskAssessmentInput = z.input<typeof riskAssessmentSchema>;

export const riskProposalReviewSchema = z.object({
  note: optionalText(1000, "A observação deve ter no máximo 1.000 caracteres."),
});

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

const optionalCount = z
  .number({ error: "Informe a quantidade de parcelas." })
  .int({ error: "A quantidade de parcelas deve ser um número inteiro." })
  .min(1, { error: "Informe pelo menos 1 parcela." })
  .max(360, { error: "No máximo 360 parcelas." })
  .nullish()
  .transform((v) => v ?? null);

const optionalAmount = amountCents("Valor inválido.").nullish().transform((v) => v ?? null);

function checkTerms(
  v: { totalAmountCents: number | null; installmentsCount: number | null; firstDueDate: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.installmentsCount !== null) {
    if (v.totalAmountCents === null) {
      ctx.addIssue({ code: "custom", path: ["totalAmountCents"], message: "Informe o valor total para gerar as parcelas." });
    } else if (v.totalAmountCents < v.installmentsCount) {
      ctx.addIssue({ code: "custom", path: ["installmentsCount"], message: "O valor total é menor que a quantidade de parcelas." });
    }
    if (v.firstDueDate === null) {
      ctx.addIssue({ code: "custom", path: ["firstDueDate"], message: "Informe o vencimento da primeira parcela." });
    }
  } else if (v.firstDueDate !== null) {
    ctx.addIssue({ code: "custom", path: ["installmentsCount"], message: "Informe a quantidade de parcelas." });
  }
}

export const settlementCreateSchema = z
  .object({
    processId: requiredId("Selecione o processo."),
    status: z.enum(SETTLEMENT_STATUSES, { error: "Selecione a situação do acordo." }).default("proposal"),
    totalAmountCents: optionalAmount,
    installmentsCount: optionalCount,
    firstDueDate: optionalDate("Vencimento inválido."),
    proposedAt: optionalDate("Data da proposta inválida."),
    responsibleId: optionalId("Responsável inválido."),
    notes: optionalText(4000, "As observações devem ter no máximo 4.000 caracteres."),
  })
  .superRefine((v, ctx) => {
    checkTerms(v, ctx);
    if (v.status === "fulfilled" || v.status === "breached" || v.status === "cancelled" || v.status === "homologated") {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "Um acordo novo começa como proposta, em negociação ou firmado; as demais situações vêm depois.",
      });
    }
  });
export type SettlementCreateInput = z.input<typeof settlementCreateSchema>;

export const settlementTermsSchema = z
  .object({
    totalAmountCents: optionalAmount,
    installmentsCount: optionalCount,
    firstDueDate: optionalDate("Vencimento inválido."),
  })
  .superRefine(checkTerms);
export type SettlementTermsInput = z.input<typeof settlementTermsSchema>;

export const settlementStatusSchema = z.object({
  status: z.enum(SETTLEMENT_STATUSES, { error: "Selecione a nova situação." }),
  date: optionalDate("Data inválida."),
});
export type SettlementStatusInput = z.input<typeof settlementStatusSchema>;

export const settlementNotesSchema = z.object({
  notes: optionalText(4000, "As observações devem ter no máximo 4.000 caracteres."),
});

export const installmentPaymentSchema = z.object({
  paid: z.boolean(),
  paidAt: optionalDate("Data de pagamento inválida."),
});
export type InstallmentPaymentInput = z.input<typeof installmentPaymentSchema>;

export const listSettlementsSchema = z.object({
  status: z.enum(SETTLEMENT_STATUSES).optional(),
  dueSoon: z.boolean().optional(),
  processId: z.guid().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});
export type ListSettlementsFilters = z.input<typeof listSettlementsSchema>;

// ---------------------------------------------------------------------------
// Review queue & snapshots
// ---------------------------------------------------------------------------

export const CONFIDENCE_FILTERS = ["baixa", "alta"] as const;
export type ConfidenceFilter = (typeof CONFIDENCE_FILTERS)[number];

export const reviewQueueFiltersSchema = z.object({
  source: z.enum(VALUATION_SOURCES).optional(),
  confidence: z.enum(CONFIDENCE_FILTERS).optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});
export type ReviewQueueFilters = z.input<typeof reviewQueueFiltersSchema>;

export const periodSchema = z
  .string({ error: "Informe a competência." })
  .trim()
  .refine((v) => isValidPeriod(v), { error: "Competência inválida (use AAAA-MM)." });
