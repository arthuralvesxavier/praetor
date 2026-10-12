"use client";

import { CalendarSearch, CircleDollarSign, Plus, Search } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { formatBp } from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS, PROCESS_INSTANCE_LABELS, VALUATION_KIND_LABELS } from "@/domain/enums";
import { formatDate, todayISO } from "@/lib/format";
import { fieldError } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { addValuationAction, getPositionAtAction, registerExtinctionAction } from "../actions";
import { ActionDialog } from "./action-dialog";
import { EstimateBadge, Money } from "./badges";

const SOURCE_OPTIONS: Option[] = [
  { value: "manual", label: "Lançamento manual" },
  { value: "document", label: "Lido em peça dos autos (documento)" },
];

export function ValuationDialog({
  processId,
  documents,
  canApprove,
}: {
  processId: string;
  documents: Option[];
  canApprove: boolean;
}) {
  return (
    <ActionDialog
      size="lg"
      trigger={
        <Button type="button" size="sm">
          <Plus aria-hidden="true" />
          Registrar valor
        </Button>
      }
      title="Registrar valor"
      description="Cada lançamento é um novo registro: valores anteriores nunca são sobrescritos (histórico preservado)."
      action={addValuationAction}
      hiddenFields={{ processId }}
      submitLabel={canApprove ? "Registrar como oficial" : "Enviar para conferência"}
    >
      {(state) => <ValuationFields state={state} documents={documents} canApprove={canApprove} />}
    </ActionDialog>
  );
}

function ValuationFields({
  state,
  documents,
  canApprove,
}: {
  state: Parameters<typeof fieldError>[0];
  documents: Option[];
  canApprove: boolean;
}) {
  const [source, setSource] = useState("manual");
  const err = (f: string) => fieldError(state, f);
  const today = todayISO();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Callout tone={canApprove ? "info" : "warning"} className="sm:col-span-2">
        {canApprove
          ? "Você confere valores: este lançamento entra como OFICIAL, com você identificado como responsável pela conferência."
          : "Este lançamento entra como PROPOSTO e só passa a valer depois da conferência de uma pessoa autorizada."}
      </Callout>
      <FormField label="Tipo de valor" htmlFor="valuation-kind" required error={err("kind")}>
        <NativeSelect name="kind" options={optionsFromLabels(VALUATION_KIND_LABELS)} defaultValue="liquidated" required />
      </FormField>
      <FormField label="Valor (R$)" htmlFor="valuation-amount" required error={err("amountCents")} hint="Ex.: 12.345,67">
        <Input name="amount" inputMode="decimal" autoComplete="off" required placeholder="0,00" />
      </FormField>
      <FormField label="Data-base do cálculo" htmlFor="valuation-base-date" required error={err("baseDate")}>
        <Input name="baseDate" type="date" max={today} defaultValue={today} required />
      </FormField>
      <FormField label="Instância" htmlFor="valuation-instance" error={err("instance")}>
        <NativeSelect name="instance" options={optionsFromLabels(PROCESS_INSTANCE_LABELS)} placeholder="Não se aplica" />
      </FormField>
      <FormField label="Origem" htmlFor="valuation-source" error={err("source")} className="sm:col-span-2">
        <NativeSelect name="source" options={SOURCE_OPTIONS} value={source} onChange={(e) => setSource(e.target.value)} />
      </FormField>
      {source === "document" ? (
        <>
          <FormField label="Documento" htmlFor="valuation-document" required error={err("documentId")}>
            <NativeSelect
              name="documentId"
              options={documents}
              placeholder={documents.length ? "Selecione…" : "Nenhum documento neste processo"}
            />
          </FormField>
          <FormField label="Página" htmlFor="valuation-page" error={err("page")}>
            <Input name="page" type="number" min={1} inputMode="numeric" />
          </FormField>
          <FormField
            label="Trecho que embasa o valor"
            htmlFor="valuation-excerpt"
            error={err("excerpt")}
            hint="Copie o trecho literal (até 500 caracteres)."
            className="sm:col-span-2"
          >
            <Textarea name="excerpt" rows={2} maxLength={500} />
          </FormField>
        </>
      ) : null}
      <FormField label="Observação" htmlFor="valuation-reason" error={err("reason")} className="sm:col-span-2">
        <Textarea name="reason" rows={2} maxLength={1000} placeholder="Ex.: cálculo homologado; divergência com a planilha…" />
      </FormField>
    </div>
  );
}

