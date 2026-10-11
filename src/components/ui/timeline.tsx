import type { ReactNode } from "react";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type TimelineItem = {
  id: string;
  /** "YYYY-MM-DD" (shown as a date) or a timestamp (shown as date + time). */
  date: Date | string;
  title: ReactNode;
  description?: ReactNode;
  /** e.g. an <OriginBadge> or a <Badge> with the event type. */
  badge?: ReactNode;
  /** Extra line under the description (author, links...). */
  meta?: ReactNode;
};

export type TimelineProps = {
  /** Order is the caller's choice (usually most recent first). */
  items: readonly TimelineItem[];
  emptyMessage?: string;
  className?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateTimeAttr(date: Date | string): string | undefined {
  if (typeof date === "string") return date;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Vertical timeline for process movements and record history. */
export function Timeline({ items, emptyMessage = "Nenhum evento registrado.", className }: TimelineProps) {
  if (items.length === 0) return <p className={cn("text-sm text-muted-foreground", className)}>{emptyMessage}</p>;
  return (
    <ol className={cn("relative ml-1.5 space-y-5 border-l border-border pl-5", className)}>
      {items.map((item) => (
        <li key={item.id} className="relative">
          <span
            aria-hidden="true"
            className="absolute top-1 -left-[25.5px] size-2.5 rounded-full bg-primary-500 ring-4 ring-surface"
          />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <time dateTime={dateTimeAttr(item.date)} className="text-xs font-medium text-muted-foreground tabular-nums">
              {typeof item.date === "string" && ISO_DATE.test(item.date) ? formatDate(item.date) : formatDateTime(item.date)}
            </time>
            {item.badge}
          </div>
          <p className="mt-0.5 text-sm font-medium text-slate-900">{item.title}</p>
          {item.description ? (
            <div className="mt-0.5 text-sm whitespace-pre-line text-slate-700">{item.description}</div>
          ) : null}
          {item.meta ? <div className="mt-1 text-xs text-muted-foreground">{item.meta}</div> : null}
        </li>
      ))}
    </ol>
  );
}
