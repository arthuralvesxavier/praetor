import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando prazos e tarefas…</span>
      <div className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} className="hidden sm:block" />
        <CardSkeleton lines={1} className="hidden sm:block" />
      </div>
      <div className="flex gap-3 border-b border-border pb-2">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 35 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    </div>
  );
}
