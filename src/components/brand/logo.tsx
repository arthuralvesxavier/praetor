import { cn } from "@/lib/utils";

/**
 * Praetor brand mark — "Pórtico": the pediment of a Roman temple (brass) over
 * a letter P whose stem stands as a column on its plinth. It reads as the
 * initial and as the place where the praetor published the edict.
 *
 * Drawn on a 24×24 grid with 2px round strokes so it stays legible at 16px.
 * The same geometry is used in src/app/icon.svg (favicon) — keep them in sync.
 */
const PEDIMENT = "M3.5 8.5 12 4l8.5 4.5Z";
const STEM = "M8 11.5v9";
const BOWL = "M8 11.5h4.75a3.25 3.25 0 0 1 0 6.5H8";
const PLINTH = "M5 20.5h6";

type MarkProps = {
  className?: string;
  /** Accessible name; omit when the wordmark is next to it (decorative). */
  title?: string;
};

/** Mark inside the navy badge (favicon, sidebar, login). */
export function LogoBadge({ className, title }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-9 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <linearGradient id="praetor-badge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f5282" />
          <stop offset="1" stopColor="#152740" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#praetor-badge)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#ffffff" strokeOpacity="0.12" />
      <g transform="translate(4 4)" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={PEDIMENT} stroke="#d4b062" />
        <path d={`${STEM} ${BOWL} ${PLINTH}`} stroke="#ffffff" />
      </g>
    </svg>
  );
}

/** Line-only mark using currentColor (pediment in brass), for large/editorial use. */
export function LogoMark({ className, title, animated = false }: MarkProps & { animated?: boolean }) {
  const draw = animated ? "motion-safe:animate-draw [stroke-dasharray:1]" : undefined;
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-10 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="none"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PEDIMENT} stroke="var(--color-brass-400)" pathLength={1} className={draw} />
      <path d={`${STEM} ${BOWL} ${PLINTH}`} stroke="currentColor" pathLength={1} className={draw} style={{ animationDelay: "250ms" }} />
    </svg>
  );
}

/** Badge + wordmark. `tone` is the background it sits on. */
export function Logo({
  className,
  tone = "dark",
  size = "md",
}: {
  className?: string;
  tone?: "dark" | "light";
  size?: "sm" | "md" | "lg";
}) {
  const badge = { sm: "size-8", md: "size-9", lg: "size-11" }[size];
  const word = { sm: "text-xl", md: "text-2xl", lg: "text-3xl" }[size];
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoBadge className={badge} />
      <span
        className={cn(
          "font-display leading-none font-semibold tracking-[0.04em]",
          word,
          tone === "dark" ? "text-white" : "text-slate-900",
        )}
      >
        Praetor
      </span>
    </span>
  );
}
