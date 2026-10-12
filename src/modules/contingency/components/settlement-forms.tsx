"use client";

import { ArrowRightLeft, CheckCircle2, FilePen, Handshake, NotebookPen, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SETTLEMENT_STATUS_LABELS, type SettlementStatus } from "@/domain/enums";
import { centsToInputValue, formatMoneyCents, todayISO } from "@/lib/format";
import { fieldError } from "@/lib/form";
import type { Option } from "@/lib/options";
import {
  createSettlementAction,
  setInstallmentPaidAction,
  setSettlementStatusAction,
  updateSettlementNotesAction,
  updateSettlementTermsAction,
} from "../actions";
import { ActionDialog, InlineAction } from "./action-dialog";

const CREATE_STATUSES: SettlementStatus[] = ["proposal", "negotiating", "signed"];

export function SettlementCreateDialog({
  processId,
  processes,
  users,
  triggerLabel = "Novo acordo",
}: {
  /** Fixed process (process tab). */
  processId?: string;
  /** Process options (when not fixed, e.g. `/acordos`). */
  processes?: Option[];
  users: Option[];
  triggerLabel?: string;
}) {
  return (
    <ActionDialog
      size="lg"
      trigger={
        <Button type="button" size="sm">
          <Handshake aria-hidden="true" />
          {triggerLabel}
        </Button>
      }
      title="Registrar acordo"
      description="Com valor total, quantidade de parcelas e primeiro vencimento, as parcelas mensais são geradas automaticamente (a última absorve o arredondamento)."
      action={createSettlementAction}
      hiddenFields={processId ? { processId } : undefined}
      submitLabel="Registrar acordo"
    >
      {(state) => (
        <div className="grid gap-4 sm:grid-cols-2">
          {!processId ? (
            <FormField label="Processo" htmlFor="settlement-process" required error={fieldError(state, "processId")} className="sm:col-span-2">
              <NativeSelect name="processId" options={processes ?? []} placeholder="Selecione o processo…" placeholderDisabled required defaultValue="" />
            </FormField>
          ) : null}
          <FormField label="Situação" htmlFor="settlement-status" required error={fieldError(state, "status")}>
            <NativeSelect
              name="status"
              options={CREATE_STATUSES.map((s) => ({ value: s, label: SETTLEMENT_STATUS_LABELS[s] }))}
              defaultValue="proposal"
            />
          </FormField>
          <FormField label="Data da proposta" htmlFor="settlement-proposed" error={fieldError(state, "proposedAt")}>
            <Input name="proposedAt" type="date" max={todayISO()} defaultValue={todayISO()} />
          </FormField>
          <FormField label="Valor total (R$)" htmlFor="settlement-total" error={fieldError(state, "totalAmountCents")} hint="Deixe em branco se ainda não definido.">
            <Input name="total" inputMode="decimal" autoComplete="off" placeholder="0,00" />
          </FormField>
          <FormField label="Parcelas" htmlFor="settlement-count" error={fieldError(state, "installmentsCount")}>
            <Input name="installmentsCount" type="number" min={1} max={360} inputMode="numeric" />
          </FormField>
          <FormField label="Vencimento da 1ª parcela" htmlFor="settlement-first-due" error={fieldError(state, "firstDueDate")}>
            <Input name="firstDueDate" type="date" />
          </FormField>
          <FormField label="Responsável" htmlFor="settlement-responsible" error={fieldError(state, "responsibleId")}>
            <NativeSelect name="responsibleId" options={users} placeholder="Sem responsável" />
          </FormField>
          <FormField label="Observações" htmlFor="settlement-notes" error={fieldError(state, "notes")} className="sm:col-span-2">
            <Textarea name="notes" rows={3} maxLength={4000} />
          </FormField>
        </div>
      )}
    </ActionDialog>
  );
}

