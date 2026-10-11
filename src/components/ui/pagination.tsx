import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatNumber } from "@/lib/format";
import { buildHref, PAGE_PARAM, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  /** List route, e.g. "/processos". */
  basePath: string;
  /** Current search params (filters are preserved in every link). */
  searchParams: SearchParams;
  className?: string;
};

/** Pages to show: first, last, current ±1, with "…" gaps. */
function pageWindow(page: number, pageCount: number): (number | "gap")[] {
  const pages = new Set([1, pageCount, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pageCount));
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push("gap");
    out.push(sorted[i]);
  }
  return out;
}

const itemBase =
  "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-sm font-medium tabular-nums transition-colors";

/** Result count + page links ("pagina" param). Renders nothing when there are no results. */
export function Pagination({ page, pageSize, total, basePath, searchParams, className }: PaginationProps) {
  if (total <= 0) return null;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  const from = (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  const href = (p: number) => buildHref(basePath, searchParams, { [PAGE_PARAM]: p > 1 ? p : null });

  return (
    <div className={cn("flex flex-col items-center justify-between gap-3 py-3 sm:flex-row", className)}>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Exibindo <span className="font-medium text-slate-700">{formatNumber(from)}</span>–
        <span className="font-medium text-slate-700">{formatNumber(to)}</span> de{" "}
        <span className="font-medium text-slate-700">{formatNumber(total)}</span>
      </p>
      {pageCount > 1 ? (
        <nav aria-label="Paginação">
          <ul className="flex items-center gap-1">
            <li>
              {current > 1 ? (
                <Link href={href(current - 1)} className={cn(itemBase, "text-slate-700 hover:bg-slate-100")} rel="prev">
                  <ChevronLeft aria-hidden="true" className="size-4" />
                  <span className="hidden sm:inline">Anterior</span>
                  <span className="sr-only sm:hidden">Página anterior</span>
                </Link>
              ) : (
                <span aria-disabled="true" className={cn(itemBase, "text-slate-400")}>
                  <ChevronLeft aria-hidden="true" className="size-4" />
                  <span className="hidden sm:inline">Anterior</span>
                </span>
              )}
            </li>
            {pageWindow(current, pageCount).map((p, i) =>
              p === "gap" ? (
                <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-slate-400">
                  …
                </li>
              ) : (
                <li key={p}>
                  <Link
                    href={href(p)}
                    aria-current={p === current ? "page" : undefined}
                    aria-label={`Página ${p}`}
                    className={cn(
                      itemBase,
                      p === current ? "bg-primary text-primary-foreground" : "text-slate-700 hover:bg-slate-100",
                    )}
                  >
                    {p}
                  </Link>
                </li>
              ),
            )}
            <li>
              {current < pageCount ? (
                <Link href={href(current + 1)} className={cn(itemBase, "text-slate-700 hover:bg-slate-100")} rel="next">
                  <span className="hidden sm:inline">Próxima</span>
                  <span className="sr-only sm:hidden">Próxima página</span>
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              ) : (
                <span aria-disabled="true" className={cn(itemBase, "text-slate-400")}>
                  <span className="hidden sm:inline">Próxima</span>
                  <ChevronRight aria-hidden="true" className="size-4" />
                </span>
              )}
            </li>
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
