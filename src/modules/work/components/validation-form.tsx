"use client";

import { useId, useState } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fieldError } from "@/lib/form";
import { formatDate } from "@/lib/format";
import { validateDeadlineAction } from "../actions";
import type { WorkUserOption } from "../types";
import { PendingButton } from "./form-parts";
import { useFormAction } from "./use-form-action";

/**
 * Human validation of an AI-suggested deadline: validate (optionally adjusting
 * the date and choosing the responsible) or reject (reason required).
 */
export function ValidationForm({
  deadlineId,
  suggestedDate,
  userOptions,
  defaultResponsibleId,
}: {
  deadlineId: string;
  suggestedDate: string;
  userOptions: WorkUserOption[];
  defaultResponsibleId?: string | null;
}) {
  const uid = useId();
  const id = (name: string) => `${uid}-validacao-${name}`;
  const [decision, setDecision] = useState<"validated" | "rejected">("validated");
  const { state, pending, formRef, onSubmit } = useFormAction(validateDeadlineAction);
  const decisionError = fieldError(state, "decision");

  if (state?.ok) {
    return <FormMessage state={state} />;
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <input type="hidden" name="id" value={deadlineId} />
      <FormMessage state={state} className="sm:col-span-2" />

      <fieldset className="sm:col-span-2" aria-describedby={decisionError ? id("decision-error") : undefined}>
        <legend className="mb-2 text-sm font-medium text-slate-900">Decisão</legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-800">
            <input
              type="radio"
              name="decision"
              value="validated"
              checked={decision === "validated"}
              onChange={() => setDecision("validated")}
              className="size-4 accent-primary"
            />
            Validar prazo
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-800">
            <input
              type="radio"
              name="decision"
              value="rejected"
              checked={decision === "rejected"}
              onChange={() => setDecision("rejected")}
              className="size-4 accent-red-700"
            />
            Rejeitar sugestão
          </label>
        </div>
        {decisionError ? (
          <p id={id("decision-error")} className="mt-1 text-xs font-medium text-red-700">
            {decisionError}
          </p>
        ) : null}
      </fieldset>

      {decision === "validated" ? (
        <>
          <FormField
            label="Data final confirmada"
            htmlFor={id("dueDate")}
            error={fieldError(state, "dueDate")}
            hint={`Sugerida pela IA: ${formatDate(suggestedDate)}. Ajuste se a contagem aplicável indicar outra data.`}
          >
            <Input name="dueDate" type="date" defaultValue={suggestedDate} />
          </FormField>
          <FormField label="Responsável" htmlFor={id("responsibleId")} error={fieldError(state, "responsibleId")}>
            <NativeSelect
              name="responsibleId"
              options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
              defaultValue={defaultResponsibleId ?? ""}
              placeholder="Manter sem responsável"
            />
          </FormField>
        </>
      ) : null}

      <FormField
        label={decision === "rejected" ? "Motivo da rejeição" : "Observação (opcional)"}
        htmlFor={id("note")}
        required={decision === "rejected"}
        error={fieldError(state, "note")}
        className="sm:col-span-2"
      >
        <Textarea name="note" rows={2} maxLength={2000} required={decision === "rejected"} />
      </FormField>

      <div className="flex justify-end sm:col-span-2">
        <PendingButton
          pending={pending}
          pendingLabel="Registrando…"
          variant={decision === "rejected" ? "destructive" : "primary"}
        >
          {decision === "rejected" ? "Rejeitar sugestão" : "Validar prazo"}
        </PendingButton>
      </div>
    </form>
  );
}
