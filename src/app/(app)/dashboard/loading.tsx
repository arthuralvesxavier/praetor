import { CardSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando o painel…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48 max-w-full" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <CardSkeleton key={i} lines={1} className={i >= 2 ? "hidden sm:block" : undefined} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <CardSkeleton lines={6} className="lg:col-span-2" />
        <CardSkeleton lines={6} />
      </div>
      <TableSkeleton rows={5} columns={5} />
    </div>
  );
}
