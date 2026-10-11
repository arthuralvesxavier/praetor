"use client";

import { Pencil, Plus } from "lucide-react";
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
import { OBLIGATION_STATUS_LABELS, type ObligationStatus } from "@/domain/enums";
import { fieldError, type FormState } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { addObligationAction, updateObligationAction } from "../actions";
import { usePreservingSubmit } from "./use-preserving-submit";

export type ObligationFormValues = {
  id: string;
  description: string;
  responsibleId: string | null;
  dueDate: string | null;
  recurrence: string | null;
  status: ObligationStatus;
};

type Props = {
  contractId: string;
  users: Option[];
  /** Present when editing an existing obligation. */
  obligation?: ObligationFormValues;
  /** Accessible name of the edit trigger (distinct per row). */
  triggerLabel?: string;
};

/** Add / edit an obligation in a dialog. Closes itself after a successful save. */
export function ObligationDialog({ contractId, users, obligation, triggerLabel }: Props) {
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(obligation);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {isEdit ? (
          <Button type="button" variant="ghost" size="sm" aria-label={triggerLabel ?? "Editar obrigação"}>
            <Pencil aria-hidden="true" />
            <span className="hidden sm:inline">Editar</span>
          </Button>
        ) : (
          <Button type="button" size="sm">
            <Plus aria-hidden="true" />
            Nova obrigação
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="md">
        {/* Remounted on every open so a previous error does not linger. */}
        <ObligationForm contractId={contractId} users={users} obligation={obligation} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ObligationForm({ contractId, users, obligation, onDone }: Omit<Props, "triggerLabel"> & { onDone: () => void }) {
  const isEdit = Boolean(obligation);
  const action = isEdit ? updateObligationAction : addObligationAction;
  const [state, formAction] = useActionState(async (_prev: FormState | null, formData: FormData): Promise<FormState> => {
    const result = await action(null, formData);
    if (result.ok) onDone();
    return result;
  }, null);
  const onSubmit = usePreservingSubmit(formAction);
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{isEdit ? "Editar obrigação" : "Nova obrigação contratual"}</DialogTitle>
        <DialogDescription>
          Registre o que deve ser cumprido, por quem e até quando. A recorrência é apenas descritiva (ex.: &quot;mensal&quot;).
        </DialogDescription>
      </DialogHeader>
      {obligation ? (
        <input type="hidden" name="id" value={obligation.id} />
      ) : (
        <input type="hidden" name="contractId" value={contractId} />
      )}
      <FormMessage state={state} />
      <FormField label="Descrição" htmlFor="obligation-description" required error={err("description")}>
        <Textarea
          name="description"
          rows={3}
          maxLength={2000}
          required
          defaultValue={obligation?.description ?? ""}
          autoFocus
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Responsável" htmlFor="obligation-responsible" error={err("responsibleId")}>
          <NativeSelect
            name="responsibleId"
            options={users}
            placeholder="Sem responsável"
            defaultValue={obligation?.responsibleId ?? ""}
          />
        </FormField>
        <FormField label="Vencimento" htmlFor="obligation-due" error={err("dueDate")}>
          <Input name="dueDate" type="date" defaultValue={obligation?.dueDate ?? ""} />
        </FormField>
        <FormField label="Recorrência" htmlFor="obligation-recurrence" hint="Ex.: mensal, trimestral, anual." error={err("recurrence")}>
          <Input name="recurrence" maxLength={120} defaultValue={obligation?.recurrence ?? ""} />
        </FormField>
        <FormField label="Situação" htmlFor="obligation-status" error={err("status")}>
          <NativeSelect
            name="status"
            options={optionsFromLabels(OBLIGATION_STATUS_LABELS)}
            defaultValue={obligation?.status ?? "pending"}
          />
        </FormField>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancelar
          </Button>
        </DialogClose>
        <SubmitButton>{isEdit ? "Salvar alterações" : "Adicionar obrigação"}</SubmitButton>
      </DialogFooter>
    </form>
  );
}
