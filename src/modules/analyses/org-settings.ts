import { eq } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/server/db/client";
import { DEFAULT_ORGANIZATION_SETTINGS, organizations, type OrganizationSettings } from "@/server/db/schema";
import { NotFoundError } from "@/server/lib/errors";

/**
 * Organization settings with defaults filled in (the jsonb column may hold a
 * partial object written by an older version). Server only.
 */
export function mergeOrganizationSettings(raw: Partial<OrganizationSettings> | null | undefined): OrganizationSettings {
  const d = DEFAULT_ORGANIZATION_SETTINGS;
  return {
    ai: { ...d.ai, ...(raw?.ai ?? {}) },
    alerts: { ...d.alerts, ...(raw?.alerts ?? {}) },
    retention: { ...d.retention, ...(raw?.retention ?? {}) },
  };
}

export async function loadOrganization(
  organizationId: string,
  db: DbOrTx = getDb(),
): Promise<{ id: string; isDemo: boolean; settings: OrganizationSettings }> {
  const [org] = await db
    .select({ id: organizations.id, isDemo: organizations.isDemo, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!org) throw new NotFoundError("Organização não encontrada.");
  return { id: org.id, isDemo: org.isDemo, settings: mergeOrganizationSettings(org.settings) };
}

/** Current usage period (`YYYY-MM`, UTC). */
export function currentUsagePeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
