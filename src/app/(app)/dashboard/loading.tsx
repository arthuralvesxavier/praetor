import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Same order as the page: decision band, filters, portfolio (net exposure first), collapsed "Mais indicadores". */
export default function DashboardLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-8">
      <span className="sr-only">Carregando o painel…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48 max-w-full" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </div>
      {/* "Exige decisão agora" band comes first. */}
      <div className="space-y-4">
        <Skeleton className="h-5 w-56 max-w-full" />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <CardSkeleton key={i} lines={4} className={i >= 1 ? "hidden md:block" : undefined} />
          ))}
        </div>
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="space-y-6">
        <Skeleton className="h-5 w-48 max-w-full" />
        {/* Net exposure of the portfolio. */}
        <CardSkeleton lines={3} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <CardSkeleton key={i} lines={2} className={i >= 1 ? "hidden sm:block" : undefined} />
          ))}
        </div>
        <CardSkeleton lines={6} />
      </div>
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
