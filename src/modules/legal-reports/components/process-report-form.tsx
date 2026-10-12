"use client";

import { useActionState } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { fieldError } from "@/lib/form";
import { generateProcessReportAction } from "../actions";

/**
 * "Gerar R1" na lista de relatórios jurídicos: escolha o processo na lista dos
 * recentes ou informe o número (com ou sem pontuação). Com R1 vigente, gera a
 * versão seguinte dele.
 */
export function ProcessReportForm({ processes }: { processes: { id: string; number: string; title: string }[] }) {
  const [state, action] = useActionState(generateProcessReportAction, null);
  const onSubmit = usePreservingSubmit(action);
  return (
    <form action={action} onSubmit={onSubmit} className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
      <FormMessage state={state} className="md:col-span-3" />
      <FormField label="Processo recente" htmlFor="r1-process" hint="Processos ativos que você pode ver.">
        <NativeSelect
          id="r1-process"
          name="processId"
          options={processes.map((p) => ({ value: p.id, label: `${p.number} · ${p.title.slice(0, 60)}` }))}
          placeholder="Escolha um processo…"
        />
      </FormField>
      <FormField
        label="Ou informe o número"
        htmlFor="r1-number"
        hint="Usado quando nenhum processo é escolhido na lista."
        error={fieldError(state, "processNumber")}
      >
        <Input id="r1-number" name="processNumber" placeholder="0000000-00.0000.0.00.0000" autoComplete="off" />
      </FormField>
      <SubmitButton pendingLabel="Gerando PDF…">Gerar R1</SubmitButton>
    </form>
  );
}
