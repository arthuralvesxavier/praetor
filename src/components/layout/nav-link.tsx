"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { matchesNavHref } from "./nav-utils";

export type NavLinkProps = {
  href: string;
  /** Rendered icon element (icons are rendered by the server component; functions can't cross the boundary). */
  icon?: ReactNode;
  /**
   * Active state computed by the parent (longest matching href, see nav-utils).
   * When omitted, the link is active for its own path and sub-routes.
   */
  active?: boolean;
  children: ReactNode;
};

/** Sidebar link with active state (`aria-current="page"` + gold left indicator + bold text). */
export function NavLink({ href, icon, active, children }: NavLinkProps) {
  const pathname = usePathname() ?? "";
  const isActive = active ?? matchesNavHref(pathname, href);
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group relative flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sidebar-indicator",
        isActive
          ? "bg-sidebar-active font-semibold text-white"
          : "font-medium text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-sidebar-indicator transition-opacity",
          isActive ? "opacity-100" : "opacity-0",
        )}
      />
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex shrink-0 [&_svg]:size-4",
            isActive ? "text-sidebar-indicator" : "text-sidebar-heading group-hover:text-sidebar-foreground",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </Link>
  );
}
