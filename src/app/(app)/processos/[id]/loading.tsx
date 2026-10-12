import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Same layout as the "Resumo" tab: header, six tabs, decision band, compact cover. */
export default function ProcessDetailLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando processo…</span>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-7 w-72 max-w-full" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-24" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      <Skeleton className="h-9 w-full" />
      {/* Decision band (P0.4), first block of the "Resumo" tab. */}
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface p-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-2 md:col-span-2 xl:col-span-1">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-3/4" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <CardSkeleton lines={8} className="lg:col-span-2" />
        <CardSkeleton lines={3} />
      </div>
    </div>
  );
}
