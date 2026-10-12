"use client";

import { useId, useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type DimensionTab = {
  value: string;
  label: string;
  /** URL value of the tab (`?<param>=<slug>`). */
  slug: string;
  /** Server-rendered panel (chart, notes and table of this dimension). */
  panel: ReactNode;
};

/**
 * Dimension selector of the portfolio chart: an ARIA tablist (Radix: arrow keys,
 * Home/End, automatic activation) over server-rendered panels. The choice is kept in
 * the address (`?dimensao=`, replaced in place, no new request) so a reload or a shared
 * link opens the same view, and — through the `form` attribute — it is submitted with
 * the filter form when the user filters the panel.
 */
export function DimensionTabs({
  tabs,
  initial,
  fallback,
  param,
  label,
  formId,
}: {
  tabs: DimensionTab[];
  initial: string;
  /** Default tab: never written to the URL. */
  fallback: string;
  param: string;
  /** Visible name of the tablist. */
  label: string;
  /** Id of the filter form that should carry the selected dimension. */
  formId?: string;
}) {
  const labelId = useId();
  const [value, setValue] = useState(initial);
  const slug = tabs.find((t) => t.value === value)?.slug;

  function select(next: string) {
    setValue(next);
    try {
      const url = new URL(window.location.href);
      const nextSlug = tabs.find((t) => t.value === next)?.slug;
      if (next === fallback || !nextSlug) url.searchParams.delete(param);
      else url.searchParams.set(param, nextSlug);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // The view still switches; only the address is left as it was.
    }
  }

  return (
    <Tabs value={value} onValueChange={select} className="gap-4">
      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-end sm:gap-3">
        <span id={labelId} className="shrink-0 text-xs font-medium text-muted-foreground sm:pb-2.5">
          {label}
        </span>
        <TabsList aria-labelledby={labelId} className="min-w-0 flex-1">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {formId && slug && value !== fallback ? <input type="hidden" form={formId} name={param} value={slug} /> : null}
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className="min-w-0">
          {t.panel}
        </TabsContent>
      ))}
    </Tabs>
  );
}
