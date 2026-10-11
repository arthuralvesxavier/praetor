import { RotateCcw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export type ErrorStateProps = {
  title?: string;
  description?: ReactNode;
  /**
   * Retry callback (shows a "Tentar novamente" button). Functions can only be
   * passed from client components (e.g. error.tsx); server components should
   * use `action` with a link instead.
   */
  retry?: () => void;
  action?: ReactNode;
  className?: string;
};

/** Error panel for failed loads. Never show stack traces or internal messages here. */
export function ErrorState({
  title = "Não foi possível carregar as informações",
  description = "Ocorreu um erro inesperado. Tente novamente em instantes; se o problema persistir, contate o administrador.",
  retry,
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-red-200 bg-surface px-6 py-10 text-center",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-red-50 text-red-700"
      >
        <TriangleAlert className="size-5" />
      </span>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description ? <div className="max-w-md text-sm text-muted-foreground">{description}</div> : null}
      {retry || action ? (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {retry ? (
            <Button type="button" variant="outline" onClick={retry}>
              <RotateCcw aria-hidden="true" />
              Tentar novamente
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
