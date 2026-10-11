import { z } from "zod";
import { ENTITY_TYPES, ROLES } from "@/domain/enums";

/**
 * Zod input contracts of the administration module (client-safe: no server
 * imports). The service validates every input with these schemas; actions
 * only translate FormData into plain objects.
 */

const guid = (message = "Identificador inválido.") => z.guid({ error: message });

const optionalId = (message?: string) => guid(message).nullable().optional();

const personName = z
  .string({ error: "Informe o nome." })
  .trim()
  .min(2, "O nome deve ter pelo menos 2 caracteres.")
  .max(120, "O nome deve ter no máximo 120 caracteres.");

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} deve ter no máximo ${max} caracteres.`)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const idList = (max: number, message: string) =>
  z.array(guid()).max(max, message).optional().default([]).transform((ids) => [...new Set(ids)]);

const role = z.enum(ROLES, { error: "Selecione um perfil válido." });

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const emailSchema = z
  .string({ error: "Informe o e-mail." })
  .trim()
  .toLowerCase()
  .max(254, "O e-mail deve ter no máximo 254 caracteres.")
  .pipe(z.email({ error: "Informe um e-mail válido." }));

export const createUserSchema = z.object({
  name: personName,
  email: emailSchema,
  role,
  unitId: optionalId("Selecione uma unidade válida."),
  jobTitle: optionalText(120, "O cargo"),
  /** Policy (length, letters and digits) is checked by the service with `passwordPolicyError`. */
  password: z.string({ error: "Informe a senha inicial." }).min(1, "Informe a senha inicial.").max(200, "A senha deve ter no máximo 200 caracteres."),
  teamIds: idList(50, "Selecione no máximo 50 equipes."),
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: personName,
  role,
  unitId: optionalId("Selecione uma unidade válida."),
  jobTitle: optionalText(120, "O cargo"),
  isActive: z.boolean({ error: "Informe se o usuário está ativo." }),
  teamIds: idList(50, "Selecione no máximo 50 equipes."),
});
export type UpdateUserInput = z.input<typeof updateUserSchema>;

export const resetPasswordSchema = z
  .object({
    password: z.string({ error: "Informe a nova senha." }).min(1, "Informe a nova senha.").max(200, "A senha deve ter no máximo 200 caracteres."),
    confirmPassword: z.string({ error: "Confirme a nova senha." }).min(1, "Confirme a nova senha."),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    error: "A confirmação não confere com a nova senha.",
  });
export type ResetPasswordInput = z.input<typeof resetPasswordSchema>;

export const USER_SITUATIONS = ["ativos", "inativos"] as const;
export type UserSituation = (typeof USER_SITUATIONS)[number];

export const userFiltersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: role.optional(),
  unitId: guid().optional(),
  active: z.boolean().optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export type UserFilters = z.input<typeof userFiltersSchema>;

// ---------------------------------------------------------------------------
// Teams & units
// ---------------------------------------------------------------------------

export const teamSchema = z.object({
  name: z
    .string({ error: "Informe o nome da equipe." })
    .trim()
    .min(2, "O nome deve ter pelo menos 2 caracteres.")
    .max(120, "O nome deve ter no máximo 120 caracteres."),
  description: optionalText(1000, "A descrição"),
  unitId: optionalId("Selecione uma unidade válida."),
  leaderId: optionalId("Selecione um líder válido."),
  memberIds: idList(500, "Selecione no máximo 500 membros."),
});
export type TeamInput = z.input<typeof teamSchema>;

export const unitSchema = z.object({
  name: z
    .string({ error: "Informe o nome da unidade." })
    .trim()
    .min(2, "O nome deve ter pelo menos 2 caracteres.")
    .max(120, "O nome deve ter no máximo 120 caracteres."),
  code: optionalText(30, "O código"),
  isActive: z.boolean().optional(),
});
export type UnitInput = z.input<typeof unitSchema>;

export const listFiltersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Organization settings
// ---------------------------------------------------------------------------

const intIn = (min: number, max: number, label: string) =>
  z
    .number({ error: `Informe ${label}.` })
    .int(`Informe um número inteiro para ${label}.`)
    .min(min, `O valor mínimo para ${label} é ${min.toLocaleString("pt-BR")}.`)
    .max(max, `O valor máximo para ${label} é ${max.toLocaleString("pt-BR")}.`);

/** Bounds shown next to each field in the settings form. */
export const SETTINGS_BOUNDS = {
  monthlyTokenBudget: { min: 0, max: 1_000_000_000 },
  maxInputChars: { min: 5_000, max: 1_000_000 },
  upcomingDeadlineDays: { min: 1, max: 90 },
  contractExpirationDays: { min: 1, max: 365 },
  closedRecordRetentionDays: { min: 30, max: 36_500 },
  auditLogRetentionDays: { min: 180, max: 36_500 },
} as const;

const B = SETTINGS_BOUNDS;

/** Flat shape (one key per form field) so field errors map 1:1 to inputs. */
export const organizationSettingsSchema = z.object({
  name: z
    .string({ error: "Informe o nome da organização." })
    .trim()
    .min(2, "O nome deve ter pelo menos 2 caracteres.")
    .max(120, "O nome deve ter no máximo 120 caracteres."),
  monthlyTokenBudget: intIn(B.monthlyTokenBudget.min, B.monthlyTokenBudget.max, "o limite mensal de tokens"),
  maxInputChars: intIn(B.maxInputChars.min, B.maxInputChars.max, "o limite de caracteres por análise"),
  autoAnalyzeOnUpload: z.boolean(),
  upcomingDeadlineDays: intIn(B.upcomingDeadlineDays.min, B.upcomingDeadlineDays.max, "a antecedência de alerta de prazos"),
  contractExpirationDays: intIn(B.contractExpirationDays.min, B.contractExpirationDays.max, "a antecedência de alerta de contratos"),
  closedRecordRetentionDays: intIn(
    B.closedRecordRetentionDays.min,
    B.closedRecordRetentionDays.max,
    "o prazo de retenção de registros encerrados",
  ),
  auditLogRetentionDays: intIn(B.auditLogRetentionDays.min, B.auditLogRetentionDays.max, "o prazo de retenção da auditoria"),
});
export type OrganizationSettingsInput = z.input<typeof organizationSettingsSchema>;

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export const ROUTINE_INTERVAL_BOUNDS = { min: 15, max: 43_200 } as const;
export const ROUTINE_MAX_PER_RUN_BOUNDS = { min: 1, max: 50 } as const;

export const routineUpdateSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: intIn(ROUTINE_INTERVAL_BOUNDS.min, ROUTINE_INTERVAL_BOUNDS.max, "o intervalo (minutos)"),
  /** Only for `stale_analysis_refresh`. */
  autoRefresh: z.boolean().optional(),
  /** Only for `stale_analysis_refresh`. */
  maxPerRun: intIn(ROUTINE_MAX_PER_RUN_BOUNDS.min, ROUTINE_MAX_PER_RUN_BOUNDS.max, "o máximo de reanálises por execução").optional(),
});
export type RoutineUpdateInput = z.input<typeof routineUpdateSchema>;

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD.")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Data inválida.");

export const auditFiltersSchema = z.object({
  action: z.string().trim().max(100).regex(/^[a-z0-9_.]+$/, "Ação inválida.").optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  actorId: guid().optional(),
  /** Narrows to one record (used by the user/team/unit pages). */
  entityId: guid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export type AuditFilters = z.input<typeof auditFiltersSchema>;
