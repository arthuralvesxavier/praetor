"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  OCCURRENCE_CATEGORY_LABELS,
  OCCURRENCE_STATUS_LABELS,
  OCCURRENCE_STATUSES,
  RISK_LEVEL_LABELS,
  type OccurrenceCategory,
  type OccurrenceStatus,
  type RiskLevel,
} from "@/domain/enums";
import { centsToInputValue, todayISO } from "@/lib/format";
import { fieldError } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { createOccurrenceAction, updateOccurrenceAction } from "../actions";
import { usePreservingSubmit } from "./use-preserving-submit";

/** Serializable values that pre-fill the form. */
export type OccurrenceFormValues = {
  id?: string;
  title: string;
  facts: string;
  category: OccurrenceCategory | "";
  status: OccurrenceStatus;
  riskLevel: RiskLevel;
  riskRationale: string | null;
  areasInvolved: string[];
  involvedParties: string | null;
  missingInformation: string[];
  estimatedExposureCents: number | null;
  unitId: string | null;
  responsibleId: string | null;
  reportedById: string | null;
  occurredOn: string | null;
  reportedOn: string;
  isConfidential: boolean;
};

export type OccurrenceFormProps = {
  mode: "create" | "edit";
  values: OccurrenceFormValues;
  units: Option[];
  users: Option[];
  /** Admins and legal managers only. */
  canSetConfidential: boolean;
  cancelHref: string;
};

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

