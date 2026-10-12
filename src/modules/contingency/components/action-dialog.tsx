"use client";

import { startTransition, useActionState, useCallback, useState, type FormEvent, type ReactNode } from "react";
import { Button, type ButtonVariantProps } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/form";
import { cn } from "@/lib/utils";

/**
 * `onSubmit` that dispatches the action inside a transition WITHOUT React's
 * automatic form reset, so typed values survive a validation error.
 */
function usePreservingSubmit(dispatch: (formData: FormData) => void) {
  return useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      const formData = new FormData(event.currentTarget, submitter);
      startTransition(() => dispatch(formData));
    },
    [dispatch],
  );
}

export type ActionDialogProps<S extends FormState> = {
  /** Trigger element (rendered with asChild), e.g. a <Button type="button">. */
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  action: (prev: S | null, formData: FormData) => Promise<S>;
  hiddenFields?: Record<string, string>;
  submitLabel: string;
  pendingLabel?: string;
  size?: "sm" | "md" | "lg";
  tone?: "primary" | "destructive";
  /** Form fields; receives the last action state to show field errors. */
  children?: (state: S | null) => ReactNode;
};

/** Dialog with a server-action form. Closes itself on `{ ok: true }`; keeps typed values on error. */
export function ActionDialog<S extends FormState>({ trigger, size = "md", ...rest }: ActionDialogProps<S>) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size={size}>
        {/* Remounted on every open so a previous error does not linger. */}
        {open ? <ActionDialogForm {...rest} onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ActionDialogForm<S extends FormState>({
  title,
  description,
  action,
  hiddenFields,
  submitLabel,
  pendingLabel,
  tone = "primary",
  children,
  onDone,
}: Omit<ActionDialogProps<S>, "trigger" | "size"> & { onDone: () => void }) {
  const [state, formAction] = useActionState(async (prev: S | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) onDone();
    return result;
  }, null);
  const onSubmit = usePreservingSubmit(formAction);
  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
        : null}
      <FormMessage state={state} />
      {children ? children(state) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancelar
          </Button>
        </DialogClose>
        <SubmitButton variant={tone === "destructive" ? "destructive" : "primary"} pendingLabel={pendingLabel}>
          {submitLabel}
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

export type InlineActionProps<S extends FormState> = {
  action: (prev: S | null, formData: FormData) => Promise<S>;
  hiddenFields: Record<string, string>;
  label: ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariantProps["variant"];
  size?: ButtonVariantProps["size"];
  /** Accessible name when the visible label is ambiguous in a table row. */
  ariaLabel?: string;
  className?: string;
  /** Show the success message too (errors are always shown). */
  showSuccess?: boolean;
};

/** One-click server action (hidden fields + submit button) with the outcome shown next to it. */
export function InlineAction<S extends FormState>({
  action,
  hiddenFields,
  label,
  pendingLabel = "Processando…",
  variant = "outline",
  size = "sm",
  ariaLabel,
  className,
  showSuccess = true,
}: InlineActionProps<S>) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={cn("inline-flex flex-col gap-2", className)}>
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel} aria-label={ariaLabel}>
        {label}
      </SubmitButton>
      {state && (!state.ok || showSuccess) ? <FormMessage state={state} className="text-xs" /> : null}
    </form>
  );
}