export function ExtinctionDialog({
  processId,
  documents,
  canApprove,
  triggerLabel = "Registrar quitação",
  triggerVariant = "outline",
}: {
  processId: string;
  documents: Option[];
  canApprove: boolean;
  triggerLabel?: string;
  triggerVariant?: "outline" | "primary" | "secondary";
}) {
  return (
    <ActionDialog
      trigger={
        <Button type="button" size="sm" variant={triggerVariant}>
          <CircleDollarSign aria-hidden="true" />
          {triggerLabel}
        </Button>
      }
      title="Registrar quitação"
      description="Extinção pela satisfação: registra um valor liquidado de R$ 0,00 com motivo “Quitação”. O histórico de valores é mantido."
      action={registerExtinctionAction}
      hiddenFields={{ processId }}
      submitLabel={canApprove ? "Registrar quitação" : "Enviar para conferência"}
    >
      {(state) => (
        <div className="grid gap-4">
          {!canApprove ? (
            <Callout tone="warning">A quitação entra como proposta e só zera o valor liquidado depois da conferência.</Callout>
          ) : null}
          <FormField label="Data da quitação" htmlFor="extinction-date" required error={fieldError(state, "baseDate")}>
            <Input name="baseDate" type="date" max={todayISO()} defaultValue={todayISO()} required />
          </FormField>
          <FormField label="Documento comprobatório" htmlFor="extinction-document" error={fieldError(state, "documentId")}>
            <NativeSelect name="documentId" options={documents} placeholder="Sem documento" />
          </FormField>
          <FormField label="Observação" htmlFor="extinction-note" error={fieldError(state, "note")}>
            <Textarea name="note" rows={2} maxLength={500} placeholder="Ex.: guia de levantamento juntada." />
          </FormField>
        </div>
      )}
    </ActionDialog>
  );
}

/** "Quanto era o passivo em data passada" (RF-09). */
export function PositionAtForm({ processId }: { processId: string }) {
  const [state, action] = useActionState(getPositionAtAction, null);
  const position = state?.ok ? state.data : null;
  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <input type="hidden" name="processId" value={processId} />
        <FormField label="Posição em" htmlFor="position-date" className="sm:w-48">
          <Input name="date" type="date" max={todayISO()} defaultValue={todayISO()} required />
        </FormField>
        <SubmitButton variant="secondary" size="md" pendingLabel="Consultando…">
          <Search aria-hidden="true" />
          Consultar
        </SubmitButton>
      </form>
      {state && !state.ok ? <FormMessage state={state} /> : null}
      {position ? (
        <div className="rounded-md border border-border bg-surface-muted p-3 text-sm" aria-live="polite">
          <p className="mb-2 flex items-center gap-2 font-medium text-slate-900">
            <CalendarSearch aria-hidden="true" className="size-4 text-slate-500" />
            Posição em {formatDate(position.date)}
          </p>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            <Item label="Valor da causa">
              <Money cents={position.claimCents} fallback="Não informado" />
              {position.claimBaseDate ? <Small>data-base {formatDate(position.claimBaseDate)}</Small> : null}
            </Item>
            <Item label="Valor liquidado">
              <Money cents={position.liquidatedCents} />
              {position.liquidatedBaseDate ? <Small>data-base {formatDate(position.liquidatedBaseDate)}</Small> : null}
            </Item>
            <Item label="Garantias vinculadas">
              <Money cents={position.linkedGuaranteesCents} />
            </Item>
            <Item label="Classificação">
              {position.classification
                ? `${LOSS_PROBABILITY_LABELS[position.classification]} · ${formatBp(position.percentageBp)}`
                : "Não classificado"}
              {position.riskEffectiveFrom ? <Small>vigente desde {formatDate(position.riskEffectiveFrom)}</Small> : null}
            </Item>
            <Item label="Exposição líquida">
              <Money cents={position.exposure.exposureCents} fallback="Sem base" />
              {position.exposure.isEstimate ? <EstimateBadge className="ml-2" /> : null}
            </Item>
            <Item label="Provisão">
              <Money cents={position.provision.provisionCents} fallback="Não calculada" />
              {position.provision.isEstimate ? <EstimateBadge className="ml-2" /> : null}
            </Item>
          </dl>
          {position.usedRecordFallback ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Sem histórico para algum dos valores: foi usado o dado atual do cadastro do processo.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium text-slate-900">{children}</dd>
    </div>
  );
}

function Small({ children }: { children: React.ReactNode }) {
  return <span className="block text-xs font-normal text-muted-foreground">{children}</span>;
}
