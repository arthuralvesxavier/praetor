import { Building2, Search } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "@/components/brand/logo";
import { DemoBanner } from "@/components/layout/demo-banner";
import { GlobalSearch } from "@/components/layout/global-search";
import { AiModeIndicator, AlertsBell, SimulatedEmailBadge } from "@/components/layout/header-indicators";
import { MobileNav } from "@/components/layout/mobile-nav";
import { filterNavGroups } from "@/components/layout/nav-utils";
import { loadShellData } from "@/components/layout/shell-data";
import { Sidebar, SidebarContent, type ShellNavGroup } from "@/components/layout/sidebar";
import { SkipLink } from "@/components/layout/skip-link";
import { UserMenu } from "@/components/layout/user-menu";
import { ROLE_LABELS } from "@/domain/enums";
import { NAV_GROUPS } from "@/lib/nav";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { signOutAction } from "./actions";

/**
 * Authenticated app shell. NOTE: layouts do not re-render on client navigation
 * and are NOT an authorization boundary — every page calls
 * requirePageContext(permission) itself. Navigation items are filtered by
 * permission only to avoid dead ends.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePageContext();
  const shell = await loadShellData(ctx);

  const navGroups: ShellNavGroup[] = filterNavGroups(NAV_GROUPS, (p) => can(ctx, p)).map((group) => ({
    label: group.label,
    items: group.items.map(({ href, label, icon: Icon }) => ({ href, label, icon: <Icon /> })),
  }));

  const sidebarFooter = (
    <>
      <span className="flex items-center gap-1.5 font-medium text-sidebar-foreground" title={shell.organizationName}>
        <Building2 aria-hidden="true" className="size-3.5 shrink-0 text-sidebar-indicator" />
        <span className="sr-only">Organização: </span>
        <span className="truncate">{shell.organizationName}</span>
      </span>
      <span className="mt-0.5 block">
        {ctx.isDemoOrganization
          ? "Ambiente demonstrativo · dados fictícios · IA e e-mail simulados"
          : "Praetor · gestão jurídica corporativa"}
      </span>
    </>
  );
  const canSearch = can(ctx, "process:read");

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <div className="flex flex-1">
        <Sidebar groups={navGroups} footer={sidebarFooter} />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Inside the content column so the full-height sticky sidebar is never pushed below the fold. */}
          {ctx.isDemoOrganization ? <DemoBanner /> : null}
          <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-surface/85 sm:gap-3 sm:px-6">
            <MobileNav>
              <SidebarContent groups={navGroups} footer={sidebarFooter} />
            </MobileNav>
            <Link
              href="/dashboard"
              aria-label="Praetor — ir para o painel executivo"
              className="inline-flex shrink-0 rounded-md p-1 focus-visible:outline-2 focus-visible:outline-ring lg:hidden"
            >
              <LogoMark className="size-6" />
            </Link>
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <p
                className="hidden min-w-0 truncate text-sm font-semibold text-slate-900 sm:block md:hidden"
                title={shell.organizationName}
              >
                {shell.organizationName}
              </p>
              {canSearch ? <GlobalSearch className="hidden w-full max-w-md md:block" /> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              {canSearch ? (
                <Link
                  href="/busca"
                  aria-label="Buscar processos, documentos, contratos e ocorrências"
                  className="inline-flex size-9 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:hidden"
                >
                  <Search aria-hidden="true" className="size-5" />
                </Link>
              ) : null}
              {shell.aiMode ? (
                <AiModeIndicator
                  mode={shell.aiMode}
                  linked={can(ctx, "analysis:read")}
                  className="hidden xl:inline-flex"
                />
              ) : null}
              {shell.emailMode ? (
                <SimulatedEmailBadge mode={shell.emailMode} className="hidden xl:inline-flex" />
              ) : null}
              {shell.alerts ? <AlertsBell counts={shell.alerts} /> : null}
              <UserMenu
                name={ctx.name}
                email={ctx.email}
                roleLabel={ROLE_LABELS[ctx.role]}
                unitName={shell.unitName}
                organizationName={shell.organizationName}
                lawFirmName={shell.lawFirmName}
                signOutAction={signOutAction}
              />
            </div>
          </header>
          <main id="conteudo" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
