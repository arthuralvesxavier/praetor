import Link from "next/link";
import { ChartTooltip } from "./chart-tooltip";
import { EmptyChart } from "./chart-card";

/** White or ink, whichever reads on the fill (relative luminance). */
function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#0f172a" : "#ffffff";
}

export type ShareSegment = { key: string; label: string; color: string; value: number; href?: string };
export type ShareRow = { key: string; label: string; segments: ShareSegment[] };

/**
 * 100% stacked bars (composition of a whole, e.g. risk distribution). Segments
 * are separated by a 2px surface gap; each segment is its own hit target and
 * link. A count is printed inside only when it fits; otherwise the tooltip and
 * the table carry it.
 */
export function ShareBars({ rows, label, unit = "" }: { rows: ShareRow[]; label: string; unit?: string }) {
  const visible = rows.filter((r) => r.segments.some((s) => s.value > 0));
  if (visible.length === 0) return <EmptyChart />;

  return (
    <ChartTooltip>
      <ul aria-label={label} className="space-y-4">
        {visible.map((row) => {
          const total = row.segments.reduce((a, s) => a + s.value, 0);
          return (
            <li key={row.key}>
              <p className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="text-slate-800">{row.label}</span>
                <span className="font-medium text-slate-900 tabular-nums">
                  {total}
                  {unit}
                </span>
              </p>
              <div className="flex h-7 w-full gap-[2px]">
                {row.segments
                  .filter((s) => s.value > 0)
                  .map((s) => {
                    const share = (s.value / total) * 100;
                    const tipValue = `${s.value}${unit} (${Math.round(share)}%)`;
                    const common = {
                      "data-tip-value": tipValue,
                      "data-tip-label": `${row.label} · ${s.label}`,
                      "aria-label": `${row.label}, ${s.label}: ${tipValue}`,
                      style: { width: `${share}%`, backgroundColor: s.color, color: inkOn(s.color) },
                      className:
                        "flex h-full min-w-[6px] items-center justify-center first:rounded-l-[4px] last:rounded-r-[4px] text-[11px] font-semibold transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    };
                    const text = share >= 12 ? <span aria-hidden="true">{s.value}</span> : null;
                    return s.href ? (
                      <Link key={s.key} href={s.href} {...common}>
                        {text}
                      </Link>
                    ) : (
                      <span key={s.key} tabIndex={0} {...common}>
                        {text}
                      </span>
                    );
                  })}
              </div>
            </li>
          );
        })}
      </ul>
    </ChartTooltip>
  );
}
