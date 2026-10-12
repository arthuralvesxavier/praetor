/**
 * Payload of POST /api/v1/processos (client-safe: no server imports). Field
 * names are pt-BR because external systems read them in docs/API.md; every
 * error message is pt-BR.
 */
import { z } from "zod";
import { normalizeCnj } from "@/domain/cnj";
import { DOCUMENT_CATEGORIES, LEGAL_AREAS, PROCESS_INSTANCES, PROCESS_PHASES } from "@/domain/enums";
import { cnpjChars, isValidCnpj } from "@/modules/organization/schemas";

export const INBOUND_MAX_DOCUMENTS = 20;
export const INBOUND_MAX_PARTIES = 50;
export const INBOUND_POLOS = ["ativo", "passivo", "terceiro", "ministerio_publico"] as const;
export type InboundPolo = (typeof INBOUND_POLOS)[number];

const MAX_CENTS = 100_000_000_000_000; // R$ 1 trilhão

const optionalText = (max: number) =>
  z
    .string({ error: "Envie um texto." })
    .trim()
    .max(max, `Use no máximo ${max} caracteres.`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const requiredText = (max: number, message: string) =>
  z.string({ error: message }).trim().min(1, message).max(max, `Use no máximo ${max} caracteres.`);

const partySchema = z.object({
  nome: requiredText(200, "Informe o nome da parte."),
  polo: z.enum(INBOUND_POLOS, { error: "Use um polo válido: ativo, passivo, terceiro ou ministerio_publico." }),
  documento: z
    .string({ error: "Envie o documento como texto." })
    .trim()
    .max(30, "Documento inválido.")
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v === "" || v.length === 11 || v.length === 14, { message: "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)." })
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
});

const documentSchema = z.object({
  titulo: requiredText(200, "Informe o título do documento."),
  categoria: z.enum(DOCUMENT_CATEGORIES, { error: "Categoria de documento inválida." }).optional(),
  nomeArquivo: requiredText(180, "Informe o nome do arquivo (com extensão .pdf, .docx ou .txt)."),
  conteudoBase64: z
    .string({ error: "Envie o conteúdo do arquivo em base64." })
    .min(1, "Envie o conteúdo do arquivo em base64.")
    .regex(/^[A-Za-z0-9+/=\s_-]+$/, "O conteúdo precisa estar em base64."),
});

export const inboundProcessSchema = z.object({
  numero: z
    .string({ error: "Informe o número do processo (campo numero)." })
    .trim()
    .min(1, "Informe o número do processo (campo numero).")
    .max(60, "Número longo demais.")
    .transform((v, ctx) => {
      const normalized = normalizeCnj(v);
      if (!normalized) {
        ctx.addIssue({ code: "custom", message: "Informe o número no padrão CNJ (20 dígitos: NNNNNNN-DD.AAAA.J.TR.OOOO)." });
        return z.NEVER;
      }
      return normalized;
    }),
  tribunal: optionalText(120),
  orgaoJulgador: optionalText(200),
  cidade: optionalText(120),
  uf: z
    .union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Informe a UF com 2 letras."), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  classe: optionalText(40),
  area: z.enum(LEGAL_AREAS, { error: `Área inválida. Use: ${LEGAL_AREAS.join(", ")}.` }).optional(),
  // P0.5: fase e instância são eixos distintos. "Em recurso" é a instância (second/superior), nunca a fase.
  fase: z.enum(PROCESS_PHASES, { error: `Fase inválida. Use: ${PROCESS_PHASES.join(", ")} (recurso é a instância: campo instancia).` }).optional(),
  instancia: z.enum(PROCESS_INSTANCES, { error: `Instância inválida. Use: ${PROCESS_INSTANCES.join(", ")} (1º, 2º ou 3º grau).` }).optional(),
  ajuizadoEm: z.iso.date({ error: "Data inválida. Use AAAA-MM-DD." }).nullable().optional(),
  valorDaCausa: z
    .string({ error: 'Envie o valor da causa como texto decimal com ponto, por exemplo "12345.67".' })
    .trim()
    .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use o formato decimal com ponto, por exemplo "12345.67".')
    .transform((v) => {
      const [int, frac = ""] = v.split(".");
      return Number(int) * 100 + Number(frac.padEnd(2, "0"));
    })
    .refine((cents) => cents <= MAX_CENTS, "Valor acima do limite permitido.")
    .nullable()
    .optional(),
  partes: z
    .array(partySchema, { error: "Envie a lista de partes (campo partes)." })
    .min(1, "Informe ao menos uma parte.")
    .max(INBOUND_MAX_PARTIES, `Envie no máximo ${INBOUND_MAX_PARTIES} partes.`),
  empresaCnpj: z
    .string({ error: "Envie o CNPJ como texto." })
    .trim()
    .transform((v) => (v === "" ? null : cnpjChars(v)))
    .refine((v) => v === null || isValidCnpj(v), "CNPJ inválido.")
    .nullable()
    .optional(),
  empresaNome: optionalText(200),
  documentos: z
    .array(documentSchema, { error: "Envie a lista de documentos (campo documentos)." })
    .max(INBOUND_MAX_DOCUMENTS, `Envie no máximo ${INBOUND_MAX_DOCUMENTS} documentos por requisição.`)
    .optional()
    .default([]),
  origem: z.object(
    {
      sistema: requiredText(80, "Informe o sistema de origem (origem.sistema)."),
      referencia: optionalText(120),
    },
    { error: "Informe a origem (objeto origem com sistema e, se houver, referencia)." },
  ),
  observacao: optionalText(2000),
});

export type InboundProcessInput = z.input<typeof inboundProcessSchema>;
export type InboundProcessValues = z.output<typeof inboundProcessSchema>;
