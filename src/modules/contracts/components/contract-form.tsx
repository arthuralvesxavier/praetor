"use client";

import { Save } from "lucide-react";
import { useActionState, type ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  RENEWAL_TYPE_LABELS,
  RISK_LEVEL_LABELS,
  type ContractStatus,
  type ContractType,
  type RenewalType,
  type RiskLevel,
} from "@/domain/enums";
import { fieldError, type FormState } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { createContractAction, updateContractAction } from "../actions";
import { usePreservingSubmit } from "./use-preserving-submit";

/** Values shown in the form (all serializable). `value` is the money input text ("1.234,56"). */
export type ContractFormValues = {
  title: string;
  counterparty: string;
  counterpartyDocument: string;
  type: ContractType | "";
  status: ContractStatus;
  startDate: string;
  endDate: string;
  renewalType: RenewalType;
  renewalNoticeDays: string;
  value: string;
  riskLevel: RiskLevel;
  unitId: string;
  responsibleId: string;
  linkedProcessId: string;
  linkedOccurrenceId: string;
  description: string;
  isConfidential: boolean;
};

export const EMPTY_CONTRACT_FORM: ContractFormValues = {
  title: "",
  counterparty: "",
  counterpartyDocument: "",
  type: "",
  status: "draft",
  startDate: "",
  endDate: "",
  renewalType: "none",
  renewalNoticeDays: "",
  value: "",
  riskLevel: "low",
  unitId: "",
  responsibleId: "",
  linkedProcessId: "",
  linkedOccurrenceId: "",
  description: "",
  isConfidential: false,
};

export type ContractFormProps = {
  /** Present when editing. */
  contractId?: string;
  defaults?: ContractFormValues;
  units: Option[];
  users: Option[];
  processes: Option[];
  occurrences: Option[];
  /** Only admins and legal managers may change confidentiality. */
  canSetConfidential: boolean;
  cancelHref: string;
};

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-lg border border-border bg-surface p-4 shadow-xs sm:grid-cols-2 sm:p-5">
      <legend className="px-1 text-sm font-semibold text-slate-900">{title}</legend>
      {description ? <p className="-mt-1 text-xs text-muted-foreground sm:col-span-2">{description}</p> : null}
      {children}
    </fieldset>
  );
}

