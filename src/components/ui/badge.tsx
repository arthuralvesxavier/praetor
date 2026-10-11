import type { ComponentProps, ReactNode } from "react";
import { TONE_CLASSES, type Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";

export type BadgeTone = Tone;

export type BadgeProps = ComponentProps<"span"> & {
  /** neutral | info | success | warning (amber) | alert (orange) | danger | primary | ai (violet, AI only) */
  tone?: Tone;
  /** Small colored dot before the text (status indicator). */
  dot?: boolean;
  /** Optional leading icon element, e.g. `<Sparkles />` (sized automatically). */
  icon?: ReactNode;
};

/** Pill badge. Color is never the only signal: always keep a text label. */
export function Badge({ tone = "neutral", dot = false, icon, className, children, ...props }: BadgeProps) {
  const t = TONE_CLASSES[tone];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-5",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        t.badge,
        className,
      )}
      {...props}
    >
      {dot ? <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", t.dot)} /> : null}
      {icon ? (
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
