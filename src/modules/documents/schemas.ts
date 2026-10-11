import { z } from "zod";
import { CONFIDENTIALITY_LEVELS, DOCUMENT_CATEGORIES } from "@/domain/enums";

/**
 * Input contracts of the documents module (client-safe: no server imports).
 * The service validates every input with these schemas.
 */

const optionalId = (message: string) =>
  z
    .guid({ error: message })
    .nullish()
    .transform((v) => v ?? null);

const title = z
  .string({ error: "Informe o título." })
  .trim()
  .min(1, "Informe o título.")
  .max(300, "O título deve ter no máximo 300 caracteres.");

const description = z
  .string()
  .trim()
  .max(5000, "A descrição deve ter no máximo 5.000 caracteres.")
  .nullish()
  .transform((v) => (v ? v : null));

const category = z.enum(DOCUMENT_CATEGORIES, { error: "Selecione uma categoria válida." });
const confidentiality = z.enum(CONFIDENTIALITY_LEVELS, { error: "Selecione um nível de confidencialidade válido." });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Informe uma data válida.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Informe uma data válida.");

export const uploadDocumentSchema = z.object({
  title,
  category,
  description,
  confidentiality: confidentiality.default("internal"),
  processId: optionalId("Processo inválido."),
  occurrenceId: optionalId("Ocorrência inválida."),
  contractId: optionalId("Contrato inválido."),
});
export type UploadDocumentMetadata = z.infer<typeof uploadDocumentSchema>;

export const addVersionSchema = z.object({
  changeNote: z
    .string()
    .trim()
    .max(1000, "A nota da versão deve ter no máximo 1.000 caracteres.")
    .nullish()
    .transform((v) => (v ? v : null)),
});

/**
 * Metadata update. Every field is optional: `undefined` keeps the current
 * value, `null` clears nullable fields (links, description, retention date).
 */
export const updateDocumentSchema = z.object({
  title: title.optional(),
  category: category.optional(),
  description: z.string().trim().max(5000, "A descrição deve ter no máximo 5.000 caracteres.").nullish(),
  confidentiality: confidentiality.optional(),
  processId: z.guid({ error: "Processo inválido." }).nullish(),
  occurrenceId: z.guid({ error: "Ocorrência inválida." }).nullish(),
  contractId: z.guid({ error: "Contrato inválido." }).nullish(),
  retentionUntil: isoDate.nullish(),
  legalHold: z.boolean().optional(),
});
export type UpdateDocumentInput = z.input<typeof updateDocumentSchema>;

export const listDocumentsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: category.optional(),
  processId: z.guid().optional(),
  occurrenceId: z.guid().optional(),
  contractId: z.guid().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

export const idSchema = z.guid();
