import { Check, Repeat, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OriginBadge } from "@/components/ui/origin-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OBLIGATION_STATUS_LABELS } from "@/domain/enums";
import { formatDate, formatRelativeDays, truncate } from "@/lib/format";
import type { Option } from "@/lib/options";
import { OBLIGATION_STATUS_TONES } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { fulfillObligationAction, removeObligationAction } from "../actions";
import { isOpenObligation, recurrenceDisplay } from "../obligations";
import type { ContractObligationItem } from "../service";
import { ObligationDialog } from "./obligation-dialog";

type Props = {
  contractId: string;
  obligations: ContractObligationItem[];
  users: Option[];
  canWrite: boolean;
  today: string;
};

/** Obligations of a contract with add / edit / fulfil (and generate next) / remove actions for users with contract:write. */
export function ObligationsTable({ contractId, obligations, users, canWrite, today }: Props) {
  const colSpan = canWrite ? 6 : 5;
  return (
    <Table aria-label="Obrigações do contrato">
      <TableHeader>
        <TableRow>
          <TableHead>Obrigação</TableHead>
          <TableHead>Responsável</TableHead>
          <TableHead>Vencimento</TableHead>
          <TableHead>Recorrência</TableHead>
          <TableHead>Situação</TableHead>
          {canWrite ? (
            <TableHead>
              <span className="sr-only">Ações</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {obligations.length === 0 ? (
          <TableEmpty
            colSpan={colSpan}
            message="Nenhuma obrigação cadastrada."
            description="Registre entregas, pagamentos, relatórios ou outras obrigações assumidas no contrato."
          />
        ) : (
          obligations.map((o) => {
            const open = isOpenObligation(o.status);
            const late = o.effectiveStatus === "overdue";
            const name = truncate(o.description, 60);
            const recurring = o.recurrenceKind !== "none" && o.recurrenceKind !== "custom";
            return (
              <TableRow key={o.id}>
                <TableCell className="max-w-md min-w-56">
                  <p className="whitespace-pre-line text-slate-900">{o.description}</p>
                  {o.origin !== "manual" ? (
                    <div className="mt-1">
                      <OriginBadge origin={o.origin} />
                    </div>
                  ) : null}
                  {o.origin === "ai_suggested" ? (
                    <p className="mt-1 text-xs text-ai-800">
                      Item sugerido a partir de análise de IA. Confirme com a leitura do contrato.
                    </p>
                  ) : null}
                  {o.origin === "system" ? (
                    <p className="mt-1 text-xs text-muted-foreground">Ocorrência gerada pela recorrência da obrigação anterior.</p>
                  ) : null}
                </TableCell>
                <TableCell>{o.responsibleName ?? <span className="text-muted-foreground">Sem responsável</span>}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {o.dueDate ? (
                    <>
                      <span className="tabular-nums">{formatDate(o.dueDate)}</span>
                      {open ? (
                        <span className={cn("block text-xs", late ? "font-medium text-red-700" : "text-muted-foreground")}>
                          {formatRelativeDays(o.dueDate, today)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Sem data</span>
                  )}
                </TableCell>
                <TableCell className="min-w-28">
                  {o.recurrence ? (
                    <span className="inline-flex items-center gap-1.5">
                      {recurring ? <Repeat aria-hidden="true" className="size-3.5 text-muted-foreground" /> : null}
                      {recurrenceDisplay(o.recurrence)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Única</span>
                  )}
                  {o.recurrenceKind === "custom" ? (
                    <span className="block text-xs text-muted-foreground">Texto livre, sem geração automática</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge label={OBLIGATION_STATUS_LABELS[o.effectiveStatus]} tone={OBLIGATION_STATUS_TONES[o.effectiveStatus]} />
                </TableCell>
                {canWrite ? (
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {open ? <FulfillDialog obligation={o} name={name} /> : null}
                      <ObligationDialog
                        contractId={contractId}
                        users={users}
                        triggerLabel={`Editar obrigação: ${name}`}
                        obligation={{
                          id: o.id,
                          description: o.description,
                          responsibleId: o.responsibleId,
                          dueDate: o.dueDate,
                          recurrence: o.recurrence,
                          status: o.status,
                        }}
                      />
                      <ConfirmDialog
                        action={removeObligationAction}
                        hiddenFields={{ id: o.id }}
                        title="Remover obrigação?"
                        description="A obrigação será removida deste contrato. A remoção fica registrada no histórico."
                        confirmLabel="Remover"
                        trigger={
                          <Button type="button" variant="ghost" size="sm" aria-label={`Remover obrigação: ${name}`}>
                            <Trash2 aria-hidden="true" />
                          </Button>
                        }
                      />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

/** "Cumprir" — for recurring obligations the dialog offers to generate the next occurrence (checked by default). */
function FulfillDialog({ obligation: o, name }: { obligation: ContractObligationItem; name: string }) {
  const canGenerate = o.nextDueDate !== null && o.nextBlockedReason === null;
  return (
    <ConfirmDialog
      action={fulfillObligationAction}
      hiddenFields={{ id: o.id }}
      tone="primary"
      title={canGenerate ? "Cumprir e gerar a próxima ocorrência?" : "Marcar obrigação como cumprida?"}
      description="A situação passará para “Cumprida”. A alteração fica registrada no histórico do contrato."
      confirmLabel={canGenerate ? "Confirmar" : "Marcar como cumprida"}
      trigger={
        <Button type="button" variant="ghost" size="sm" aria-label={`${canGenerate ? "Cumprir e gerar próxima" : "Marcar como cumprida"}: ${name}`}>
          <Check aria-hidden="true" />
          <span className="hidden sm:inline">{canGenerate ? "Cumprir e gerar próxima" : "Cumprida"}</span>
        </Button>
      }
    >
      {canGenerate ? (
        <Checkbox
          id={`generate-next-${o.id}`}
          name="generateNext"
          defaultChecked
          label={`Gerar a próxima ocorrência com vencimento em ${formatDate(o.nextDueDate)}`}
          description={`Recorrência ${recurrenceDisplay(o.recurrence).toLowerCase()}: mesma descrição e responsável. Desmarque para apenas cumprir esta.`}
        />
      ) : o.nextBlockedReason ? (
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-slate-700">{o.nextBlockedReason}</p>
      ) : null}
    </ConfirmDialog>
  );
}
