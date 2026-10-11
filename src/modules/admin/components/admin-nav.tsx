import { LinkTabs } from "@/components/ui/tabs";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { ADMIN_SECTIONS, type AdminSectionKey } from "../sections";

/** Sub-navigation of the administration area: only the sections the user can access. */
export function AdminNav({ ctx, active }: { ctx: AuthContext; active: AdminSectionKey }) {
  const tabs = ADMIN_SECTIONS.filter((s) => s.permissions.some((p) => can(ctx, p))).map((s) => ({
    key: s.key,
    label: s.label,
    href: s.href,
  }));
  return <LinkTabs tabs={tabs} active={active} label="Seções da administração" className="mb-6" />;
}
