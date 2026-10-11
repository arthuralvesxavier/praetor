import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatNumber } from "@/lib/format";
import { TONE_CLASSES, type Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";

export type MetricItem = {
  key: string;
  label: string;
  value: number;
  /** Formatted value override (e.g. money). */
  display?: ReactNode;
  hint?: ReactNode;
  /** Filtered list that originates the figure. */
  href?: string;
  /** Highlight tone used when value > 0. */
  tone?: Tone;
};

/** Compact list of labelled figures, each linking to the records behind it. */
export function MetricList({ items, label, className }: { items: MetricItem[]; label: string; className?: string }) {
  return (
    <ul aria-label={label} className={cn("divide-y divide-border", className)}>
      {items.map((m) => {
        const highlighted = m.value > 0 && m.tone && m.tone !== "neutral";
        const content = (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={cn("size-2 shrink-0 rounded-full", highlighted ? TONE_CLASSES[m.tone!].dot : "bg-slate-200")}
              />
              <span className="min-w-0">
                <span className="block text-sm text-slate-700">{m.label}</span>
                {m.hint ? <span className="block text-xs text-muted-foreground">{m.hint}</span> : null}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="text-sm font-semibold text-slate-900 tabular-nums">{m.display ?? formatNumber(m.value)}</span>
              {m.href ? <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400 group-hover:text-slate-600" /> : null}
            </span>
          </>
        );
        return (
          <li key={m.key}>
            {m.href ? (
              <Link
                href={m.href}
                className="group -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              >
                {content}
              </Link>
            ) : (
              <div className="flex items-center justify-between gap-3 py-2.5">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
