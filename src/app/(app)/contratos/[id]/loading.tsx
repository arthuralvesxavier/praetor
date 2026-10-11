import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function ContractLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando contrato…</span>
      <div className="space-y-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-7 w-80 max-w-full" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-24" />
        </div>
      </div>
      <Skeleton className="h-9 w-full" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={6} />
        </div>
        <div className="space-y-6">
          <CardSkeleton lines={3} />
          <CardSkeleton lines={2} />
        </div>
      </div>
    </div>
  );
}
