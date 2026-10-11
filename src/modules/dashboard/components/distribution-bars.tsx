import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { formatNumber, formatPercent } from "@/lib/format";
import { TONE_CLASSES, type Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";

export type DistributionItem = {
  key: string;
  label: string;
  count: number;
  /** Filtered list that originates this figure. */
  href: string;
  tone?: Tone;
};

export type DistributionBarsProps = {
  /** Accessible name of the list (also shown as a small heading when `showHeading`). */
  title: string;
  items: DistributionItem[];
  /** Denominator for proportions; defaults to the sum of the items. */
  total?: number;
  /** Hide rows with zero (they are still part of the total). */
  hideZero?: boolean;
  emptyMessage?: string;
  showHeading?: boolean;
  className?: string;
};

/**
 * Sober horizontal bars: each row links to the filtered list, the number is
 * always printed, and the bar carries `role="img"` with "N de M".
 */
export function DistributionBars({
  title,
  items,
  total,
  hideZero = false,
  emptyMessage = "Nenhum registro para exibir.",
  showHeading = true,
  className,
}: DistributionBarsProps) {
  const denominator = total ?? items.reduce((s, i) => s + i.count, 0);
  const rows = hideZero ? items.filter((i) => i.count > 0) : items;
  const headingId = useId();

  return (
    <div className={cn("space-y-2", className)}>
      {showHeading ? (
        <h3 id={headingId} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
      ) : null}
      {denominator === 0 || rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="space-y-1" aria-labelledby={showHeading ? headingId : undefined} aria-label={showHeading ? undefined : title}>
          {rows.map((item) => {
            const ratio = denominator > 0 ? item.count / denominator : 0;
            const tone = item.tone ?? "primary";
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="group block rounded-md px-2 py-1.5 -mx-2 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                >
                  <span className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-slate-700 group-hover:text-slate-900">{item.label}</span>
                    <span className="flex shrink-0 items-center gap-1 tabular-nums">
                      <span className="font-semibold text-slate-900">{formatNumber(item.count)}</span>
                      <span className="text-xs text-muted-foreground">({formatPercent(ratio)})</span>
                      <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400 group-hover:text-slate-600" />
                    </span>
                  </span>
                  <span
                    role="img"
                    aria-label={`${formatNumber(item.count)} de ${formatNumber(denominator)}`}
                    className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
                  >
                    <span
                      className={cn("block h-full rounded-full opacity-80", TONE_CLASSES[tone].dot)}
                      style={{ width: `${item.count > 0 ? Math.max(2, Math.round(ratio * 100)) : 0}%` }}
                    />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
