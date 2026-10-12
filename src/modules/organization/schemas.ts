import { z } from "zod";

/**
 * Zod input contracts for companies (empresas do grupo) and external law firms
 * (escritórios externos). Client-safe: no server imports. The service validates
 * every input with these schemas; actions only translate FormData.
 */

// ---------------------------------------------------------------------------
// CNPJ
// ---------------------------------------------------------------------------

/**
 * CNPJ check digits (módulo 11). Supports the alphanumeric CNPJ (IN RFB
 * 2.229/2024, in force since July 2026): the first 12 characters may be
 * letters or digits — each worth its ASCII code minus 48 — and the two check
 * digits are always numeric.
 */
function cnpjCheckDigit(base: string): number {
  const weights = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < base.length; i++) sum += (base.charCodeAt(i) - 48) * weights[i];
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** Uppercases and strips punctuation (".", "/", "-", spaces). */
export function cnpjChars(raw: string): string {
  return raw.toUpperCase().replace(/[\s./-]/g, "");
}

/** True when the value is a CNPJ (numeric or alphanumeric) with valid check digits. */
export function isValidCnpj(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const v = cnpjChars(raw);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(v)) return false;
  if (/^(\d)\1{13}$/.test(v)) return false; // 00.000.000/0000-00, 11.111.111/1111-11…
  const first = cnpjCheckDigit(v.slice(0, 12));
  const second = cnpjCheckDigit(v.slice(0, 12) + String(first));
  return v.slice(12) === `${first}${second}`;
}

/** "12.345.678/0001-95" (works for alphanumeric CNPJs too). Returns null for anything that is not 14 characters. */
export function formatCnpj(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = cnpjChars(raw);
  if (v.length !== 14) return null;
  return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`;
}

const cnpj = z
  .string()
  .trim()
  .max(30, "Informe um CNPJ válido.")
  .nullable()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^[0-9A-Za-z\s./-]+$/.test(v), "Use apenas números, letras e a pontuação do CNPJ.")
  .refine((v) => v === null || /^[0-9A-Z]{12}\d{2}$/.test(cnpjChars(v)), "O CNPJ deve ter 14 caracteres (ex.: 12.345.678/0001-95).")
  .refine((v) => v === null || isValidCnpj(v), "CNPJ inválido: os dígitos verificadores não conferem.")
  .transform((v) => (v === null ? null : formatCnpj(v)));

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const orgName = (label: string) =>
  z
    .string({ error: `Informe o nome ${label}.` })
    .trim()
    .min(2, "O nome deve ter pelo menos 2 caracteres.")
    .max(160, "O nome deve ter no máximo 160 caracteres.");

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} deve ter no máximo ${max} caracteres.`)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "O e-mail deve ter no máximo 254 caracteres.")
  .nullable()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || z.email().safeParse(v).success, "Informe um e-mail válido.");

// ---------------------------------------------------------------------------
// Companies & law firms
// ---------------------------------------------------------------------------

export const companySchema = z.object({
  name: orgName("da empresa"),
  document: cnpj,
  isActive: z.boolean().optional(),
});
export type CompanyInput = z.input<typeof companySchema>;

export const lawFirmSchema = z.object({
  name: orgName("do escritório"),
  document: cnpj,
  contactName: optionalText(120, "O nome do contato"),
  contactEmail: optionalEmail,
  isActive: z.boolean().optional(),
});
export type LawFirmInput = z.input<typeof lawFirmSchema>;

export const organizationListFiltersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  active: z.boolean().optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export type OrganizationListFilters = z.input<typeof organizationListFiltersSchema>;
