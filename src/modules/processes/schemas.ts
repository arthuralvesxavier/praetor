/**
 * Input contracts of the litigation module (client-safe: no server imports).
 * The service validates every input with these schemas; actions only map
 * FormData to plain objects.
 */
import { z } from "zod";
import type { FormState } from "@/lib/form";
import {
  CLOSURE_REASONS,
  LEGAL_AREAS,
  LIABILITY_NATURES,
  LOSS_PROBABILITIES,
  PROCESS_INSTANCES,
  PARTY_ROLES,
  PROCESS_EVENT_TYPES,
  PROCESS_PHASES,
  PROCESS_STATUSES,
  RISK_LEVELS,
  type LegalArea,
  type OccurrenceCategory,
} from "@/domain/enums";
import { isValidCnj, normalizeCnj } from "@/domain/cnj";

// ---------------------------------------------------------------------------
// CNJ number shape
// ---------------------------------------------------------------------------

/**
 * Shape of the CNJ unified numbering (Res. CNJ 65/2008): NNNNNNN-DD.AAAA.J.TR.OOOO.
 * Numbers outside the pattern are stored as informed and flagged in the UI as
 * "fora do padrão CNJ". The check digit is verified (`cnjCheck`) but never
 * "corrected": an invalid digit is a warning for a person to verify.
 * There is no tribunal lookup.
 */
export const CNJ_NUMBER_PATTERN = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;

export function isCnjNumberFormat(value: string | null | undefined): boolean {
  return typeof value === "string" && CNJ_NUMBER_PATTERN.test(value.trim());
}

export type CnjCheck = "valid" | "invalid_check_digit" | "not_cnj";

/** CNJ shape + check digit (mod 97). */
export function cnjCheck(value: string | null | undefined): CnjCheck {
  if (!isCnjNumberFormat(value)) return "not_cnj";
  return isValidCnj(value) ? "valid" : "invalid_check_digit";
}

/**
 * RN-01: the CNJ number is the key of a process. A number typed with exactly
 * 20 digits and only CNJ punctuation ("00012345620245020001",
 * "0001234 56 2024 5 02 0001") is stored in the canonical CNJ format, so the
 * same CNJ cannot be registered twice with different punctuation. Anything
 * else is stored as informed.
 */
