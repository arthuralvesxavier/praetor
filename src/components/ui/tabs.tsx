import Link from "next/link";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs-client";

export type LinkTab = { key: string; label: string; href: string; count?: number | null };

export type LinkTabsProps = {
  tabs: readonly LinkTab[];
  /** Key of the active tab (e.g. the `aba` search param). */
  active: string;
  /** Accessible name of the tab navigation. */
  label?: string;
  className?: string;
};

/**
 * URL-driven tabs (server-friendly): each tab is a link, e.g. `?aba=prazos`.
 * Build hrefs with `buildHref(base, sp, { aba: key, pagina: null })`.
 */
export function LinkTabs({ tabs, active, label = "Seções", className }: LinkTabsProps) {
  return (
    <nav aria-label={label} className={cn("border-b border-border", className)}>
      <ul className="-mb-px flex max-w-full gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const isActive = t.key === active;
          return (
            <li key={t.key} className="shrink-0">
              <Link
                href={t.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  isActive
                    ? "border-primary text-slate-900"
                    : "border-transparent text-muted-foreground hover:border-border-strong hover:text-slate-900",
                )}
              >
                {t.label}
                {t.count != null ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-px text-xs font-semibold tabular-nums",
                      isActive ? "bg-primary text-primary-foreground" : "bg-slate-100 text-slate-700",
                    )}
                  >
                    {formatNumber(t.count)}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
