import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Breadcrumb = { label: string; href?: string };

export type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons / links on the right (stack below the title on mobile). */
  actions?: ReactNode;
  breadcrumbs?: readonly Breadcrumb[];
  /** Extra content under the title (badges, meta). */
  meta?: ReactNode;
  className?: string;
};

/** Page title block — the only <h1> of the page. */
export function PageHeader({ title, description, actions, breadcrumbs, meta, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-6 flex flex-col gap-3", className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Trilha de navegação">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {breadcrumbs.map((b, i) => {
              const last = i === breadcrumbs.length - 1;
              return (
                <li key={`${b.label}-${i}`} className="flex items-center gap-1">
                  {b.href && !last ? (
                    <Link href={b.href} className="rounded-sm hover:text-slate-900 hover:underline underline-offset-2">
                      {b.label}
                    </Link>
                  ) : (
                    <span aria-current={last ? "page" : undefined} className={cn(last && "text-slate-700")}>
                      {b.label}
                    </span>
                  )}
                  {!last ? <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400" /> : null}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
          {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
          {meta ? <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
