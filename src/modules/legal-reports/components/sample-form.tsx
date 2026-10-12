"use client";

import { useActionState } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { fieldError } from "@/lib/form";
import { generateEngineSampleAction } from "../actions";

/**
 * Gera o "Documento de teste do motor" para um processo visível: escolha na
 * lista dos processos recentes ou informe o número (com ou sem pontuação).
 */
export function EngineSampleForm({ processes }: { processes: { id: string; number: string; title: string }[] }) {
  const [state, action] = useActionState(generateEngineSampleAction, null);
  const onSubmit = usePreservingSubmit(action);
  return (
    <form action={action} onSubmit={onSubmit} className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
      <FormMessage state={state} className="md:col-span-3" />
      <FormField label="Processo recente" htmlFor="sample-process" hint="Processos ativos que você pode ver.">
        <NativeSelect
          name="processId"
          options={processes.map((p) => ({ value: p.id, label: `${p.number} · ${p.title.slice(0, 60)}` }))}
          placeholder="Escolha um processo…"
        />
      </FormField>
      <FormField
        label="Ou informe o número"
        htmlFor="sample-number"
        hint="Usado quando nenhum processo é escolhido na lista."
        error={fieldError(state, "processNumber")}
      >
        <Input name="processNumber" placeholder="0000000-00.0000.0.00.0000" autoComplete="off" />
      </FormField>
      <SubmitButton pendingLabel="Gerando PDF…">Gerar documento de teste</SubmitButton>
    </form>
  );
}
