"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isNavActive } from "@/lib/nav";
import { cn } from "@/lib/utils";

export type NavLinkProps = {
  href: string;
  /** Rendered icon element (icons are rendered by the server component; functions can't cross the boundary). */
  icon?: ReactNode;
  children: ReactNode;
};

/** Sidebar link with active state (`aria-current="page"` + left indicator) derived from the current path. */
export function NavLink({ href, icon, children }: NavLinkProps) {
  const pathname = usePathname() ?? "";
  const active = isNavActive(pathname, href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sidebar-indicator",
        active
          ? "bg-sidebar-active text-white"
          : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-1.5 left-0 w-0.5 rounded-r bg-sidebar-indicator transition-opacity",
          active ? "opacity-100" : "opacity-0",
        )}
      />
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </Link>
  );
}
