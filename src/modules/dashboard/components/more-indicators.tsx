import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * "Mais indicadores": third block of the panel, collapsed by default. Native
 * <details>/<summary> (keyboard and screen-reader support without client JS); the page
 * opens it when the URL carries a filter that only applies inside it (the period).
 */
export function MoreIndicators({
  defaultOpen = false,
  description,
  children,
}: {
  defaultOpen?: boolean;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <details id="mais-indicadores" open={defaultOpen} className="group/more border-t border-border pt-6">
      {/* Summary content: a heading plus phrasing content only (valid HTML), laid out as a grid. */}
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-xs hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <h2 className="col-start-1 row-start-1 text-lg font-semibold tracking-tight text-slate-900">Mais indicadores</h2>
        <span className="col-start-1 row-start-2 block min-w-0 text-sm text-muted-foreground">{description}</span>
        <span
          aria-hidden="true"
          className="col-start-2 row-span-2 row-start-1 inline-flex items-center gap-1 text-sm font-medium text-primary-700"
        >
          <span className="group-open/more:hidden">Mostrar</span>
          <span className="hidden group-open/more:inline">Ocultar</span>
          <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open/more:rotate-180" />
        </span>
      </summary>
      <div className="mt-6 space-y-8">{children}</div>
    </details>
  );
}
