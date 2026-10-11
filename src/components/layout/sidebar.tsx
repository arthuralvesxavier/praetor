import Link from "next/link";
import type { ReactNode } from "react";
import { LogoBadge } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { NavLink } from "./nav-link";

export type ShellNavItem = { href: string; label: string; icon: ReactNode };

/** Product mark + name. */
export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/dashboard"
      className={cn(
        "flex items-center gap-2.5 rounded-md px-1 py-1 text-white focus-visible:outline-2 focus-visible:outline-sidebar-indicator",
        className,
      )}
    >
      <LogoBadge className="size-8" />
      <span className="flex flex-col leading-tight">
        <span className="font-display text-xl leading-none font-semibold tracking-[0.04em]">Praetor</span>
        <span className="text-[11px] font-normal text-sidebar-muted">Gestão jurídica</span>
      </span>
    </Link>
  );
}

/** Main navigation list (already filtered by permission on the server). */
export function SidebarNav({ items }: { items: readonly ShellNavItem[] }) {
  return (
    <nav aria-label="Navegação principal">
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.href}>
            <NavLink href={item.href} icon={item.icon}>
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export type SidebarProps = {
  items: readonly ShellNavItem[];
  /** Small content pinned to the bottom (e.g. environment notice). */
  footer?: ReactNode;
};

/** Desktop sidebar (lg+). Below lg the same content is shown in <MobileNav>. */
export function Sidebar({ items, footer }: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <SidebarContent items={items} footer={footer} />
    </aside>
  );
}

/** Brand + nav + footer, shared by the desktop sidebar and the mobile drawer. */
export function SidebarContent({ items, footer }: SidebarProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
        <Brand />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <SidebarNav items={items} />
      </div>
      {footer ? <div className="shrink-0 border-t border-sidebar-border px-4 py-3 text-xs text-sidebar-muted">{footer}</div> : null}
    </div>
  );
}