export function normalizeProcessNumber(value: string): string {
  const trimmed = value.trim();
  if (/^[\d.\-\s/]+$/.test(trimmed)) return normalizeCnj(trimmed) ?? trimmed;
  return trimmed;
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
    .union([z.guid({ error: msg }), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const optionalEnum = <const T extends readonly [string, ...string[]]>(values: T, msg: string) =>
  z
    .union([z.enum(values, { error: msg }), z.literal("")])
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
  .union([z.guid(), z.literal("")])
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const optionalState = z
  .union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Informe a UF com 2 letras."), z.literal("")])
  .transform((v) => (v === "" ? null : v))
  .nullable()
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
  /** Valor da causa. Setting/changing it records an official `claim` valuation (value history, RF-09). */
  claimAmountCents: optionalCents,
  /**
   * @deprecated Mirror maintained by the contingency module (current provision).
   * Accepted for backward compatibility and IGNORED by the service.
   */
  provisionAmountCents: optionalCents,
  riskLevel: z.enum(RISK_LEVELS, { error: "Selecione a classificação de risco." }),
  /**
   * @deprecated Mirror of the official risk assessment (contingency module).
   * Accepted for backward compatibility and IGNORED by the service.
   */
  lossProbability: optionalEnum(LOSS_PROBABILITIES, "Probabilidade de perda inválida."),
  riskRationale: optionalText(4000),
  description: optionalText(20000),
  /** Only honored for admin / legal manager (ignored for other roles). */
  isConfidential: z.boolean().optional(),
  // v2 (ids are tenant-checked in the service)
  companyId: optionalId("Empresa inválida."),
  lawFirmId: optionalId("Escritório inválido."),
  instance: optionalEnum(PROCESS_INSTANCES, "Instância inválida."),
  processClass: optionalText(40),
  city: optionalText(120),
  state: optionalState,
  phaseDetail: optionalText(500),
  closureReason: optionalEnum(CLOSURE_REASONS, "Motivo de encerramento inválido."),
  needsVerification: z.boolean().optional(),
  verificationNote: optionalText(2000),
  lastMovementAt: optionalDate,
};

function checkDates(
  v: { filedAt?: string | null; closedAt?: string | null; lastMovementAt?: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.filedAt && v.closedAt && v.closedAt < v.filedAt) {
    ctx.addIssue({
      code: "custom",
      path: ["closedAt"],
      message: "A data de encerramento não pode ser anterior à distribuição.",
    });
  }
  if (v.filedAt && v.lastMovementAt && v.lastMovementAt < v.filedAt) {
    ctx.addIssue({
      code: "custom",
      path: ["lastMovementAt"],
      message: "A última movimentação não pode ser anterior à distribuição.",
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

// ---------------------------------------------------------------------------
// Portfolio list filters (URL params are mapped in ./filters.ts)
// ---------------------------------------------------------------------------

/** `active` = status active/suspended (carteira ativa); `closed` = archived/closed (RN-12). */
export const PORTFOLIO_VIEWS = ["active", "closed", "all"] as const;
export type PortfolioView = (typeof PORTFOLIO_VIEWS)[number];

export const LIQUIDATED_FILTERS = ["with", "without"] as const;
export type LiquidatedFilter = (typeof LIQUIDATED_FILTERS)[number];

/**
 * Registration gaps ("pendências de cadastro", URL `pendencia=`): processes whose
 * field is empty — null, or blank text for court and city. The dashboard keeps
 * these processes out of its charts and links here (same rule on both sides).
 */
export const PROCESS_MISSING_FIELDS = ["court", "instance", "phase", "city", "company", "unit"] as const;
export type ProcessMissingField = (typeof PROCESS_MISSING_FIELDS)[number];

export const PROCESS_SORTS = [
  "updated_desc",
  "number_asc",
  "claim_desc",
  "claim_asc",
  "liquidated_desc",
  "liquidated_asc",
  "filed_desc",
  "filed_asc",
  "last_movement_desc",
] as const;
export type ProcessSort = (typeof PROCESS_SORTS)[number];

export const processFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(PROCESS_STATUSES).optional(),
  area: z.enum(LEGAL_AREAS).optional(),
  phase: z.enum(PROCESS_PHASES).optional(),
  riskLevel: z.enum(RISK_LEVELS).optional(),
  unitId: uuidFilter,
  responsibleId: uuidFilter,
  /** Tribunal (exact value, as stored). */
  court: z.string().trim().min(1).max(120).optional(),
  instance: z.enum(PROCESS_INSTANCES).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
  companyId: uuidFilter,
  lawFirmId: uuidFilter,
  processClass: z.string().trim().min(1).max(40).optional(),
  /** Valor da causa range, in cents (URLs carry reais). Processes without valor da causa are excluded when set. */
  claimMinCents: z.number().int().min(0).max(MAX_CENTS).optional(),
  claimMaxCents: z.number().int().min(0).max(MAX_CENTS).optional(),
  /** `with` = valor liquidado apurado; `without` = não apurado (null, RN-03). */
  liquidated: z.enum(LIQUIDATED_FILTERS).optional(),
  /** Only processes whose field is empty (registration gap). */
  missingField: z.enum(PROCESS_MISSING_FIELDS).optional(),
  needsVerification: z.boolean().optional(),
  /** Omitted = every status (callers such as the list page default to `active`). */
  portfolio: z.enum(PORTFOLIO_VIEWS).optional(),
  sort: z.enum(PROCESS_SORTS).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export type ProcessFilters = z.input<typeof processFiltersSchema>;

// ---------------------------------------------------------------------------
// Lifecycle: closure (RN-12 / RF-06), reactivation, verification flag
// ---------------------------------------------------------------------------

export const closeProcessSchema = z.object({
  closureReason: z.enum(CLOSURE_REASONS, { error: "Selecione o motivo da saída da carteira ativa." }),
  /** Defaults to today. */
  closedAt: optionalDate,
  note: optionalText(500),
});
export type CloseProcessInput = z.input<typeof closeProcessSchema>;

export const reactivateProcessSchema = z.object({
  note: optionalText(500),
});
export type ReactivateProcessInput = z.input<typeof reactivateProcessSchema>;

export const flagVerificationSchema = z.object({
  note: requiredText(2000, "Descreva o que precisa ser conferido."),
});
export type FlagVerificationInput = z.input<typeof flagVerificationSchema>;

export const resolveVerificationSchema = z.object({
  note: optionalText(500),
});
export type ResolveVerificationInput = z.input<typeof resolveVerificationSchema>;

// ---------------------------------------------------------------------------
// Instances (vínculos de instância, RN-01/RN-09)
// ---------------------------------------------------------------------------

export const processInstanceInputSchema = z.object({
  instance: z.enum(PROCESS_INSTANCES, { error: "Selecione o grau." }),
  court: requiredText(120, "Informe o tribunal desta instância."),
  courtDivision: optionalText(200),
  city: optionalText(120),
  state: optionalState,
  processClass: optionalText(40),
  phase: optionalEnum(PROCESS_PHASES, "Fase inválida."),
  phaseDetail: optionalText(500),
  claimAmountCents: optionalCents,
  liquidatedAmountCents: optionalCents,
  /** Marks this instance as the one where the process is now (updates the process "instância atual"). */
  isCurrent: z.boolean().optional(),
});
export type ProcessInstanceInput = z.input<typeof processInstanceInputSchema>;

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export const partyInputSchema = z
  .object({
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
    /** Natureza da responsabilidade (direta / solidária / subsidiária): only for the defendant side. */
    liabilityNature: optionalEnum(LIABILITY_NATURES, "Natureza da responsabilidade inválida."),
  })
  .superRefine((v, ctx) => {
    if (v.liabilityNature && v.role !== "defendant") {
      ctx.addIssue({
        code: "custom",
        path: ["liabilityNature"],
        message: "A natureza da responsabilidade se aplica somente ao polo passivo.",
      });
    }
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
  instance: optionalEnum(PROCESS_INSTANCES, "Instância inválida."),
  /**
   * Code of the CNJ movement table (Tabelas Processuais Unificadas), ONLY when
   * informed by a person from an official source. Never suggested or inferred.
   */
  cnjMovementCode: z
    .number({ error: "Informe somente números no código do movimento." })
    .int("Informe somente números no código do movimento.")
    .min(1, "Código do movimento inválido.")
    .max(999_999, "Código do movimento inválido.")
    .nullable()
    .optional(),
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
  companyId: "empresa",
  lawFirmId: "escritório externo",
  instance: "instância",
  processClass: "classe",
  city: "cidade",
  state: "UF",
  phaseDetail: "detalhe da fase",
  closureReason: "motivo de saída",
  needsVerification: "marcação para conferência",
  verificationNote: "nota de conferência",
  lastMovementAt: "última movimentação",
};

/**
 * Form state returned by this module's actions: `ActionResult` plus the
 * submitted values on failure, so forms can re-fill their fields after React
 * resets them (React 19 resets uncontrolled forms after an action).
 */
export type ValuesFormState = FormState & { values?: Record<string, string> };

/** String values of every field of <ProcessForm> (money already formatted as "1.234,56"). */
export type ProcessFormDefaults = {
  number: string;
  title: string;
  court: string;
  courtDivision: string;
  jurisdiction: string;
  area: string;
  phase: string;
  phaseDetail: string;
  status: string;
  filedAt: string;
  lastMovementAt: string;
  instance: string;
  processClass: string;
  city: string;
  state: string;
  companyId: string;
  lawFirmId: string;
  unitId: string;
  responsibleId: string;
  claimAmountCents: string;
  riskLevel: string;
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
  phaseDetail: "",
  status: "active",
  filedAt: "",
  lastMovementAt: "",
  instance: "first",
  processClass: "",
  city: "",
  state: "",
  companyId: "",
  lawFirmId: "",
  unitId: "",
  responsibleId: "",
  claimAmountCents: "",
  riskLevel: "medium",
  riskRationale: "",
  description: "",
  isConfidential: false,
};
