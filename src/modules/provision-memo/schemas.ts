import { z } from "zod";

export const PROVISION_MEMO_FORMATS = ["xlsx", "pdf"] as const;
export type ProvisionMemoFormat = (typeof PROVISION_MEMO_FORMATS)[number];

export const memoPeriodSchema = z
  .string({ error: "Informe a competência." })
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Competência inválida (use AAAA-MM)." });

export const memoFormatSchema = z.enum(PROVISION_MEMO_FORMATS, { error: "Formato inválido: use xlsx ou pdf." });
