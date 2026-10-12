import Link from "next/link";
import { cn } from "@/lib/utils";
import { ChartTooltip } from "./chart-tooltip";
import { EmptyChart, niceScale } from "./chart-card";

export type ColumnSeries = { key: string; label: string; color: string };
export type ColumnCategory = { key: string; label: string; longLabel: string; href?: string; color?: string };

/**
 * Vertical (grouped) columns over ordered categories, e.g. months. Each
 * category column is one hit target whose tooltip lists every series at that
 * X — the reader aims at a date, not at a 2px bar. Columns are ≤ 24px wide
 * with a 4px rounded data-end and a 2px gap between neighbors.
 */
export function ColumnChart({
  categories,
  series,
  values,
  format = (n) => String(n),
  height = 176,
  label,
}: {
  categories: ColumnCategory[];
  series: ColumnSeries[];
  /** values[seriesIndex][categoryIndex] */
  values: number[][];
  format?: (n: number) => string;
  height?: number;
  /** Accessible name of the chart. */
  label: string;
}) {
  const max = Math.max(0, ...values.flat());
  if (categories.length === 0 || max === 0) return <EmptyChart />;
  const scale = niceScale(max);
  const every = Math.max(1, Math.ceil(categories.length / 8));

  return (
    <ChartTooltip>
      <figure aria-label={label} className="m-0">
        {/* pt-2: room for the top tick label, centered on its gridline. */}
        <div className="flex gap-2 pt-2">
          {/* Y axis */}
          <div className="relative w-10 shrink-0 text-right text-[11px] text-subtle-foreground tabular-nums" style={{ height }} aria-hidden="true">
            {scale.ticks.map((t) => (
              <span key={t} className="absolute right-0 -translate-y-1/2" style={{ bottom: `${(t / scale.max) * 100}%` }}>
                {format(t)}
              </span>
            ))}
          </div>
          {/* Plot */}
          <div className="relative min-w-0 flex-1" style={{ height }}>
            {scale.ticks.map((t) => (
              <div
                key={t}
                aria-hidden="true"
                className={cn("absolute inset-x-0 border-t", t === 0 ? "border-slate-300" : "border-slate-100")}
                style={{ bottom: `${(t / scale.max) * 100}%` }}
              />
            ))}
            <ul className="absolute inset-0 flex items-end">
              {categories.map((cat, ci) => {
                const tipValue = series.map((s, si) => `${s.label}: ${format(values[si]?.[ci] ?? 0)}`).join(" · ");
                const bars = (
                  <span className="flex h-full w-full items-end justify-center gap-[2px] px-[2px]">
                    {series.map((s, si) => {
                      const v = values[si]?.[ci] ?? 0;
                      return (
                        <span
                          key={s.key}
                          aria-hidden="true"
                          className="w-full max-w-6 min-w-[3px] rounded-t-[4px] transition-opacity group-hover:opacity-85"
                          style={{
                            height: v > 0 ? `max(2px, ${(v / scale.max) * 100}%)` : 0,
                            backgroundColor: cat.color ?? s.color,
                          }}
                        />
                      );
                    })}
                  </span>
                );
                const common = {
                  "data-tip-value": tipValue,
                  "data-tip-label": cat.longLabel,
                  "aria-label": `${cat.longLabel}: ${tipValue}`,
                  className:
                    "group flex h-full w-full rounded-sm hover:bg-slate-100/70 focus-visible:bg-slate-100/70 focus-visible:outline-2 focus-visible:outline-ring",
                };
                return (
                  <li key={cat.key} className="flex h-full min-w-0 flex-1">
                    {cat.href ? (
                      <Link href={cat.href} {...common}>
                        {bars}
                      </Link>
                    ) : (
                      <span tabIndex={0} {...common}>
                        {bars}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        {/* X axis */}
        <div className="mt-1 flex pl-12" aria-hidden="true">
          {categories.map((cat, ci) => (
            <span key={cat.key} className="min-w-0 flex-1 truncate text-center text-[11px] text-subtle-foreground">
              {ci % every === 0 || ci === categories.length - 1 ? cat.label : ""}
            </span>
          ))}
        </div>
      </figure>
    </ChartTooltip>
  );
}
