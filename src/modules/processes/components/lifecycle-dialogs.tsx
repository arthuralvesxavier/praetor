"use client";

import { Archive, ArchiveRestore, SearchCheck, SearchX } from "lucide-react";
import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { CLOSURE_REASON_LABELS, type ClosureReason } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import type { ValuesFormState } from "../schemas";

type Action<S> = (prev: S | null, formData: FormData) => Promise<S>;

const reasonOptions = optionsFromLabels(CLOSURE_REASON_LABELS);

/** Short pt-BR explanation of each closure reason (RN-12). */
const CLOSURE_REASON_HELP: Record<ClosureReason, string> = {
  paid_extinct: "A obrigação foi satisfeita (pagamento) e o processo foi extinto. Registre a quitação também na aba “Valores e acordos”.",
  settlement_fulfilled: "O acordo foi integralmente cumprido.",
  dismissed: "Improcedência ou extinção sem ônus para a empresa.",
  archived: "Arquivamento definitivo dos autos.",
  returned_to_origin: "O recurso foi decidido e os autos baixaram à origem; o acompanhamento segue na instância de origem.",
  lost_patronage:
    "Perda do patrocínio: o jurídico/escritório deixou de patrocinar a causa (saída do acervo). O processo sai da carteira ativa, mas valores, documentos e histórico são preservados.",
  other: "Descreva o motivo na observação.",
};

/**
 * `useActionState` for a dialog form: calls `onDone` (closes the dialog) on success and
 * returns the `onSubmit` handler that keeps typed values AND selects on error.
 */
function useDialogAction<S extends ValuesFormState>(action: Action<S>, onDone: () => void) {
  const [state, formAction] = useActionState(async (prev: S | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) onDone();
    return result;
  }, null);
  const onSubmit = usePreservingSubmit(formAction);
  return { state, formAction, onSubmit };
}

/** Dialog opened by its own trigger button (forms below also work in a controlled dialog). */
function DialogShell({ trigger, children }: { trigger: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="md">{children(() => setOpen(false))}</DialogContent>
    </Dialog>
  );
}

function Footer({ confirm, pending, destructive = false }: { confirm: string; pending: string; destructive?: boolean }) {
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button type="button" variant="outline">
          Cancelar
        </Button>
      </DialogClose>
      <SubmitButton pendingLabel={pending} variant={destructive ? "destructive" : "primary"}>
        {confirm}
      </SubmitButton>
    </DialogFooter>
  );
}

// ---------------------------------------------------------------------------
// Retirar da carteira ativa
// ---------------------------------------------------------------------------

export type CloseProcessFormProps<S> = {
  action: Action<S>;
  processId: string;
  processNumber: string;
  /** "YYYY-MM-DD" (server time zone). */
  today: string;
  onDone: () => void;
};

export function CloseProcessDialog<S extends ValuesFormState>(props: Omit<CloseProcessFormProps<S>, "onDone">) {
  return (
    <DialogShell
      trigger={
        <Button type="button" variant="outline">
          <Archive aria-hidden="true" />
          Retirar da carteira ativa
        </Button>
      }
    >
      {(close) => <CloseProcessForm {...props} onDone={close} />}
    </DialogShell>
  );
}

