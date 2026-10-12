import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Same layout as the portfolio list: header, view tabs, compact totals strip, filters and the list. */
export default function ProcessesLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <span className="sr-only">Carregando a carteira de processos…</span>
      <div className="mb-6 space-y-2">
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-80 max-w-full" />
      <div
        aria-hidden="true"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4"
      >
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2 bg-surface px-4 py-3">
            <Skeleton className="h-3 w-28 max-w-full" />
            <Skeleton className="h-5 w-24 max-w-full" />
            <Skeleton className="h-2.5 w-20 max-w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-16 w-full" />
      <TableSkeleton rows={10} columns={8} className="hidden xl:block" />
      <div aria-hidden="true" className="divide-y divide-border rounded-lg border border-border bg-surface xl:hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="space-y-2 px-4 py-3">
            <Skeleton className="h-3 w-48 max-w-full" />
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
