"use client";

import { useRef, useState, type ReactNode } from "react";

type Tip = { x: number; y: number; value: string; label: string };

/**
 * Hover/focus tooltip for every mark inside it carrying `data-tip-value` and
 * `data-tip-label` (event delegation — one tooltip per chart). Tooltips only
 * enhance: every value is also in the chart's table view. Text is rendered by
 * React (never innerHTML).
 */
export function ChartTooltip({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  function fromTarget(target: EventTarget | null, point?: { clientX: number; clientY: number }) {
    const root = ref.current;
    if (!root || !(target instanceof Element)) return setTip(null);
    const mark = target.closest<HTMLElement>("[data-tip-value]");
    if (!mark || !root.contains(mark)) return setTip(null);
    const box = root.getBoundingClientRect();
    const markBox = mark.getBoundingClientRect();
    const x = (point ? point.clientX : markBox.left + markBox.width / 2) - box.left;
    const y = (point ? point.clientY : markBox.top) - box.top;
    setTip({ x, y, value: mark.dataset.tipValue ?? "", label: mark.dataset.tipLabel ?? "" });
  }

  return (
    <div
      ref={ref}
      className={`relative ${className ?? ""}`}
      onPointerMove={(e) => fromTarget(e.target, e)}
      onPointerLeave={() => setTip(null)}
      onFocus={(e) => fromTarget(e.target)}
      onBlur={() => setTip(null)}
    >
      {children}
      {tip ? (
        <div
          role="status"
          className="pointer-events-none absolute z-20 max-w-60 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-md border border-border bg-white px-2.5 py-1.5 shadow-md"
          style={{ left: tip.x, top: tip.y }}
        >
          <p className="text-sm font-semibold whitespace-nowrap text-slate-900 tabular-nums">{tip.value}</p>
          <p className="text-xs text-muted-foreground">{tip.label}</p>
        </div>
      ) : null}
    </div>
  );
}
