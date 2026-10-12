/**
 * zod contracts of the emails module (client-safe, no server imports).
 *
 * Template data comes from other modules (briefs, intake, routines). Strings
 * are clipped instead of rejected so a long process title never makes a
 * pipeline fail; only structural errors (missing field, wrong type) reject.
 */
import { z } from "zod";
import { EMAIL_TEMPLATES, ENTITY_TYPES, type EmailTemplate } from "@/domain/enums";
import type { EmailTemplateDataMap } from "./templates";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Trimmed string clipped to `max` characters (with an ellipsis). */
const clip = (max: number) =>
  z
    .string()
    .trim()
    .transform((v) => (v.length > max ? `${v.slice(0, max - 1)}…` : v));

/** Same, but blank -> null. */
const clipOrNull = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => {
      const t = (v ?? "").trim();
      if (!t) return null;
      return t.length > max ? `${t.slice(0, max - 1)}…` : t;
    });

/** Array capped at `max` items. */
const capped = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item).transform((list) => list.slice(0, max));

const isoDate = z.string().regex(ISO_DATE_RE, { error: "Data inválida." });
const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { error: "Data e hora inválidas." });
const count = z.number().int().min(0);

export const templateDataSchemas = {
  case_brief_ready: z.object({
    processNumber: clip(60).pipe(z.string().min(1)),
    processTitle: clip(300),
    court: clipOrNull(200),
    parties: clip(400),
    headline: clip(1500),
    urgencies: capped(clip(400), 12),
    possibleDeadlines: capped(z.object({ description: clip(400), date: isoDate.nullable() }), 12),
    gapsCount: count,
    missingDocumentsCount: count,
    isDemo: z.boolean(),
    briefVersion: z.number().int().min(1),
  }),
  intake_assigned: z.object({
    processNumber: clip(60).pipe(z.string().min(1)),
    processTitle: clip(300),
    court: clipOrNull(200),
    assignmentReason: clip(600),
    receivedAt: isoDateTime,
  }),
  deadline_reminder: z.object({
    title: clip(300).pipe(z.string().min(1)),
    dueDate: isoDate,
    processNumber: clipOrNull(60),
    pendingValidation: z.boolean(),
  }),
  hearing_reminder: z.object({
    processNumber: clip(60).pipe(z.string().min(1)),
    processTitle: clip(300),
    kindLabel: clip(120),
    modeLabel: clip(120),
    scheduledAt: isoDateTime,
    location: clipOrNull(300),
  }),
  daily_digest: z.object({
    items: capped(
      z.object({
        label: clip(160),
        count,
        path: z.string().trim().max(500).refine(isAppPath, { error: "Caminho inválido." }),
      }),
      20,
    ),
  }),
  brief_approved: z.object({
    processNumber: clip(60).pipe(z.string().min(1)),
    processTitle: clip(300),
    approvedByName: clip(160),
    briefVersion: z.number().int().min(1),
  }),
} satisfies { [K in EmailTemplate]: z.ZodType<EmailTemplateDataMap[K], unknown> };

/** Internal app path: starts with a single "/", no whitespace or backslashes (never an external URL). */
export function isAppPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !/[\s\\]/.test(value) && value.length <= 500;
}

export const sendTemplatedEmailSchema = z.object({
  template: z.enum(EMAIL_TEMPLATES, { error: "Modelo de e-mail inválido." }),
  toUserId: z.guid({ error: "Destinatário inválido." }),
  data: z.unknown(),
  linkPath: z.string({ error: "Informe o link do e-mail." }).trim().refine(isAppPath, { error: "Link inválido." }),
  processId: z.guid({ error: "Processo inválido." }).nullish(),
  briefId: z.guid({ error: "Análise preliminar inválida." }).nullish(),
  intakeId: z.guid({ error: "Entrada inválida." }).nullish(),
  entity: z
    .object({ type: z.enum(ENTITY_TYPES), id: z.guid() }, { error: "Vínculo inválido." })
    .nullish(),
});

export const listEmailsSchema = z.object({
  template: z.enum(EMAIL_TEMPLATES).optional(),
  toUserId: z.guid().optional(),
  processId: z.guid().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});
export type ListEmailsFilters = z.input<typeof listEmailsSchema>;

export const emailIdSchema = z.guid({ error: "Registro inválido." });
