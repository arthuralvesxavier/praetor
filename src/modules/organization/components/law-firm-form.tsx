"use client";

import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { PendingButton, useAdminForm, type FormAction } from "@/modules/admin/components/form-utils";

export type LawFirmFormValues = {
  id?: string;
  name: string;
  document: string | null;
  contactName: string | null;
  contactEmail: string | null;
  isActive: boolean;
};

/** Create/edit form of an external law firm (escritório externo). */
export function LawFirmForm<S extends FormState>({
  mode,
  action,
  defaults,
}: {
  mode: "create" | "edit";
  action: FormAction<S>;
  defaults?: LawFirmFormValues;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const err = (f: string) => fieldError(state, f);
  return (
    <form action={formAction} onSubmit={onSubmit} className="grid gap-4" noValidate>
      {defaults?.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Nome do escritório" htmlFor="name" required error={err("name")} hint="Único na organização.">
          <Input name="name" defaultValue={defaults?.name} maxLength={160} required placeholder="Ex.: Silva & Associados Advogados" />
        </FormField>
        <FormField
          label="CNPJ"
          htmlFor="document"
          error={err("document")}
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
        <FormField label="Contato responsável" htmlFor="contactName" error={err("contactName")} hint="Opcional.">
          <Input name="contactName" defaultValue={defaults?.contactName ?? ""} maxLength={120} autoComplete="off" />
        </FormField>
        <FormField
          label="E-mail do contato"
          htmlFor="contactEmail"
          error={err("contactEmail")}
          hint="Opcional. Usado apenas como referência de cadastro; nenhum e-mail real é enviado nesta versão."
        >
          <Input name="contactEmail" type="email" defaultValue={defaults?.contactEmail ?? ""} maxLength={254} autoComplete="off" />
        </FormField>
      </div>
      {mode === "edit" ? (
        // Activation is changed only through the dedicated buttons; the current value is re-sent as is.
        <input type="hidden" name="isActive" value={defaults?.isActive ? "on" : ""} />
      ) : null}
      <div>
        <PendingButton pending={pending}>{mode === "create" ? "Cadastrar escritório" : "Salvar alterações"}</PendingButton>
      </div>
    </form>
  );
}
