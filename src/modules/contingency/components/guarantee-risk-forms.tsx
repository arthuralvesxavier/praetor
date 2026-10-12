"use client";

import { ArrowRightLeft, Pencil, Plus, Scale, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { RiskPercentages } from "@/domain/contingency";
import {
  GUARANTEE_KIND_LABELS,
  GUARANTEE_STATUS_LABELS,
  LOSS_PROBABILITY_LABELS,
  type GuaranteeKind,
  type GuaranteeStatus,
  type LossProbability,
} from "@/domain/enums";
import { centsToInputValue, todayISO } from "@/lib/format";
import { fieldError } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import {
  addRiskAssessmentAction,
  createGuaranteeAction,
  deleteGuaranteeAction,
  reviewRiskProposalAction,
  setGuaranteeStatusAction,
  updateGuaranteeAction,
} from "../actions";
import { ActionDialog } from "./action-dialog";

export type GuaranteeFormValues = {
  id: string;
  kind: GuaranteeKind;
  amountCents: number;
  depositedAt: string | null;
  documentId: string | null;
  description: string | null;
  status: GuaranteeStatus;
};

export function GuaranteeDialog({
  processId,
  documents,
  guarantee,
}: {
  processId: string;
  documents: Option[];
  guarantee?: GuaranteeFormValues;
}) {
  const isEdit = Boolean(guarantee);
  return (
    <ActionDialog
      trigger={
        isEdit ? (
          <Button type="button" variant="ghost" size="sm" aria-label="Editar garantia">
            <Pencil aria-hidden="true" />
            <span className="hidden sm:inline">Editar</span>
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline">
            <Plus aria-hidden="true" />
            Vincular garantia
          </Button>
        )
      }
      title={isEdit ? "Editar garantia" : "Vincular garantia"}
      description="Depósitos, penhoras, seguro garantia e cartas de fiança vinculados ao processo abatem a exposição."
      action={isEdit ? updateGuaranteeAction : createGuaranteeAction}
      hiddenFields={isEdit ? { id: guarantee!.id } : { processId }}
      submitLabel={isEdit ? "Salvar alterações" : "Vincular garantia"}
    >
      {(state) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Tipo" htmlFor="guarantee-kind" required error={fieldError(state, "kind")}>
            <NativeSelect
              name="kind"
              options={optionsFromLabels(GUARANTEE_KIND_LABELS)}
              defaultValue={guarantee?.kind ?? "judicial_deposit"}
              required
            />
          </FormField>
          <FormField label="Valor (R$)" htmlFor="guarantee-amount" required error={fieldError(state, "amountCents")}>
            <Input
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              required
              defaultValue={guarantee ? centsToInputValue(guarantee.amountCents) : ""}
              placeholder="0,00"
            />
          </FormField>
          <FormField label="Data do depósito / constrição" htmlFor="guarantee-date" error={fieldError(state, "depositedAt")}>
            <Input name="depositedAt" type="date" max={todayISO()} defaultValue={guarantee?.depositedAt ?? ""} />
          </FormField>
          <FormField label="Documento" htmlFor="guarantee-document" error={fieldError(state, "documentId")}>
            <NativeSelect name="documentId" options={documents} placeholder="Sem documento" defaultValue={guarantee?.documentId ?? ""} />
          </FormField>
          <FormField label="Descrição" htmlFor="guarantee-description" error={fieldError(state, "description")} className="sm:col-span-2">
            <Textarea
              name="description"
              rows={2}
              maxLength={1000}
              defaultValue={guarantee?.description ?? ""}
              placeholder="Ex.: depósito recursal do recurso ordinário (guia nº …)."
            />
          </FormField>
        </div>
      )}
    </ActionDialog>
  );
}

export function GuaranteeStatusDialog({ guarantee }: { guarantee: Pick<GuaranteeFormValues, "id" | "status" | "depositedAt"> }) {
  const options = optionsFromLabels(GUARANTEE_STATUS_LABELS).filter((o) => o.value !== guarantee.status);
  return (
    <ActionDialog
      size="sm"
      trigger={
        <Button type="button" variant="ghost" size="sm" aria-label="Alterar situação da garantia">
          <ArrowRightLeft aria-hidden="true" />
          <span className="hidden sm:inline">Situação</span>
        </Button>
      }
      title="Alterar situação da garantia"
      description="Somente garantias vinculadas ao processo abatem a exposição. Liberação ao autor ou devolução à empresa encerram o abatimento a partir da data informada."
      action={setGuaranteeStatusAction}
      hiddenFields={{ id: guarantee.id }}
      submitLabel="Salvar situação"
    >
      {(state) => (
        <div className="grid gap-4">
          <FormField label="Nova situação" htmlFor="guarantee-status" required error={fieldError(state, "status")}>
            <NativeSelect name="status" options={options} defaultValue={options[0]?.value} required />
          </FormField>
          <FormField label="Data da mudança" htmlFor="guarantee-status-date" error={fieldError(state, "statusChangedAt")}>
            <Input name="statusChangedAt" type="date" min={guarantee.depositedAt ?? undefined} max={todayISO()} defaultValue={todayISO()} />
          </FormField>
        </div>
      )}
    </ActionDialog>
  );
}

