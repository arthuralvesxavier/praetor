"use client";

import { useId } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PRIORITY_LABELS, TASK_KIND_LABELS, type TaskKind } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import { createTaskAction } from "../actions";
import type { FixedWorkLink, WorkLinkOptions, WorkUserOption } from "../types";
import { FixedLinkFields, LinkSelect, PendingButton } from "./form-parts";
import { useFormAction } from "./use-form-action";

export type TaskFormProps = {
  userOptions: WorkUserOption[];
  linkOptions?: WorkLinkOptions;
  fixedLink?: FixedWorkLink;
  /** Default task kind; with `lockKind` the kind is fixed (e.g. action plan items). */
  defaultKind?: TaskKind;
  lockKind?: boolean;
  defaultAssigneeId?: string | null;
  onSuccess?: () => void;
  secondaryAction?: React.ReactNode;
};

export function TaskForm({
  userOptions,
  linkOptions,
  fixedLink,
  defaultKind = "general",
  lockKind = false,
  defaultAssigneeId,
  onSuccess,
  secondaryAction,
}: TaskFormProps) {
  const uid = useId();
  const id = (name: string) => `${uid}-tarefa-${name}`;
  const { state, pending, formRef, onSubmit } = useFormAction(createTaskAction, { onSuccess });

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <FormMessage state={state} className="sm:col-span-2" />
      {fixedLink ? <FixedLinkFields link={fixedLink} /> : null}

      <FormField label="Título da tarefa" htmlFor={id("title")} required error={fieldError(state, "title")} className="sm:col-span-2">
        <Input name="title" required maxLength={300} autoComplete="off" />
      </FormField>

      {lockKind ? (
        <input type="hidden" name="kind" value={defaultKind} />
      ) : (
        <FormField label="Tipo" htmlFor={id("kind")} error={fieldError(state, "kind")}>
          <NativeSelect name="kind" options={optionsFromLabels(TASK_KIND_LABELS)} defaultValue={defaultKind} />
        </FormField>
      )}

      <FormField label="Prioridade" htmlFor={id("priority")} error={fieldError(state, "priority")}>
        <NativeSelect name="priority" options={optionsFromLabels(PRIORITY_LABELS)} defaultValue="medium" />
      </FormField>

      <FormField label="Data limite" htmlFor={id("dueDate")} error={fieldError(state, "dueDate")}>
        <Input name="dueDate" type="date" />
      </FormField>

      <FormField label="Responsável" htmlFor={id("assigneeId")} error={fieldError(state, "assigneeId")}>
        <NativeSelect
          name="assigneeId"
          options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
          defaultValue={defaultAssigneeId ?? ""}
          placeholder="Sem responsável"
        />
      </FormField>

      {!fixedLink && linkOptions ? (
        <FormField label="Vínculo" htmlFor={id("link")} error={fieldError(state, "link")} className="sm:col-span-2">
          <LinkSelect name="link" options={linkOptions} defaultValue="" />
        </FormField>
      ) : null}

      <FormField label="Descrição" htmlFor={id("description")} error={fieldError(state, "description")} className="sm:col-span-2">
        <Textarea name="description" rows={3} maxLength={5000} />
      </FormField>

      <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
        {secondaryAction}
        <PendingButton pending={pending}>Salvar tarefa</PendingButton>
      </div>
    </form>
  );
}
