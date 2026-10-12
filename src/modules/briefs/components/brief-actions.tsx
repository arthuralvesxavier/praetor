"use client";

import { CalendarPlus, CheckCircle2, CircleCheck, ListPlus, LoaderCircle, RefreshCw, Send, Sparkles, XCircle } from "lucide-react";
import { useActionState, useId, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/form";
import { cn } from "@/lib/utils";
import {
  applyBriefDeadlineAction,
  applyBriefNextStepAction,
  approveCaseBriefAction,
  proposeBriefAmountAction,
  regenerateCaseBriefAction,
  rejectCaseBriefAction,
  requestCaseBriefAction,
} from "../actions";

type ItemActionKind = "deadline" | "task" | "amount";

const ITEM_LABELS: Record<ItemActionKind, { label: string; pending: string; icon: ReactNode }> = {
  deadline: { label: "Criar prazo para validação", pending: "Criando…", icon: <CalendarPlus /> },
  task: { label: "Criar tarefa", pending: "Criando…", icon: <ListPlus /> },
  amount: { label: "Enviar valor para conferência", pending: "Enviando…", icon: <Send /> },
};

function PendingButton({ label, pending, icon }: { label: string; pending: string; icon: ReactNode }) {
  const status = useFormStatus();
  return (
    <Button type="submit" size="sm" variant="outline" disabled={status.pending}>
      {status.pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <span aria-hidden="true">{icon}</span>}
      {status.pending ? pending : label}
    </Button>
  );
}

type ItemActionProps = {
  kind: ItemActionKind;
  briefId: string;
  processId: string;
  index: number;
  /** Accessible context, e.g. the item description. */
  itemLabel: string;
};

/** One-click action on a brief item (deadline, task or amount). Shows the result next to the button. */
export function BriefItemAction(props: ItemActionProps) {
  if (props.kind === "deadline") return <ItemActionForm {...props} action={applyBriefDeadlineAction} />;
  if (props.kind === "task") return <ItemActionForm {...props} action={applyBriefNextStepAction} />;
  return <ItemActionForm {...props} action={proposeBriefAmountAction} />;
}

function ItemActionForm<S extends FormState>({
  kind,
  briefId,
  processId,
  index,
  itemLabel,
  action: serverAction,
}: ItemActionProps & { action: (prev: S | null, formData: FormData) => Promise<S> }) {
  const config = ITEM_LABELS[kind];
  const [state, action] = useActionState(serverAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" aria-label={`${config.label}: ${itemLabel}`}>
      <input type="hidden" name="briefId" value={briefId} />
      <input type="hidden" name="processId" value={processId} />
      <input type="hidden" name="index" value={index} />
      {state?.ok ? (
        <p role="status" className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-800">
          <CircleCheck aria-hidden="true" className="size-4" />
          {state.message}
        </p>
      ) : (
        <PendingButton label={config.label} pending={config.pending} icon={config.icon} />
      )}
      {state && !state.ok ? (
        <p role="alert" className="text-xs text-red-700">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** "Gerar análise preliminar (simulação)" button used on the process tab. */
export function RequestBriefButton({ processId, label }: { processId: string; label: string }) {
  const [state, action] = useActionState(requestCaseBriefAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="processId" value={processId} />
      <div>
        <PendingSubmit icon={<Sparkles />} label={label} pending="Solicitando…" />
      </div>
      {state && !state.ok ? <FormMessage state={state} /> : null}
    </form>
  );
}

function PendingSubmit({ icon, label, pending }: { icon: ReactNode; label: string; pending: string }) {
  const status = useFormStatus();
  return (
    <Button type="submit" disabled={status.pending}>
      {status.pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <span aria-hidden="true">{icon}</span>}
      {status.pending ? pending : label}
    </Button>
  );
}

/** Approve / reject / regenerate buttons of the brief page. */
export function BriefReviewActions({
  briefId,
  processId,
  canDecide,
  canRegenerate,
  className,
}: {
  briefId: string;
  processId: string;
  /** Approve/reject available (brief:review and a reviewable status). */
  canDecide: boolean;
  canRegenerate: boolean;
  className?: string;
}) {
  const uid = useId();
  const hidden = { briefId, processId };
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {canDecide ? (
        <>
          <ConfirmDialog
            action={approveCaseBriefAction}
            hiddenFields={hidden}
            tone="primary"
            trigger={
              <Button type="button">
                <CheckCircle2 aria-hidden="true" />
                Aprovar
              </Button>
            }
            title="Aprovar a análise preliminar?"
            description="A aprovação fica registrada com seu nome e a data. A análise continua sendo apoio: prazos e valores só valem após a validação própria de cada um."
            confirmLabel="Aprovar análise"
            pendingLabel="Aprovando…"
          >
            <FormField label="Observação (opcional)" htmlFor={`${uid}-note`}>
              <Textarea name="note" rows={3} maxLength={2000} placeholder="Ex.: conferido com os autos até a notificação." />
            </FormField>
          </ConfirmDialog>
          <RejectDialog briefId={briefId} processId={processId} />
        </>
      ) : null}
      {canRegenerate ? (
        <ConfirmDialog
          action={regenerateCaseBriefAction}
          hiddenFields={hidden}
          tone="primary"
          trigger={
            <Button type="button" variant="outline">
              <RefreshCw aria-hidden="true" />
              Gerar nova versão
            </Button>
          }
          title="Gerar nova versão da análise?"
          description="Uma nova versão (simulação) será gerada com o cadastro e os documentos atuais do processo. A versão atual e seu histórico de revisões são mantidos."
          confirmLabel="Gerar nova versão"
          pendingLabel="Solicitando…"
        />
      ) : null}
    </div>
  );
}

function RejectDialog({ briefId, processId }: { briefId: string; processId: string }) {
  const uid = useId();
  return (
    <ConfirmDialog
      action={rejectCaseBriefAction}
      hiddenFields={{ briefId, processId }}
      trigger={
        <Button type="button" variant="outline">
          <XCircle aria-hidden="true" />
          Rejeitar
        </Button>
      }
      title="Rejeitar a análise preliminar?"
      description="Informe o motivo. A análise fica registrada como rejeitada e pode ser gerada novamente."
      confirmLabel="Rejeitar análise"
      pendingLabel="Rejeitando…"
    >
      <FormField label="Motivo da rejeição" htmlFor={`${uid}-reason`} required>
        <Textarea name="reason" rows={3} minLength={3} maxLength={2000} required placeholder="Ex.: documentos de outro processo." />
      </FormField>
    </ConfirmDialog>
  );
}
