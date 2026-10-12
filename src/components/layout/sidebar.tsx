import Link from "next/link";
import type { ReactNode } from "react";
import { LogoWordmark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { SidebarNav, type ShellNavGroup, type ShellNavItem } from "./sidebar-nav";

export type { ShellNavGroup, ShellNavItem };

/** Official wordmark (light variant on the navy sidebar), linking to the executive dashboard. */
export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/dashboard"
      aria-label="Praetor: ir para o painel executivo"
      className={cn(
        "inline-flex items-center rounded-md px-1 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-indicator",
        className,
      )}
    >
      <LogoWordmark variant="light" title="" className="h-[22px]" />
    </Link>
  );
}

export type SidebarProps = {
  groups: readonly ShellNavGroup[];
  /** Small content pinned to the bottom (e.g. environment notice). */
  footer?: ReactNode;
};

/** Desktop sidebar (lg+). Below lg the same content is shown in <MobileNav>. */
export function Sidebar({ groups, footer }: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <SidebarContent groups={groups} footer={footer} />
    </aside>
  );
}

/** Brand + grouped nav + footer, shared by the desktop sidebar and the mobile drawer. */
export function SidebarContent({ groups, footer }: SidebarProps) {
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
        <Brand />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-5 [scrollbar-color:var(--color-sidebar-active)_transparent] [scrollbar-width:thin]">
        <SidebarNav groups={groups} />
      </div>
      {footer ? (
        <div className="shrink-0 border-t border-sidebar-border px-4 py-3 text-xs leading-relaxed text-sidebar-muted">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
