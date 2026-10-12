/**
 * Input contracts of the API keys module (client-safe: no server imports).
 */
import { z } from "zod";
import { API_KEY_SCOPES } from "@/domain/enums";

export const API_KEY_PREFIX = "prt_";
/** "prt_" + 32 random bytes in base64url (43 characters). */
export const API_KEY_PATTERN = /^prt_[A-Za-z0-9_-]{43}$/;

export const createApiKeySchema = z.object({
  name: z
    .string({ error: "Informe um nome para a chave." })
    .trim()
    .min(3, "Use pelo menos 3 caracteres no nome.")
    .max(80, "Use no máximo 80 caracteres no nome."),
  scopes: z
    .array(z.enum(API_KEY_SCOPES, { error: "Permissão inválida." }), { error: "Selecione ao menos uma permissão." })
    .min(1, "Selecione ao menos uma permissão.")
    .transform((v) => [...new Set(v)]),
  /** Optional expiry date ("YYYY-MM-DD", end of that day in UTC). */
  expiresOn: z
    .union([z.iso.date({ error: "Data inválida." }), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
});
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;

/** What the creation returns to the administrator, once. */
export type CreatedApiKey = { key: string; name: string; keyPrefix: string };
