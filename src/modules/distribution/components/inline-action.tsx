"use client";

import { useActionState, type ReactNode } from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ButtonVariantProps } from "@/components/ui/button";
import type { FormState } from "@/lib/form";
import { cn } from "@/lib/utils";

export type InlineActionProps<S extends FormState> = {
  /** Server action with the useActionState signature `(prev, formData) => ActionResult`. */
  action: (prev: S | null, formData: FormData) => Promise<S>;
  hiddenFields?: Record<string, string>;
  children: ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariantProps["variant"];
  size?: ButtonVariantProps["size"];
  /** Accessible name when the button only shows an icon. */
  ariaLabel?: string;
  /** Show the success message next to the button (errors are always shown). */
  showSuccess?: boolean;
  className?: string;
  buttonClassName?: string;
};

/**
 * One-button form bound to a server action (activate, move, reprocess...).
 * Errors are announced with role="alert"; success optionally with role="status".
 */
export function InlineAction<S extends FormState>({
  action,
  hiddenFields,
  children,
  pendingLabel = "Processando…",
  variant = "outline",
  size = "sm",
  ariaLabel,
  showSuccess = false,
  className,
  buttonClassName,
}: InlineActionProps<S>) {
  const [state, formAction] = useActionState<S | null, FormData>(action, null);
  return (
    <form action={formAction} className={cn("inline-flex flex-col items-start gap-1", className)}>
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
        : null}
      <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel} aria-label={ariaLabel} className={buttonClassName}>
        {children}
      </SubmitButton>
      {state && !state.ok ? (
        <p role="alert" className="max-w-xs text-xs font-medium text-red-700">
          {state.error}
        </p>
      ) : null}
      {state && state.ok && showSuccess && state.message ? (
        <p role="status" className="max-w-md text-xs text-emerald-800">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
