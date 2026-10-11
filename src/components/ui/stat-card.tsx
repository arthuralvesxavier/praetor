import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { TONE_CLASSES, type Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";

export type StatCardProps = {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** When set the whole card is a link to the records behind the indicator. */
  href?: string;
  tone?: Tone;
  /** Icon element, e.g. `<Scale />`. */
  icon?: ReactNode;
  className?: string;
};

/**
 * KPI card for dashboards. With `href` it gives direct access to the records
 * that originate the indicator (e.g. `/prazos?situacao=vencidos`).
 */
export function StatCard({ label, value, hint, href, tone = "neutral", icon, className }: StatCardProps) {
  const t = TONE_CLASSES[tone];
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {icon ? (
          <span
            aria-hidden="true"
            className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4", t.icon)}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {hint || href ? (
        <div className="mt-1 flex items-center justify-between gap-2">
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : <span />}
          {href ? (
            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-primary-600 group-hover:text-primary">
              Ver registros
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );

  const base = "relative flex flex-col rounded-lg border border-border bg-surface p-4 shadow-xs";
  const accent = <span aria-hidden="true" className={cn("absolute inset-y-3 left-0 w-0.5 rounded-r", t.dot)} />;

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          base,
          "group transition-colors hover:border-primary-300 hover:bg-primary-50/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        {tone !== "neutral" ? accent : null}
        {body}
      </Link>
    );
  }
  return (
    <div className={cn(base, className)}>
      {tone !== "neutral" ? accent : null}
      {body}
    </div>
  );
}
