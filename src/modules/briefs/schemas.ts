import { z } from "zod";
import { CASE_BRIEF_SECTIONS, type CaseBriefSectionKey } from "@/domain/case-brief";
import { CASE_BRIEF_STATUSES } from "@/domain/enums";

/**
 * Input contracts of the briefs module (client-safe: no server imports).
 * The service validates every input with these schemas; the brief content
 * itself is validated with `caseBriefSchema` (@/domain/case-brief).
 */

export const idSchema = z.guid();

const optionalNote = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullish()
    .transform((v) => (v ? v : null));

export const requestBriefSchema = z.object({
  processId: z.guid({ error: "Processo inválido." }),
  intakeId: z.guid({ error: "Entrada inválida." }).nullish(),
  inline: z.boolean().optional(),
});

export const listBriefsSchema = z.object({
  status: z.enum(CASE_BRIEF_STATUSES).optional(),
  responsibleId: z.guid().optional(),
  processId: z.guid().optional(),
  staleOnly: z.boolean().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});
export type ListBriefsFilters = z.input<typeof listBriefsSchema>;

export const approveBriefSchema = z.object({
  note: optionalNote(2000, "A observação pode ter no máximo 2.000 caracteres."),
});

export const rejectBriefSchema = z.object({
  reason: z
    .string({ error: "Informe o motivo da rejeição." })
    .trim()
    .min(3, "Informe o motivo da rejeição.")
    .max(2000, "O motivo pode ter no máximo 2.000 caracteres."),
});

export const revisionMetaSchema = z.object({
  baseRevision: z.number({ error: "Revisão de referência inválida." }).int().min(0),
  changeNote: optionalNote(1000, "A nota da revisão pode ter no máximo 1.000 caracteres."),
});

/** Sections that can be edited one at a time (plus the headline). */
export const EDITABLE_SECTION_KEYS = ["headline", ...CASE_BRIEF_SECTIONS.map((s) => s.key)] as const satisfies readonly (
  | "headline"
  | CaseBriefSectionKey
)[];
export type EditableSectionKey = (typeof EDITABLE_SECTION_KEYS)[number];

export const sectionKeySchema = z.enum(EDITABLE_SECTION_KEYS, { error: "Seção inválida." });

export const itemIndexSchema = z.object({
  briefId: z.guid({ error: "Análise inválida." }),
  index: z.number({ error: "Item inválido." }).int().min(0).max(500),
});

export const citationPageSchema = z.object({
  briefId: z.guid({ error: "Análise inválida." }),
  ref: z.string().regex(/^D\d{1,4}$/, "Referência inválida."),
  page: z.number().int().min(1).max(10_000).nullable(),
});
