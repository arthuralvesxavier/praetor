"use client";

import { Link2 } from "lucide-react";
import { useActionState } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { fieldError } from "@/lib/form";
import type { Option } from "@/lib/options";
import { linkOccurrenceToProcessAction } from "../actions";

/** Select an existing (visible) process and link the occurrence to it. */
export function ProcessLinkForm({ occurrenceId, processes }: { occurrenceId: string; processes: Option[] }) {
  const [state, formAction] = useActionState(linkOccurrenceToProcessAction, null);
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="occurrenceId" value={occurrenceId} />
      <FormMessage state={state} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <FormField label="Processo existente" htmlFor="processId" required error={fieldError(state, "processId")} className="flex-1">
          <NativeSelect name="processId" options={processes} placeholder="Selecione um processo…" defaultValue="" required />
        </FormField>
        <SubmitButton pendingLabel="Vinculando…" className="sm:mb-px">
          <Link2 aria-hidden="true" />
          Vincular
        </SubmitButton>
      </div>
      <p className="text-xs text-muted-foreground">
        Ao vincular, a situação da ocorrência passa a ser “Convertida em processo” e as análises de IA existentes ficam
        marcadas como desatualizadas.
      </p>
    </form>
  );
}
