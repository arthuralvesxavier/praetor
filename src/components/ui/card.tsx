import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Card container. Children use horizontal padding only; the card provides the
 * vertical rhythm. For a flush table use `<CardContent className="px-0">`.
 */
export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("flex flex-col gap-4 rounded-lg border border-border bg-surface py-5 shadow-xs", className)}
      {...props}
    />
  );
}

export type CardHeaderProps = ComponentProps<"div"> & {
  /** Buttons/links aligned to the right of the title. */
  actions?: ReactNode;
};

export function CardHeader({ className, actions, children, ...props }: CardHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 px-5", className)} {...props}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export type CardTitleProps = ComponentProps<"h2"> & { as?: "h2" | "h3" | "h4" };

export function CardTitle({ className, as: Tag = "h2", ...props }: CardTitleProps) {
  return <Tag className={cn("text-base font-semibold leading-snug text-slate-900", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 border-t border-border px-5 pt-4", className)}
      {...props}
    />
  );
}
