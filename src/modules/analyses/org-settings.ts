import { eq } from "drizzle-orm";
import { CORRECTION_INDEXES } from "@/domain/enums";
import { getDb, type DbOrTx } from "@/server/db/client";
import { DEFAULT_ORGANIZATION_SETTINGS, organizations, type OrganizationSettings } from "@/server/db/schema";
import { NotFoundError } from "@/server/lib/errors";

/**
 * Organization settings with defaults filled in (the jsonb column may hold a
 * partial object written by an older version). Server only.
 */
export function mergeOrganizationSettings(raw: Partial<OrganizationSettings> | null | undefined): OrganizationSettings {
  const d = DEFAULT_ORGANIZATION_SETTINGS;
  const contingency = { ...d.contingency, ...(raw?.contingency ?? {}) };
  return {
    ai: { ...d.ai, ...(raw?.ai ?? {}) },
    alerts: { ...d.alerts, ...(raw?.alerts ?? {}) },
    retention: { ...d.retention, ...(raw?.retention ?? {}) },
    contingency: {
      ...contingency,
      riskPercentages: { ...d.contingency.riskPercentages, ...(raw?.contingency?.riskPercentages ?? {}) },
      // P1.7: an unknown stored value never reaches the valuations (same fallback as the DB trigger).
      defaultCorrectionIndex: (CORRECTION_INDEXES as readonly string[]).includes(String(contingency.defaultCorrectionIndex))
        ? contingency.defaultCorrectionIndex
        : d.contingency.defaultCorrectionIndex,
    },
    // Only the simulated mode exists in this version, whatever an older row says.
    email: { ...d.email, ...(raw?.email ?? {}), mode: "simulated" },
    intake: { ...d.intake, ...(raw?.intake ?? {}) },
    integrations: {
      datajud: { ...d.integrations.datajud, ...(raw?.integrations?.datajud ?? {}) },
      simulatedFeed: { ...d.integrations.simulatedFeed, ...(raw?.integrations?.simulatedFeed ?? {}) },
    },
    legalReports: {
      ...d.legalReports,
      ...(raw?.legalReports ?? {}),
      bands: { ...d.legalReports.bands, ...(raw?.legalReports?.bands ?? {}) },
    },
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
