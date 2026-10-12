"use client";

import { CalendarPlus, FileX2 } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { addDaysISO, formatDate } from "@/lib/format";
import { fieldError, type FormState } from "@/lib/form";
import type { Option } from "@/lib/options";
import { renewContractAction, terminateContractAction } from "../actions";
import { usePreservingSubmit } from "./use-preserving-submit";

type DocumentsProps = {
  /** Documents linked to the contract that the user can see. */
  documents: Option[];
};

function DocumentField({
  id,
  name,
  label,
  documents,
  error,
}: DocumentsProps & { id: string; name: string; label: string; error?: string }) {
  return (
    <FormField
      label={label}
      htmlFor={id}
      hint={
        documents.length === 0
          ? "Nenhum documento vinculado a este contrato. Envie o arquivo na aba “Documentos e versões” para poder vinculá-lo."
          : "Somente documentos já vinculados a este contrato."
      }
      error={error}
    >
      <NativeSelect name={name} options={documents} placeholder="Nenhum documento" defaultValue="" disabled={documents.length === 0} />
    </FormField>
  );
}

/** "Registrar renovação": new end date + optional aditivo. */
export function RenewContractDialog({
  contractId,
  currentEndDate,
  documents,
}: DocumentsProps & { contractId: string; currentEndDate: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <CalendarPlus aria-hidden="true" />
          Registrar renovação
        </Button>
      </DialogTrigger>
      <DialogContent size="md">
        <RenewForm contractId={contractId} currentEndDate={currentEndDate} documents={documents} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RenewForm({
  contractId,
  currentEndDate,
  documents,
  onDone,
}: DocumentsProps & { contractId: string; currentEndDate: string; onDone: () => void }) {
  const [state, formAction] = useActionState(async (_prev: FormState | null, formData: FormData): Promise<FormState> => {
    const result = await renewContractAction(null, formData);
    if (result.ok) onDone();
    return result;
  }, null);
  const onSubmit = usePreservingSubmit(formAction);
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Registrar renovação</DialogTitle>
        <DialogDescription>
          O término atual é {formatDate(currentEndDate)}. Informe o novo término conforme o aditivo; a data-limite para aviso
          será recalculada a partir dele. A renovação fica registrada no histórico do contrato.
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={contractId} />
      <FormMessage state={state} />
      <FormField label="Novo término da vigência" htmlFor="renew-end" required error={err("newEndDate")}>
        <Input name="newEndDate" type="date" required min={addDaysISO(currentEndDate, 1)} autoFocus />
      </FormField>
      <DocumentField
        id="renew-document"
        name="amendmentDocumentId"
        label="Aditivo (documento)"
        documents={documents}
        error={err("amendmentDocumentId")}
      />
      <FormField label="Observação" htmlFor="renew-note" hint="Opcional. Ex.: renovação por 12 meses com reajuste." error={err("note")}>
        <Textarea name="note" rows={2} maxLength={500} />
      </FormField>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancelar
          </Button>
        </DialogClose>
        <SubmitButton pendingLabel="Registrando…">Registrar renovação</SubmitButton>
      </DialogFooter>
    </form>
  );
}

/** "Registrar rescisão": effective date + optional distrato/notificação. */
export function TerminateContractDialog({
  contractId,
  today,
  openObligations,
  documents,
}: DocumentsProps & { contractId: string; today: string; openObligations: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <FileX2 aria-hidden="true" />
          Registrar rescisão
        </Button>
      </DialogTrigger>
      <DialogContent size="md">
        <TerminateForm
          contractId={contractId}
          today={today}
          openObligations={openObligations}
          documents={documents}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function TerminateForm({
  contractId,
  today,
  openObligations,
  documents,
  onDone,
}: DocumentsProps & { contractId: string; today: string; openObligations: number; onDone: () => void }) {
  const [state, formAction] = useActionState(async (_prev: FormState | null, formData: FormData): Promise<FormState> => {
    const result = await terminateContractAction(null, formData);
    if (result.ok) onDone();
    return result;
  }, null);
  const onSubmit = usePreservingSubmit(formAction);
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Registrar rescisão</DialogTitle>
        <DialogDescription>
          O contrato passará para “Rescindido” e o término da vigência será a data de efeito informada. A rescisão fica
          registrada no histórico do contrato.
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={contractId} />
      <FormMessage state={state} />
      {openObligations > 0 ? (
        <p role="note" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {openObligations === 1
            ? "Há 1 obrigação em aberto. Ela continua registrada: cumpra-a ou dispense-a na aba “Obrigações”."
            : `Há ${openObligations} obrigações em aberto. Elas continuam registradas: cumpra-as ou dispense-as na aba “Obrigações”.`}
        </p>
      ) : null}
      <FormField label="Data de efeito da rescisão" htmlFor="terminate-date" required error={err("terminationDate")}>
        <Input name="terminationDate" type="date" required defaultValue={today} autoFocus />
      </FormField>
      <DocumentField
        id="terminate-document"
        name="documentId"
        label="Distrato ou notificação (documento)"
        documents={documents}
        error={err("documentId")}
      />
      <FormField label="Observação" htmlFor="terminate-note" hint="Opcional. Ex.: rescisão por iniciativa da contratante." error={err("note")}>
        <Textarea name="note" rows={2} maxLength={500} />
      </FormField>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancelar
          </Button>
        </DialogClose>
        <SubmitButton variant="destructive" pendingLabel="Registrando…">
          Registrar rescisão
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}
