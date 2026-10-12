"use client";

import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { formatNumber } from "@/lib/format";
import { CONTINGENCY_BOUNDS, type ContingencySettingsInput } from "../schemas";
import { PendingButton, useAdminForm, type FormAction } from "./form-utils";

type Values = Required<ContingencySettingsInput>;

/**
 * Contingency parameters. Changing a risk percentage creates a new rules
 * version (RNF-14): assessments and monthly closings already recorded keep the
 * version — and the percentages — they used.
 */
export function ContingencySettingsForm<S extends FormState>({
  action,
  defaults,
  rulesVersion,
}: {
  action: FormAction<S>;
  defaults: Values;
  rulesVersion: number;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const err = (f: string) => fieldError(state, f);

  const numberField = (
    key: keyof Values,
    label: string,
    bounds: { min: number; max: number },
    unit: string,
    hint?: string,
  ) => (
    <FormField
      label={label}
      htmlFor={key}
      required
      error={err(key)}
      hint={`Entre ${formatNumber(bounds.min)} e ${formatNumber(bounds.max)} ${unit}.${hint ? ` ${hint}` : ""}`}
    >
      <Input
        name={key}
        type="number"
        inputMode="numeric"
        step={1}
        min={bounds.min}
        max={bounds.max}
        defaultValue={defaults[key]}
        required
      />
    </FormField>
  );

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle id="contingencias-titulo">Contingências</CardTitle>
          <CardDescription>
            Percentual aplicado sobre a base de provisão de cada classificação de risco (remota, possível, provável), confiança
            mínima para conferência em lote de valores extraídos e prazo para alertar depósitos e garantias parados.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FormMessage state={state} />
          <Callout tone="info" title={`Regras de risco em vigor: versão ${formatNumber(rulesVersion)}`}>
            Alterar qualquer percentual cria uma nova versão das regras. Classificações e fechamentos mensais já registrados
            continuam com a versão e os percentuais que usaram, para que relatórios anteriores possam ser reproduzidos. A
            alteração fica registrada na auditoria com os valores anteriores e novos.
          </Callout>
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-medium text-slate-800">Percentual de provisão por classificação (%)</legend>
            {numberField("riskRemote", "Remota", CONTINGENCY_BOUNDS.riskPercent, "%")}
            {numberField("riskPossible", "Possível", CONTINGENCY_BOUNDS.riskPercent, "%")}
            {numberField("riskProbable", "Provável", CONTINGENCY_BOUNDS.riskPercent, "%")}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            Os percentuais devem crescer de “remota” para “provável”. Provisão = base (valor liquidado líquido de garantias ou,
            sem liquidação, valor da causa como estimativa) × percentual da classificação vigente.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField(
              "confidenceThreshold",
              "Confiança mínima para conferência em lote (%)",
              CONTINGENCY_BOUNDS.confidenceThreshold,
              "%",
              "Abaixo dela, cada valor proposto precisa ser conferido individualmente.",
            )}
            {numberField(
              "idleGuaranteeDays",
              "Garantia parada após (dias)",
              CONTINGENCY_BOUNDS.idleGuaranteeDays,
              "dias",
              "Garantias vinculadas sem alteração há mais tempo geram alerta.",
            )}
          </div>
          <div>
            <PendingButton pending={pending}>Salvar parâmetros de contingência</PendingButton>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
