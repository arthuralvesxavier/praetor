"use client";

import { useActionState } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { PROCESS_EVENT_TYPE_LABELS } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import type { ValuesFormState } from "../schemas";

const typeOptions = optionsFromLabels(PROCESS_EVENT_TYPE_LABELS);

/** Form to register a manual movement on the process timeline. Resets after success. */
export function EventForm<S extends ValuesFormState>({
  action,
  processId,
  today,
}: {
  action: (prev: S | null, formData: FormData) => Promise<S>;
  processId: string;
  /** "YYYY-MM-DD" in the app time zone (computed on the server). */
  today: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const sent = state && !state.ok ? state.values : undefined;
  const val = (key: string, fallback = "") => (sent ? (sent[key] ?? "") : fallback);
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2" noValidate>
      <input type="hidden" name="processId" value={processId} />
      <FormMessage state={state} className="sm:col-span-2" />
      <FormField label="Data" htmlFor="event-occurredAt" required error={err("occurredAt")}>
        <Input name="occurredAt" type="date" required defaultValue={val("occurredAt", today)} />
      </FormField>
      <FormField label="Tipo" htmlFor="event-type" required error={err("type")}>
        <NativeSelect name="type" options={typeOptions} placeholder="Selecione…" required defaultValue={val("type")} />
      </FormField>
      <FormField label="Título" htmlFor="event-title" required error={err("title")} className="sm:col-span-2">
        <Input name="title" required maxLength={200} defaultValue={val("title")} placeholder="Ex.: Audiência de conciliação designada" />
      </FormField>
      <FormField label="Detalhes" htmlFor="event-description" error={err("description")} className="sm:col-span-2">
        <Textarea name="description" rows={3} maxLength={10000} defaultValue={val("description")} />
      </FormField>
      <div className="sm:col-span-2">
        <SubmitButton>Registrar movimentação</SubmitButton>
      </div>
    </form>
  );
}
