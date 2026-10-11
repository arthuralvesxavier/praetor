import { Inbox } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Data table. Always horizontally scrollable on small screens.
 * Give it an accessible name: `<Table aria-label="Processos">` or a <TableCaption>.
 */
export function Table({ className, containerClassName, ...props }: ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <div className={cn("relative w-full overflow-x-auto", containerClassName)}>
      <table className={cn("w-full caption-bottom border-collapse text-sm tabular-nums", className)} {...props} />
    </div>
  );
}

/** Visually hidden by default; pass `visible` to show it under the table. */
export function TableCaption({ className, visible = false, ...props }: ComponentProps<"caption"> & { visible?: boolean }) {
  return (
    <caption
      className={cn(visible ? "mt-3 text-xs text-muted-foreground" : "sr-only", className)}
      {...props}
    />
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("border-b border-border bg-slate-50", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&>tr:last-child]:border-0", className)} {...props} />;
}

/** `interactive` adds a hover background (use when rows contain a primary link). */
export function TableRow({ className, interactive = false, ...props }: ComponentProps<"tr"> & { interactive?: boolean }) {
  return (
    <tr
      className={cn(
        "border-b border-border transition-colors",
        interactive && "hover:bg-slate-50 has-[a:focus-visible]:bg-slate-50",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, scope = "col", ...props }: ComponentProps<"th">) {
  return (
    <th
      scope={scope}
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-semibold whitespace-nowrap text-slate-600 first:pl-5 last:pr-5",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td className={cn("px-3 py-2.5 align-middle text-slate-800 first:pl-5 last:pr-5", className)} {...props} />
  );
}

export type TableEmptyProps = {
  colSpan: number;
  message?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
};

/** Single full-width row for empty results. */
export function TableEmpty({ colSpan, message = "Nenhum registro encontrado.", description, action }: TableEmptyProps) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-10 text-center">
        <div className="mx-auto flex max-w-md flex-col items-center gap-2">
          <Inbox aria-hidden="true" className="size-6 text-slate-400" />
          <p className="font-medium text-slate-700">{message}</p>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          {action ? <div className="mt-1">{action}</div> : null}
        </div>
      </td>
    </tr>
  );
}

/** Styling for the primary link of a row (e.g. the record title in the first column). */
export const tableLinkClasses = "font-medium text-primary-700 hover:text-primary-900 hover:underline underline-offset-2";