export function SettlementTermsDialog({
  id,
  totalAmountCents,
  installmentsCount,
  firstDueDate,
}: {
  id: string;
  totalAmountCents: number | null;
  installmentsCount: number | null;
  firstDueDate: string | null;
}) {
  return (
    <ActionDialog
      trigger={
        <Button type="button" size="sm" variant="ghost">
          <FilePen aria-hidden="true" />
          Alterar termos
        </Button>
      }
      title="Alterar termos do acordo"
      description="As parcelas são recalculadas. Só é possível enquanto nenhuma parcela foi paga."
      action={updateSettlementTermsAction}
      hiddenFields={{ id }}
      submitLabel="Salvar termos"
    >
      {(state) => (
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Valor total (R$)" htmlFor="terms-total" error={fieldError(state, "totalAmountCents")}>
            <Input name="total" inputMode="decimal" defaultValue={centsToInputValue(totalAmountCents)} />
          </FormField>
          <FormField label="Parcelas" htmlFor="terms-count" error={fieldError(state, "installmentsCount")}>
            <Input name="installmentsCount" type="number" min={1} max={360} defaultValue={installmentsCount ?? ""} />
          </FormField>
          <FormField label="1º vencimento" htmlFor="terms-first" error={fieldError(state, "firstDueDate")}>
            <Input name="firstDueDate" type="date" defaultValue={firstDueDate ?? ""} />
          </FormField>
        </div>
      )}
    </ActionDialog>
  );
}

export function SettlementStatusDialog({ id, next }: { id: string; next: readonly SettlementStatus[] }) {
  if (next.length === 0) return null;
  return (
    <ActionDialog
      size="sm"
      trigger={
        <Button type="button" size="sm" variant="outline">
          <ArrowRightLeft aria-hidden="true" />
          Mudar situação
        </Button>
      }
      title="Mudar situação do acordo"
      description="Fluxo: proposta → negociação → firmado → homologado → cumprido ou descumprido."
      action={setSettlementStatusAction}
      hiddenFields={{ id }}
      submitLabel="Salvar situação"
    >
      {(state) => (
        <div className="grid gap-4">
          <FormField label="Nova situação" htmlFor={`settlement-next-${id}`} required error={fieldError(state, "status")}>
            <NativeSelect
              name="status"
              options={next.map((s) => ({ value: s, label: SETTLEMENT_STATUS_LABELS[s] }))}
              defaultValue={next[0]}
            />
          </FormField>
          <FormField label="Data" htmlFor={`settlement-date-${id}`} error={fieldError(state, "date")} hint="Usada como data de assinatura ou homologação.">
            <Input name="date" type="date" max={todayISO()} defaultValue={todayISO()} />
          </FormField>
          {next.includes("fulfilled") ? (
            <Callout tone="info">Para registrar o cumprimento, todas as parcelas precisam estar pagas.</Callout>
          ) : null}
        </div>
      )}
    </ActionDialog>
  );
}

export function SettlementNotesDialog({ id, notes }: { id: string; notes: string | null }) {
  return (
    <ActionDialog
      trigger={
        <Button type="button" size="sm" variant="ghost">
          <NotebookPen aria-hidden="true" />
          Observações
        </Button>
      }
      title="Observações do acordo"
      action={updateSettlementNotesAction}
      hiddenFields={{ id }}
      submitLabel="Salvar observações"
    >
      {(state) => (
        <FormField label="Observações" htmlFor={`settlement-notes-${id}`} error={fieldError(state, "notes")}>
          <Textarea name="notes" rows={5} maxLength={4000} defaultValue={notes ?? ""} />
        </FormField>
      )}
    </ActionDialog>
  );
}

export function InstallmentPayment({
  id,
  number,
  amountCents,
  paid,
}: {
  id: string;
  number: number;
  amountCents: number;
  paid: boolean;
}) {
  if (paid) {
    return (
      <InlineAction
        action={setInstallmentPaidAction}
        hiddenFields={{ id }}
        variant="ghost"
        label={
          <>
            <Undo2 aria-hidden="true" />
            <span className="hidden sm:inline">Desfazer</span>
          </>
        }
        ariaLabel={`Desfazer pagamento da parcela ${number}`}
        pendingLabel="Salvando…"
        showSuccess={false}
      />
    );
  }
  return (
    <ActionDialog
      size="sm"
      trigger={
        <Button type="button" size="sm" variant="outline" aria-label={`Registrar pagamento da parcela ${number}`}>
          <CheckCircle2 aria-hidden="true" />
          <span className="hidden sm:inline">Paga</span>
        </Button>
      }
      title={`Registrar pagamento da parcela ${number}`}
      description={`Valor da parcela: ${formatMoneyCents(amountCents)}.`}
      action={setInstallmentPaidAction}
      hiddenFields={{ id, paid: "1" }}
      submitLabel="Marcar como paga"
    >
      {(state) => (
        <FormField label="Data do pagamento" htmlFor={`paid-at-${id}`} error={fieldError(state, "paidAt")}>
          <Input name="paidAt" type="date" max={todayISO()} defaultValue={todayISO()} />
        </FormField>
      )}
    </ActionDialog>
  );
}