export function CloseProcessForm<S extends ValuesFormState>({ action, processId, processNumber, today, onDone }: CloseProcessFormProps<S>) {
  const { state, formAction, onSubmit } = useDialogAction(action, onDone);
  const sent = state && !state.ok ? state.values : undefined;
  const [reason, setReason] = useState<string>(sent?.closureReason ?? "");
  const err = (f: string) => fieldError(state, f);
  const help = reason ? CLOSURE_REASON_HELP[reason as ClosureReason] : null;

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Retirar da carteira ativa</DialogTitle>
        <DialogDescription>
          O processo {processNumber} deixa de contar na carteira ativa. Nada é apagado: valores, documentos e
          histórico continuam disponíveis, e é possível reativá-lo depois.
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={processId} />
      <FormMessage state={state} />
      <FormField label="Motivo da saída" htmlFor="close-reason" required error={err("closureReason")}>
        <NativeSelect
          name="closureReason"
          options={reasonOptions}
          placeholder="Selecione…"
          required
          defaultValue={sent?.closureReason ?? ""}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
      </FormField>
      {help ? (
        <Callout tone={reason === "lost_patronage" ? "warning" : "info"} aria-live="polite">
          {help}
        </Callout>
      ) : null}
      <FormField label="Data da saída" htmlFor="close-date" error={err("closedAt")} hint="Padrão: hoje.">
        <Input name="closedAt" type="date" max={today} defaultValue={sent?.closedAt ?? today} />
      </FormField>
      <FormField label="Observação" htmlFor="close-note" error={err("note")} hint="Opcional. Fica registrada no histórico.">
        <Textarea name="note" rows={3} maxLength={500} defaultValue={sent?.note ?? ""} />
      </FormField>
      <Footer confirm="Retirar da carteira" pending="Salvando…" />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Reativar
// ---------------------------------------------------------------------------

export type ReactivateProcessFormProps<S> = {
  action: Action<S>;
  processId: string;
  closureLabel: string | null;
  onDone: () => void;
};

export function ReactivateProcessDialog<S extends ValuesFormState>(props: Omit<ReactivateProcessFormProps<S>, "onDone">) {
  return (
    <DialogShell
      trigger={
        <Button type="button" variant="outline">
          <ArchiveRestore aria-hidden="true" />
          Reativar
        </Button>
      }
    >
      {(close) => <ReactivateProcessForm {...props} onDone={close} />}
    </DialogShell>
  );
}

export function ReactivateProcessForm<S extends ValuesFormState>({ action, processId, closureLabel, onDone }: ReactivateProcessFormProps<S>) {
  const { state, formAction, onSubmit } = useDialogAction(action, onDone);
  const sent = state && !state.ok ? state.values : undefined;
  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Reativar processo</DialogTitle>
        <DialogDescription>
          O processo volta para a carteira ativa com a situação “Ativo”.
          {closureLabel
            ? ` O motivo de saída registrado (${closureLabel}) e a data de saída serão limpos, mas continuam no histórico.`
            : ""}
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={processId} />
      <FormMessage state={state} />
      <FormField label="Observação" htmlFor="reactivate-note" error={fieldError(state, "note")} hint="Opcional. Fica registrada no histórico.">
        <Textarea name="note" rows={3} maxLength={500} defaultValue={sent?.note ?? ""} />
      </FormField>
      <Footer confirm="Reativar" pending="Reativando…" />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Conferência (needsVerification)
// ---------------------------------------------------------------------------

export type FlagVerificationFormProps<S> = {
  action: Action<S>;
  processId: string;
  /** Present when already flagged (the form then edits the note). */
  currentNote?: string | null;
  onDone: () => void;
};

export function FlagVerificationDialog<S extends ValuesFormState>(props: Omit<FlagVerificationFormProps<S>, "onDone">) {
  return (
    <DialogShell
      trigger={
        <Button type="button" variant="outline">
          <SearchCheck aria-hidden="true" />
          {props.currentNote !== undefined ? "Editar nota de conferência" : "Marcar para conferência"}
        </Button>
      }
    >
      {(close) => <FlagVerificationForm {...props} onDone={close} />}
    </DialogShell>
  );
}

export function FlagVerificationForm<S extends ValuesFormState>({ action, processId, currentNote, onDone }: FlagVerificationFormProps<S>) {
  const { state, formAction, onSubmit } = useDialogAction(action, onDone);
  const sent = state && !state.ok ? state.values : undefined;
  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Marcar para conferência</DialogTitle>
        <DialogDescription>
          Sinaliza que algum dado precisa ser conferido (ex.: “saiu do acervo?”, valores divergentes entre planilhas). O
          processo aparece com o selo “Pendente de conferência” e no filtro “Somente pendentes de conferência”.
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={processId} />
      <FormMessage state={state} />
      <FormField label="O que precisa ser conferido" htmlFor="verify-note" required error={fieldError(state, "note")}>
        <Textarea name="note" rows={4} maxLength={2000} required defaultValue={sent?.note ?? currentNote ?? ""} />
      </FormField>
      <Footer confirm="Salvar marcação" pending="Salvando…" />
    </form>
  );
}

export type ResolveVerificationFormProps<S> = {
  action: Action<S>;
  processId: string;
  note: string | null;
  onDone: () => void;
};

export function ResolveVerificationDialog<S extends ValuesFormState>(props: Omit<ResolveVerificationFormProps<S>, "onDone">) {
  return (
    <DialogShell
      trigger={
        <Button type="button" variant="outline">
          <SearchX aria-hidden="true" />
          Concluir conferência
        </Button>
      }
    >
      {(close) => <ResolveVerificationForm {...props} onDone={close} />}
    </DialogShell>
  );
}

export function ResolveVerificationForm<S extends ValuesFormState>({ action, processId, note, onDone }: ResolveVerificationFormProps<S>) {
  const { state, formAction, onSubmit } = useDialogAction(action, onDone);
  const sent = state && !state.ok ? state.values : undefined;
  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Concluir conferência</DialogTitle>
        <DialogDescription>Remove o selo “Pendente de conferência”. A nota e a conclusão ficam no histórico do processo.</DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={processId} />
      {note ? (
        <div className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">
          <p className="text-xs font-medium text-muted-foreground">Pendência registrada</p>
          <p className="mt-0.5 whitespace-pre-line text-slate-900">{note}</p>
        </div>
      ) : null}
      <FormMessage state={state} />
      <FormField label="Conclusão" htmlFor="resolve-note" error={fieldError(state, "note")} hint="Opcional. Fica registrada no histórico.">
        <Textarea name="note" rows={3} maxLength={500} defaultValue={sent?.note ?? ""} />
      </FormField>
      <Footer confirm="Concluir conferência" pending="Salvando…" />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Excluir
// ---------------------------------------------------------------------------

export type DeleteProcessFormProps<S> = {
  action: Action<S>;
  processId: string;
  processNumber: string;
  onDone: () => void;
};

/** Confirmation of the soft delete (the action redirects to /processos on success). */
export function DeleteProcessForm<S extends ValuesFormState>({ action, processId, processNumber, onDone }: DeleteProcessFormProps<S>) {
  const { state, formAction, onSubmit } = useDialogAction(action, onDone);
  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Excluir processo?</DialogTitle>
        <DialogDescription>
          O processo {processNumber} deixará de aparecer nas listagens. A exclusão fica registrada na auditoria. Para
          tirá-lo apenas da carteira ativa, use “Retirar da carteira ativa”.
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={processId} />
      <FormMessage state={state} />
      <Footer confirm="Excluir processo" pending="Excluindo…" destructive />
    </form>
  );
}
