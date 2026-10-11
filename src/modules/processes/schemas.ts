/**
 * Input contracts of the litigation module (client-safe: no server imports).
 * The service validates every input with these schemas; actions only map
 * FormData to plain objects.
 */
import { z } from "zod";
import type { FormState } from "@/lib/form";
import {
  LEGAL_AREAS,
  LOSS_PROBABILITIES,
  PARTY_ROLES,
  PROCESS_EVENT_TYPES,
  PROCESS_PHASES,
  PROCESS_STATUSES,
  RISK_LEVELS,
  type LegalArea,
  type OccurrenceCategory,
} from "@/domain/enums";

// ---------------------------------------------------------------------------
// CNJ number shape
// ---------------------------------------------------------------------------

/**
 * Shape of the CNJ unified numbering (Res. CNJ 65/2008): NNNNNNN-DD.AAAA.J.TR.OOOO.
 * Only the SHAPE is checked. Check digits are not validated nor "corrected",
 * and there is no tribunal lookup: numbers outside the pattern are stored as
 * informed and flagged in the UI as "fora do padrão CNJ".
 */
export const CNJ_NUMBER_PATTERN = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;

export function isCnjNumberFormat(value: string | null | undefined): boolean {
  return typeof value === "string" && CNJ_NUMBER_PATTERN.test(value.trim());
}

// ---------------------------------------------------------------------------
// Shared field builders
// ---------------------------------------------------------------------------

