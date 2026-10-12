"use client";

import { Check, ClipboardList, Pencil, Plus, Scale, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { RiskPercentages } from "@/domain/contingency";
import {
  CLAIM_CATEGORY_LABELS,
  CORRECTION_INDEX_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROCESS_INSTANCE_LABELS,
  type ClaimCategory,
  type CorrectionIndex,
  type LossProbability,
  type ProcessInstance,
} from "@/domain/enums";
import { centsToInputValue, formatDate, formatMoneyCents, todayISO } from "@/lib/format";
import { fieldError, type FormState } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import { ActionDialog } from "@/modules/contingency/components/action-dialog";
import {
  assessClaimAction,
  confirmClaimAction,
  createClaimAction,
  dismissClaimAction,
  overrideProcessRiskAction,
  removeClaimAction,
  updateClaimAction,
} from "../actions";

export type ClaimFormValues = {
  id: string;
  description: string;
  category: ClaimCategory | null;
  claimedAmountCents: number | null;
  amountBaseDate: string | null;
  correctionIndex: CorrectionIndex | null;
  instance: ProcessInstance | null;
};

function percentText(value: number): string {
  return String(value).replace(".", ",");
}

function ClaimFields({ state, claim, idPrefix }: { state: FormState | null; claim?: ClaimFormValues; idPrefix: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        label="Pedido (verba pleiteada)"
        htmlFor={`${idPrefix}-description`}
        required
        error={fieldError(state, "description")}
        className="sm:col-span-2"
      >
        <Textarea name="description" rows={2} maxLength={500} required defaultValue={claim?.description ?? ""} />
      </FormField>
      <FormField label="Categoria" htmlFor={`${idPrefix}-category`} error={fieldError(state, "category")}>
        <NativeSelect
          name="category"
          options={optionsFromLabels(CLAIM_CATEGORY_LABELS)}
          placeholder="Sem categoria"
          defaultValue={claim?.category ?? ""}
        />
      </FormField>
      <FormField label="Instância" htmlFor={`${idPrefix}-instance`} error={fieldError(state, "instance")}>
        <NativeSelect
          name="instance"
          options={optionsFromLabels(PROCESS_INSTANCE_LABELS)}
          placeholder="Não informada"
          defaultValue={claim?.instance ?? ""}
        />
      </FormField>
      <FormField
        label="Valor do pedido (R$)"
        htmlFor={`${idPrefix}-amount`}
        error={fieldError(state, "claimedAmountCents")}
        hint="Deixe em branco quando o pedido não tiver valor: ele fica como não quantificado (não vale zero)."
      >
        <Input
          name="claimedAmount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          defaultValue={claim ? centsToInputValue(claim.claimedAmountCents) : ""}
        />
      </FormField>
      <FormField
        label="Data-base do valor"
        htmlFor={`${idPrefix}-base-date`}
        error={fieldError(state, "amountBaseDate")}
        hint="Obrigatória quando houver valor."
      >
        <Input name="amountBaseDate" type="date" defaultValue={claim?.amountBaseDate ?? ""} />
      </FormField>
      <FormField
        label="Índice de atualização"
        htmlFor={`${idPrefix}-index`}
        error={fieldError(state, "correctionIndex")}
        hint="Escolha da pessoa responsável; o sistema não define o índice de cada caso."
        className="sm:col-span-2"
      >
        <NativeSelect
          name="correctionIndex"
          options={optionsFromLabels(CORRECTION_INDEX_LABELS)}
          placeholder="Sem índice informado"
          defaultValue={claim?.correctionIndex ?? ""}
        />
      </FormField>
    </div>
  );
}

export function ClaimDialog({ processId, claim }: { processId: string; claim?: ClaimFormValues }) {
  const isEdit = Boolean(claim);
  return (
    <ActionDialog
      size="lg"
      trigger={
        isEdit ? (
          <Button type="button" variant="ghost" size="sm" aria-label="Editar pedido">
            <Pencil aria-hidden="true" />
            <span className="hidden sm:inline">Editar</span>
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline">
            <Plus aria-hidden="true" />
            Incluir pedido
          </Button>
        )
      }
      title={isEdit ? "Editar pedido" : "Incluir pedido"}
      description={
        isEdit
          ? "Avaliações já registradas mantêm a base que usaram. Se o valor mudou, registre nova avaliação."
          : "Pedido (verba pleiteada) do processo. O risco é avaliado por pedido."
      }
      action={isEdit ? updateClaimAction : createClaimAction}
      hiddenFields={isEdit ? { id: claim!.id } : { processId }}
      submitLabel={isEdit ? "Salvar alterações" : "Incluir pedido"}
    >
      {(state) => <ClaimFields state={state} claim={claim} idPrefix={isEdit ? `claim-${claim!.id}` : "claim-new"} />}
    </ActionDialog>
  );
}

/** Confirms a suggestion of the preliminary analysis (the person reviews and corrects the fields). */
export function ConfirmClaimDialog({ claim, suggestedBaseDate }: { claim: ClaimFormValues; suggestedBaseDate: string | null }) {
  const values: ClaimFormValues = {
    ...claim,
    amountBaseDate: claim.amountBaseDate ?? (claim.claimedAmountCents !== null ? suggestedBaseDate : null),
  };
  return (
    <ActionDialog
      size="lg"
      trigger={
        <Button type="button" size="sm">
          <Check aria-hidden="true" />
          Confirmar
        </Button>
      }
      title="Confirmar pedido sugerido"
      description="Confira o pedido na petição antes de confirmar. Depois de confirmado ele pode ser avaliado e passa a contar no risco do processo."
      action={confirmClaimAction}
      hiddenFields={{ id: claim.id }}
      submitLabel="Confirmar pedido"
    >
      {(state) => (
        <>
          {suggestedBaseDate && claim.claimedAmountCents !== null && !claim.amountBaseDate ? (
            <Callout tone="info">
              A data-base veio preenchida com a data de ajuizamento do cadastro ({formatDate(suggestedBaseDate)}). Ajuste se o
              valor da petição tiver outra data.
            </Callout>
          ) : null}
          <ClaimFields state={state} claim={values} idPrefix={`claim-confirm-${claim.id}`} />
        </>
      )}
    </ActionDialog>
  );
}

export function DismissClaimDialog({ id }: { id: string }) {
  return (
    <ActionDialog
      size="sm"
      tone="destructive"
      trigger={
        <Button type="button" variant="ghost" size="sm" aria-label="Descartar sugestão">
          <X aria-hidden="true" />
          <span className="hidden sm:inline">Descartar</span>
        </Button>
      }
      title="Descartar pedido sugerido?"
      description="A sugestão fica registrada como descartada e não é sugerida de novo. Não conta no risco."
      action={dismissClaimAction}
      hiddenFields={{ id }}
      submitLabel="Descartar sugestão"
      pendingLabel="Descartando…"
    >
      {(state) => (
        <FormField label="Motivo (opcional)" htmlFor={`claim-dismiss-${id}`} error={fieldError(state, "reason")}>
          <Textarea name="reason" rows={2} maxLength={500} />
        </FormField>
      )}
    </ActionDialog>
  );
}

export function RemoveClaimDialog({ id }: { id: string }) {
  return (
    <ActionDialog
      size="sm"
      tone="destructive"
      trigger={
        <Button type="button" variant="ghost" size="sm" aria-label="Excluir pedido">
          <Trash2 aria-hidden="true" />
          <span className="hidden sm:inline">Excluir</span>
        </Button>
      }
      title="Excluir pedido?"
      description="Use apenas para lançamento indevido. A exclusão fica registrada na auditoria e, se o pedido tinha avaliação, o risco do processo é recalculado."
      action={removeClaimAction}
      hiddenFields={{ id }}
      submitLabel="Excluir pedido"
      pendingLabel="Excluindo…"
    >
      {(state) => (
        <FormField label="Motivo" htmlFor={`claim-remove-${id}`} required error={fieldError(state, "reason")}>
          <Textarea name="reason" rows={2} maxLength={500} required />
        </FormField>
      )}
    </ActionDialog>
  );
}

type AssessClaim = {
  id: string;
  claimedAmountCents: number | null;
  amountBaseDate: string | null;
  correctionIndex: CorrectionIndex | null;
};

export function AssessClaimDialog({ claim, percentages }: { claim: AssessClaim; percentages: RiskPercentages }) {
  return (
    <ActionDialog
      size="lg"
      trigger={
        <Button type="button" size="sm" variant="outline">
          <Scale aria-hidden="true" />
          Avaliar
        </Button>
      }
      title="Avaliar risco do pedido"
      description="Nova avaliação datada: as anteriores ficam no histórico. A classificação do processo é recalculada a partir dos pedidos."
      action={assessClaimAction}
      hiddenFields={{ id: claim.id }}
      submitLabel="Registrar avaliação"
    >
      {(state) => <AssessFields state={state} claim={claim} percentages={percentages} />}
    </ActionDialog>
  );
}

function AssessFields({ state, claim, percentages }: { state: FormState | null; claim: AssessClaim; percentages: RiskPercentages }) {
  const [classification, setClassification] = useState<LossProbability>("possible");
  const [percentage, setPercentage] = useState(percentText(percentages.possible));
  const [baseMode, setBaseMode] = useState<"claim" | "other" | "unquantified">(
    claim.claimedAmountCents === null ? "unquantified" : "claim",
  );
  const p = `assess-${claim.id}`;
  const claimLabel =
    claim.claimedAmountCents === null
      ? "Valor do pedido (não quantificado)"
      : `Valor do pedido: ${formatMoneyCents(claim.claimedAmountCents)}${claim.amountBaseDate ? ` em ${formatDate(claim.amountBaseDate)}` : ""}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField label="Classificação do pedido" htmlFor={`${p}-classification`} required error={fieldError(state, "classification")}>
        <NativeSelect
          name="classification"
          options={optionsFromLabels(LOSS_PROBABILITY_LABELS)}
          value={classification}
          onChange={(e) => {
            const c = e.target.value as LossProbability;
            setClassification(c);
            setPercentage(percentText(percentages[c]));
          }}
          required
        />
      </FormField>
      <FormField
        label="Percentual (%)"
        htmlFor={`${p}-percentage`}
        error={fieldError(state, "percentage")}
        hint={`Padrão da organização: remota ${percentages.remote}%, possível ${percentages.possible}%, provável ${percentages.probable}%.`}
      >
        <Input name="percentage" inputMode="decimal" value={percentage} onChange={(e) => setPercentage(e.target.value)} />
      </FormField>
      <FormField
        label="Base de cálculo"
        htmlFor={`${p}-base-mode`}
        error={fieldError(state, "baseAmountCents")}
        className="sm:col-span-2"
        hint="Pedido não quantificado fica fora da soma da provisão e aparece como não quantificado (não vale zero)."
      >
        <NativeSelect
          name="baseMode"
          value={baseMode}
          onChange={(e) => setBaseMode(e.target.value as typeof baseMode)}
          options={[
            ...(claim.claimedAmountCents !== null ? [{ value: "claim", label: claimLabel }] : []),
            { value: "other", label: "Outro valor (informar base e data-base)" },
            { value: "unquantified", label: "Não quantificado" },
          ]}
        />
      </FormField>
      {baseMode === "other" ? (
        <>
          <FormField label="Base (R$)" htmlFor={`${p}-base`} required error={fieldError(state, "baseAmountCents")}>
            <Input name="baseAmount" inputMode="decimal" autoComplete="off" placeholder="0,00" required />
          </FormField>
          <FormField label="Data-base da base" htmlFor={`${p}-base-date`} required error={fieldError(state, "baseDate")}>
            <Input name="baseDate" type="date" required />
          </FormField>
          <FormField label="Índice de atualização" htmlFor={`${p}-index`} error={fieldError(state, "correctionIndex")} className="sm:col-span-2">
            <NativeSelect name="correctionIndex" options={optionsFromLabels(CORRECTION_INDEX_LABELS)} placeholder="Sem índice informado" />
          </FormField>
        </>
      ) : null}
      {baseMode === "claim" && (!claim.amountBaseDate || fieldError(state, "baseDate")) ? (
        <Callout tone="warning" className="sm:col-span-2">
          {fieldError(state, "baseDate") ?? "O valor do pedido não tem data-base."} Edite o pedido ou use &quot;Outro valor&quot; com a
          data-base.
        </Callout>
      ) : null}
      <FormField label="Vigente a partir de" htmlFor={`${p}-effective`} required error={fieldError(state, "effectiveFrom")}>
        <Input name="effectiveFrom" type="date" max={todayISO()} defaultValue={todayISO()} required />
      </FormField>
      <FormField
        label="Parecer (fundamento)"
        htmlFor={`${p}-opinion`}
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

export function OverrideRiskDialog({
  processId,
  percentages,
  derived,
  current,
  triggerLabel = "Definir classificação diferente",
}: {
  processId: string;
  percentages: RiskPercentages;
  derived: { label: string };
  current?: { classification: LossProbability; percentageBp: number } | null;
  triggerLabel?: string;
}) {
  return (
    <ActionDialog
      size="lg"
      trigger={
        <Button type="button" size="sm" variant="outline">
          <ClipboardList aria-hidden="true" />
          {triggerLabel}
        </Button>
      }
      title="Classificação do processo diferente da derivada"
      description={`Derivada dos pedidos: ${derived.label}. A classificação manual exige justificativa e é mantida até alguém revisá-la; quando a avaliação dos pedidos mudar, ela é sinalizada para revisão.`}
      action={overrideProcessRiskAction}
      hiddenFields={{ processId }}
      submitLabel="Registrar classificação manual"
    >
      {(state) => <OverrideFields state={state} percentages={percentages} current={current ?? null} processId={processId} />}
    </ActionDialog>
  );
}

function OverrideFields({
  state,
  percentages,
  current,
  processId,
}: {
  state: FormState | null;
  percentages: RiskPercentages;
  current: { classification: LossProbability; percentageBp: number } | null;
  processId: string;
}) {
  const [classification, setClassification] = useState<LossProbability>(current?.classification ?? "probable");
  const [percentage, setPercentage] = useState(
    current ? percentText(current.percentageBp / 100) : percentText(percentages.probable),
  );
  const p = `override-${processId}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField label="Classificação do processo" htmlFor={`${p}-classification`} required error={fieldError(state, "classification")}>
        <NativeSelect
          name="classification"
          options={optionsFromLabels(LOSS_PROBABILITY_LABELS)}
          value={classification}
          onChange={(e) => {
            const c = e.target.value as LossProbability;
            setClassification(c);
            setPercentage(percentText(percentages[c]));
          }}
          required
        />
      </FormField>
      <FormField
        label="Percentual de provisão (%)"
        htmlFor={`${p}-percentage`}
        error={fieldError(state, "percentage")}
        hint={`Padrão da organização: remota ${percentages.remote}%, possível ${percentages.possible}%, provável ${percentages.probable}%.`}
      >
        <Input name="percentage" inputMode="decimal" value={percentage} onChange={(e) => setPercentage(e.target.value)} />
      </FormField>
      <FormField
        label="Justificativa"
        htmlFor={`${p}-justification`}
        required
        error={fieldError(state, "justification")}
        hint="Por que a classificação do processo difere da derivada dos pedidos. Fica registrada como parecer."
        className="sm:col-span-2"
      >
        <Textarea name="justification" rows={4} maxLength={2000} required />
      </FormField>
    </div>
  );
}
