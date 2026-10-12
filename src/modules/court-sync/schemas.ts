/**
 * Input contracts of the court-sync module (client-safe: no server imports).
 */
import { z } from "zod";
import { COURT_SYNC_TRIGGERS } from "@/domain/enums";

const int = (min: number, max: number, label: string) =>
  z
    .number({ error: `Informe ${label}.` })
    .int(`Informe ${label} sem casas decimais.`)
    .min(min, `${label.charAt(0).toUpperCase()}${label.slice(1)}: mínimo ${min}.`)
    .max(max, `${label.charAt(0).toUpperCase()}${label.slice(1)}: máximo ${max}.`);

export const COURT_SETTINGS_BOUNDS = {
  syncIntervalHours: { min: 1, max: 720 },
  maxRequestsPerMinute: { min: 1, max: 120 },
  batchSize: { min: 1, max: 500 },
  simulatedFeedIntervalMinutes: { min: 5, max: 10_080 },
} as const;

export const courtIntegrationSettingsSchema = z.object({
  enabled: z.boolean(),
  syncIntervalHours: int(1, 720, "o intervalo entre consultas (horas)"),
  maxRequestsPerMinute: int(1, 120, "o limite de requisições por minuto"),
  batchSize: int(1, 500, "a quantidade de números por consulta"),
  autoApplyPhase: z.boolean(),
  enrichOnIntake: z.boolean(),
  simulatedFeedEnabled: z.boolean(),
  simulatedFeedIntervalMinutes: int(5, 10_080, "o intervalo da chegada simulada (minutos)"),
});
export type CourtIntegrationSettingsInput = z.input<typeof courtIntegrationSettingsSchema>;

/** Payload of the "court_sync.run" job. */
export const courtSyncJobPayloadSchema = z.object({
  alias: z
    .string()
    .regex(/^[a-z0-9-]{2,12}$/)
    .optional(),
  processIds: z.array(z.guid()).max(500).optional(),
  trigger: z.enum(COURT_SYNC_TRIGGERS).default("routine"),
  force: z.boolean().optional(),
  requestedById: z.guid().nullish(),
  /** Continuation of a long run (see runCourtSyncJob). */
  continuation: z.number().int().min(0).max(1000).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
});
export type CourtSyncJobPayload = z.output<typeof courtSyncJobPayloadSchema>;
