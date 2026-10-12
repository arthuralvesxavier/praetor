"use client";

import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { PendingButton, useAdminForm, type FormAction } from "@/modules/admin/components/form-utils";

export type CompanyFormValues = { id?: string; name: string; document: string | null; isActive: boolean };

/** Create/edit form of a company (empresa do grupo). */
export function CompanyForm<S extends FormState>({
  mode,
  action,
  defaults,
}: {
  mode: "create" | "edit";
  action: FormAction<S>;
  defaults?: CompanyFormValues;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  return (
    <form action={formAction} onSubmit={onSubmit} className="grid gap-4" noValidate>
      {defaults?.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Razão social ou nome" htmlFor="name" required error={fieldError(state, "name")} hint="Único na organização.">
          <Input name="name" defaultValue={defaults?.name} maxLength={160} required placeholder="Ex.: Empresa Modelo Ltda." />
        </FormField>
        <FormField
          label="CNPJ"
          htmlFor="document"
          error={fieldError(state, "document")}
          hint="Opcional. Aceita o CNPJ numérico ou alfanumérico; os dígitos verificadores são conferidos."
        >
          <Input
            name="document"
            defaultValue={defaults?.document ?? ""}
            maxLength={30}
            autoComplete="off"
            spellCheck={false}
            placeholder="00.000.000/0000-00"
          />
        </FormField>
      </div>
      {mode === "edit" ? (
        // Activation is changed only through the dedicated buttons; the current value is re-sent as is.
        <input type="hidden" name="isActive" value={defaults?.isActive ? "on" : ""} />
      ) : null}
      <div>
        <PendingButton pending={pending}>{mode === "create" ? "Cadastrar empresa" : "Salvar alterações"}</PendingButton>
      </div>
    </form>
  );
}
