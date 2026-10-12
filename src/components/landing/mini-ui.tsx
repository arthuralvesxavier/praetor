import { CircleDashed, Database, FileSearch, PenLine, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { TONE_CLASSES, type Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";

/**
 * Miniature versions of the app's UI kit (src/components/ui), used only by the
 * landing page mockups. Same tokens and tones as Badge, StatCard, Card,
 * PageHeader and LinkTabs, at a smaller scale. They render static markup:
 * buttons and links here are drawings, not controls.
 */

export function MiniBadge({
  tone = "neutral",
  dot = false,
  icon: Icon,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const t = TONE_CLASSES[tone];
  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-1.5 text-[9.5px] leading-4 font-medium whitespace-nowrap",
        t.badge,
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className={cn("size-1 shrink-0 rounded-full", t.dot)} /> : null}
      {Icon ? <Icon aria-hidden="true" className="size-2.5 shrink-0" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function MiniCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-w-0 rounded-md border border-border bg-surface shadow-xs", className)}>{children}</div>;
}

export function MiniCardHeader({ title, aside, icon: Icon }: { title: string; aside?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
      <p className="flex min-w-0 items-center gap-1.5 text-[10.5px] font-semibold text-slate-900">
        {Icon ? <Icon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" /> : null}
        <span className="truncate">{title}</span>
      </p>
      {aside}
    </div>
  );
}

/** PageHeader: title, optional breadcrumb, description, meta and actions. */
export function MiniPageHeader({
  title,
  description,
  crumbs,
  meta,
  actions,
}: {
  title: string;
  description?: string;
  crumbs?: string[];
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      {crumbs ? (
        <p className="flex min-w-0 items-center gap-1 text-[9.5px] text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={c} className={cn("min-w-0 truncate", i === crumbs.length - 1 && "text-slate-700")}>
              {i > 0 ? <span aria-hidden="true" className="pr-1 text-slate-400">›</span> : null}
              {c}
            </span>
          ))}
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] leading-tight font-semibold tracking-tight text-slate-900">{title}</p>
          {description ? <p className="mt-0.5 line-clamp-1 text-[9.5px] text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {meta ? <div className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">{meta}</div> : null}
    </div>
  );
}

export function MiniButton({
  children,
  icon: Icon,
  variant = "primary",
  className,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  variant?: "primary" | "outline";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[9.5px] font-medium whitespace-nowrap",
        variant === "primary"
          ? "bg-primary text-primary-foreground"
          : "border border-border-strong bg-surface text-slate-800",
        className,
      )}
    >
      {Icon ? <Icon aria-hidden="true" className="size-2.5" /> : null}
      {children}
    </span>
  );
}

/** LinkTabs: underline tabs with an optional count pill. */
export function MiniTabs({ tabs }: { tabs: { label: string; count?: number; active?: boolean }[] }) {
  return (
    <div className="flex gap-0.5 overflow-hidden border-b border-border">
      {tabs.map((t) => (
        <span
          key={t.label}
          className={cn(
            "-mb-px inline-flex shrink-0 items-center gap-1 border-b-2 px-1.5 py-1 text-[10px] font-medium whitespace-nowrap",
            t.active ? "border-primary text-slate-900" : "border-transparent text-muted-foreground",
          )}
        >
          {t.label}
          {t.count != null ? (
            <span
              className={cn(
                "rounded-full px-1 text-[9px] leading-3.5 font-semibold tabular-nums",
                t.active ? "bg-primary text-primary-foreground" : "bg-slate-100 text-slate-700",
              )}
            >
              {t.count}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** StatCard: label, value, hint and the tone accent on the left edge. */
export function MiniStat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="relative min-w-0 rounded-md border border-border bg-surface p-2 shadow-xs">
      {tone !== "neutral" ? (
        <span aria-hidden="true" className={cn("absolute inset-y-2 left-0 w-0.5 rounded-r", TONE_CLASSES[tone].dot)} />
      ) : null}
      <p className="line-clamp-2 text-[9.5px] leading-tight font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[12px] font-semibold tracking-tight text-slate-900 tabular-nums @xl:text-[13px]">
        {value}
      </p>
      {hint ? <p className="truncate text-[9px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A CNJ number styled like the links of the portfolio table. */
export function MiniCnj({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("block truncate font-mono text-[9.5px] font-medium text-primary-700", className)}>{children}</span>
  );
}

/** "Não apurado" / "Não informado": shown as such, never as zero. */
export function MiniMissing({ children = "Não apurado" }: { children?: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** Provenance of a preliminary-analysis item (same tones and short labels as briefs/brief-badges.tsx). */
const PROVENANCE: Record<"extracted" | "record" | "missing" | "reviewer", { tone: Tone; icon: LucideIcon; label: string }> = {
  extracted: { tone: "info", icon: FileSearch, label: "Extraído" },
  record: { tone: "neutral", icon: Database, label: "Cadastro/planilha" },
  missing: { tone: "alert", icon: CircleDashed, label: "Lacuna" },
  reviewer: { tone: "success", icon: PenLine, label: "Editado pelo advogado" },
};

export function Provenance({ kind }: { kind: keyof typeof PROVENANCE }) {
  const p = PROVENANCE[kind];
  return (
    <MiniBadge tone={p.tone} icon={p.icon}>
      {p.label}
    </MiniBadge>
  );
}

