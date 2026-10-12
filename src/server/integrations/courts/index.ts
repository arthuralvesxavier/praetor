import { env } from "@/server/env";
import { DataJudProvider } from "./datajud";
import type { CourtDataProvider } from "./types";

export * from "./types";
export { courtAliasesForCnj, aliasLabel, UNSUPPORTED_REASON_LABELS, type CourtAliases } from "./aliases";

/**
 * Court data provider registry. Without `DATAJUD_API_KEY` there is no
 * provider: the collection stays inactive and every screen says so
 * ("Coleta inativa: configure DATAJUD_API_KEY"); nothing else breaks.
 */

let override: CourtDataProvider | null | undefined;

export function getCourtProvider(): CourtDataProvider | null {
  if (override !== undefined) return override;
  const e = env();
  if (!e.DATAJUD_API_KEY) return null;
  return new DataJudProvider({ apiKey: e.DATAJUD_API_KEY, baseUrl: e.DATAJUD_BASE_URL, timeoutMs: e.DATAJUD_TIMEOUT_MS });
}

/** Tests only: `undefined` restores the environment-based provider, `null` forces "inactive". */
export function setCourtProviderForTesting(provider: CourtDataProvider | null | undefined): void {
  override = provider;
}

export const COURT_COLLECTION_INACTIVE = "Coleta inativa: configure DATAJUD_API_KEY.";

/** What the screens may show about the provider (never the key). */
export function getCourtRuntimeInfo(): { active: boolean; provider: string; baseUrl: string | null; timeoutMs: number } {
  const provider = getCourtProvider();
  const e = env();
  return {
    active: provider !== null,
    provider: provider?.name ?? "DataJud (CNJ)",
    baseUrl: provider ? e.DATAJUD_BASE_URL : null,
    timeoutMs: e.DATAJUD_TIMEOUT_MS,
  };
}
