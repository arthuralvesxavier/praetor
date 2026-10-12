"use client";

import { usePathname } from "next/navigation";
import { useId, type ReactNode } from "react";
import { NavLink } from "./nav-link";
import { activeNavHref } from "./nav-utils";

export type ShellNavItem = { href: string; label: string; icon: ReactNode };
export type ShellNavGroup = { label: string | null; items: readonly ShellNavItem[] };

/**
 * Grouped main navigation (already filtered by permission on the server).
 * Exactly one item is active: the longest href matching the current path.
 */
export function SidebarNav({ groups }: { groups: readonly ShellNavGroup[] }) {
  const pathname = usePathname() ?? "";
  const baseId = useId();
  const active = activeNavHref(
    pathname,
    groups.flatMap((g) => g.items.map((i) => i.href)),
  );

  return (
    <nav aria-label="Navegação principal">
      <div className="flex flex-col gap-5">
        {groups.map((group, gi) => {
          const headingId = `${baseId}-grupo-${gi}`;
          return (
            <div key={group.label ?? `grupo-${gi}`}>
              {group.label ? (
                <p
                  id={headingId}
                  className="mb-1.5 px-3 text-[11px] font-semibold tracking-[0.14em] text-sidebar-heading uppercase"
                >
                  {group.label}
                </p>
              ) : null}
              <ul aria-labelledby={group.label ? headingId : undefined} className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <NavLink href={item.href} icon={item.icon} active={item.href === active}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
