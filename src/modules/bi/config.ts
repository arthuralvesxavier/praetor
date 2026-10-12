import { eq } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/server/db/client";
import { biSettings, type BiReportConfig } from "@/server/db/schema";
import { DEFAULT_BI_RLS_ROLE } from "./schemas";

/**
 * Configuração dos painéis Power BI de uma organização (tabela `bi_settings`),
 * com padrões quando a linha ainda não existe. Server only, sem checagem de
 * permissão: quem chama (service, rotina, job) decide o que pode ver.
 */
export type BiConfig = {
  workspaceId: string | null;
  reports: BiReportConfig[];
  rlsRole: string;
  autoRefresh: boolean;
  configUpdatedAt: Date | null;
  configUpdatedById: string | null;
  accessRefreshedAt: Date | null;
  accessUserCount: number | null;
  accessRowCount: number | null;
  /** Last time the access rows changed (a link was added or removed). */
  accessChangedAt: Date | null;
  sourceWatermarkAt: Date | null;
};

export const DEFAULT_BI_CONFIG: BiConfig = {
  workspaceId: null,
  reports: [],
  rlsRole: DEFAULT_BI_RLS_ROLE,
  autoRefresh: true,
  configUpdatedAt: null,
  configUpdatedById: null,
  accessRefreshedAt: null,
  accessUserCount: null,
  accessRowCount: null,
  accessChangedAt: null,
  sourceWatermarkAt: null,
};

/** Keeps only well-formed report entries (the jsonb column is not trusted blindly). */
export function sanitizeReports(raw: unknown): BiReportConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const x = r as Partial<BiReportConfig> | null;
    if (!x || typeof x.id !== "string" || typeof x.datasetId !== "string" || typeof x.name !== "string") return [];
    return [{ id: x.id, name: x.name, datasetId: x.datasetId }];
  });
}

export async function loadBiConfig(organizationId: string, db: DbOrTx = getDb()): Promise<BiConfig> {
  const [row] = await db.select().from(biSettings).where(eq(biSettings.organizationId, organizationId)).limit(1);
  if (!row) return { ...DEFAULT_BI_CONFIG };
  return {
    workspaceId: row.workspaceId,
    reports: sanitizeReports(row.reports),
    rlsRole: row.rlsRole || DEFAULT_BI_RLS_ROLE,
    autoRefresh: row.autoRefresh,
    configUpdatedAt: row.configUpdatedAt,
    configUpdatedById: row.configUpdatedById,
    accessRefreshedAt: row.accessRefreshedAt,
    accessUserCount: row.accessUserCount,
    accessRowCount: row.accessRowCount,
    accessChangedAt: row.accessChangedAt,
    sourceWatermarkAt: row.sourceWatermarkAt,
  };
}

/** Distinct dataset ids of the configured reports. */
export function configuredDatasets(config: Pick<BiConfig, "reports">): string[] {
  return [...new Set(config.reports.map((r) => r.datasetId.toLowerCase()))];
}

/** Makes sure the organization has a `bi_settings` row (defaults) and locks it for the transaction. */
export async function lockBiSettingsRow(organizationId: string, tx: DbOrTx): Promise<void> {
  await tx.insert(biSettings).values({ organizationId }).onConflictDoNothing({ target: biSettings.organizationId });
  await tx.select({ id: biSettings.organizationId }).from(biSettings).where(eq(biSettings.organizationId, organizationId)).for("update");
}
