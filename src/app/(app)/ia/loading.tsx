import { CardSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function AiCenterLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Carregando a Central de Inteligência Artificial…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
      <TableSkeleton rows={6} columns={6} />
    </div>
  );
}