export function ContractForm({
  contractId,
  defaults = EMPTY_CONTRACT_FORM,
  units,
  users,
  processes,
  occurrences,
  canSetConfidential,
  cancelHref,
}: ContractFormProps) {
  const isEdit = Boolean(contractId);
  const save = isEdit ? updateContractAction : createContractAction;
  // The actions ignore the previous state; the wrapper only adapts ActionResult to the client-safe FormState.
  const [state, formAction] = useActionState<FormState | null, FormData>(
    async (_prev, formData) => save(null, formData),
    null,
  );
  const onSubmit = usePreservingSubmit(formAction);
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      {contractId ? <input type="hidden" name="id" value={contractId} /> : null}
      <FormMessage state={state} />

      <Section title="Identificação">
        <FormField label="Título" htmlFor="title" required error={err("title")} className="sm:col-span-2">
          <Input name="title" defaultValue={defaults.title} maxLength={200} required autoFocus={!isEdit} />
        </FormField>
        <FormField label="Contraparte" htmlFor="counterparty" required error={err("counterparty")}>
          <Input name="counterparty" defaultValue={defaults.counterparty} maxLength={200} required />
        </FormField>
        <FormField
          label="CNPJ/CPF da contraparte"
          htmlFor="counterpartyDocument"
          hint="Opcional. Somente números ou com pontuação. Exibido mascarado nas listagens."
          error={err("counterpartyDocument")}
        >
          <Input
            name="counterpartyDocument"
            defaultValue={defaults.counterpartyDocument}
            inputMode="numeric"
            autoComplete="off"
            maxLength={32}
          />
        </FormField>
        <FormField label="Tipo" htmlFor="type" required error={err("type")}>
          <NativeSelect
            name="type"
            defaultValue={defaults.type}
            options={optionsFromLabels(CONTRACT_TYPE_LABELS)}
            placeholder="Selecione…"
            placeholderDisabled
            required
          />
        </FormField>
        <FormField label="Situação" htmlFor="status" required error={err("status")}>
          <NativeSelect name="status" defaultValue={defaults.status} options={optionsFromLabels(CONTRACT_STATUS_LABELS)} required />
        </FormField>
      </Section>

      <Section
        title="Vigência e renovação"
        description="O prazo de aviso e os alertas de vencimento são calculados a partir das datas informadas aqui."
      >
        <FormField label="Início da vigência" htmlFor="startDate" error={err("startDate")}>
          <Input name="startDate" type="date" defaultValue={defaults.startDate} />
        </FormField>
        <FormField
          label="Término da vigência"
          htmlFor="endDate"
          hint="Deixe em branco para prazo indeterminado."
          error={err("endDate")}
        >
          <Input name="endDate" type="date" defaultValue={defaults.endDate} />
        </FormField>
        <FormField label="Tipo de renovação" htmlFor="renewalType" error={err("renewalType")}>
          <NativeSelect name="renewalType" defaultValue={defaults.renewalType} options={optionsFromLabels(RENEWAL_TYPE_LABELS)} />
        </FormField>
        <FormField
          label="Antecedência de aviso (dias)"
          htmlFor="renewalNoticeDays"
          hint="Dias antes do término para notificar renovação ou rescisão."
          error={err("renewalNoticeDays")}
        >
          <Input
            name="renewalNoticeDays"
            type="number"
            inputMode="numeric"
            min={0}
            max={3650}
            step={1}
            defaultValue={defaults.renewalNoticeDays}
          />
        </FormField>
      </Section>

      <Section title="Valor e risco">
        <FormField label="Valor do contrato (R$)" htmlFor="value" hint="Ex.: 12.500,00" error={err("valueCents") ?? err("value")}>
          <Input name="value" inputMode="decimal" autoComplete="off" defaultValue={defaults.value} placeholder="0,00" />
        </FormField>
        <FormField label="Nível de risco" htmlFor="riskLevel" error={err("riskLevel")}>
          <NativeSelect name="riskLevel" defaultValue={defaults.riskLevel} options={optionsFromLabels(RISK_LEVEL_LABELS)} />
        </FormField>
      </Section>

      <Section title="Responsabilidade">
        <FormField label="Unidade" htmlFor="unitId" error={err("unitId")}>
          <NativeSelect name="unitId" defaultValue={defaults.unitId} options={units} placeholder="Sem unidade" />
        </FormField>
        <FormField label="Responsável" htmlFor="responsibleId" error={err("responsibleId")}>
          <NativeSelect name="responsibleId" defaultValue={defaults.responsibleId} options={users} placeholder="Sem responsável" />
        </FormField>
      </Section>

      <Section title="Vínculos" description="Opcional. Relacione o contrato a um processo ou a uma ocorrência preventiva.">
        <FormField label="Processo" htmlFor="linkedProcessId" error={err("linkedProcessId")}>
          <NativeSelect name="linkedProcessId" defaultValue={defaults.linkedProcessId} options={processes} placeholder="Nenhum" />
        </FormField>
        <FormField label="Ocorrência" htmlFor="linkedOccurrenceId" error={err("linkedOccurrenceId")}>
          <NativeSelect
            name="linkedOccurrenceId"
            defaultValue={defaults.linkedOccurrenceId}
            options={occurrences}
            placeholder="Nenhuma"
          />
        </FormField>
      </Section>

      <Section title="Descrição">
        <FormField label="Descrição e observações" htmlFor="description" error={err("description")} className="sm:col-span-2">
          <Textarea name="description" rows={5} maxLength={10_000} defaultValue={defaults.description} />
        </FormField>
      </Section>

      <Section title="Confidencialidade">
        <div className="sm:col-span-2">
          {canSetConfidential ? (
            <Checkbox
              name="isConfidential"
              defaultChecked={defaults.isConfidential}
              label="Contrato confidencial"
              description="Visível apenas para administradores, gestores jurídicos, o responsável e quem cadastrou."
            />
          ) : (
            <>
              {defaults.isConfidential ? <input type="hidden" name="isConfidential" value="on" /> : null}
              <p className="text-sm text-muted-foreground">
                {defaults.isConfidential ? "Este contrato é confidencial. " : "Este contrato não é confidencial. "}
                Somente administradores e gestores jurídicos podem alterar a confidencialidade.
              </p>
            </>
          )}
          {err("isConfidential") ? (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {err("isConfidential")}
            </p>
          ) : null}
        </div>
      </Section>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="outline">
          Cancelar
        </ButtonLink>
        <SubmitButton>
          <Save aria-hidden="true" />
          {isEdit ? "Salvar alterações" : "Cadastrar contrato"}
        </SubmitButton>
      </div>
    </form>
  );
}
