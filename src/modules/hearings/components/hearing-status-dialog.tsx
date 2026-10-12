"use client";

import { CalendarClock, CheckCircle2, XCircle } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
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
import { HEARING_MODE_LABELS, type HearingMode } from "@/domain/enums";
import { fieldError, type FormState } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import { PendingButton } from "@/modules/work/components/form-parts";
import { useFormAction } from "@/modules/work/components/use-form-action";
import { setHearingStatusAction } from "../actions";

export type HearingStatusTarget = "held" | "cancelled" | "rescheduled";

type Props = {
  hearingId: string;
  /** e.g. "Instrução em 12/11/2026 às 14:00" — used in titles and accessible names. */
  hearingLabel: string;
  target: HearingStatusTarget;
  current: { mode: HearingMode; location: string | null; meetingUrl: string | null };
  /** Date has not arrived yet: "Registrar resultado" is disabled with an explanation. */
  disabled?: boolean;
  disabledReason?: string;
};

const TRIGGERS: Record<HearingStatusTarget, { label: string; icon: ReactNode }> = {
  held: { label: "Registrar resultado", icon: <CheckCircle2 aria-hidden="true" /> },
  rescheduled: { label: "Redesignar", icon: <CalendarClock aria-hidden="true" /> },
  cancelled: { label: "Cancelar", icon: <XCircle aria-hidden="true" /> },
};

const TITLES: Record<HearingStatusTarget, string> = {
  held: "Registrar resultado da audiência",
  rescheduled: "Redesignar audiência",
  cancelled: "Cancelar audiência",
};

const DESCRIPTIONS: Record<HearingStatusTarget, string> = {
  held: "Descreva o que aconteceu (acordo, instrução encerrada, nova data para julgamento etc.). O registro fica no histórico do processo.",
  rescheduled:
    "A audiência atual fica registrada como redesignada e uma nova audiência é cadastrada com a nova data. As duas ficam no histórico.",
  cancelled: "A audiência deixa de constar na agenda e o alerta de audiência próxima é encerrado. O cancelamento fica no histórico.",
};

/** Status change of a scheduled hearing (held / rescheduled / cancelled) in a dialog. */
export function HearingStatusDialog({ hearingId, hearingLabel, target, current, disabled = false, disabledReason }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = TRIGGERS[target];
  if (disabled) {
    return (
      <Button type="button" variant="ghost" size="sm" disabled aria-disabled="true" title={disabledReason}>
        {trigger.icon}
        <span>{trigger.label}</span>
        {disabledReason ? <span className="sr-only"> — {disabledReason}</span> : null}
      </Button>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={target === "cancelled" ? "ghost" : "outline"}
          size="sm"
          aria-label={`${trigger.label}: ${hearingLabel}`}
        >
          {trigger.icon}
          <span>{trigger.label}</span>
        </Button>
      </DialogTrigger>
      <DialogContent size={target === "rescheduled" ? "lg" : "md"}>
        <DialogHeader>
          <DialogTitle>{TITLES[target]}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-slate-800">{hearingLabel}.</span> {DESCRIPTIONS[target]}
          </DialogDescription>
        </DialogHeader>
        {open ? <StatusForm hearingId={hearingId} target={target} current={current} onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function StatusForm({
  hearingId,
  target,
  current,
  onDone,
}: Pick<Props, "hearingId" | "target" | "current"> & { onDone: () => void }) {
  const uid = useId();
  const id = (name: string) => `${uid}-status-${name}`;
  const { state, pending, formRef, onSubmit } = useFormAction(
    setHearingStatusAction as (prev: FormState | null, formData: FormData) => Promise<FormState>,
    { onSuccess: onDone },
  );
  const [mode, setMode] = useState<HearingMode>(current.mode);
  const err = (field: string) => fieldError(state, field);

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <FormMessage state={state} className="sm:col-span-2" />
      <input type="hidden" name="id" value={hearingId} />
      <input type="hidden" name="status" value={target} />

      {target === "held" ? (
        <FormField label="Resultado" htmlFor={id("outcome")} required error={err("outcome")} className="sm:col-span-2">
          <Textarea name="outcome" rows={5} required maxLength={5000} autoFocus />
        </FormField>
      ) : null}

      {target === "cancelled" ? (
        <FormField label="Motivo do cancelamento" htmlFor={id("reason")} error={err("reason")} className="sm:col-span-2">
          <Textarea name="reason" rows={3} maxLength={2000} autoFocus />
        </FormField>
      ) : null}

      {target === "rescheduled" ? (
        <>
          <FormField label="Nova data" htmlFor={id("date")} required error={err("date")}>
            <Input name="date" type="date" required autoFocus />
          </FormField>
          <FormField label="Novo horário" htmlFor={id("time")} required error={err("time")} hint="Horário de Brasília.">
            <Input name="time" type="time" required step={60} />
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
          <FormField
            label="Local"
            htmlFor={id("location")}
            required={mode !== "virtual"}
            error={err("location")}
            hint={mode === "virtual" ? "Opcional para audiência telepresencial." : undefined}
          >
            <Input name="location" maxLength={300} defaultValue={current.location ?? ""} autoComplete="off" />
          </FormField>
          {mode !== "in_person" ? (
            <FormField label="Link da sala virtual" htmlFor={id("meetingUrl")} error={err("meetingUrl")} className="sm:col-span-2">
              <Input name="meetingUrl" type="url" maxLength={1000} defaultValue={current.meetingUrl ?? ""} autoComplete="off" />
            </FormField>
          ) : null}
          <FormField label="Motivo da redesignação" htmlFor={id("reason")} error={err("reason")} className="sm:col-span-2">
            <Textarea name="reason" rows={2} maxLength={2000} />
          </FormField>
        </>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Voltar
          </Button>
        </DialogClose>
        <PendingButton
          pending={pending}
          variant={target === "cancelled" ? "destructive" : "primary"}
          pendingLabel="Registrando…"
        >
          {target === "held" ? "Registrar resultado" : target === "cancelled" ? "Cancelar audiência" : "Redesignar"}
        </PendingButton>
      </div>
    </form>
  );
}