export function OccurrenceForm({ mode, values, units, users, canSetConfidential, cancelHref }: OccurrenceFormProps) {
  const action = mode === "create" ? createOccurrenceAction : updateOccurrenceAction;
  const [state, formAction, pending] = useActionState(action, null);
  const onSubmit = usePreservingSubmit(formAction);
  const formRef = useRef<HTMLFormElement>(null);

  // Move focus to the first invalid field (or the error banner) after a failed submit.
  useEffect(() => {
    if (!state || state.ok) return;
    const form = formRef.current;
    const target = form?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? form?.querySelector<HTMLElement>('[role="alert"]');
    target?.focus();
  }, [state]);

  // "Convertida em processo" is only reached by linking a process; keep it only when already set.
  const statusOptions = optionsFromLabels(
    OCCURRENCE_STATUS_LABELS,
    OCCURRENCE_STATUSES.filter((s) => s !== "converted_to_process" || values.status === "converted_to_process"),
  );
  const today = todayISO();
  const err = (field: string) => fieldError(state, field);

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className="grid gap-6" noValidate>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <FormMessage state={state} className="outline-none" />

      <Section title="Fatos" description="Descreva o que aconteceu, com datas, locais e pessoas, sem juízo de valor.">
        <FormField label="Título" htmlFor="title" required error={err("title")} className="sm:col-span-2">
          <Input name="title" defaultValue={values.title} maxLength={200} required autoComplete="off" />
        </FormField>
        <FormField
          label="Narrativa dos fatos"
          htmlFor="facts"
          required
          error={err("facts")}
          hint="Este texto pode ser usado como fonte nas análises de IA solicitadas para a ocorrência."
          className="sm:col-span-2"
        >
          <Textarea name="facts" defaultValue={values.facts} rows={8} maxLength={20000} required />
        </FormField>
      </Section>

      <Section
        title="Classificação"
        description="A classificação de risco é definida pela equipe jurídica; a IA não altera este campo."
      >
        <FormField label="Categoria" htmlFor="category" required error={err("category")}>
          <NativeSelect
            name="category"
            defaultValue={values.category}
            options={optionsFromLabels(OCCURRENCE_CATEGORY_LABELS)}
            placeholder="Selecione…"
            placeholderDisabled
            required
          />
        </FormField>
        <FormField label="Situação" htmlFor="status" required error={err("status")}>
          <NativeSelect name="status" defaultValue={values.status} options={statusOptions} required />
        </FormField>
        <FormField label="Nível de risco" htmlFor="riskLevel" required error={err("riskLevel")}>
          <NativeSelect name="riskLevel" defaultValue={values.riskLevel} options={optionsFromLabels(RISK_LEVEL_LABELS)} required />
        </FormField>
        <FormField
          label="Justificativa do risco"
          htmlFor="riskRationale"
          error={err("riskRationale")}
          hint="Por que este nível de risco? Ex.: reincidência, valores envolvidos, exposição de imagem."
          className="sm:col-span-2"
        >
          <Textarea name="riskRationale" defaultValue={values.riskRationale ?? ""} rows={3} maxLength={4000} />
        </FormField>
      </Section>

      <Section title="Áreas e pessoas">
        <FormField
          label="Áreas envolvidas"
          htmlFor="areasInvolved"
          error={err("areasInvolved")}
          hint="Separe por vírgulas. Ex.: RH, Comercial, Operações."
          className="sm:col-span-2"
        >
          <Input name="areasInvolved" defaultValue={values.areasInvolved.join(", ")} autoComplete="off" />
        </FormField>
        <FormField
          label="Partes envolvidas"
          htmlFor="involvedParties"
          error={err("involvedParties")}
          hint="Pessoas ou empresas externas envolvidas (reclamantes, fornecedores, órgãos)."
          className="sm:col-span-2"
        >
          <Textarea name="involvedParties" defaultValue={values.involvedParties ?? ""} rows={3} maxLength={4000} />
        </FormField>
        <FormField label="Unidade" htmlFor="unitId" error={err("unitId")}>
          <NativeSelect name="unitId" defaultValue={values.unitId ?? ""} options={units} placeholder="Sem unidade" />
        </FormField>
        <FormField label="Responsável" htmlFor="responsibleId" error={err("responsibleId")}>
          <NativeSelect name="responsibleId" defaultValue={values.responsibleId ?? ""} options={users} placeholder="Sem responsável" />
        </FormField>
        <FormField label="Reportada por" htmlFor="reportedById" error={err("reportedById")}>
          <NativeSelect name="reportedById" defaultValue={values.reportedById ?? ""} options={users} placeholder="Não informado" />
        </FormField>
      </Section>

      <Section title="Datas">
        <FormField label="Data da ocorrência" htmlFor="occurredOn" error={err("occurredOn")} hint="Quando os fatos aconteceram, se conhecido.">
          <Input type="date" name="occurredOn" defaultValue={values.occurredOn ?? ""} max={today} />
        </FormField>
        <FormField label="Reportada em" htmlFor="reportedOn" required error={err("reportedOn")}>
          <Input type="date" name="reportedOn" defaultValue={values.reportedOn} max={today} required />
        </FormField>
      </Section>

      <Section
        title="Informações faltantes"
        description="O que a equipe ainda precisa levantar. A IA pode apontar outras lacunas nas análises, sempre separadas desta lista."
      >
        <FormField
          label="Informações faltantes"
          htmlFor="missingInformation"
          error={err("missingInformation")}
          hint="Uma por linha."
          className="sm:col-span-2"
        >
          <Textarea name="missingInformation" defaultValue={values.missingInformation.join("\n")} rows={5} />
        </FormField>
      </Section>

      <Section title="Exposição estimada" description="Estimativa interna da equipe. Não é previsão de resultado.">
        <FormField
          label="Valor estimado (R$)"
          htmlFor="estimatedExposure"
          error={err("estimatedExposureCents")}
          hint="Ex.: 15.000,00. Deixe em branco se ainda não houver estimativa."
        >
          <Input
            name="estimatedExposure"
            inputMode="decimal"
            defaultValue={centsToInputValue(values.estimatedExposureCents)}
            autoComplete="off"
          />
        </FormField>
      </Section>

      <Section title="Confidencialidade">
        <div className="sm:col-span-2">
          {canSetConfidential ? (
            <>
              <input type="hidden" name="confidentialField" value="1" />
              <Checkbox
                name="isConfidential"
                defaultChecked={values.isConfidential}
                label="Ocorrência confidencial"
                description="Visível apenas para administradores, gestores jurídicos, o responsável e quem cadastrou."
                aria-invalid={err("isConfidential") ? true : undefined}
              />
              {err("isConfidential") ? (
                <p className="mt-1 text-sm text-red-700" role="alert">
                  {err("isConfidential")}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {values.isConfidential ? "Esta ocorrência é confidencial. " : "Esta ocorrência não é confidencial. "}
              Somente administradores e gestores jurídicos podem alterar a confidencialidade.
            </p>
          )}
        </div>
      </Section>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="outline">
          Cancelar
        </ButtonLink>
        <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
          {pending ? (
            <>
              <LoaderCircle aria-hidden="true" className="animate-spin" />
              <span>Salvando…</span>
            </>
          ) : (
            <>
              <Save aria-hidden="true" />
              {mode === "create" ? "Cadastrar ocorrência" : "Salvar alterações"}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
