import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  /** e.g. a <ButtonLink> to create the first record or clear filters. */
  action?: ReactNode;
  /** Icon element (default: Inbox). */
  icon?: ReactNode;
  className?: string;
};

/** Friendly empty state for lists and panels. */
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-10 text-center",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-slate-100 text-slate-500 [&_svg]:size-5"
      >
        {icon ?? <Inbox />}
      </span>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
