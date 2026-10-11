import { eq } from "drizzle-orm";
import Link from "next/link";
import type { ReactNode } from "react";
import { DemoBanner } from "@/components/layout/demo-banner";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Sidebar, SidebarContent, type ShellNavItem } from "@/components/layout/sidebar";
import { SkipLink } from "@/components/layout/skip-link";
import { UserMenu } from "@/components/layout/user-menu";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { ROLE_LABELS, type AiMode } from "@/domain/enums";
import { NAV_ITEMS } from "@/lib/nav";
import { getAiRuntimeInfo } from "@/modules/analyses/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { organizations, units } from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { signOutAction } from "./actions";

/**
 * Authenticated app shell. NOTE: layouts do not re-render on client navigation
 * and are NOT an authorization boundary — every page calls
 * requirePageContext(permission) itself.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePageContext();
  const db = getDb();

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const [unit] = ctx.unitId
    ? await db.select({ name: units.name }).from(units).where(eq(units.id, ctx.unitId)).limit(1)
    : [];

  let aiMode: AiMode | null = null;
  try {
    aiMode = getAiRuntimeInfo().mode;
  } catch (error) {
    logger.error("ai_runtime_info_failed", { error });
  }

  const navItems: ShellNavItem[] = NAV_ITEMS.filter((item) => item.permissions.some((p) => can(ctx, p))).map(
    ({ href, label, icon: Icon }) => ({ href, label, icon: <Icon /> }),
  );

  const sidebarFooter = ctx.isDemoOrganization ? (
    <span>Ambiente demonstrativo · dados fictícios</span>
  ) : (
    <span>Praetor · gestão jurídica corporativa</span>
  );
  const canSeeAi = can(ctx, "analysis:read");

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      {ctx.isDemoOrganization ? <DemoBanner /> : null}
      <div className="flex flex-1">
        <Sidebar items={navItems} footer={sidebarFooter} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/85 sm:px-6">
            <MobileNav>
              <SidebarContent items={navItems} footer={sidebarFooter} />
            </MobileNav>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-900" title={org?.name}>
                {org?.name ?? "Organização"}
              </p>
            </div>
            {aiMode ? (
              canSeeAi ? (
                <Link
                  href="/ia"
                  className="hidden items-center gap-1 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:inline-flex"
                  title="Abrir a Central de IA"
                >
                  <AiModeBadge mode={aiMode} />
                  <span className="sr-only">— abrir a Central de IA</span>
                </Link>
              ) : (
                <AiModeBadge mode={aiMode} className="hidden sm:inline-flex" />
              )
            ) : null}
            <UserMenu
              name={ctx.name}
              email={ctx.email}
              roleLabel={ROLE_LABELS[ctx.role]}
              unitName={unit?.name ?? null}
              signOutAction={signOutAction}
            />
          </header>
          <main id="conteudo" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
