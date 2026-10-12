"use client";

import { UserRoundCog } from "lucide-react";
import { useActionState, useEffect, useId, useRef } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { fieldError, type FormState } from "@/lib/form";
import type { Option } from "@/lib/options";
import { cn } from "@/lib/utils";

export type ManualAssignFormProps<S extends FormState> = {
  action: (prev: S | null, formData: FormData) => Promise<S>;
  hiddenFields: Record<string, string>;
  users: Option[];
  submitLabel?: string;
  className?: string;
};

/** Manual (re)assignment with a mandatory reason (recorded in the audit trail). */
export function ManualAssignForm<S extends FormState>({
  action,
  hiddenFields,
  users,
  submitLabel = "Atribuir manualmente",
  className,
}: ManualAssignFormProps<S>) {
  const uid = useId();
  const [state, formAction] = useActionState<S | null, FormData>(action, null);
  // No React form reset: the chosen responsible and the reason survive an error result.
  const onSubmit = usePreservingSubmit(formAction);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // After a successful (re)assignment the fields are cleared, as before.
    if (state?.ok) formRef.current?.reset();
  }, [state]);
  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className={cn("grid gap-3", className)} noValidate>
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <FormMessage state={state} />
      <FormField label="Novo responsável" htmlFor={`${uid}-user`} required error={fieldError(state, "userId")}>
        <NativeSelect name="userId" options={users} placeholder="Selecione…" placeholderDisabled defaultValue="" required />
      </FormField>
      <FormField
        label="Motivo"
        htmlFor={`${uid}-reason`}
        required
        hint="Fica registrado na trilha de auditoria e no histórico da entrada."
        error={fieldError(state, "reason")}
      >
        <Textarea name="reason" rows={2} maxLength={500} required placeholder="Ex.: redistribuição por férias do advogado" />
      </FormField>
      <div>
        <SubmitButton variant="outline" pendingLabel="Atribuindo…">
          <UserRoundCog aria-hidden="true" />
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}
