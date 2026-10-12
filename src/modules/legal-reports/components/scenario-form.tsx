"use client";

import { useActionState } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { PROBABILITY_BAND_LABELS, PROBABILITY_BANDS, type ProbabilityBand } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { addProcessScenarioAction } from "../actions";

/** Registro de um cenário (append-only): faixa e percentuais dentro da faixa configurada. */
export function ScenarioForm({
  processId,
  bands,
}: {
  processId: string;
  bands: Record<ProbabilityBand, { min: number; max: number }>;
}) {
  const [state, action] = useActionState(addProcessScenarioAction, null);
  const onSubmit = usePreservingSubmit(action);
  return (
    <form action={action} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="processId" value={processId} />
      <FormMessage state={state} className="sm:col-span-2" />
      <FormField label="Cenário" htmlFor="scenario-description" required error={fieldError(state, "description")} className="sm:col-span-2">
        <Textarea name="description" rows={2} required minLength={5} maxLength={1000} />
      </FormField>
      <FormField label="Faixa de probabilidade" htmlFor="scenario-band" required error={fieldError(state, "probabilityBand")}>
        <NativeSelect
          name="probabilityBand"
          required
          placeholder="Escolha a faixa…"
          options={PROBABILITY_BANDS.map((b) => ({
            value: b,
            label: `${PROBABILITY_BAND_LABELS[b]} (${bands[b].min}% a ${bands[b].max}%)`,
          }))}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Mínimo (%)" htmlFor="scenario-min" hint="Vazio = mínimo da faixa." error={fieldError(state, "percentMin")}>
          <Input name="percentMin" type="number" min={0} max={100} step={1} />
        </FormField>
        <FormField label="Máximo (%)" htmlFor="scenario-max" hint="Vazio = máximo da faixa." error={fieldError(state, "percentMax")}>
          <Input name="percentMax" type="number" min={0} max={100} step={1} />
        </FormField>
      </div>
      <FormField label="Comentário" htmlFor="scenario-comment" error={fieldError(state, "comment")} className="sm:col-span-2">
        <Textarea name="comment" rows={2} maxLength={2000} />
      </FormField>
      <div className="sm:col-span-2">
        <SubmitButton>Registrar cenário</SubmitButton>
      </div>
    </form>
  );
}
