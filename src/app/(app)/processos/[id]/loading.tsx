import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function ProcessDetailLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando processo…</span>
      <div className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-7 w-96 max-w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-20" />
        </div>
      </div>
      <Skeleton className="h-9 w-full" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <CardSkeleton lines={8} className="lg:col-span-2" />
        <div className="space-y-6">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={3} />
        </div>
      </div>
    </div>
  );
}
