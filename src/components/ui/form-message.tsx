import { CircleAlert, CircleCheck } from "lucide-react";
import type { FormState } from "@/lib/form";
import { cn } from "@/lib/utils";

export type FormMessageProps = {
  /** Result of a server action (`ActionResult`) or null before the first submit. */
  state: FormState | null | undefined;
  /** Shown on success when the action returned no `message`. Omit to show nothing. */
  successFallback?: string;
  className?: string;
};

/**
 * Banner for the outcome of a form submission: success (role="status") or
 * error (role="alert"). Field-level messages are shown by <FormField>.
 */
export function FormMessage({ state, successFallback, className }: FormMessageProps) {
  if (!state) return null;
  if (state.ok) {
    const text = state.message ?? successFallback;
    if (!text) return null;
    return (
      <div
        role="status"
        className={cn(
          "flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900",
          className,
        )}
      >
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-700" />
        <span>{text}</span>
      </div>
    );
  }
  const hasFieldErrors = Object.values(state.fieldErrors ?? {}).some((v) => v && v.length > 0);
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900",
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red-700" />
      <div>
        <p>{state.error}</p>
        {hasFieldErrors && !/campo/i.test(state.error) ? (
          <p className="mt-0.5 text-xs text-red-800">Verifique os campos destacados abaixo.</p>
        ) : null}
      </div>
    </div>
  );
}
