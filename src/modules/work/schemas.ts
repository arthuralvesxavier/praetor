import { z } from "zod";
import {
  DATA_ORIGINS,
  DEADLINE_KINDS,
  DEADLINE_STATUSES,
  PRIORITIES,
  TASK_KINDS,
  TASK_STATUSES,
  VALIDATION_STATUSES,
} from "@/domain/enums";

/**
 * zod input contracts of the work module (deadlines + tasks). Client-safe:
 * no server imports. Services validate every input with these schemas.
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date "YYYY-MM-DD" between 1990 and 2199. */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1990 || y > 2199) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export const isoDateSchema = z
  .string({ error: "Informe a data." })
  .trim()
  .refine(isValidIsoDate, { message: "Informe uma data válida." });

/** "YYYY-MM" month (calendar). */
export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const monthSchema = z.string().trim().regex(MONTH_RE, "Mês inválido.");

// Any well-formed UUID (what PostgreSQL accepts); existence/visibility is checked by the service.
const idSchema = z.guid({ error: "Identificador inválido." });
const optionalId = idSchema.nullish();

const titleSchema = z
  .string({ error: "Informe o título." })
  .trim()
  .min(3, "Informe um título com pelo menos 3 caracteres.")
  .max(300, "O título pode ter no máximo 300 caracteres.");

const descriptionSchema = z.string().trim().max(5000, "A descrição pode ter no máximo 5.000 caracteres.").nullish();

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

export const deadlineInputSchema = z.object({
  title: titleSchema,
  description: descriptionSchema,
  dueDate: isoDateSchema,
  kind: z.enum(DEADLINE_KINDS, { error: "Selecione o tipo de prazo." }),
  priority: z.enum(PRIORITIES, { error: "Selecione a prioridade." }).optional(),
  responsibleId: optionalId,
  unitId: optionalId,
  processId: optionalId,
  occurrenceId: optionalId,
  contractId: optionalId,
});
/** Manual deadline input (`createDeadline`). */
export type DeadlineInput = z.input<typeof deadlineInputSchema>;

export const suggestedDeadlineInputSchema = z.object({
  title: z.string({ error: "Informe o título." }).trim().min(1, "Informe o título.").max(300, "O título pode ter no máximo 300 caracteres."),
  dueDate: isoDateSchema,
  kind: z.enum(DEADLINE_KINDS, { error: "Selecione o tipo de prazo." }),
  // AI-provided context can be long: kept, but truncated.
  description: z
    .string()
    .trim()
    .transform((s) => s.slice(0, 5000))
    .nullish(),
  priority: z.enum(PRIORITIES).optional(),
  sourceAnalysisId: idSchema,
  sourceExcerpt: z
    .string({ error: "Informe o trecho da fonte." })
    .trim()
    .min(1, "Informe o trecho da fonte que menciona a data.")
    .max(4000, "O trecho da fonte pode ter no máximo 4.000 caracteres."),
  processId: optionalId,
  occurrenceId: optionalId,
  contractId: optionalId,
});
export type SuggestedDeadlineInput = z.input<typeof suggestedDeadlineInputSchema>;

export const validateDeadlineSchema = z
  .object({
    decision: z.enum(["validated", "rejected"], { error: "Escolha validar ou rejeitar." }),
    note: z.string().trim().max(2000, "A observação pode ter no máximo 2.000 caracteres.").nullish(),
    dueDate: isoDateSchema.nullish(),
    responsibleId: optionalId,
  })
  .superRefine((v, ctx) => {
    if (v.decision === "rejected" && !v.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Informe o motivo da rejeição." });
    }
  });
export type ValidateDeadlineInput = z.input<typeof validateDeadlineSchema>;

export const deadlineStatusSchema = z.enum(DEADLINE_STATUSES, { error: "Situação inválida." });

export const DEADLINE_SITUATIONS = ["overdue", "upcoming", "open"] as const;
export type DeadlineSituation = (typeof DEADLINE_SITUATIONS)[number];

/** URL values (`situacao=`) of the deadline situations. */
export const SITUATION_PARAM_VALUES = { vencidos: "overdue", proximos: "upcoming", abertos: "open" } as const;
export const SITUATION_LABELS: Record<DeadlineSituation, string> = {
  overdue: "Vencidos",
  upcoming: "Próximos",
  open: "Em aberto",
};

export const deadlineFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  situation: z.enum(DEADLINE_SITUATIONS).optional(),
  status: z.enum(DEADLINE_STATUSES).optional(),
  responsibleId: idSchema.optional(),
  origin: z.enum(DATA_ORIGINS).optional(),
  validationStatus: z.enum(VALIDATION_STATUSES).optional(),
  /** Only deadlines that count as real deadlines (manual or validated). */
  realOnly: z.boolean().optional(),
  processId: idSchema.optional(),
  occurrenceId: idSchema.optional(),
  contractId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const taskInputSchema = z.object({
  title: titleSchema,
  description: descriptionSchema,
  kind: z.enum(TASK_KINDS, { error: "Selecione o tipo de tarefa." }).optional(),
  priority: z.enum(PRIORITIES, { error: "Selecione a prioridade." }).optional(),
  dueDate: isoDateSchema.nullish(),
  assigneeId: optionalId,
  unitId: optionalId,
  processId: optionalId,
  occurrenceId: optionalId,
  contractId: optionalId,
  documentId: optionalId,
});
export type TaskInput = z.input<typeof taskInputSchema>;

export const createTaskSchema = taskInputSchema.extend({
  origin: z.enum(["manual", "ai_suggested"]).optional(),
  sourceAnalysisId: optionalId,
});

export const taskPatchSchema = taskInputSchema.partial().extend({
  status: z.enum(TASK_STATUSES, { error: "Status inválido." }).optional(),
});
export type TaskPatch = z.input<typeof taskPatchSchema>;

export const taskFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: idSchema.optional(),
  kind: z.enum(TASK_KINDS).optional(),
  processId: idSchema.optional(),
  occurrenceId: idSchema.optional(),
  contractId: idSchema.optional(),
  overdue: z.boolean().optional(),
  /** Hide done/cancelled tasks. */
  activeOnly: z.boolean().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

/** Task statuses considered finished (not overdue, completedAt set for done). */
export const CLOSED_TASK_STATUSES = ["done", "cancelled"] as const;
