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
import { PROCESS_INSTANCE_LABELS, PROCESS_PHASE_LABELS } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import type { ValuesFormState } from "../schemas";
import { STATE_OPTIONS } from "../states";

/** String values of the instance form (money as "1.234,56"). */
export type InstanceDefaults = {
  instance: string;
  court: string;
  courtDivision: string;
  city: string;
  state: string;
  processClass: string;
  phase: string;
  phaseDetail: string;
  claimAmountCents: string;
  liquidatedAmountCents: string;
  isCurrent: boolean;
};

export type InstanceDialogProps<S extends ValuesFormState> = {
  action: (prev: S | null, formData: FormData) => Promise<S>;
  mode: "add" | "edit";
  /** `{ processId }` to add, `{ instanceId }` to edit. */
  hiddenFields: Record<string, string>;
  defaults: InstanceDefaults;
  /** Accessible name of the edit button. */
  instanceLabel?: string;
  /** Imported link: edits are recorded as manual changes. */
  imported?: boolean;
};

const instanceOptions = optionsFromLabels(PROCESS_INSTANCE_LABELS);
const phaseOptions = optionsFromLabels(PROCESS_PHASE_LABELS);

export function InstanceDialog<S extends ValuesFormState>({ mode, instanceLabel, ...rest }: InstanceDialogProps<S>) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {mode === "add" ? (
          <Button type="button" size="sm">
            <Plus aria-hidden="true" />
            Incluir instância
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" aria-label={`Editar o vínculo ${instanceLabel ?? ""}`.trim()}>
            <Pencil aria-hidden="true" />
            Editar
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="lg">
        <InstanceForm {...rest} mode={mode} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function InstanceForm<S extends ValuesFormState>({
  action,
  mode,
  hiddenFields,
  defaults,
  imported,
  onDone,
}: Omit<InstanceDialogProps<S>, "instanceLabel"> & { onDone: () => void }) {
  const [state, formAction] = useActionState(async (prev: S | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) onDone();
    return result;
  }, null);
  // No automatic reset on error: grau, UF and fase stay selected.
  const onSubmit = usePreservingSubmit(formAction);
  const sent = state && !state.ok ? state.values : undefined;
  const val = (key: Exclude<keyof InstanceDefaults, "isCurrent">) => (sent ? (sent[key] ?? "") : defaults[key]);
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{mode === "add" ? "Incluir instância" : "Editar instância"}</DialogTitle>
        <DialogDescription>
          O número CNJ é o mesmo em todos os graus: cada grau é um vínculo deste processo, com o órgão, a fase e os
          valores informados naquela instância. Valor da causa e valor liquidado nunca são somados.
          {imported ? " Este vínculo veio de planilha importada; a alteração fica registrada como edição manual." : ""}
        </DialogDescription>
      </DialogHeader>
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <FormMessage state={state} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Grau" htmlFor="instance-instance" required error={err("instance")}>
          <NativeSelect name="instance" options={instanceOptions} placeholder="Selecione…" required defaultValue={val("instance")} />
        </FormField>
        <FormField label="Tribunal" htmlFor="instance-court" required error={err("court")} hint="Ex.: TRT10, TST.">
          <Input name="court" required maxLength={120} defaultValue={val("court")} />
        </FormField>
        <FormField label="Vara / órgão julgador / turma" htmlFor="instance-courtDivision" error={err("courtDivision")} className="sm:col-span-2">
          <Input name="courtDivision" maxLength={200} defaultValue={val("courtDivision")} />
        </FormField>
        <FormField label="Cidade" htmlFor="instance-city" error={err("city")}>
          <Input name="city" maxLength={120} defaultValue={val("city")} />
        </FormField>
        <FormField label="UF" htmlFor="instance-state" error={err("state")}>
          <NativeSelect name="state" options={STATE_OPTIONS} placeholder="Não informada" defaultValue={val("state")} />
        </FormField>
        <FormField label="Classe" htmlFor="instance-processClass" error={err("processClass")}>
          <Input name="processClass" maxLength={40} defaultValue={val("processClass")} />
        </FormField>
        <FormField label="Fase" htmlFor="instance-phase" error={err("phase")}>
          <NativeSelect name="phase" options={phaseOptions} placeholder="Não informada" defaultValue={val("phase")} />
        </FormField>
        <FormField label="Detalhe da fase" htmlFor="instance-phaseDetail" error={err("phaseDetail")} className="sm:col-span-2">
          <Input name="phaseDetail" maxLength={500} defaultValue={val("phaseDetail")} />
        </FormField>
        <FormField label="Valor da causa nesta instância (R$)" htmlFor="instance-claim" error={err("claimAmountCents")}>
          <Input name="claimAmountCents" inputMode="decimal" placeholder="0,00" defaultValue={val("claimAmountCents")} />
        </FormField>
        <FormField
          label="Valor liquidado / apurado nesta instância (R$)"
          htmlFor="instance-liquidated"
          error={err("liquidatedAmountCents")}
          hint="Em branco = não apurado (diferente de zero)."
        >
          <Input name="liquidatedAmountCents" inputMode="decimal" placeholder="Não apurado" defaultValue={val("liquidatedAmountCents")} />
        </FormField>
        <Checkbox
          id="instance-isCurrent"
          name="isCurrent"
          className="sm:col-span-2"
          defaultChecked={sent ? sent.isCurrent === "on" : defaults.isCurrent}
          label="Instância atual"
          description="O processo tramita agora neste grau (atualiza a “instância atual” do cadastro)."
        />
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancelar
          </Button>
        </DialogClose>
        <SubmitButton>{mode === "add" ? "Incluir" : "Salvar"}</SubmitButton>
      </DialogFooter>
    </form>
  );
}
