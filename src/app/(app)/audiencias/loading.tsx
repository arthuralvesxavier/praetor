import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando a agenda de audiências…</span>
      <div className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} className="hidden sm:block" />
        <CardSkeleton lines={1} className="hidden sm:block" />
      </div>
      <Skeleton className="h-16 w-full" />
      <CardSkeleton lines={4} />
      <CardSkeleton lines={4} />
    </div>
  );
}
