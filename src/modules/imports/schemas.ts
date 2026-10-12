/**
 * Input contracts of the import module (client-safe: no server imports).
 */
import { z } from "zod";
import { IMPORT_ROW_ACTIONS, ISSUE_LEVELS } from "@/domain/enums";

export { MAX_IMPORT_BYTES, MAX_IMPORT_MB } from "./limits";

const optionalGuid = (message: string) =>
  z
    .union([z.guid({ error: message }), z.literal("")])
    .nullable()
    .optional()
    .transform((v) => v || null);

const optionalDate = z
  .union([z.iso.date({ error: "Data inválida." }), z.literal("")])
  .nullable()
  .optional()
  .transform((v) => v || null);

export const analyzeImportSchema = z.object({
  fileName: z
    .string({ error: "Selecione a planilha." })
    .trim()
    .min(1, "Selecione a planilha.")
    .max(255, "Nome de arquivo muito longo.")
    .refine((name) => /\.xlsx$/i.test(name), "Envie uma planilha no formato .xlsx."),
  companyId: z.guid({ error: "Selecione a empresa da carteira." }),
  defaultUnitId: optionalGuid("Unidade inválida."),
  baseDate: optionalDate,
  distributeAfterCommit: z.boolean().optional().default(false),
});
export type AnalyzeImportData = z.output<typeof analyzeImportSchema>;

export const commitImportSchema = z.object({
  baseDate: z.iso.date({ error: "Informe a data-base dos valores." }),
  distributeAfterCommit: z.boolean().optional(),
});
export type CommitImportInput = z.input<typeof commitImportSchema>;

export const listImportRowsSchema = z.object({
  sheet: z.string().trim().max(200).optional(),
  action: z.enum(IMPORT_ROW_ACTIONS).optional(),
  level: z.enum(ISSUE_LEVELS).optional(),
});
export type ListImportRowsFilters = z.input<typeof listImportRowsSchema>;

export const listImportIssuesSchema = z.object({
  sheet: z.string().trim().max(200).optional(),
  level: z.enum(ISSUE_LEVELS).optional(),
  code: z
    .string()
    .trim()
    .regex(/^[a-z_]{1,60}$/)
    .optional(),
});
export type ListImportIssuesFilters = z.input<typeof listImportIssuesSchema>;
