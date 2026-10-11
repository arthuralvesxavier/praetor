"use client";

import { useActionState, useState, type ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  LEGAL_AREA_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  RISK_LEVEL_LABELS,
} from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { isCnjNumberFormat, type ProcessFormDefaults, type ValuesFormState } from "../schemas";

export type ProcessFormProps<S extends ValuesFormState> = {
  action: (prev: S | null, formData: FormData) => Promise<S>;
  mode: "create" | "edit";
  /** Required in edit mode (sent as hidden field `id`). */
  processId?: string;
  defaults: ProcessFormDefaults;
  units: readonly Option[];
  users: readonly Option[];
  canEditConfidential: boolean;
  /** When creating from a preventive occurrence. */
  fromOccurrence?: { id: string; title: string } | null;
  cancelHref: string;
};

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="grid grid-cols-1 gap-4 border-t border-border pt-5 first-of-type:border-t-0 first-of-type:pt-0 sm:grid-cols-2">
      <legend className="sr-only">{title}</legend>
      <div className="sm:col-span-2">
        <h2 aria-hidden="true" className="text-sm font-semibold text-slate-900">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </fieldset>
  );
}

const areaOptions = optionsFromLabels(LEGAL_AREA_LABELS);
const phaseOptions = optionsFromLabels(PROCESS_PHASE_LABELS);
const statusOptions = optionsFromLabels(PROCESS_STATUS_LABELS);
const riskOptions = optionsFromLabels(RISK_LEVEL_LABELS);
const lossOptions = optionsFromLabels(LOSS_PROBABILITY_LABELS);

