"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Brings the active tab (`aria-current="page"`) of a horizontally scrolling tab bar
 * (`LinkTabs`) fully into view, centered in the bar. Only the bar scrolls (never the
 * page) and nothing happens when every tab fits or the active one is already visible.
 */
export function scrollActiveTabIntoView(root: HTMLElement): void {
  const active = root.querySelector<HTMLElement>('[aria-current="page"]');
  const bar = active?.closest("ul");
  if (!active || !bar || bar.scrollWidth <= bar.clientWidth) return;
  const tab = active.getBoundingClientRect();
  const box = bar.getBoundingClientRect();
  if (tab.left >= box.left && tab.right <= box.right) return;
  bar.scrollLeft += tab.left - box.left - (box.width - tab.width) / 2;
}

/**
 * Wrapper of the process tab bar: on a phone the six tabs do not fit and the bar scrolls
 * sideways, so the open tab could sit off-screen. After each render with a new active tab
 * it scrolls the bar to show it.
 */
export function ActiveTabScroller({ active, children }: { active: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) scrollActiveTabIntoView(ref.current);
  }, [active]);
  return <div ref={ref}>{children}</div>;
}
