"use client";

import { useActionState, useState, type ReactNode } from "react";
import type { FormState } from "@/lib/form";
import { Button, type ButtonVariantProps } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import { FormMessage } from "./form-message";
import { SubmitButton } from "./submit-button";
import { usePreservingSubmit } from "./use-preserving-submit";

export type ConfirmDialogProps<S extends FormState> = {
  /** Server action with the useActionState signature `(prev, formData) => ActionResult`. */
  action: (prev: S | null, formData: FormData) => Promise<S>;
  title: string;
  description?: ReactNode;
  /** Hidden inputs sent with the form, e.g. `{ id: record.id }`. */
  hiddenFields?: Record<string, string>;
  /** Extra form fields (e.g. a justification <Textarea>) shown in the dialog body. */
  children?: ReactNode;
  /** Custom trigger element (rendered with asChild). Defaults to a button with `triggerLabel`. */
  trigger?: ReactNode;
  triggerLabel?: string;
  triggerVariant?: ButtonVariantProps["variant"];
  triggerSize?: ButtonVariantProps["size"];
  confirmLabel?: string;
  pendingLabel?: string;
  cancelLabel?: string;
  /** "destructive" (default) for deletions; "primary" for non-destructive confirmations. */
  tone?: "destructive" | "primary";
};

/**
 * Confirmation dialog wrapping a server-action form. Closes itself when the
 * action returns `{ ok: true }`; shows the error banner otherwise, keeping
 * what was typed in the extra fields (`usePreservingSubmit`, no React form
 * reset). If the action calls `redirect()`, navigation happens as usual.
 *
 *   <ConfirmDialog action={deleteProcessAction} hiddenFields={{ id }} triggerLabel="Excluir"
 *     title="Excluir processo?" description="Esta ação não pode ser desfeita." confirmLabel="Excluir" />
 */
export function ConfirmDialog<S extends FormState>({
  trigger,
  triggerLabel = "Excluir",
  triggerVariant,
  triggerSize = "md",
  tone = "destructive",
  ...rest
}: ConfirmDialogProps<S>) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant={triggerVariant ?? (tone === "destructive" ? "outline" : "primary")} size={triggerSize}>
            {triggerLabel}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="sm" role="alertdialog">
        {/* Remounted on every open so a previous error does not linger. */}
        <ConfirmForm {...rest} tone={tone} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmForm<S extends FormState>({
  action,
  title,
  description,
  hiddenFields,
  children,
  confirmLabel = "Confirmar",
  pendingLabel = "Processando…",
  cancelLabel = "Cancelar",
  tone,
  onDone,
}: Omit<ConfirmDialogProps<S>, "trigger" | "triggerLabel" | "triggerVariant" | "triggerSize"> & {
  tone: "destructive" | "primary";
  onDone: () => void;
}) {
  const [state, formAction] = useActionState(async (prev: S | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) onDone();
    return result;
  }, null);
  // Fields in `children` (justification, date, checkbox…) keep what was typed when the action returns an error.
  const onSubmit = usePreservingSubmit(formAction);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
        : null}
      {children}
      <FormMessage state={state} />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {cancelLabel}
          </Button>
        </DialogClose>
        <SubmitButton variant={tone === "destructive" ? "destructive" : "primary"} pendingLabel={pendingLabel}>
          {confirmLabel}
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}
