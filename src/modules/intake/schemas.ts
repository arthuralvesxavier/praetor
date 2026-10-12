/**
 * Input contracts of the intake module (client-safe: no server imports).
 */
import { z } from "zod";
import { LEGAL_AREAS, PROCESS_INSTANCES, PROCESS_PHASES } from "@/domain/enums";
import { normalizeCnj } from "@/domain/cnj";

const MAX_CENTS = 100_000_000_000_000; // R$ 1 trilhão, in cents

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use no máximo ${max} caracteres.`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const optionalId = (msg: string) =>
  z
    .union([z.guid({ error: msg }), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const optionalDate = z
  .union([z.iso.date({ error: "Data inválida." }), z.literal("")])
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

/** Process data of an incoming case (the documents travel separately). */
export const registerIntakeSchema = z.object({
  number: z
    .string({ error: "Informe o número do processo." })
    .trim()
    .min(1, "Informe o número do processo.")
    .max(60, "Número longo demais.")
    .transform((v, ctx) => {
      const normalized = normalizeCnj(v);
      if (!normalized) {
        ctx.addIssue({
          code: "custom",
          message: "Informe o número no padrão CNJ (20 dígitos: NNNNNNN-DD.AAAA.J.TR.OOOO).",
        });
        return z.NEVER;
      }
      return normalized;
    }),
  court: z
    .string({ error: "Informe o tribunal." })
    .trim()
    .min(1, "Informe o tribunal.")
    .max(120, "Use no máximo 120 caracteres."),
  courtDivision: optionalText(200),
  city: optionalText(120),
  state: z
    .union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Informe a UF com 2 letras."), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  processClass: optionalText(40),
  area: z.enum(LEGAL_AREAS, { error: "Selecione a área do direito." }),
  phase: z.enum(PROCESS_PHASES, { error: "Selecione a fase processual." }),
  instance: z.enum(PROCESS_INSTANCES, { error: "Selecione a instância." }),
  companyId: optionalId("Empresa inválida."),
  unitId: optionalId("Unidade inválida."),
  responsibleId: optionalId("Responsável inválido."),
  claimAmountCents: z
    .number({ error: "Valor inválido. Use o formato 1.234,56." })
    .int("Valor inválido. Use no máximo duas casas decimais.")
    .min(0, "O valor não pode ser negativo.")
    .max(MAX_CENTS, "Valor acima do limite permitido.")
    .nullable()
    .optional(),
  filedAt: optionalDate,
  plaintiffName: z
    .string({ error: "Informe a parte autora." })
    .trim()
    .min(1, "Informe a parte autora.")
    .max(200, "Use no máximo 200 caracteres."),
  defendantName: optionalText(200),
  title: optionalText(200),
  description: optionalText(5000),
});

export type RegisterIntakeInput = z.input<typeof registerIntakeSchema>;
export type RegisterIntakeValues = z.output<typeof registerIntakeSchema>;
