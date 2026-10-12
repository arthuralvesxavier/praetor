"use client";

import { useActionState, useRef } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { PROCESS_EVENT_TYPE_LABELS, PROCESS_INSTANCE_LABELS } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import type { ValuesFormState } from "../schemas";

const typeOptions = optionsFromLabels(PROCESS_EVENT_TYPE_LABELS);
const instanceOptions = optionsFromLabels(PROCESS_INSTANCE_LABELS);

/** Form to register a manual movement on the process timeline. Resets after success. */
export function EventForm<S extends ValuesFormState>({
  action,
  processId,
  today,
  defaultInstance,
}: {
  action: (prev: S | null, formData: FormData) => Promise<S>;
  processId: string;
  /** Current instance of the process (pre-selected). */
  defaultInstance?: string | null;
  /** "YYYY-MM-DD" in the app time zone (computed on the server). */
  today: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(async (prev: S | null, formData: FormData) => {
    const result = await action(prev, formData);
    // Registered: clear the form for the next movement (date and instance back to their defaults).
    if (result.ok) formRef.current?.reset();
    return result;
  }, null);
  // No automatic reset on error: the chosen type and instance stay selected.
  const onSubmit = usePreservingSubmit(formAction);
  const sent = state && !state.ok ? state.values : undefined;
  const val = (key: string, fallback = "") => (sent ? (sent[key] ?? "") : fallback);
  const err = (field: string) => fieldError(state, field);

  return (
    // Container query: one column in the narrow side column of the page, two when there is room.
    <div className="@container">
      <form ref={formRef} action={formAction} onSubmit={onSubmit} className="grid grid-cols-1 gap-4 @md:grid-cols-2" noValidate>
        <input type="hidden" name="processId" value={processId} />
        <FormMessage state={state} className="@md:col-span-2" />
        <FormField label="Data" htmlFor="event-occurredAt" required error={err("occurredAt")}>
          <Input name="occurredAt" type="date" required defaultValue={val("occurredAt", today)} />
        </FormField>
        <FormField label="Tipo" htmlFor="event-type" required error={err("type")}>
          <NativeSelect name="type" options={typeOptions} placeholder="Selecione…" required defaultValue={val("type")} />
        </FormField>
        <FormField label="Título" htmlFor="event-title" required error={err("title")} className="@md:col-span-2">
          <Input name="title" required maxLength={200} defaultValue={val("title")} placeholder="Ex.: Audiência de conciliação designada" />
        </FormField>
        <FormField label="Detalhes" htmlFor="event-description" error={err("description")} className="@md:col-span-2">
          <Textarea name="description" rows={3} maxLength={10000} defaultValue={val("description")} />
        </FormField>
        <FormField label="Instância" htmlFor="event-instance" error={err("instance")}>
          <NativeSelect
            name="instance"
            options={instanceOptions}
            placeholder="Não informada"
            defaultValue={val("instance", defaultInstance ?? "")}
          />
        </FormField>
        <FormField
          label="Código do movimento (CNJ)"
          htmlFor="event-cnjMovementCode"
          error={err("cnjMovementCode")}
          hint="Opcional. Preencha só se o código constar do andamento oficial. Para movimentações registradas aqui, o sistema não sugere códigos."
        >
          <Input name="cnjMovementCode" inputMode="numeric" maxLength={6} autoComplete="off" defaultValue={val("cnjMovementCode")} />
        </FormField>
        <div className="@md:col-span-2">
          <SubmitButton>Registrar movimentação</SubmitButton>
        </div>
      </form>
    </div>
  );
}