export function ProcessForm<S extends ValuesFormState>({
  action,
  mode,
  processId,
  defaults,
  units,
  users,
  canEditConfidential,
  fromOccurrence,
  cancelHref,
}: ProcessFormProps<S>) {
  const [state, formAction] = useActionState(action, null);
  // After a failed submit React resets the form; re-fill it with what was sent.
  const sent = state && !state.ok ? state.values : undefined;
  const val = (key: Exclude<keyof ProcessFormDefaults, "isConfidential">): string =>
    sent ? (sent[key] ?? "") : defaults[key];
  const confidential = sent ? sent.isConfidential === "on" : defaults.isConfidential;

  const [numberDraft, setNumberDraft] = useState<string | null>(null);
  const numberValue = numberDraft ?? val("number");
  const outOfCnj = numberValue.trim() !== "" && !isCnjNumberFormat(numberValue);
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {mode === "edit" && processId ? <input type="hidden" name="id" value={processId} /> : null}
      {fromOccurrence ? <input type="hidden" name="fromOccurrenceId" value={fromOccurrence.id} /> : null}
      <FormMessage state={state} />
      {err("fromOccurrenceId") ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {err("fromOccurrenceId")}
        </p>
      ) : null}

      <Section title="Identificação">
        <FormField
          label="Número do processo"
          htmlFor="number"
          required
          error={err("number")}
          hint={
            outOfCnj ? (
              <span className="font-medium text-amber-800">
                Fora do padrão CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO). O número será salvo como informado.
              </span>
            ) : (
              "Padrão CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO. Outros formatos são aceitos e sinalizados."
            )
          }
        >
          <Input
            name="number"
            defaultValue={val("number")}
            required
            maxLength={60}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder="0000000-00.0000.0.00.0000"
            onChange={(e) => setNumberDraft(e.currentTarget.value)}
          />
        </FormField>
        <FormField label="Título" htmlFor="title" required error={err("title")} hint="Identificação interna, ex.: “Reclamação trabalhista — ex-colaborador”.">
          <Input name="title" defaultValue={val("title")} required maxLength={200} />
        </FormField>
        <FormField label="Tribunal" htmlFor="court" required error={err("court")} hint="Ex.: TJSP, TRT-2, TRF-3.">
          <Input name="court" defaultValue={val("court")} required maxLength={120} />
        </FormField>
        <FormField label="Vara / órgão julgador" htmlFor="courtDivision" error={err("courtDivision")}>
          <Input name="courtDivision" defaultValue={val("courtDivision")} maxLength={200} />
        </FormField>
        <FormField label="Comarca / jurisdição" htmlFor="jurisdiction" error={err("jurisdiction")}>
          <Input name="jurisdiction" defaultValue={val("jurisdiction")} maxLength={120} />
        </FormField>
        <FormField label="Área do direito" htmlFor="area" required error={err("area")}>
          <NativeSelect name="area" options={areaOptions} placeholder="Selecione…" defaultValue={val("area")} required />
        </FormField>
        <FormField label="Fase processual" htmlFor="phase" required error={err("phase")}>
          <NativeSelect name="phase" options={phaseOptions} placeholder="Selecione…" defaultValue={val("phase")} required />
        </FormField>
        <FormField label="Situação" htmlFor="status" required error={err("status")}>
          <NativeSelect name="status" options={statusOptions} placeholder="Selecione…" defaultValue={val("status")} required />
        </FormField>
        <FormField label="Data de distribuição" htmlFor="filedAt" error={err("filedAt")}>
          <Input name="filedAt" type="date" defaultValue={val("filedAt")} />
        </FormField>
        <FormField label="Data de encerramento" htmlFor="closedAt" error={err("closedAt")} hint="Preencha quando o processo for encerrado.">
          <Input name="closedAt" type="date" defaultValue={val("closedAt")} />
        </FormField>
      </Section>

      <Section title="Responsabilidade">
        <FormField label="Unidade" htmlFor="unitId" error={err("unitId")}>
          <NativeSelect name="unitId" options={units} placeholder="Sem unidade" defaultValue={val("unitId")} />
        </FormField>
        <FormField label="Responsável" htmlFor="responsibleId" error={err("responsibleId")}>
          <NativeSelect name="responsibleId" options={users} placeholder="Sem responsável" defaultValue={val("responsibleId")} />
        </FormField>
      </Section>

      <Section
        title="Valores e risco"
        description="A classificação de risco e a probabilidade de perda são avaliações da equipe jurídica — não são previsões de resultado."
      >
        <FormField label="Valor da causa (R$)" htmlFor="claimAmountCents" error={err("claimAmountCents")}>
          <Input name="claimAmountCents" inputMode="decimal" placeholder="0,00" defaultValue={val("claimAmountCents")} />
        </FormField>
        <FormField label="Provisão (R$)" htmlFor="provisionAmountCents" error={err("provisionAmountCents")}>
          <Input name="provisionAmountCents" inputMode="decimal" placeholder="0,00" defaultValue={val("provisionAmountCents")} />
        </FormField>
        <FormField label="Classificação de risco" htmlFor="riskLevel" required error={err("riskLevel")}>
          <NativeSelect name="riskLevel" options={riskOptions} placeholder="Selecione…" defaultValue={val("riskLevel")} required />
        </FormField>
        <FormField label="Probabilidade de perda" htmlFor="lossProbability" error={err("lossProbability")}>
          <NativeSelect name="lossProbability" options={lossOptions} placeholder="Não avaliada" defaultValue={val("lossProbability")} />
        </FormField>
        <FormField
          label="Justificativa da classificação"
          htmlFor="riskRationale"
          error={err("riskRationale")}
          className="sm:col-span-2"
        >
          <Textarea name="riskRationale" rows={3} maxLength={4000} defaultValue={val("riskRationale")} />
        </FormField>
      </Section>

      <Section title="Descrição">
        <FormField label="Resumo do caso" htmlFor="description" error={err("description")} className="sm:col-span-2">
          <Textarea name="description" rows={6} maxLength={20000} defaultValue={val("description")} />
        </FormField>
      </Section>

      {canEditConfidential ? (
        <Section title="Confidencialidade">
          <div className="sm:col-span-2">
            <input type="hidden" name="confidentialityField" value="1" />
            <Checkbox
              name="isConfidential"
              defaultChecked={confidential}
              label="Processo confidencial"
              description="Visível apenas para administradores, gestores jurídicos, o responsável e quem o cadastrou."
            />
          </div>
        </Section>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-5 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="outline">
          Cancelar
        </ButtonLink>
        <SubmitButton>{mode === "create" ? "Cadastrar processo" : "Salvar alterações"}</SubmitButton>
      </div>
    </form>
  );
}
