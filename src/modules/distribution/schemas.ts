/**
 * Input contracts of the distribution module (client-safe: no server imports).
 * The service validates every input with these schemas; actions only map
 * FormData to plain objects.
 *
 * The form is flat on purpose (one field per criterion) so validation errors
 * map to individual fields; the service converts it to the
 * `DistributionCriteria` / `DistributionAssignment` jsonb columns.
 */
import { z } from "zod";
import { LEGAL_AREAS, PROCESS_INSTANCES, type Role } from "@/domain/enums";

export const DISTRIBUTION_METHODS = ["fixed", "round_robin", "least_loaded"] as const;
export type DistributionMethod = (typeof DISTRIBUTION_METHODS)[number];

export const DISTRIBUTION_METHOD_LABELS: Record<DistributionMethod, string> = {
  fixed: "Responsável fixo",
  round_robin: "Rodízio entre a equipe",
  least_loaded: "Menor carga de trabalho",
};

export const DISTRIBUTION_METHOD_DESCRIPTIONS: Record<DistributionMethod, string> = {
  fixed: "Sempre o primeiro advogado ativo da lista (os demais são reserva, na ordem).",
  round_robin: "Um de cada vez, na ordem da lista; a posição do rodízio avança a cada distribuição.",
  least_loaded: "Quem tiver menos processos ativos sob sua responsabilidade + entradas em aberto.",
};

/** Roles that can receive a distributed process. */
export const ASSIGNABLE_ROLES = ["lawyer", "legal_manager", "external_counsel"] as const satisfies readonly Role[];

export function isAssignableRole(role: Role): boolean {
  return (ASSIGNABLE_ROLES as readonly Role[]).includes(role);
}

const MAX_CENTS = 100_000_000_000_000; // R$ 1 trilhão, in cents

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use no máximo ${max} caracteres.`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const textList = (maxItems: number, maxLen: number, itemMsg: string) =>
  z
    .array(z.string().trim().min(1, itemMsg).max(maxLen, `Cada item deve ter no máximo ${maxLen} caracteres.`))
    .max(maxItems, `Informe no máximo ${maxItems} itens.`)
    .optional();

const idList = (msg: string) => z.array(z.guid({ error: msg })).max(100, "Itens demais selecionados.").optional();

const optionalCents = z
  .number({ error: "Valor inválido. Use o formato 1.234,56." })
  .int("Valor inválido. Use no máximo duas casas decimais.")
  .min(0, "O valor não pode ser negativo.")
  .max(MAX_CENTS, "Valor acima do limite permitido.")
  .nullable()
  .optional();

const optionalId = (msg: string) =>
  z
    .union([z.guid({ error: msg }), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const ruleInputSchema = z
  .object({
    name: z
      .string({ error: "Informe o nome da regra." })
      .trim()
      .min(1, "Informe o nome da regra.")
      .max(120, "Use no máximo 120 caracteres."),
    description: optionalText(1000),
    priority: z
      .number({ error: "Informe a prioridade (número inteiro)." })
      .int("A prioridade deve ser um número inteiro.")
      .min(0, "A prioridade não pode ser negativa.")
      .max(100_000, "Use uma prioridade de até 100.000."),
    isActive: z.boolean().optional(),
    // Criteria (empty = does not restrict)
    courts: textList(50, 40, "Tribunal inválido."),
    areas: z.array(z.enum(LEGAL_AREAS, { error: "Área inválida." })).optional(),
    companyIds: idList("Empresa inválida."),
    unitIds: idList("Unidade inválida."),
    states: z
      .array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use UFs com 2 letras (ex.: TO, SP)."))
      .max(27, "Informe no máximo 27 UFs.")
      .optional(),
    cities: textList(100, 120, "Cidade inválida."),
    instances: z.array(z.enum(PROCESS_INSTANCES, { error: "Instância inválida." })).optional(),
    processClasses: textList(50, 40, "Classe inválida."),
    minClaimCents: optionalCents,
    maxClaimCents: optionalCents,
    // Assignment
    method: z.enum(DISTRIBUTION_METHODS, { error: "Selecione o método de distribuição." }),
    userIds: z
      .array(z.guid({ error: "Advogado inválido." }))
      .min(1, "Selecione pelo menos um advogado para receber os processos.")
      .max(100, "Selecione no máximo 100 pessoas."),
    lawFirmId: optionalId("Escritório inválido."),
    assignUnitId: optionalId("Unidade inválida."),
  })
  .superRefine((v, ctx) => {
    if (
      v.minClaimCents !== null &&
      v.minClaimCents !== undefined &&
      v.maxClaimCents !== null &&
      v.maxClaimCents !== undefined &&
      v.maxClaimCents < v.minClaimCents
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxClaimCents"],
        message: "O valor máximo não pode ser menor que o mínimo.",
      });
    }
    if (new Set(v.userIds).size !== v.userIds.length) {
      ctx.addIssue({ code: "custom", path: ["userIds"], message: "Há advogados repetidos na lista." });
    }
  });

export type RuleInput = z.input<typeof ruleInputSchema>;
export type RuleValues = z.output<typeof ruleInputSchema>;

export const manualAssignmentSchema = z.object({
  userId: z.guid({ error: "Selecione o novo responsável." }),
  reason: z
    .string({ error: "Informe o motivo da redistribuição." })
    .trim()
    .min(3, "Informe o motivo da redistribuição.")
    .max(500, "Use no máximo 500 caracteres."),
});

export type ManualAssignmentInput = z.input<typeof manualAssignmentSchema>;

/** Values shown in the rule form (all serializable). Money as typed text ("1.234,56"). */
export type RuleFormValues = {
  name: string;
  description: string;
  priority: string;
  isActive: boolean;
  courts: string;
  areas: string[];
  companyIds: string[];
  unitIds: string[];
  states: string;
  cities: string;
  instances: string[];
  processClasses: string;
  minClaim: string;
  maxClaim: string;
  method: DistributionMethod;
  userIds: string[];
  lawFirmId: string;
  assignUnitId: string;
};

export const EMPTY_RULE_FORM: RuleFormValues = {
  name: "",
  description: "",
  priority: "",
  isActive: true,
  courts: "",
  areas: [],
  companyIds: [],
  unitIds: [],
  states: "",
  cities: "",
  instances: [],
  processClasses: "",
  minClaim: "",
  maxClaim: "",
  method: "least_loaded",
  userIds: [],
  lawFirmId: "",
  assignUnitId: "",
};

/** "TRT10, TRT2; TST" → ["TRT10", "TRT2", "TST"] (comma, semicolon or line separated). */
export function splitList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
