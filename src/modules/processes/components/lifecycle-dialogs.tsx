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
import { CLOSURE_REASON_LABELS, type ClosureReason } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import type { ValuesFormState } from "../schemas";

type Action<S> = (prev: S | null, formData: FormData) => Promise<S>;

const reasonOptions = optionsFromLabels(CLOSURE_REASON_LABELS);

/** Short pt-BR explanation of each closure reason (RN-12). */
const CLOSURE_REASON_HELP: Record<ClosureReason, string> = {
  paid_extinct: "A obrigação foi satisfeita (pagamento) e o processo foi extinto. Registre a quitação também na aba “Valores e risco”.",
  settlement_fulfilled: "O acordo foi integralmente cumprido.",
  dismissed: "Improcedência ou extinção sem ônus para a empresa.",
  archived: "Arquivamento definitivo dos autos.",
  returned_to_origin: "O recurso foi decidido e os autos baixaram à origem; o acompanhamento segue na instância de origem.",
  lost_patronage:
    "Perda do patrocínio: o jurídico/escritório deixou de patrocinar a causa (saída do acervo). O processo sai da carteira ativa, mas valores, documentos e histórico são preservados.",
  other: "Descreva o motivo na observação.",
};

function useDialogAction<S extends ValuesFormState>(action: Action<S>, onDone: () => void) {
  return useActionState(async (prev: S | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) onDone();
    return result;
  }, null);
}

function DialogShell({
  trigger,
  children,
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="md">{children(() => setOpen(false))}</DialogContent>
    </Dialog>
  );
}

function Footer({ confirm, pending }: { confirm: string; pending: string }) {
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button type="button" variant="outline">
          Cancelar
        </Button>
      </DialogClose>
      <SubmitButton pendingLabel={pending}>{confirm}</SubmitButton>
    </DialogFooter>
  );
}

// ---------------------------------------------------------------------------
// Retirar da carteira ativa
// ---------------------------------------------------------------------------

export function CloseProcessDialog<S extends ValuesFormState>({
  action,
  processId,
  processNumber,
  today,
}: {
  action: Action<S>;
  processId: string;
  processNumber: string;
  /** "YYYY-MM-DD" (server time zone). */
  today: string;
}) {
  return (
    <DialogShell
      trigger={
        <Button type="button" variant="outline">
          <Archive aria-hidden="true" />
          Retirar da carteira ativa
        </Button>
      }
    >
      {(close) => <CloseForm action={action} processId={processId} processNumber={processNumber} today={today} onDone={close} />}
    </DialogShell>
  );
}

function CloseForm<S extends ValuesFormState>({
  action,
  processId,
  processNumber,
  today,
  onDone,
}: {
  action: Action<S>;
  processId: string;
  processNumber: string;
  today: string;
  onDone: () => void;
}) {
  const [state, formAction] = useDialogAction(action, onDone);
  const sent = state && !state.ok ? state.values : undefined;
  const [reason, setReason] = useState<string>(sent?.closureReason ?? "");
  const err = (f: string) => fieldError(state, f);
  const help = reason ? CLOSURE_REASON_HELP[reason as ClosureReason] : null;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
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

export function ReactivateProcessDialog<S extends ValuesFormState>({
  action,
  processId,
  closureLabel,
}: {
  action: Action<S>;
  processId: string;
  closureLabel: string | null;
}) {
  return (
    <DialogShell
      trigger={
        <Button type="button" variant="outline">
          <ArchiveRestore aria-hidden="true" />
          Reativar
        </Button>
      }
    >
      {(close) => <ReactivateForm action={action} processId={processId} closureLabel={closureLabel} onDone={close} />}
    </DialogShell>
  );
}

function ReactivateForm<S extends ValuesFormState>({
  action,
  processId,
  closureLabel,
  onDone,
}: {
  action: Action<S>;
  processId: string;
  closureLabel: string | null;
  onDone: () => void;
}) {
  const [state, formAction] = useDialogAction(action, onDone);
  const sent = state && !state.ok ? state.values : undefined;
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Reativar processo</DialogTitle>
        <DialogDescription>
          O processo volta para a carteira ativa com a situação “Ativo”.
          {closureLabel ? ` O motivo de saída registrado (${closureLabel}) e a data de saída serão limpos — continuam no histórico.` : ""}
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
// Verificação
// ---------------------------------------------------------------------------

export function FlagVerificationDialog<S extends ValuesFormState>({
  action,
  processId,
  currentNote,
}: {
  action: Action<S>;
  processId: string;
  /** Present when already flagged (the dialog then edits the note). */
  currentNote?: string | null;
}) {
  return (
    <DialogShell
      trigger={
        <Button type="button" variant="outline">
          <SearchCheck aria-hidden="true" />
          {currentNote !== undefined ? "Editar nota de verificação" : "Marcar para verificação"}
        </Button>
      }
    >
      {(close) => <FlagForm action={action} processId={processId} currentNote={currentNote ?? ""} onDone={close} />}
    </DialogShell>
  );
}

function FlagForm<S extends ValuesFormState>({
  action,
  processId,
  currentNote,
  onDone,
}: {
  action: Action<S>;
  processId: string;
  currentNote: string;
  onDone: () => void;
}) {
  const [state, formAction] = useDialogAction(action, onDone);
  const sent = state && !state.ok ? state.values : undefined;
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Marcar para verificação</DialogTitle>
        <DialogDescription>
          Sinaliza que algum dado precisa ser conferido (ex.: “saiu do acervo?”, valores divergentes entre planilhas). O
          processo aparece com o selo “Verificar” e no filtro “Somente a verificar”.
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={processId} />
      <FormMessage state={state} />
      <FormField label="O que precisa ser verificado" htmlFor="verify-note" required error={fieldError(state, "note")}>
        <Textarea name="note" rows={4} maxLength={2000} required defaultValue={sent?.note ?? currentNote} />
      </FormField>
      <Footer confirm="Salvar marcação" pending="Salvando…" />
    </form>
  );
}

export function ResolveVerificationDialog<S extends ValuesFormState>({
  action,
  processId,
  note,
}: {
  action: Action<S>;
  processId: string;
  note: string | null;
}) {
  return (
    <DialogShell
      trigger={
        <Button type="button" variant="outline">
          <SearchX aria-hidden="true" />
          Concluir verificação
        </Button>
      }
    >
      {(close) => <ResolveForm action={action} processId={processId} note={note} onDone={close} />}
    </DialogShell>
  );
}

function ResolveForm<S extends ValuesFormState>({
  action,
  processId,
  note,
  onDone,
}: {
  action: Action<S>;
  processId: string;
  note: string | null;
  onDone: () => void;
}) {
  const [state, formAction] = useDialogAction(action, onDone);
  const sent = state && !state.ok ? state.values : undefined;
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Concluir verificação</DialogTitle>
        <DialogDescription>Remove o selo “Verificar”. A nota e a conclusão ficam no histórico do processo.</DialogDescription>
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
      <Footer confirm="Concluir verificação" pending="Salvando…" />
    </form>
  );
}
