import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { INTAKE_STATUS_LABELS, type IntakeStatus } from "@/domain/enums";
import { formatNumber } from "@/lib/format";
import { buildHref, type SearchParams } from "@/lib/search-params";
import { TONE_CLASSES } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { INTAKE_STATUS_TONES, PIPELINE_STATUSES } from "../status";

function Chip({
  href,
  label,
  count,
  active,
  tone,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  tone: keyof typeof TONE_CLASSES;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-slate-700 hover:bg-slate-50",
      )}
    >
      {!active ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", TONE_CLASSES[tone].dot)} /> : null}
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 tabular-nums",
          active ? "bg-white/20 text-primary-foreground" : count > 0 ? "bg-slate-100 text-slate-900" : "text-muted-foreground",
        )}
      >
        {formatNumber(count)}
      </span>
    </Link>
  );
}

/** Status chips in pipeline order (filters the list by effective status, param `status`). */
export function PipelineStrip({
  counts,
  active,
  sp,
}: {
  counts: Record<IntakeStatus, number>;
  active: IntakeStatus | undefined;
  sp: SearchParams;
}) {
  const total = Object.entries(counts)
    .filter(([s]) => s !== "cancelled")
    .reduce((sum, [, n]) => sum + n, 0);
  return (
    <nav aria-label="Etapas do fluxo de entrada" className="mb-4 rounded-lg border border-border bg-surface p-3 shadow-xs">
      <ol className="flex flex-wrap items-center gap-1.5">
        <li>
          <Chip href={buildHref("/entrada", sp, { status: null, pagina: null })} label="Todas" count={total} active={!active} tone="neutral" />
        </li>
        {PIPELINE_STATUSES.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            {i > 0 ? <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400" /> : <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />}
            <Chip
              href={buildHref("/entrada", sp, { status: s, pagina: null })}
              label={INTAKE_STATUS_LABELS[s]}
              count={counts[s] ?? 0}
              active={active === s}
              tone={INTAKE_STATUS_TONES[s]}
            />
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
          <Chip
            href={buildHref("/entrada", sp, { status: "failed", pagina: null })}
            label={INTAKE_STATUS_LABELS.failed}
            count={counts.failed ?? 0}
            active={active === "failed"}
            tone="danger"
          />
        </li>
      </ol>
    </nav>
  );
}
