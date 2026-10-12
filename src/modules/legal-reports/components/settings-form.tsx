"use client";

import { useActionState } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { PROBABILITY_BAND_LABELS, PROBABILITY_BANDS, type ProbabilityBand } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { updateLegalReportSettingsAction } from "../actions";

export type LegalReportSettingsValues = {
  confidenceThreshold: number;
  bands: Record<ProbabilityBand, { min: number; max: number }>;
  legalBasisText: string;
};

/** Parâmetros dos relatórios jurídicos (admin:organization). */
export function LegalReportSettingsForm({ values }: { values: LegalReportSettingsValues }) {
  const [state, action] = useActionState(updateLegalReportSettingsAction, null);
  const onSubmit = usePreservingSubmit(action);
  const bandsError = fieldError(state, "bands");
  return (
    <form action={action} onSubmit={onSubmit} className="grid gap-6">
      <FormMessage state={state} />
      <FormField
        label="Limite de confiança para afirmar um item"
        htmlFor="confidenceThreshold"
        required
        hint="De 0 a 100. Itens com confiança abaixo deste valor não são afirmados: vão para “Pendências do relatório”."
        error={fieldError(state, "confidenceThreshold")}
      >
        <Input name="confidenceThreshold" type="number" min={0} max={100} step={1} required defaultValue={values.confidenceThreshold} className="max-w-32" />
      </FormField>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium text-foreground">Faixas de probabilidade dos cenários (%)</legend>
        <p className="text-xs text-muted-foreground">
          Da mais alta para a mais baixa, sem sobreposição (os limites podem se tocar). Relatórios já emitidos guardam as faixas usadas.
        </p>
        {bandsError ? (
          <p role="alert" className="text-sm text-red-700">
            {bandsError}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PROBABILITY_BANDS.map((band) => (
            <div key={band} className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium">{PROBABILITY_BAND_LABELS[band]}</p>
              <div className="grid grid-cols-2 gap-2">
                <FormField label={<>Mínimo<span className="sr-only"> da faixa {PROBABILITY_BAND_LABELS[band]}</span></>} htmlFor={`band_${band}_min`} required>
                  <Input name={`band_${band}_min`} type="number" min={0} max={100} step={1} required defaultValue={values.bands[band].min} />
                </FormField>
                <FormField label={<>Máximo<span className="sr-only"> da faixa {PROBABILITY_BAND_LABELS[band]}</span></>} htmlFor={`band_${band}_max`} required>
                  <Input name={`band_${band}_max`} type="number" min={0} max={100} step={1} required defaultValue={values.bands[band].max} />
                </FormField>
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      <FormField
        label="Base legal do tratamento de dados (LGPD)"
        htmlFor="legalBasisText"
        required
        hint="Texto citado na capa de todo relatório."
        error={fieldError(state, "legalBasisText")}
      >
        <Textarea name="legalBasisText" rows={3} required minLength={10} maxLength={500} defaultValue={values.legalBasisText} />
      </FormField>
      <div>
        <SubmitButton>Salvar parâmetros</SubmitButton>
      </div>
    </form>
  );
}
