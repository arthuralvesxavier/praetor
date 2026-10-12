import { cn } from "@/lib/utils";
import { GLYPHS, LETTERS, LETTERS_TRANSFORM } from "./wordmark-paths";

/**
 * PRAETOR brand (client artwork in public/brand/):
 *   - symbol: a navy arch (the portico through which one "goes ahead", prae-ire)
 *     resting next to a gold square — praetor-simbolo.svg, 32×32 grid;
 *   - horizontal wordmark: the symbol scaled 5× plus the outlined serif letters
 *     "PRAETOR" — praetor-logo.svg.
 * The paths below are copied verbatim from those files; never redraw them.
 * The favicon (src/app/icon.svg) uses the same symbol on a navy tile.
 */
export const BRAND_NAVY = "#0B1A2C";
export const BRAND_GOLD = "#D4B062";

const ARCH = "M4 28V14A10 10 0 0 1 14 4H18A10 10 0 0 1 28 14V18H22V16A6 6 0 0 0 10 16V28Z";
const SQUARE = "M22 22H28V28H22Z";

/**
 * - `color`: navy arch + gold square, for light backgrounds (default);
 * - `light`: white arch + gold square, for navy/dark backgrounds;
 * - `mono`: single color (`currentColor`), for print, watermarks and tight spaces.
 */
export type LogoVariant = "color" | "light" | "mono";

function fills(variant: LogoVariant): { arch: string; square: string; letters: string } {
  if (variant === "light") return { arch: "#FFFFFF", square: BRAND_GOLD, letters: "#FFFFFF" };
  if (variant === "mono") return { arch: "currentColor", square: "currentColor", letters: "currentColor" };
  return { arch: BRAND_NAVY, square: BRAND_GOLD, letters: BRAND_NAVY };
}

type A11yProps = {
  className?: string;
  /** Accessible name. Omit when the logo is decorative (e.g. next to visible text or inside a labelled link). */
  title?: string;
};

function a11y(title: string | undefined) {
  return title
    ? ({ role: "img", "aria-label": title } as const)
    : ({ "aria-hidden": true, focusable: "false" } as const);
}

/**
 * Symbol only, cropped tight to the artwork (viewBox 4..28). `animated` traces
 * the arch, fills it and lands the square (only with motion allowed).
 */
export function LogoMark({
  className,
  title,
  variant = "color",
  animated = false,
}: A11yProps & { variant?: LogoVariant; animated?: boolean }) {
  const f = fills(variant);
  return (
    <svg viewBox="4 4 24 24" className={cn("size-10 shrink-0", className)} {...a11y(title)}>
      {animated ? (
        <path
          d={ARCH}
          fill="none"
          stroke={variant === "light" ? BRAND_GOLD : f.arch}
          strokeWidth={0.5}
          pathLength={1}
          className="opacity-0 motion-safe:animate-mark-trace motion-safe:[stroke-dasharray:1]"
        />
      ) : null}
      <path d={ARCH} fill={f.arch} className={animated ? "motion-safe:animate-mark-fill" : undefined} />
      <path
        d={SQUARE}
        fill={f.square}
        className={animated ? "origin-center [transform-box:fill-box] motion-safe:animate-mark-square" : undefined}
      />
    </svg>
  );
}

/**
 * Official horizontal wordmark (symbol + outlined "PRAETOR"), cropped tight
 * (aspect ≈ 7.36:1). Size it by height: `className="h-6 w-auto"`.
 */
export function LogoWordmark({
  className,
  title = "Praetor",
  variant = "color",
}: A11yProps & { variant?: LogoVariant }) {
  const f = fills(variant);
  return (
    <svg viewBox="24 24 882.72 120" className={cn("h-7 w-auto shrink-0", className)} {...a11y(title || undefined)}>
      <g transform="translate(4 4) scale(5)">
        <path d={ARCH} fill={f.arch} />
        <path d={SQUARE} fill={f.square} />
      </g>
      <g transform={LETTERS_TRANSFORM} fill={f.letters}>
        {LETTERS.map((l) => (
          <path key={l.x} transform={`translate(${l.x} 0)`} d={GLYPHS[l.glyph]} />
        ))}
      </g>
    </svg>
  );
}

/** Symbol on a navy rounded tile (app icon style: favicon, avatars of the system, compact headers). */
export function LogoBadge({ className, title }: A11yProps) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-9 shrink-0", className)} {...a11y(title)}>
      <rect width="32" height="32" rx="7" fill={BRAND_NAVY} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="6.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.14" />
      <g transform="translate(1.6 1.6) scale(0.9)">
        <path d={ARCH} fill="#FFFFFF" />
        <path d={SQUARE} fill={BRAND_GOLD} />
      </g>
    </svg>
  );
}

/**
 * Full logo for headers. `tone` is the background it sits on: "dark" (navy
 * sidebar, landing hero) uses the light variant; "light" uses the color one.
 */
export function Logo({
  className,
  tone = "dark",
  size = "md",
  title = "Praetor",
}: {
  className?: string;
  tone?: "dark" | "light";
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const height = { sm: "h-5", md: "h-6", lg: "h-8" }[size];
  return <LogoWordmark variant={tone === "dark" ? "light" : "color"} className={cn(height, className)} title={title} />;
}
