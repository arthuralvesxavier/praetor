"use client";

import { Pencil, Plus } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { LIABILITY_NATURE_LABELS, PARTY_ROLE_LABELS } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { formatDocument } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import type { ValuesFormState } from "../schemas";

export type PartyDefaults = {
  name: string;
  role: string;
  documentNumber: string | null;
  isClient: boolean;
  liabilityNature: string | null;
  counselName: string | null;
};

export type PartyDialogProps<S extends ValuesFormState> = {
  action: (prev: S | null, formData: FormData) => Promise<S>;
  mode: "add" | "edit";
  /** Hidden fields: `{ processId }` to add, `{ partyId }` to edit. */
  hiddenFields: Record<string, string>;
  defaults?: PartyDefaults;
  /** Used in the edit button's accessible name. */
  partyName?: string;
};

const roleOptions = optionsFromLabels(PARTY_ROLE_LABELS);
const liabilityOptions = optionsFromLabels(LIABILITY_NATURE_LABELS);

export function PartyDialog<S extends ValuesFormState>({ mode, partyName, ...rest }: PartyDialogProps<S>) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {mode === "add" ? (
          <Button type="button" size="sm">
            <Plus aria-hidden="true" />
            Adicionar parte
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" aria-label={`Editar a parte ${partyName ?? ""}`.trim()}>
            <Pencil aria-hidden="true" />
            Editar
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="md">
        <PartyForm {...rest} mode={mode} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PartyForm<S extends ValuesFormState>({
  action,
  mode,
  hiddenFields,
  defaults,
  onDone,
}: Omit<PartyDialogProps<S>, "partyName"> & { onDone: () => void }) {
  const [state, formAction] = useActionState(async (prev: S | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) onDone();
    return result;
  }, null);
  // No automatic reset on error: the chosen polo and responsibility stay selected.
  const onSubmit = usePreservingSubmit(formAction);
  const sent = state && !state.ok ? state.values : undefined;
  const val = (key: "name" | "role" | "documentNumber" | "counselName" | "liabilityNature", fallback: string) =>
    sent ? (sent[key] ?? "") : fallback;
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{mode === "add" ? "Adicionar parte" : "Editar parte"}</DialogTitle>
        <DialogDescription>
          CPF e CNPJ são dados pessoais/cadastrais: aparecem mascarados nas listagens e nas exportações.
        </DialogDescription>
      </DialogHeader>
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <FormMessage state={state} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Nome" htmlFor="party-name" required error={err("name")} className="sm:col-span-2">
          <Input name="name" defaultValue={val("name", defaults?.name ?? "")} required maxLength={200} autoComplete="off" />
        </FormField>
        <FormField label="Polo" htmlFor="party-role" required error={err("role")}>
          <NativeSelect
            name="role"
            options={roleOptions}
            placeholder="Selecione…"
            defaultValue={val("role", defaults?.role ?? "")}
            required
          />
        </FormField>
        <FormField label="CPF / CNPJ" htmlFor="party-document" error={err("documentNumber")} hint="Opcional. Somente números ou com pontuação.">
          <Input
            name="documentNumber"
            inputMode="numeric"
            autoComplete="off"
            maxLength={30}
            defaultValue={val("documentNumber", defaults?.documentNumber ? formatDocument(defaults.documentNumber) : "")}
          />
        </FormField>
        <FormField
          label="Natureza da responsabilidade"
          htmlFor="party-liabilityNature"
          error={err("liabilityNature")}
          hint="Somente para o polo passivo (direta, solidária ou subsidiária). Análise jurídica, opcional."
        >
          <NativeSelect
            name="liabilityNature"
            options={liabilityOptions}
            placeholder="Não informada"
            defaultValue={val("liabilityNature", defaults?.liabilityNature ?? "")}
          />
        </FormField>
        <FormField label="Advogado(a) da parte" htmlFor="party-counsel" error={err("counselName")}>
          <Input name="counselName" defaultValue={val("counselName", defaults?.counselName ?? "")} maxLength={200} />
        </FormField>
        <Checkbox
          id="party-isClient"
          name="isClient"
          className="sm:col-span-2"
          defaultChecked={sent ? sent.isClient === "on" : (defaults?.isClient ?? false)}
          label="É a própria organização / cliente"
          description="Marque quando a parte for a empresa representada pelo departamento jurídico."
        />
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancelar
          </Button>
        </DialogClose>
        <SubmitButton>{mode === "add" ? "Adicionar" : "Salvar"}</SubmitButton>
      </DialogFooter>
    </form>
  );
}
