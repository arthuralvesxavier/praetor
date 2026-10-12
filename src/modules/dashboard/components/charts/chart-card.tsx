import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type LegendItem = { label: string; color: string };

export type ChartTable = {
  caption: string;
  headers: string[];
  rows: ReactNode[][];
};

/**
 * Frame for every BI chart: title, optional legend (always present for ≥ 2
 * series), a note for filter caveats, the chart, and a table view with every
 * value (so nothing depends on hover or on color).
 */
export function ChartCard({
  title,
  description,
  legend,
  note,
  table,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  legend?: LegendItem[];
  note?: ReactNode;
  table?: ChartTable;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-w-0 flex-col", className)}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <ChartBody legend={legend} note={note} table={table}>
          {children}
        </ChartBody>
      </CardContent>
    </Card>
  );
}

/**
 * Inside of a chart frame: legend (only for ≥ 2 series), the chart, the note and the
 * "Ver dados em tabela" view. Used by `ChartCard` and by charts that live in another
 * frame (e.g. one tab panel of the dimension selector); the caller provides the flex column.
 */
export function ChartBody({
  legend,
  note,
  table,
  children,
}: {
  legend?: LegendItem[];
  note?: ReactNode;
  table?: ChartTable;
  children: ReactNode;
}) {
  return (
    <>
      {legend && legend.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legenda">
          {legend.map((l) => (
            <li key={l.label} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-[3px]" style={{ backgroundColor: l.color }} />
              {l.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex-1">{children}</div>
      {note ? (
        <p className="flex items-start gap-1.5 text-xs text-subtle-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{note}</span>
        </p>
      ) : null}
      {table ? (
        <details className="group text-sm">
          <summary className="cursor-pointer text-xs font-medium text-primary-600 hover:text-primary">
            Ver dados em tabela
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">{table.caption}</caption>
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {table.headers.map((h, i) => (
                    <th key={h} scope="col" className={cn("py-1.5 pr-3 font-medium", i > 0 && "text-right")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-border/60 last:border-0">
                    {r.map((cell, ci) =>
                      ci === 0 ? (
                        <th key={ci} scope="row" className="py-1.5 pr-3 font-normal text-slate-800">
                          {cell}
                        </th>
                      ) : (
                        <td key={ci} className="py-1.5 pr-3 text-right text-slate-800 tabular-nums">
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </>
  );
}

/** Rounded axis maximum and 4 evenly spaced ticks (0 … max). */
export function niceScale(max: number): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const niceStep = step < 1 ? 1 : step;
  const top = Math.ceil(max / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += niceStep) ticks.push(Math.round(v * 100) / 100);
  return { max: top, ticks };
}

export function EmptyChart({ children = "Sem dados para os filtros selecionados." }: { children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
      {children}
    </div>
  );
}
