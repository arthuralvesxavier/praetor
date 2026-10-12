"use client";

import { useActionState, useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  CONFIDENTIALITY_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  type ConfidentialityLevel,
  type DocumentCategory,
} from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { updateDocumentMetadataAction } from "../actions";
import { SENSITIVE_HEALTH_HINT } from "../confidentiality";

export type DocumentMetadataFormProps = {
  document: {
    id: string;
    title: string;
    description: string | null;
    category: DocumentCategory;
    confidentiality: ConfidentialityLevel;
    processId: string | null;
    occurrenceId: string | null;
    contractId: string | null;
    retentionUntil: string | null;
    legalHold: boolean;
  };
  processOptions: Option[];
  occurrenceOptions: Option[];
  contractOptions: Option[];
  /** Only users with `document:delete` may change the legal hold flag. */
  canSetLegalHold: boolean;
};

const CATEGORY_OPTIONS = optionsFromLabels(DOCUMENT_CATEGORY_LABELS);
const CONFIDENTIALITY_OPTIONS = optionsFromLabels(CONFIDENTIALITY_LABELS);

/** Keeps the current link selectable even when the linked record is not visible to the user. */
function withCurrent(options: Option[], current: string | null): Option[] {
  if (!current || options.some((o) => o.value === current)) return options;
  return [{ value: current, label: "Registro vinculado atual (sem acesso)" }, ...options];
}

export function DocumentMetadataForm({
  document: d,
  processOptions,
  occurrenceOptions,
  contractOptions,
  canSetLegalHold,
}: DocumentMetadataFormProps) {
  const [state, action] = useActionState(updateDocumentMetadataAction, null);
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;
  const [category, setCategory] = useState<string>(d.category);
  const healthDocument = category === "sensitive_health";

  return (
    <form action={action} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FormMessage state={state} className="sm:col-span-2" />
      <input type="hidden" name="id" value={d.id} />

      <FormField label="Título" htmlFor={fid("title")} required className="sm:col-span-2" error={fieldError(state, "title")}>
        <Input name="title" required maxLength={300} defaultValue={d.title} />
      </FormField>
      <FormField label="Categoria" htmlFor={fid("category")} required error={fieldError(state, "category")}>
        <NativeSelect
          name="category"
          options={CATEGORY_OPTIONS}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          required
        />
      </FormField>
      <FormField
        label="Confidencialidade"
        htmlFor={fid("confidentiality")}
        hint={healthDocument ? SENSITIVE_HEALTH_HINT : undefined}
        error={fieldError(state, "confidentiality")}
      >
        {healthDocument ? (
          <NativeSelect options={CONFIDENTIALITY_OPTIONS} value="restricted" disabled aria-readonly="true" onChange={() => undefined} />
        ) : (
          <NativeSelect name="confidentiality" options={CONFIDENTIALITY_OPTIONS} defaultValue={d.confidentiality} />
        )}
      </FormField>
      {healthDocument ? <input type="hidden" name="confidentiality" value="restricted" /> : null}
      <FormField label="Processo vinculado" htmlFor={fid("processId")} error={fieldError(state, "processId")}>
        <NativeSelect
          name="processId"
          options={withCurrent(processOptions, d.processId)}
          placeholder="Sem vínculo"
          defaultValue={d.processId ?? ""}
        />
      </FormField>
      <FormField label="Ocorrência vinculada" htmlFor={fid("occurrenceId")} error={fieldError(state, "occurrenceId")}>
        <NativeSelect
          name="occurrenceId"
          options={withCurrent(occurrenceOptions, d.occurrenceId)}
          placeholder="Sem vínculo"
          defaultValue={d.occurrenceId ?? ""}
        />
      </FormField>
      <FormField label="Contrato vinculado" htmlFor={fid("contractId")} error={fieldError(state, "contractId")}>
        <NativeSelect
          name="contractId"
          options={withCurrent(contractOptions, d.contractId)}
          placeholder="Sem vínculo"
          defaultValue={d.contractId ?? ""}
        />
      </FormField>
      <FormField
        label="Reter até"
        htmlFor={fid("retentionUntil")}
        hint="Após esta data o documento entra na revisão de retenção."
        error={fieldError(state, "retentionUntil")}
      >
        <Input type="date" name="retentionUntil" defaultValue={d.retentionUntil ?? ""} />
      </FormField>
      <FormField label="Descrição" htmlFor={fid("description")} className="sm:col-span-2" error={fieldError(state, "description")}>
        <Textarea name="description" rows={3} maxLength={5000} defaultValue={d.description ?? ""} />
      </FormField>
      {canSetLegalHold ? (
        <div className="sm:col-span-2">
          <input type="hidden" name="legalHoldEditable" value="1" />
          <Checkbox
            id={fid("legalHold")}
            name="legalHold"
            defaultChecked={d.legalHold}
            label="Preservação legal (legal hold)"
            description="Impede a exclusão do documento enquanto estiver ativa."
          />
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <SubmitButton>Salvar alterações</SubmitButton>
      </div>
    </form>
  );
}
