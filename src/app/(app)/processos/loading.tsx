import { CardSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function ProcessesLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando processos…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48 max-w-full" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} className="hidden sm:block" />
        <CardSkeleton lines={1} className="hidden sm:block" />
      </div>
      <Skeleton className="h-16 w-full" />
      <TableSkeleton rows={8} columns={7} />
    </div>
  );
}
