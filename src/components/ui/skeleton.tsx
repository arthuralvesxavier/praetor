import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Placeholder block (decorative; wrap groups in an element with role="status" + sr-only text). */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-slate-200/70", className)} {...props} />;
}

export function TableSkeleton({ rows = 6, columns = 5, className }: { rows?: number; columns?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("overflow-hidden rounded-lg border border-border bg-surface", className)}>
      <div className="flex gap-4 border-b border-border bg-slate-50 px-5 py-3">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-border px-5 py-3.5 last:border-0">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={cn("h-3.5 flex-1", c === 0 && "flex-[2]")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("space-y-3 rounded-lg border border-border bg-surface p-5", className)}>
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