const requiredText = (max: number, requiredMsg: string) =>
  z
    .string({ error: requiredMsg })
    .trim()
    .min(1, requiredMsg)
    .max(max, `Use no máximo ${max} caracteres.`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use no máximo ${max} caracteres.`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const optionalDate = z
  .union([z.iso.date({ error: "Data inválida." }), z.literal("")])
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

const optionalId = (msg: string) =>
  z
    .union([z.uuid({ error: msg }), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const MAX_CENTS = 100_000_000_000_000; // R$ 1 trilhão, in cents

const optionalCents = z
  .number({ error: "Valor inválido. Use o formato 1.234,56." })
  .int("Valor inválido. Use no máximo duas casas decimais.")
  .min(0, "O valor não pode ser negativo.")
  .max(MAX_CENTS, "Valor acima do limite permitido.")
  .nullable()
  .optional();

const uuidFilter = z
  .union([z.uuid(), z.literal("")])
  .transform((v) => (v === "" ? undefined : v))
  .optional();

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/**
 * Fields of a process. No `.default()` on purpose: the same object is used
 * (partially) for updates, and defaults would overwrite stored values.
 */
const processFields = {
  number: requiredText(60, "Informe o número do processo."),
  title: requiredText(200, "Informe um título para o processo."),
  court: requiredText(120, "Informe o tribunal."),
  courtDivision: optionalText(200),
  jurisdiction: optionalText(120),
  area: z.enum(LEGAL_AREAS, { error: "Selecione a área do direito." }),
  phase: z.enum(PROCESS_PHASES, { error: "Selecione a fase processual." }),
  status: z.enum(PROCESS_STATUSES, { error: "Selecione a situação." }),
  filedAt: optionalDate,
  closedAt: optionalDate,
  unitId: optionalId("Unidade inválida."),
  responsibleId: optionalId("Responsável inválido."),
  claimAmountCents: optionalCents,
  provisionAmountCents: optionalCents,
  riskLevel: z.enum(RISK_LEVELS, { error: "Selecione a classificação de risco." }),
  lossProbability: z
    .union([z.enum(LOSS_PROBABILITIES, { error: "Probabilidade de perda inválida." }), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  riskRationale: optionalText(4000),
  description: optionalText(20000),
  /** Only honored for admin / legal manager (ignored for other roles). */
  isConfidential: z.boolean().optional(),
};

function checkDates(v: { filedAt?: string | null; closedAt?: string | null }, ctx: z.RefinementCtx) {
  if (v.filedAt && v.closedAt && v.closedAt < v.filedAt) {
    ctx.addIssue({
      code: "custom",
      path: ["closedAt"],
      message: "A data de encerramento não pode ser anterior à distribuição.",
    });
  }
}

export const createProcessSchema = z
  .object({
    ...processFields,
    status: processFields.status.optional(),
    riskLevel: processFields.riskLevel.optional(),
    /** Occurrence (preventive record) this process originates from. */
    fromOccurrenceId: optionalId("Ocorrência inválida."),
  })
  .superRefine(checkDates);

export const updateProcessSchema = z.object(processFields).partial().superRefine(checkDates);

export type CreateProcessInput = z.input<typeof createProcessSchema>;
export type UpdateProcessInput = z.input<typeof updateProcessSchema>;

export const processFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(PROCESS_STATUSES).optional(),
  area: z.enum(LEGAL_AREAS).optional(),
  phase: z.enum(PROCESS_PHASES).optional(),
  riskLevel: z.enum(RISK_LEVELS).optional(),
  unitId: uuidFilter,
  responsibleId: uuidFilter,
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export type ProcessFilters = z.input<typeof processFiltersSchema>;

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export const partyInputSchema = z.object({
  name: requiredText(200, "Informe o nome da parte."),
  role: z.enum(PARTY_ROLES, { error: "Selecione o polo da parte." }),
  /** CPF (11 digits) or CNPJ (14 digits); stored as digits only. Personal data: masked in lists. */
  documentNumber: z
    .string()
    .trim()
    .max(30, "Documento inválido.")
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v === "" || v.length === 11 || v.length === 14, {
      message: "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).",
    })
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  isClient: z.boolean().optional(),
  counselName: optionalText(200),
});

export type PartyInput = z.input<typeof partyInputSchema>;

// ---------------------------------------------------------------------------
// Timeline events (movimentações)
// ---------------------------------------------------------------------------

export const processEventInputSchema = z.object({
  occurredAt: z.iso.date({ error: "Informe a data da movimentação." }),
  type: z.enum(PROCESS_EVENT_TYPES, { error: "Selecione o tipo de movimentação." }),
  title: requiredText(200, "Descreva a movimentação em poucas palavras."),
  description: optionalText(10000),
});

export type ProcessEventInput = z.input<typeof processEventInputSchema>;

// ---------------------------------------------------------------------------
// Occurrence -> process prefill
// ---------------------------------------------------------------------------

/** Obvious mappings only; ambiguous categories leave the area for the user to choose. */
const OCCURRENCE_CATEGORY_TO_AREA: Partial<Record<OccurrenceCategory, LegalArea>> = {
  labor: "labor",
  consumer_complaint: "consumer",
  contractual: "civil",
  regulatory: "regulatory",
  environmental: "environmental",
  corporate: "corporate",
  tax: "tax",
};

export function areaFromOccurrenceCategory(category: OccurrenceCategory): LegalArea | null {
  return OCCURRENCE_CATEGORY_TO_AREA[category] ?? null;
}

/** pt-BR names of the fields, used in audit summaries and stale-analysis reasons. */
export const PROCESS_FIELD_LABELS: Record<string, string> = {
  number: "número",
  title: "título",
  court: "tribunal",
  courtDivision: "vara/órgão",
  jurisdiction: "comarca",
  area: "área",
  phase: "fase",
  status: "situação",
  filedAt: "data de distribuição",
  closedAt: "data de encerramento",
  unitId: "unidade",
  responsibleId: "responsável",
  claimAmountCents: "valor da causa",
  provisionAmountCents: "provisão",
  riskLevel: "classificação de risco",
  lossProbability: "probabilidade de perda",
  riskRationale: "justificativa do risco",
  description: "descrição",
  isConfidential: "confidencialidade",
};

/**
 * Form state returned by this module's actions: `ActionResult` plus the
 * submitted values on failure, so forms can re-fill their fields after React
 * resets them (React 19 resets uncontrolled forms after an action).
 */
export type ValuesFormState = FormState & { values?: Record<string, string> };

/** String values of every field (money already formatted as "1.234,56"). */
export type ProcessFormDefaults = {
  number: string;
  title: string;
  court: string;
  courtDivision: string;
  jurisdiction: string;
  area: string;
  phase: string;
  status: string;
  filedAt: string;
  closedAt: string;
  unitId: string;
  responsibleId: string;
  claimAmountCents: string;
  provisionAmountCents: string;
  riskLevel: string;
  lossProbability: string;
  riskRationale: string;
  description: string;
  isConfidential: boolean;
};

export const EMPTY_PROCESS_FORM: ProcessFormDefaults = {
  number: "",
  title: "",
  court: "",
  courtDivision: "",
  jurisdiction: "",
  area: "",
  phase: "knowledge",
  status: "active",
  filedAt: "",
  closedAt: "",
  unitId: "",
  responsibleId: "",
  claimAmountCents: "",
  provisionAmountCents: "",
  riskLevel: "medium",
  lossProbability: "",
  riskRationale: "",
  description: "",
  isConfidential: false,
};
