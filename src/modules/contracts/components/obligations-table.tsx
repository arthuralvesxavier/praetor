import { Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OriginBadge } from "@/components/ui/origin-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OBLIGATION_STATUS_LABELS } from "@/domain/enums";
import { daysUntil, formatDate, formatRelativeDays, truncate } from "@/lib/format";
import type { Option } from "@/lib/options";
import { OBLIGATION_STATUS_TONES } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { removeObligationAction, setObligationStatusAction } from "../actions";
import type { ContractObligationItem } from "../service";
import { ObligationDialog } from "./obligation-dialog";

type Props = {
  contractId: string;
  obligations: ContractObligationItem[];
  users: Option[];
  canWrite: boolean;
  today: string;
};

function isOpen(status: ContractObligationItem["status"]) {
  return status === "pending" || status === "overdue";
}

/** Obligations of a contract with add / edit / fulfil / remove actions for users with contract:write. */
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
            const late = isOpen(o.status) && o.dueDate !== null && daysUntil(o.dueDate, today) < 0;
            const name = truncate(o.description, 60);
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
                      Item sugerido a partir de análise de IA — confirme com a leitura do contrato.
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>{o.responsibleName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {o.dueDate ? (
                    <>
                      <span className="tabular-nums">{formatDate(o.dueDate)}</span>
                      {isOpen(o.status) ? (
                        <span className={cn("block text-xs", late ? "font-medium text-red-700" : "text-muted-foreground")}>
                          {formatRelativeDays(o.dueDate, today)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Sem data</span>
                  )}
                </TableCell>
                <TableCell>{o.recurrence ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>
                  <StatusBadge label={OBLIGATION_STATUS_LABELS[o.status]} tone={OBLIGATION_STATUS_TONES[o.status]} />
                </TableCell>
                {canWrite ? (
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {isOpen(o.status) ? (
                        <ConfirmDialog
                          action={setObligationStatusAction}
                          hiddenFields={{ id: o.id, status: "fulfilled" }}
                          tone="primary"
                          title="Marcar obrigação como cumprida?"
                          description="A situação passará para “Cumprida”. A alteração fica registrada no histórico."
                          confirmLabel="Marcar como cumprida"
                          trigger={
                            <Button type="button" variant="ghost" size="sm" aria-label={`Marcar como cumprida: ${name}`}>
                              <Check aria-hidden="true" />
                              <span className="hidden sm:inline">Cumprida</span>
                            </Button>
                          }
                        />
                      ) : null}
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
