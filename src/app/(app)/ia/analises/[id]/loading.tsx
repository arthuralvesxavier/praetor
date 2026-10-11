import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function AnalysisLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando a análise…</span>
      <div className="space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <Skeleton className="h-16 w-full" />
      <CardSkeleton lines={4} />
      <CardSkeleton lines={8} />
    </div>
  );
}
