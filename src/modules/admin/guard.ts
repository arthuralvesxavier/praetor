import { redirect } from "next/navigation";
import type { UserContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { ADMIN_AREA_PERMISSIONS } from "./sections";

/**
 * Page guard for administration pages available to ANY admin-area permission
 * (overview, permission matrix). Pages tied to one permission call
 * `requirePageContext(permission)` directly.
 */
export async function requireAdminAreaContext(): Promise<UserContext> {
  const ctx = await requirePageContext();
  if (!ADMIN_AREA_PERMISSIONS.some((p) => can(ctx, p))) redirect("/sem-permissao");
  return ctx;
}
