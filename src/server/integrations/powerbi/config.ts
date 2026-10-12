import { env } from "@/server/env";

/**
 * Credenciais do Power BI (aplicativo registrado no Microsoft Entra ID,
 * "service principal"). Ficam SOMENTE nas variáveis de ambiente do servidor:
 * nunca no banco, em logs, em respostas ou na tela.
 */
export type PowerBiCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Ex.: https://api.powerbi.com */
  apiUrl: string;
  /** Ex.: https://login.microsoftonline.com */
  authorityUrl: string;
};

/** Nomes das variáveis obrigatórias (exibidos na tela de administração quando faltam; nunca os valores). */
export const POWERBI_REQUIRED_ENV = ["POWERBI_TENANT_ID", "POWERBI_CLIENT_ID", "POWERBI_CLIENT_SECRET"] as const;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Variáveis obrigatórias que não estão definidas. */
export function missingPowerBiEnv(): string[] {
  const e = env();
  const values: Record<(typeof POWERBI_REQUIRED_ENV)[number], string | undefined> = {
    POWERBI_TENANT_ID: e.POWERBI_TENANT_ID,
    POWERBI_CLIENT_ID: e.POWERBI_CLIENT_ID,
    POWERBI_CLIENT_SECRET: e.POWERBI_CLIENT_SECRET,
  };
  return POWERBI_REQUIRED_ENV.filter((k) => !values[k]?.trim());
}

/** Credenciais completas, ou null quando alguma variável obrigatória falta. */
export function getPowerBiCredentials(): PowerBiCredentials | null {
  if (missingPowerBiEnv().length > 0) return null;
  const e = env();
  return {
    tenantId: e.POWERBI_TENANT_ID!.trim(),
    clientId: e.POWERBI_CLIENT_ID!.trim(),
    clientSecret: e.POWERBI_CLIENT_SECRET!,
    apiUrl: trimSlash(e.POWERBI_API_URL),
    authorityUrl: trimSlash(e.POWERBI_AUTHORITY_URL),
  };
}

export function isPowerBiConfigured(): boolean {
  return getPowerBiCredentials() !== null;
}