export function GuaranteeDeleteDialog({ id }: { id: string }) {
  return (
    <ActionDialog
      size="sm"
      tone="destructive"
      trigger={
        <Button type="button" variant="ghost" size="sm" aria-label="Excluir garantia">
          <Trash2 aria-hidden="true" />
          <span className="hidden sm:inline">Excluir</span>
        </Button>
      }
      title="Excluir garantia?"
      description="Use apenas para lançamento indevido. Para garantia liberada ou devolvida, altere a situação (o histórico é mantido). A exclusão fica registrada na auditoria."
      action={deleteGuaranteeAction}
      hiddenFields={{ id }}
      submitLabel="Excluir garantia"
      pendingLabel="Excluindo…"
    />
  );
}

export function RiskDialog({ processId, percentages }: { processId: string; percentages: RiskPercentages }) {
  return (
    <ActionDialog
      size="lg"
      trigger={
        <Button type="button" size="sm">
          <Scale aria-hidden="true" />
          Classificar risco
        </Button>
      }
      title="Classificar risco do processo"
      description="Registra uma classificação oficial com o seu parecer. Classificações anteriores ficam no histórico (vigência pela data)."
      action={addRiskAssessmentAction}
      hiddenFields={{ processId }}
      submitLabel="Registrar classificação"
    >
      {(state) => <RiskFields state={state} percentages={percentages} />}
    </ActionDialog>
  );
}

function RiskFields({ state, percentages }: { state: Parameters<typeof fieldError>[0]; percentages: RiskPercentages }) {
  const [classification, setClassification] = useState<LossProbability>("possible");
  const [percentage, setPercentage] = useState(String(percentages.possible).replace(".", ","));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField label="Classificação" htmlFor="risk-classification" required error={fieldError(state, "classification")}>
        <NativeSelect
          name="classification"
          options={optionsFromLabels(LOSS_PROBABILITY_LABELS)}
          value={classification}
          onChange={(e) => {
            const c = e.target.value as LossProbability;
            setClassification(c);
            setPercentage(String(percentages[c]).replace(".", ","));
          }}
          required
        />
      </FormField>
      <FormField
        label="Percentual de provisão (%)"
        htmlFor="risk-percentage"
        error={fieldError(state, "percentage")}
        hint={`Padrão da organização: remota ${percentages.remote}%, possível ${percentages.possible}%, provável ${percentages.probable}%.`}
      >
        <Input name="percentage" inputMode="decimal" value={percentage} onChange={(e) => setPercentage(e.target.value)} />
      </FormField>
      <FormField label="Vigente a partir de" htmlFor="risk-effective" required error={fieldError(state, "effectiveFrom")}>
        <Input name="effectiveFrom" type="date" max={todayISO()} defaultValue={todayISO()} required />
      </FormField>
      <FormField
        label="Parecer (fundamento)"
        htmlFor="risk-opinion"
        required
        error={fieldError(state, "opinion")}
        hint="Obrigatório para auditoria. Até 2.000 caracteres."
        className="sm:col-span-2"
      >
        <Textarea name="opinion" rows={4} maxLength={2000} required />
      </FormField>
    </div>
  );
}

export function RiskProposalReview({ id, decision }: { id: string; decision: "approve" | "reject" }) {
  const approve = decision === "approve";
  return (
    <ActionDialog
      size="sm"
      tone={approve ? "primary" : "destructive"}
      trigger={
        <Button type="button" size="sm" variant={approve ? "primary" : "outline"}>
          {approve ? "Aprovar" : "Rejeitar"}
        </Button>
      }
      title={approve ? "Aprovar sugestão de classificação?" : "Rejeitar sugestão de classificação?"}
      description={
        approve
          ? "A sugestão passa a ser a classificação oficial a partir de hoje, com você identificado como responsável."
          : "A sugestão fica no histórico como rejeitada e não altera a provisão."
      }
      action={reviewRiskProposalAction}
      hiddenFields={{ id, decision }}
      submitLabel={approve ? "Aprovar classificação" : "Rejeitar sugestão"}
    >
      {(state) => (
        <>
          {approve ? (
            <Callout tone="info">A regra considera apenas fase, instância, encerramento e valor liquidado. Não analisa o mérito.</Callout>
          ) : null}
          <FormField label={approve ? "Parecer complementar (opcional)" : "Motivo (opcional)"} htmlFor={`risk-note-${id}`} error={fieldError(state, "note")}>
            <Textarea name="note" rows={3} maxLength={1000} />
          </FormField>
        </>
      )}
    </ActionDialog>
  );
}
