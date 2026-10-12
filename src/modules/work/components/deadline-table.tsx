import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PriorityBadge } from "@/components/ui/priority-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatRelativeDays } from "@/lib/format";
import { cn } from "@/lib/utils";
import { setDeadlineStatusAction } from "../actions";
import type { DeadlineListItem } from "../service";
import { DeadlineKindBadge, DeadlineSituationBadge, WorkLinks, WorkOriginBadge } from "./work-badges";

/** Concluir / Cancelar (open) or Reabrir (done/cancelled). Only for real deadlines. */
export function DeadlineStatusActions({ item, size = "sm" }: { item: DeadlineListItem; size?: "sm" | "md" }) {
  if (!item.countsAsDeadline) return null;
  if (item.status === "open") {
    return (
      <div className="flex flex-wrap gap-1.5">
        <ConfirmDialog
          action={setDeadlineStatusAction}
          hiddenFields={{ id: item.id, status: "done" }}
          tone="primary"
          triggerLabel="Concluir"
          triggerVariant="outline"
          triggerSize={size}
          title="Marcar prazo como cumprido?"
          description={`"${item.title}" — vencimento em ${formatDate(item.dueDate)}.`}
          confirmLabel="Marcar como cumprido"
        />
        <ConfirmDialog
          action={setDeadlineStatusAction}
          hiddenFields={{ id: item.id, status: "cancelled" }}
          triggerLabel="Cancelar"
          triggerVariant="ghost"
          triggerSize={size}
          title="Cancelar este prazo?"
          description={`"${item.title}" deixará de aparecer como prazo em aberto. A ação fica registrada na auditoria.`}
          confirmLabel="Cancelar prazo"
          cancelLabel="Voltar"
        />
      </div>
    );
  }
  return (
    <ConfirmDialog
      action={setDeadlineStatusAction}
      hiddenFields={{ id: item.id, status: "open" }}
      tone="primary"
      triggerLabel="Reabrir"
      triggerVariant="ghost"
      triggerSize={size}
      title="Reabrir este prazo?"
      description={`"${item.title}" voltará a ser considerado prazo em aberto.`}
      confirmLabel="Reabrir"
    />
  );
}

export function DeadlineTable({
  items,
  today,
  canWrite,
  highlightId,
  emptyMessage = "Nenhum prazo encontrado.",
  emptyDescription,
}: {
  items: DeadlineListItem[];
  today: string;
  canWrite: boolean;
  highlightId?: string;
  emptyMessage?: string;
  emptyDescription?: string;
}) {
  const columns = canWrite ? 9 : 8;
  return (
    <Table aria-label="Prazos">
      <TableHeader>
        <TableRow>
          <TableHead>Prazo</TableHead>
          <TableHead>Data</TableHead>
          <TableHead>Tipo</TableHead>
          <TableHead>Prioridade</TableHead>
          <TableHead>Vínculo</TableHead>
          <TableHead>Responsável</TableHead>
          <TableHead>Origem</TableHead>
          <TableHead>Situação</TableHead>
          {canWrite ? (
            <TableHead>
              <span className="sr-only">Ações</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableEmpty colSpan={columns} message={emptyMessage} description={emptyDescription} />
        ) : (
          items.map((d) => {
            const highlighted = d.id === highlightId;
            return (
              <TableRow
                key={d.id}
                id={`prazo-${d.id}`}
                aria-current={highlighted ? "true" : undefined}
                className={cn(highlighted && "bg-amber-50 outline-2 -outline-offset-2 outline-amber-400")}
              >
                <TableCell className="max-w-72 min-w-48">
                  <p className="font-medium text-slate-900">{d.title}</p>
                  {d.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{d.description}</p> : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <time dateTime={d.dueDate} className="font-medium">
                    {formatDate(d.dueDate)}
                  </time>
                  {d.status === "open" && d.countsAsDeadline ? (
                    <p className={cn("text-xs", d.isOverdue ? "font-medium text-red-700" : "text-muted-foreground")}>
                      {formatRelativeDays(d.dueDate, today)}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <DeadlineKindBadge kind={d.kind} />
                </TableCell>
                <TableCell>
                  <PriorityBadge priority={d.priority} />
                </TableCell>
                <TableCell className="max-w-64 min-w-40 text-sm">
                  <WorkLinks links={d.links} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {d.responsibleName ?? <span className="text-muted-foreground">Sem responsável</span>}
                </TableCell>
                <TableCell>
                  <WorkOriginBadge origin={d.origin} validationStatus={d.validationStatus} sourceKind={d.sourceKind} />
                </TableCell>
                <TableCell>
                  <DeadlineSituationBadge status={d.status} validationStatus={d.validationStatus} isOverdue={d.isOverdue} />
                </TableCell>
                {canWrite ? (
                  <TableCell className="whitespace-nowrap">
                    <DeadlineStatusActions item={d} />
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
