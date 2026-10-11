import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type DescriptionItem = {
  label: ReactNode;
  /** null / undefined / "" render an em dash. */
  value: ReactNode;
  /** Span all columns (long text such as descriptions). */
  full?: boolean;
};

export type DescriptionListProps = {
  /** Falsy entries are skipped, so `cond && { label, value }` works. */
  items: readonly (DescriptionItem | null | false | undefined)[];
  columns?: 1 | 2 | 3;
  className?: string;
};

const cols = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3" } as const;
const fullSpan = { 1: "", 2: "sm:col-span-2", 3: "sm:col-span-2 lg:col-span-3" } as const;

/**
 * Label/value grid for record details (single column on mobile).
 *
 *   <DescriptionList columns={2} items={[
 *     { label: "Número", value: p.number },
 *     { label: "Valor da causa", value: formatMoneyCents(p.claimAmountCents) },
 *     { label: "Descrição", value: p.description, full: true },
 *   ]} />
 */
export function DescriptionList({ items, columns = 2, className }: DescriptionListProps) {
  const visible = items.filter((i): i is DescriptionItem => Boolean(i));
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-4", cols[columns], className)}>
      {visible.map((item, i) => {
        const empty = item.value === null || item.value === undefined || item.value === "";
        return (
          <div key={i} className={cn("min-w-0", item.full && fullSpan[columns])}>
            <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
            <dd className="mt-0.5 text-sm break-words whitespace-pre-line text-slate-900">
              {empty ? (
                <>
                  <span aria-hidden="true" className="text-slate-400">
                    —
                  </span>
                  <span className="sr-only">Não informado</span>
                </>
              ) : (
                item.value
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
