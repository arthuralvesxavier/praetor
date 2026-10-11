import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function OccurrenceLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando ocorrência…</span>
      <div className="space-y-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-7 w-96 max-w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-28" />
        </div>
      </div>
      <Skeleton className="h-9 w-full" />
      <div className="grid gap-6 lg:grid-cols-3">
        <CardSkeleton lines={6} className="lg:col-span-2" />
        <CardSkeleton lines={4} />
      </div>
      <CardSkeleton lines={3} />
    </div>
  );
}
