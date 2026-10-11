"use client";

import { useId } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEADLINE_KIND_LABELS, PRIORITY_LABELS, type DeadlineKind } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import { createDeadlineAction } from "../actions";
import type { FixedWorkLink, WorkLinkOptions, WorkUserOption } from "../types";
import { FixedLinkFields, LinkSelect, PendingButton } from "./form-parts";
import { useFormAction } from "./use-form-action";

export type DeadlineFormProps = {
  userOptions: WorkUserOption[];
  /** Selectable records (on /prazos). Ignored when `fixedLink` is given. */
  linkOptions?: WorkLinkOptions;
  /** Entity page: the deadline is linked to this record. */
  fixedLink?: FixedWorkLink;
  defaultKind?: DeadlineKind;
  /** Defaults the responsible select to the current user. */
  defaultResponsibleId?: string | null;
  onSuccess?: () => void;
  /** Extra buttons next to submit (e.g. "Cancelar" inside a dialog). */
  secondaryAction?: React.ReactNode;
};

/** Manual deadline form. The date is typed by a person: the system does not count legal deadlines. */
export function DeadlineForm({
  userOptions,
  linkOptions,
  fixedLink,
  defaultKind,
  defaultResponsibleId,
  onSuccess,
  secondaryAction,
}: DeadlineFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-prazo-${name}`;
  const { state, pending, formRef, onSubmit } = useFormAction(createDeadlineAction, { onSuccess });

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <FormMessage state={state} className="sm:col-span-2" />
      {fixedLink ? <FixedLinkFields link={fixedLink} /> : null}

      <FormField label="Título do prazo" htmlFor={id("title")} required error={fieldError(state, "title")} className="sm:col-span-2">
        <Input name="title" required maxLength={300} autoComplete="off" placeholder="Ex.: Apresentar contestação" />
      </FormField>

      <FormField
        label="Data final"
        htmlFor={id("dueDate")}
        required
        error={fieldError(state, "dueDate")}
        hint="Informe a data já contada. O sistema não calcula prazos processuais."
      >
        <Input name="dueDate" type="date" required />
      </FormField>

      <FormField label="Tipo" htmlFor={id("kind")} required error={fieldError(state, "kind")}>
        <NativeSelect
          name="kind"
          required
          options={optionsFromLabels(DEADLINE_KIND_LABELS)}
          defaultValue={defaultKind ?? ""}
          placeholder="Selecione…"
          placeholderDisabled
        />
      </FormField>

      <FormField label="Prioridade" htmlFor={id("priority")} error={fieldError(state, "priority")}>
        <NativeSelect name="priority" options={optionsFromLabels(PRIORITY_LABELS)} defaultValue="medium" />
      </FormField>

      <FormField label="Responsável" htmlFor={id("responsibleId")} error={fieldError(state, "responsibleId")}>
        <NativeSelect
          name="responsibleId"
          options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
          defaultValue={defaultResponsibleId ?? ""}
          placeholder="Sem responsável"
        />
      </FormField>

      {!fixedLink && linkOptions ? (
        <FormField
          label="Vínculo"
          htmlFor={id("link")}
          error={fieldError(state, "link")}
          hint="Processo, ocorrência ou contrato a que o prazo se refere."
          className="sm:col-span-2"
        >
          <LinkSelect name="link" options={linkOptions} defaultValue="" />
        </FormField>
      ) : null}

      <FormField label="Descrição" htmlFor={id("description")} error={fieldError(state, "description")} className="sm:col-span-2">
        <Textarea name="description" rows={3} maxLength={5000} />
      </FormField>

      <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
        {secondaryAction}
        <PendingButton pending={pending}>Salvar prazo</PendingButton>
      </div>
    </form>
  );
}
