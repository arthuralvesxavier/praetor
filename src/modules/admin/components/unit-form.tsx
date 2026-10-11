"use client";

import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { PendingButton, useAdminForm, type FormAction } from "./form-utils";

export type UnitFormValues = { id?: string; name: string; code: string | null; isActive: boolean };

export function UnitForm<S extends FormState>({
  mode,
  action,
  defaults,
}: {
  mode: "create" | "edit";
  action: FormAction<S>;
  defaults?: UnitFormValues;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  return (
    <form action={formAction} onSubmit={onSubmit} className="grid gap-4" noValidate>
      {defaults?.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Nome" htmlFor="name" required error={fieldError(state, "name")} hint="Único na organização.">
          <Input name="name" defaultValue={defaults?.name} maxLength={120} required placeholder="Ex.: Filial Recife" />
        </FormField>
        <FormField label="Código" htmlFor="code" error={fieldError(state, "code")} hint="Opcional, ex.: centro de custo.">
          <Input name="code" defaultValue={defaults?.code ?? ""} maxLength={30} />
        </FormField>
      </div>
      {mode === "edit" ? (
        // Activation is changed only through the dedicated buttons; the current value is re-sent as is.
        <input type="hidden" name="isActive" value={defaults?.isActive ? "on" : ""} />
      ) : null}
      <div>
        <PendingButton pending={pending}>{mode === "create" ? "Criar unidade" : "Salvar alterações"}</PendingButton>
      </div>
    </form>
  );
}
