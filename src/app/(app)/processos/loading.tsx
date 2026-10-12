import { CardSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function ProcessesLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando a carteira de processos…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-80 max-w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} className="hidden sm:block" />
        <CardSkeleton lines={1} className="hidden sm:block" />
        <CardSkeleton lines={1} className="hidden xl:block" />
      </div>
      <Skeleton className="h-16 w-full" />
      <TableSkeleton rows={8} columns={10} />
    </div>
  );
}
