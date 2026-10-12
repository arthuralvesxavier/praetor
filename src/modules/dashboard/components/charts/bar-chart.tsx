import Link from "next/link";
import { ChartTooltip } from "./chart-tooltip";
import { EmptyChart } from "./chart-card";

export type BarSeries = { key: string; label: string; color: string };
export type BarRow = { key: string; label: string; href?: string; values: number[] };

/**
 * Horizontal bars, one row per category. `grouped` draws one thin bar per
 * series (same scale, e.g. valor da causa × provisão); `stacked` joins the
 * series into one bar separated by a 2px surface gap (e.g. prazos + tarefas).
 * The whole row is the hit target and links to the originating records.
 * `header` labels the columns like an axis (e.g. "Tribunal (processos)" and the
 * chart's single money unit, "R$ milhões"), so the values carry no unit of their own.
 */
export function BarChart({
  rows,
  series,
  mode = "grouped",
  format = (n) => String(n),
  valueText,
  tipValue,
  label,
  header,
}: {
  rows: BarRow[];
  series: BarSeries[];
  mode?: "grouped" | "stacked";
  format?: (n: number) => string;
  /** Text at the end of the row (defaults to the formatted first series, or the stacked total). */
  valueText?: (row: BarRow) => string;
  /**
   * Tooltip and accessible text of the row (defaults to "<series>: <formatted value>" for every
   * series). Pass it when a value of 0 does not mean zero (e.g. "não apurado").
   */
  tipValue?: (row: BarRow) => string;
  label: string;
  /** Column headers: the category column and the value column (the unit of every value). */
  header?: { label: string; value: string };
}) {
  const total = (r: BarRow) => r.values.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...rows.map((r) => (mode === "stacked" ? total(r) : Math.max(0, ...r.values))));
  if (rows.length === 0 || max === 0) return <EmptyChart />;
  const pct = (v: number) => `${Math.max(0, (v / max) * 100)}%`;
  const grid =
    "grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 px-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]";

  return (
    <ChartTooltip>
      {header ? (
        <div className={`${grid} border-b border-border/60 pb-1 text-xs font-medium text-muted-foreground`}>
          <span className="truncate">{header.label}</span>
          <span aria-hidden="true" />
          <span className="text-right">{header.value}</span>
        </div>
      ) : null}
      <ul aria-label={label} className={header ? "mt-1 space-y-1" : "space-y-1"}>
        {rows.map((row) => {
          const tip = tipValue ? tipValue(row) : series.map((s, i) => `${s.label}: ${format(row.values[i] ?? 0)}`).join(" · ");
          const end = valueText ? valueText(row) : mode === "stacked" ? format(total(row)) : format(row.values[0] ?? 0);
          const content = (
            <>
              <span className="truncate text-sm text-slate-800" title={row.label}>
                {row.label}
              </span>
              <span className="flex min-w-0 flex-col justify-center gap-[2px]" aria-hidden="true">
                {mode === "stacked" ? (
                  <span className="flex h-3 w-full gap-[2px]">
                    {series.map((s, i) => {
                      const v = row.values[i] ?? 0;
                      return v > 0 ? (
                        <span
                          key={s.key}
                          className="h-full first:rounded-l-[2px] last:rounded-r-[4px]"
                          style={{ width: pct(v), backgroundColor: s.color }}
                        />
                      ) : null;
                    })}
                  </span>
                ) : (
                  series.map((s, i) => {
                    const v = row.values[i] ?? 0;
                    return (
                      <span key={s.key} className="block h-2.5 w-full">
                        <span
                          className="block h-full rounded-r-[4px]"
                          style={{ width: v > 0 ? `max(2px, ${pct(v)})` : 0, backgroundColor: s.color }}
                        />
                      </span>
                    );
                  })
                )}
              </span>
              <span className="text-right text-sm font-medium text-slate-900 tabular-nums">{end}</span>
            </>
          );
          const common = {
            "data-tip-value": tip,
            "data-tip-label": row.label,
            "aria-label": `${row.label}: ${tip}`,
            className: `${grid} rounded-md py-1.5 hover:bg-slate-100/70 focus-visible:bg-slate-100/70 focus-visible:outline-2 focus-visible:outline-ring`,
          };
          return (
            <li key={row.key}>
              {row.href ? (
                <Link href={row.href} {...common}>
                  {content}
                </Link>
              ) : (
                <div tabIndex={0} {...common}>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </ChartTooltip>
  );
}
