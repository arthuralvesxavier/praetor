"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { formatNumber } from "@/lib/format";
import { SETTINGS_BOUNDS, type OrganizationSettingsInput } from "../schemas";
import { PendingButton, useAdminForm, type FormAction } from "./form-utils";

type NumericKey = keyof typeof SETTINGS_BOUNDS;

function range(key: NumericKey, unit: string) {
  const b = SETTINGS_BOUNDS[key];
  return `Entre ${formatNumber(b.min)} e ${formatNumber(b.max)} ${unit}.`;
}

/** Organization name, AI limits, alert thresholds and retention periods. */
export function OrganizationSettingsForm<S extends FormState>({
  action,
  defaults,
}: {
  action: FormAction<S>;
  defaults: Required<OrganizationSettingsInput>;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const err = (f: string) => fieldError(state, f);

  const numberField = (key: NumericKey, label: string, unit: string, extraHint?: string) => (
    <FormField
      label={label}
      htmlFor={key}
      required
      error={err(key)}
      hint={extraHint ? `${range(key, unit)} ${extraHint}` : range(key, unit)}
    >
      <Input
        name={key}
        type="number"
        inputMode="numeric"
        step={1}
        min={SETTINGS_BOUNDS[key].min}
        max={SETTINGS_BOUNDS[key].max}
        defaultValue={defaults[key]}
        required
      />
    </FormField>
  );

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <FormMessage state={state} />

      <Card>
        <CardHeader>
          <CardTitle>Organização</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label="Nome da organização" htmlFor="name" required error={err("name")}>
            <Input name="name" defaultValue={defaults.name} maxLength={120} required />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Limites de uso da IA</CardTitle>
          <CardDescription>
            O limite mensal vale para chamadas reais ao provedor de IA. Com limite 0, novas análises por IA ficam bloqueadas.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {numberField("monthlyTokenBudget", "Limite mensal de tokens", "tokens", "Soma de tokens de entrada e saída.")}
          {numberField(
            "maxInputChars",
            "Máximo de caracteres por análise",
            "caracteres",
            "Textos maiores são cortados e a análise informa a limitação.",
          )}
          <Checkbox
            name="autoAnalyzeOnUpload"
            className="sm:col-span-2"
            label="Analisar documentos automaticamente ao enviar"
            description="Coloca um resumo na fila quando um novo documento ou versão tem o texto extraído. O resultado sempre exige revisão humana."
            defaultChecked={defaults.autoAnalyzeOnUpload}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alertas</CardTitle>
          <CardDescription>Antecedência usada pelas rotinas de alertas e pelos indicadores do painel executivo.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {numberField("upcomingDeadlineDays", "Prazos próximos (dias)", "dias")}
          {numberField("contractExpirationDays", "Contratos a vencer (dias)", "dias")}
          {numberField("upcomingHearingDays", "Audiências próximas (dias)", "dias", "Também define a janela de “próximas audiências” do painel.")}
          {numberField("installmentDueDays", "Parcelas de acordo a vencer (dias)", "dias")}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retenção de dados</CardTitle>
          <CardDescription>
            Prazos usados pela rotina de revisão de retenção. Nesta versão nenhum dado é excluído automaticamente: a rotina
            apenas relata os registros elegíveis para revisão.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {numberField("closedRecordRetentionDays", "Registros encerrados (dias)", "dias", "Contados a partir do encerramento.")}
          {numberField("auditLogRetentionDays", "Trilha de auditoria (dias)", "dias")}
        </CardContent>
      </Card>

      <div>
        <PendingButton pending={pending}>Salvar configurações</PendingButton>
      </div>
    </form>
  );
}
