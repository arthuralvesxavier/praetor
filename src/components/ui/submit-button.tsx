"use client";

import { LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./button";

export type SubmitButtonProps = Omit<ButtonProps, "type" | "asChild"> & {
  /** Text while the form is submitting (default "Salvando…"). */
  pendingLabel?: string;
};

/**
 * Submit button for forms bound to server actions: disables itself and shows a
 * spinner while the enclosing <form> is pending. Must be rendered inside the <form>.
 */
export function SubmitButton({ children, pendingLabel = "Salvando…", disabled, ...props }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending || undefined} {...props}>
      {pending ? (
        <>
          <LoaderCircle aria-hidden="true" className="animate-spin" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
}
