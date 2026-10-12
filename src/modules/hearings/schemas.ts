import { z } from "zod";
import { HEARING_KINDS, HEARING_MODES, HEARING_STATUSES } from "@/domain/enums";
import { isValidIsoDate } from "@/modules/work/schemas";
import { TIME_RE, isHttpUrl } from "./time";

/**
 * zod input contracts of the hearings module (client-safe: no server imports).
 * Services validate every input with these schemas.
 *
 * Dates and times are typed as a calendar date ("YYYY-MM-DD") plus a wall-clock
 * time ("HH:MM") in America/Sao_Paulo; the service converts them to the
 * `scheduled_at` timestamp.
 */

const idSchema = z.guid({ error: "Identificador inválido." });

const dateSchema = z
  .string({ error: "Informe a data." })
  .trim()
  .refine(isValidIsoDate, { message: "Informe uma data válida." });

const timeSchema = z
  .string({ error: "Informe o horário." })
  .trim()
  .regex(TIME_RE, "Informe o horário no formato HH:MM.");

const locationSchema = z.string().trim().max(300, "O local pode ter no máximo 300 caracteres.").nullish();

const meetingUrlSchema = z
  .string()
  .trim()
  .max(1000, "O link pode ter no máximo 1.000 caracteres.")
  .refine((v) => v === "" || isHttpUrl(v), { message: "Informe um link válido (http:// ou https://)." })
  .nullish();

const notesSchema = z.string().trim().max(5000, "As observações podem ter no máximo 5.000 caracteres.").nullish();

/** Where a hearing record came from (people; the DataJud collection never creates hearings, it only alerts). */
export const HEARING_ORIGINS = ["manual", "ai_suggested"] as const;

const hearingFields = {
  kind: z.enum(HEARING_KINDS, { error: "Selecione o tipo de audiência." }),
  mode: z.enum(HEARING_MODES, { error: "Selecione a modalidade." }),
  date: dateSchema,
  time: timeSchema,
  location: locationSchema,
  meetingUrl: meetingUrlSchema,
  responsibleId: idSchema.nullish(),
  notes: notesSchema,
};

function requireLocation(
  v: { mode: (typeof HEARING_MODES)[number]; location?: string | null },
  ctx: z.RefinementCtx,
): void {
  if ((v.mode === "in_person" || v.mode === "hybrid") && !v.location) {
    ctx.addIssue({ code: "custom", path: ["location"], message: "Informe o local da audiência presencial ou híbrida." });
  }
}

export const createHearingSchema = z
  .object({
    processId: idSchema,
    ...hearingFields,
    /**
     * `ai_suggested`: registered by a person from a hint of the preliminary
     * analysis (simulation). Still an explicit user action; never automatic.
     */
    origin: z.enum(HEARING_ORIGINS).optional(),
  })
  .superRefine(requireLocation);
export type CreateHearingInput = z.input<typeof createHearingSchema>;

export const updateHearingSchema = z.object(hearingFields).superRefine(requireLocation);
export type UpdateHearingInput = z.input<typeof updateHearingSchema>;

export const hearingStatusSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("held"),
      outcome: z
        .string({ error: "Descreva o resultado da audiência." })
        .trim()
        .min(3, "Descreva o resultado da audiência.")
        .max(5000, "O resultado pode ter no máximo 5.000 caracteres."),
    }),
    z.object({
      status: z.literal("cancelled"),
      reason: z.string().trim().max(2000, "O motivo pode ter no máximo 2.000 caracteres.").nullish(),
    }),
    z
      .object({
        status: z.literal("rescheduled"),
        date: dateSchema,
        time: timeSchema,
        mode: z.enum(HEARING_MODES, { error: "Selecione a modalidade." }),
        location: locationSchema,
        meetingUrl: meetingUrlSchema,
        reason: z.string().trim().max(2000, "O motivo pode ter no máximo 2.000 caracteres.").nullish(),
      })
      .superRefine(requireLocation),
  ],
  { error: "Escolha uma situação válida." },
);
export type HearingStatusInput = z.input<typeof hearingStatusSchema>;

/** `/audiencias?periodo=` values. Without the param the agenda shows every upcoming hearing. */
export const HEARING_PERIOD_PARAMS = ["7d", "30d", "90d", "passadas"] as const;
export type HearingPeriodParam = (typeof HEARING_PERIOD_PARAMS)[number];
export const HEARING_PERIOD_LABELS: Record<HearingPeriodParam, string> = {
  "7d": "Próximos 7 dias",
  "30d": "Próximos 30 dias",
  "90d": "Próximos 90 dias",
  passadas: "Passadas",
};

export const HEARING_PERIODS = ["upcoming", "7d", "30d", "90d", "past"] as const;
export type HearingPeriod = (typeof HEARING_PERIODS)[number];

export const hearingFiltersSchema = z.object({
  period: z.enum(HEARING_PERIODS).optional(),
  status: z.enum(HEARING_STATUSES).optional(),
  responsibleId: idSchema.optional(),
  processId: idSchema.optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});
export type HearingFilters = z.input<typeof hearingFiltersSchema>;
