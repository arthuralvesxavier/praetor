"use client";

import { Check, CheckCheck, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { CORRECTION_INDEX_LABELS, type CorrectionIndex } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { cn } from "@/lib/utils";
import { ValuationUpdatedValue } from "@/modules/indices/components/valuation-values";
import type { ValuationUpdate } from "@/modules/indices/types";
import { bulkApproveValuationsAction, reviewValuationAction } from "../actions";

/** "IPCA-E", "Sem atualização" or "sem índice informado" (P1.7). */
function correctionIndexText(index: CorrectionIndex | null): string {
  return index ? CORRECTION_INDEX_LABELS[index] : "sem índice informado";
}

/**
 * Approve / correct (inline amount) / reject one proposed valuation (RN-11).
 * `correctionIndex` (P1.7): the index shown to the reviewer; it is sent with the
 * decision and the service refuses an approval or correction if it changed since.
 */
export function ReviewActions({
  id,
  amountInput,
  correctionIndex,
}: {
  id: string;
  amountInput: string;
  correctionIndex?: CorrectionIndex | null;
}) {
  const [mode, setMode] = useState<"approve" | "correct" | "reject">("approve");
  const [state, action] = useActionState(reviewValuationAction, null);
  return (
    <div className="space-y-3">
      <div role="group" aria-label="Decisão da conferência" className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant={mode === "approve" ? "primary" : "outline"} aria-pressed={mode === "approve"} onClick={() => setMode("approve")}>
          <Check aria-hidden="true" />
          Aprovar
        </Button>
        <Button type="button" size="sm" variant={mode === "correct" ? "primary" : "outline"} aria-pressed={mode === "correct"} onClick={() => setMode("correct")}>
          <Pencil aria-hidden="true" />
          Corrigir
        </Button>
        <Button type="button" size="sm" variant={mode === "reject" ? "destructive" : "outline"} aria-pressed={mode === "reject"} onClick={() => setMode("reject")}>
          <X aria-hidden="true" />
          Rejeitar
        </Button>
      </div>
      <form action={action} className="space-y-3 rounded-md border border-border bg-surface-muted p-3" key={mode}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value={mode} />
        {correctionIndex !== undefined ? (
          <input type="hidden" name="expectedCorrectionIndex" value={correctionIndex ?? ""} />
        ) : null}
        <FormMessage state={state} />
        {correctionIndex !== undefined && mode !== "reject" ? (
          <p className="text-sm text-slate-700">
            Índice de atualização: <strong>{correctionIndexText(correctionIndex)}</strong>. O valor fica oficial com este
            índice; depois, somente quem confere valores troca o índice, com um novo registro de mesmo valor e data-base.
          </p>
        ) : null}
        {mode === "correct" ? (
          <FormField
            label="Valor corrigido (R$)"
            htmlFor={`corrected-${id}`}
            required
            error={fieldError(state, "correctedAmountCents")}
            hint="O valor proposto fica registrado como rejeitado e um novo valor oficial é criado; nenhum registro anterior é apagado ou alterado."
          >
            <Input name="correctedAmount" inputMode="decimal" defaultValue={amountInput} autoFocus required />
          </FormField>
        ) : null}
        <FormField
          label={mode === "reject" ? "Motivo da rejeição" : "Observação (opcional)"}
          htmlFor={`note-${id}-${mode}`}
          required={mode === "reject"}
          error={fieldError(state, "note")}
        >
          <Textarea name="note" rows={2} maxLength={1000} required={mode === "reject"} />
        </FormField>
        <SubmitButton
          size="sm"
          variant={mode === "reject" ? "destructive" : "primary"}
          pendingLabel="Registrando…"
        >
          {mode === "approve" ? "Aprovar e oficializar" : mode === "correct" ? "Corrigir e oficializar" : "Rejeitar valor"}
        </SubmitButton>
        <p className="text-xs text-muted-foreground">Sua identificação fica registrada como responsável pela conferência.</p>
      </form>
    </div>
  );
}

export type QueueRow = {
  id: string;
  href: string;
  selected: boolean;
  processNumber: string;
  processTitle: string;
  kindLabel: string;
  amount: string;
  currentOfficial: string | null;
  baseDate: string;
  sourceLabel: string;
  isSimulation: boolean;
  confidence: number | null;
  bulkEligible: boolean;
  documentLabel: string | null;
  /** P1.7: index of the proposal (null = sem índice informado), pinned on bulk approval. */
  correctionIndex: CorrectionIndex | null;
  /** P1.7: updated value computed on read (`computeValuationUpdates`); undefined = not calculated. */
  update?: ValuationUpdate;
};

/** Queue table with bulk approval of high-confidence items (RN-11); simulated extractions are never bulk-eligible. */
export function ReviewQueueTable({ rows, canApprove, threshold }: { rows: QueueRow[]; canApprove: boolean; threshold: number }) {
  const [state, action] = useActionState(bulkApproveValuationsAction, null);
  const eligible = rows.filter((r) => r.bulkEligible).map((r) => r.id);
  const [selected, setSelected] = useState<string[]>([]);
  // Rows approved by a previous submit disappear after revalidation: only count what is still listed.
  const effective = selected.filter((id) => eligible.includes(id));
  const allSelected = eligible.length > 0 && eligible.every((id) => effective.includes(id));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <form action={action} className="flex flex-col gap-3">
      {canApprove ? (
        <div className="flex flex-wrap items-center gap-2 px-5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={eligible.length === 0}
            onClick={() => setSelected(allSelected ? [] : eligible)}
          >
            {allSelected ? "Desmarcar todos" : `Selecionar alta confiança (${eligible.length})`}
          </Button>
          <SubmitButton size="sm" disabled={effective.length === 0} pendingLabel="Aprovando…">
            <CheckCheck aria-hidden="true" />
            Aprovar selecionados ({effective.length})
          </SubmitButton>
          <span className="text-xs text-muted-foreground">
            Conferência em lote só para confiança ≥ {threshold}%
            {rows.some((r) => r.isSimulation) ? "; extrações simuladas nunca entram no lote: confira cada uma no documento." : "."}
          </span>
        </div>
      ) : null}
      {state ? <FormMessage state={state} className="mx-5" /> : null}
      <Table aria-label="Valores aguardando conferência">
        <TableHeader>
          <TableRow>
            {canApprove ? (
              <TableHead className="w-10">
                <span className="sr-only">Selecionar</span>
              </TableHead>
            ) : null}
            <TableHead>Processo</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead className="text-right">Valor proposto</TableHead>
            <TableHead className="text-right">Índice e valor atualizado</TableHead>
            <TableHead>Origem</TableHead>
            <TableHead className="text-right">Confiança</TableHead>
            <TableHead>
              <span className="sr-only">Conferir</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmpty colSpan={canApprove ? 8 : 7} message="Nenhum valor aguardando conferência." description="Valores propostos por planilha, documento ou lançamento de advogado aparecerão aqui." />
          ) : (
            rows.map((r) => (
              <TableRow key={r.id} className={cn(r.selected && "bg-primary-50/60")}>
                {canApprove ? (
                  <TableCell>
                    {r.bulkEligible ? (
                      <>
                        <input
                          type="checkbox"
                          name="ids"
                          value={r.id}
                          checked={selected.includes(r.id)}
                          onChange={() => toggle(r.id)}
                          aria-label={`Selecionar ${r.kindLabel} de ${r.processNumber} para aprovação em lote`}
                          className="size-4 cursor-pointer rounded border-border-strong accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        />
                        {/* P1.7: the index shown in this row; a row whose index changed since is refused. */}
                        <input type="hidden" name={`expectedCorrectionIndex:${r.id}`} value={r.correctionIndex ?? ""} />
                      </>
                    ) : (
                      <span className="sr-only">
                        {r.isSimulation ? "Conferência individual: extração simulada" : "Conferência individual"}
                      </span>
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="min-w-44">
                  <span className="block font-medium tabular-nums text-slate-900">{r.processNumber}</span>
                  <span className="block truncate text-xs text-muted-foreground" title={r.processTitle}>
                    {r.processTitle}
                  </span>
                </TableCell>
                <TableCell className="min-w-32 text-sm">
                  {r.kindLabel}
                  <span className="block text-xs text-muted-foreground">data-base {r.baseDate}</span>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {r.amount}
                  {r.currentOfficial ? <span className="block text-xs text-muted-foreground">oficial: {r.currentOfficial}</span> : null}
                </TableCell>
                <TableCell className="min-w-44 text-right">
                  <span className="block text-xs font-medium text-slate-700">{`Índice: ${correctionIndexText(r.correctionIndex)}`}</span>
                  <ValuationUpdatedValue update={r.update} compact />
                </TableCell>
                <TableCell className="min-w-40 text-sm">
                  {r.isSimulation ? <Badge tone="warning">{r.sourceLabel}</Badge> : r.sourceLabel}
                  {r.documentLabel ? <span className="block text-xs text-muted-foreground">{r.documentLabel}</span> : null}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {r.confidence === null ? (
                    <span className="text-xs text-muted-foreground">não informada</span>
                  ) : (
                    <span className={cn(r.bulkEligible ? "text-emerald-800" : "text-amber-800")}>
                      {r.confidence}%
                      <span className="block text-xs">
                        {r.isSimulation ? "simulada · individual" : r.bulkEligible ? "alta" : "baixa"}
                      </span>
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    href={r.href}
                    aria-current={r.selected ? "true" : undefined}
                    className="inline-flex h-8 items-center rounded-md px-2 text-sm font-medium text-primary-600 hover:bg-primary-50 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {r.selected ? "Em conferência" : "Conferir"}
                  </Link>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </form>
  );
}
