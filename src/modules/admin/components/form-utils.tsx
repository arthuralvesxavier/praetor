"use client";

import { Loader2 } from "lucide-react";
import { startTransition, useActionState, type FormEvent, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import type { FormState } from "@/lib/form";
import { cn } from "@/lib/utils";

export type FormAction<S extends FormState = FormState> = (prev: S | null, formData: FormData) => Promise<S>;

/**
 * `useActionState` wrapper for edit forms. React 19 resets uncontrolled
 * fields after every `<form action>` submission — including failed ones,
 * which would wipe what the user typed. Dispatching manually from `onSubmit`
 * keeps the values; `action` stays on the form for no-JS submissions.
 */
export function useAdminForm<S extends FormState>(action: FormAction<S>) {
  const [state, formAction, pending] = useActionState(action, null);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  };
  return { state, formAction, pending, onSubmit };
}

export function PendingButton({
  pending,
  pendingLabel = "Salvando…",
  children,
  disabled,
  ...props
}: Omit<ButtonProps, "type" | "asChild"> & { pending: boolean; pendingLabel?: string }) {
  return (
    <Button type="submit" disabled={pending || disabled} aria-disabled={pending || disabled} {...props}>
      {pending ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/**
 * One-button form for simple commands ("Executar agora", "Reativar"…) with
 * an inline result message.
 */
export function ActionButtonForm<S extends FormState>({
  action,
  hiddenFields,
  children,
  pendingLabel = "Processando…",
  variant = "outline",
  size = "sm",
  className,
  messageClassName,
}: {
  action: FormAction<S>;
  hiddenFields?: Record<string, string>;
  children: ReactNode;
  pendingLabel?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  messageClassName?: string;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  return (
    <form action={formAction} onSubmit={onSubmit} className={cn("flex flex-col items-start gap-2", className)}>
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
        : null}
      <PendingButton pending={pending} pendingLabel={pendingLabel} variant={variant} size={size}>
        {children}
      </PendingButton>
      <FormMessage state={state} className={messageClassName} />
    </form>
  );
}
