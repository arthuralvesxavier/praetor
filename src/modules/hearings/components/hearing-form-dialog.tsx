"use client";

import { CalendarPlus, Pencil } from "lucide-react";
import { useId, useState } from "react";
import { Button, type ButtonVariantProps } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { HEARING_KIND_LABELS, HEARING_MODE_LABELS, type HearingKind, type HearingMode } from "@/domain/enums";
import { fieldError, type FormState } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { PendingButton } from "@/modules/work/components/form-parts";
import { useFormAction } from "@/modules/work/components/use-form-action";
import { createHearingAction, updateHearingAction } from "../actions";

export type HearingFormValues = {
  id: string;
  kind: HearingKind;
  mode: HearingMode;
  /** "YYYY-MM-DD" in America/Sao_Paulo. */
  date: string;
  /** "HH:MM" in America/Sao_Paulo. */
  time: string;
  location: string | null;
  meetingUrl: string | null;
  responsibleId: string | null;
  notes: string | null;
};

type Props = {
  /** Process page: the hearing is linked to this process (hidden field). */
  processId?: string;
  /** Agenda page: ask for the process number instead. */
  askProcessNumber?: boolean;
  users: Option[];
  /** Present when editing. */
  hearing?: HearingFormValues;
  /** Accessible name of the edit trigger (distinct per row). */
  triggerLabel?: string;
  triggerVariant?: ButtonVariantProps["variant"];
  defaultResponsibleId?: string | null;
};

/** "Nova audiência" / "Editar" button + dialog. Closes after a successful save. */
export function HearingFormDialog({
  processId,
  askProcessNumber = false,
  users,
  hearing,
  triggerLabel,
  triggerVariant,
  defaultResponsibleId,
}: Props) {
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(hearing);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {isEdit ? (
          <Button type="button" variant={triggerVariant ?? "ghost"} size="sm" aria-label={triggerLabel ?? "Editar audiência"}>
            <Pencil aria-hidden="true" />
            <span>Editar</span>
          </Button>
        ) : (
          <Button type="button" variant={triggerVariant ?? "primary"}>
            <CalendarPlus aria-hidden="true" />
            {triggerLabel ?? "Nova audiência"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar audiência" : "Nova audiência"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Corrija os dados da audiência designada. Para mudar a data com histórico, use “Redesignar”."
              : "Cadastro manual: informe a data e o horário conforme a intimação ou a pauta publicada. O DataJud não informa a data das audiências, e PJe e MNI não estão integrados nesta versão."}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <HearingForm
            processId={processId}
            askProcessNumber={askProcessNumber}
            users={users}
            hearing={hearing}
            defaultResponsibleId={defaultResponsibleId}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function HearingForm({
  processId,
  askProcessNumber,
  users,
  hearing,
  defaultResponsibleId,
  onDone,
}: Omit<Props, "triggerLabel" | "triggerVariant"> & { onDone: () => void }) {
  const uid = useId();
  const id = (name: string) => `${uid}-audiencia-${name}`;
  const isEdit = Boolean(hearing);
  const action = (isEdit ? updateHearingAction : createHearingAction) as (
    prev: FormState | null,
    formData: FormData,
  ) => Promise<FormState>;
  const { state, pending, formRef, onSubmit } = useFormAction(action, { onSuccess: onDone });
  const [mode, setMode] = useState<HearingMode>(hearing?.mode ?? "in_person");
  const locationRequired = mode !== "virtual";
  const err = (field: string) => fieldError(state, field);

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <FormMessage state={state} className="sm:col-span-2" />
      {hearing ? <input type="hidden" name="id" value={hearing.id} /> : null}
      {!hearing && processId ? <input type="hidden" name="processId" value={processId} /> : null}

      {!hearing && !processId && askProcessNumber ? (
        <FormField
          label="Número do processo"
          htmlFor={id("processNumber")}
          required
          hint="Número CNJ (com ou sem pontuação) de um processo que você pode acessar."
          error={err("processNumber") ?? err("processId")}
          className="sm:col-span-2"
        >
          <Input name="processNumber" required maxLength={60} autoComplete="off" inputMode="numeric" placeholder="0000000-00.0000.0.00.0000" />
        </FormField>
      ) : null}

      <FormField label="Tipo" htmlFor={id("kind")} required error={err("kind")}>
        <NativeSelect
          name="kind"
          required
          options={optionsFromLabels(HEARING_KIND_LABELS)}
          defaultValue={hearing?.kind ?? ""}
          placeholder="Selecione…"
          placeholderDisabled
        />
      </FormField>

      <FormField label="Modalidade" htmlFor={id("mode")} required error={err("mode")}>
        <NativeSelect
          name="mode"
          required
          options={optionsFromLabels(HEARING_MODE_LABELS)}
          value={mode}
          onChange={(e) => setMode(e.currentTarget.value as HearingMode)}
        />
      </FormField>

      <FormField label="Data" htmlFor={id("date")} required error={err("date")}>
        <Input name="date" type="date" required defaultValue={hearing?.date ?? ""} />
      </FormField>

      <FormField label="Horário" htmlFor={id("time")} required error={err("time")} hint="Horário de Brasília.">
        <Input name="time" type="time" required step={60} defaultValue={hearing?.time ?? ""} />
      </FormField>

      <FormField
        label="Local"
        htmlFor={id("location")}
        required={locationRequired}
        error={err("location")}
        hint={locationRequired ? "Fórum, vara e sala." : "Opcional para audiência telepresencial."}
        className="sm:col-span-2"
      >
        <Input name="location" maxLength={300} defaultValue={hearing?.location ?? ""} autoComplete="off" />
      </FormField>

      {mode !== "in_person" ? (
        <FormField
          label="Link da sala virtual"
          htmlFor={id("meetingUrl")}
          error={err("meetingUrl")}
          hint="Informe quando o juízo divulgar o link (https://…)."
          className="sm:col-span-2"
        >
          <Input name="meetingUrl" type="url" maxLength={1000} defaultValue={hearing?.meetingUrl ?? ""} autoComplete="off" />
        </FormField>
      ) : null}

      <FormField label="Responsável" htmlFor={id("responsibleId")} error={err("responsibleId")} className="sm:col-span-2">
        <NativeSelect
          name="responsibleId"
          options={users}
          defaultValue={hearing ? (hearing.responsibleId ?? "") : (defaultResponsibleId ?? "")}
          placeholder="Sem responsável"
        />
      </FormField>

      <FormField label="Observações" htmlFor={id("notes")} error={err("notes")} className="sm:col-span-2">
        <Textarea name="notes" rows={3} maxLength={5000} defaultValue={hearing?.notes ?? ""} />
      </FormField>

      <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancelar
          </Button>
        </DialogClose>
        <PendingButton pending={pending}>{isEdit ? "Salvar alterações" : "Cadastrar audiência"}</PendingButton>
      </div>
    </form>
  );
}
