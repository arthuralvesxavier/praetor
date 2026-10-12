import { eq } from "drizzle-orm";
import { z } from "zod";
import { mergeOrganizationSettings } from "@/modules/analyses/org-settings";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { organizations, type OrganizationSettings } from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { legalReportSettingsSchema, type LegalReportSettingsInput } from "./schemas";

/** Parâmetros dos relatórios jurídicos (limite de confiança, faixas, base legal). */
export async function getLegalReportSettings(ctx: AuthContext): Promise<OrganizationSettings["legalReports"]> {
  assertCan(ctx, "report:read");
  const [org] = await getDb()
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId));
  if (!org) throw new NotFoundError("Organização não encontrada.");
  return mergeOrganizationSettings(org.settings).legalReports;
}

function flatten(s: OrganizationSettings["legalReports"]): Record<string, unknown> {
  const out: Record<string, unknown> = { confidenceThreshold: s.confidenceThreshold, legalBasisText: s.legalBasisText };
  for (const [band, r] of Object.entries(s.bands)) {
    out[`band_${band}_min`] = r.min;
    out[`band_${band}_max`] = r.max;
  }
  return out;
}

/** Altera os parâmetros (admin:organization). Relatórios já emitidos guardam os parâmetros usados. */
export async function updateLegalReportSettings(ctx: AuthContext, input: LegalReportSettingsInput): Promise<{ changed: boolean }> {
  assertCan(ctx, "admin:organization");
  const parsed = legalReportSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Verifique os campos informados.", z.flattenError(parsed.error).fieldErrors as Record<string, string[]>);
  }
  const next: OrganizationSettings["legalReports"] = {
    confidenceThreshold: parsed.data.confidenceThreshold,
    bands: parsed.data.bands,
    legalBasisText: parsed.data.legalBasisText
      .replace(/[ \u00a0]+[\u2012-\u2015][ \u00a0]+/g, ", ")
      .replace(/[\u2012-\u2015]/g, "-"),
  };
  return getDb().transaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.organizationId)).for("update");
    if (!org) throw new NotFoundError("Organização não encontrada.");
    const current = mergeOrganizationSettings(org.settings);
    const changes = diffChanges(flatten(current.legalReports), flatten(next));
    if (!changes) return { changed: false };
    await tx
      .update(organizations)
      .set({ settings: { ...current, legalReports: next } })
      .where(eq(organizations.id, ctx.organizationId));
    await recordAudit(
      ctx,
      {
        action: "organization.legal_reports_settings_update",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: "Parâmetros dos relatórios jurídicos alterados",
        changes,
      },
      tx,
    );
    return { changed: true };
  });
}
