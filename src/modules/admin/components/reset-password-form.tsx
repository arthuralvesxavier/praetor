"use client";

import { useRef } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { PendingButton, useAdminForm, type FormAction } from "./form-utils";

/** Admin sets a new password for a user; every session of that user is ended. */
export function ResetPasswordForm<S extends FormState>({
  action,
  userId,
  isSelf,
}: {
  action: FormAction<S>;
  userId: string;
  isSelf: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const { state, formAction, pending, onSubmit } = useAdminForm(async (prev: S | null, fd: FormData) => {
    const result = await action(prev, fd);
    // Never keep passwords in the fields after a successful reset.
    if (result.ok) formRef.current?.reset();
    return result;
  });
  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className="grid gap-4" noValidate>
      <input type="hidden" name="id" value={userId} />
      <FormMessage state={state} />
      <p className="text-sm text-muted-foreground">
        Mínimo de 10 caracteres, com letras e números. Todas as sessões abertas do usuário serão encerradas
        {isSelf ? ", inclusive a sua, e você precisará entrar novamente." : "."}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Nova senha" htmlFor="new-password" required error={fieldError(state, "password")}>
          <Input name="password" type="password" autoComplete="new-password" minLength={10} maxLength={200} required />
        </FormField>
        <FormField label="Confirmar nova senha" htmlFor="confirm-password" required error={fieldError(state, "confirmPassword")}>
          <Input name="confirmPassword" type="password" autoComplete="new-password" maxLength={200} required />
        </FormField>
      </div>
      <div>
        <PendingButton pending={pending} variant="secondary" pendingLabel="Redefinindo…">
          Redefinir senha
        </PendingButton>
      </div>
    </form>
  );
}
