/**
 * Server-side data for the authenticated app shell (header, user menu). Pure
 * data loading — no `next/*` imports — so it is unit-tested with PGlite
 * (tests/shell/shell-data.test.ts). Never import from client components.
 *
 * Every read is tenant-scoped: organization/unit/law firm by the ids in the
 * AuthContext AND `organization_id = ctx.organizationId`; alert counts use the
 * row-visibility rules of the alerts service.
 */
import { and, eq } from "drizzle-orm";
import type { AiMode } from "@/domain/enums";
import { countOpenAlerts } from "@/modules/alerts/service";
import { getAiRuntimeInfo } from "@/modules/analyses/service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { lawFirms, organizations, units } from "@/server/db/schema";
import { getEmailRuntimeInfo } from "@/server/integrations/email";
import { logger } from "@/server/lib/logger";

export type ShellData = {
  organizationName: string;
  unitName: string | null;
  /** Only for external counsel: the law firm whose portfolio they see. */
  lawFirmName: string | null;
  /** Null when the user cannot open /alertas or the count failed. */
  alerts: { total: number; critical: number } | null;
  aiMode: AiMode | null;
  /** Null when the user cannot open the e-mail center (email:read). */
  emailMode: "simulated" | "live" | null;
};

export async function loadShellData(ctx: AuthContext): Promise<ShellData> {
  const db = getDb();

  const orgQuery = db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const unitQuery = ctx.unitId
    ? db
        .select({ name: units.name })
        .from(units)
        .where(and(eq(units.id, ctx.unitId), eq(units.organizationId, ctx.organizationId)))
        .limit(1)
    : Promise.resolve([] as { name: string }[]);
  const firmQuery =
    ctx.role === "external_counsel" && ctx.lawFirmId
      ? db
          .select({ name: lawFirms.name })
          .from(lawFirms)
          .where(and(eq(lawFirms.id, ctx.lawFirmId), eq(lawFirms.organizationId, ctx.organizationId)))
          .limit(1)
      : Promise.resolve([] as { name: string }[]);
  const alertsQuery = can(ctx, "dashboard:read")
    ? countOpenAlerts(ctx).catch((error: unknown) => {
        logger.error("shell_alert_count_failed", { error });
        return null;
      })
    : Promise.resolve(null);

  const [[org], [unit], [firm], alerts] = await Promise.all([orgQuery, unitQuery, firmQuery, alertsQuery]);

  let aiMode: AiMode | null = null;
  try {
    aiMode = getAiRuntimeInfo().mode;
  } catch (error) {
    logger.error("ai_runtime_info_failed", { error });
  }

  let emailMode: ShellData["emailMode"] = null;
  if (can(ctx, "email:read")) {
    try {
      emailMode = getEmailRuntimeInfo().mode;
    } catch (error) {
      logger.error("email_runtime_info_failed", { error });
      emailMode = "simulated";
    }
  }

  return {
    organizationName: org?.name ?? "Organização",
    unitName: unit?.name ?? null,
    lawFirmName: firm?.name ?? null,
    alerts,
    aiMode,
    emailMode,
  };
}
