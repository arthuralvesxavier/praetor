import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PriorityBadge } from "@/components/ui/priority-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TASK_KIND_LABELS } from "@/domain/enums";
import { formatDate, formatRelativeDays } from "@/lib/format";
import { cn } from "@/lib/utils";
import { deleteTaskAction } from "../actions";
import type { TaskListItem } from "../service";
import { TaskStatusForm } from "./task-status-form";
import { TaskStatusBadge, WorkLinks, WorkOriginBadge } from "./work-badges";

export function DeleteTaskButton({ task }: { task: TaskListItem }) {
  if (!task.canDelete) return null;
  return (
    <ConfirmDialog
      action={deleteTaskAction}
      hiddenFields={{ id: task.id }}
      triggerLabel="Excluir"
      triggerVariant="ghost"
      triggerSize="sm"
      title="Excluir tarefa?"
      description={`"${task.title}" será removida das listas. Para manter o histórico, prefira alterar o status para "Cancelada".`}
      confirmLabel="Excluir tarefa"
    />
  );
}

export function TaskTable({
  items,
  today,
  canWrite,
  highlightId,
  emptyMessage = "Nenhuma tarefa encontrada.",
  emptyDescription,
}: {
  items: TaskListItem[];
  today: string;
  canWrite: boolean;
  highlightId?: string;
  emptyMessage?: string;
  emptyDescription?: string;
}) {
  const columns = canWrite ? 9 : 8;
  return (
    <Table aria-label="Tarefas">
      <TableHeader>
        <TableRow>
          <TableHead>Tarefa</TableHead>
          <TableHead>Data limite</TableHead>
          <TableHead>Tipo</TableHead>
          <TableHead>Prioridade</TableHead>
          <TableHead>Vínculo</TableHead>
          <TableHead>Responsável</TableHead>
          <TableHead>Origem</TableHead>
          <TableHead>Status</TableHead>
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
          items.map((t) => {
            const highlighted = t.id === highlightId;
            const active = t.status !== "done" && t.status !== "cancelled";
            return (
              <TableRow
                key={t.id}
                id={`tarefa-${t.id}`}
                aria-current={highlighted ? "true" : undefined}
                className={cn(highlighted && "bg-amber-50 outline-2 -outline-offset-2 outline-amber-400")}
              >
                <TableCell className="max-w-72 min-w-48">
                  <p className={cn("font-medium text-slate-900", t.status === "cancelled" && "line-through decoration-slate-400")}>
                    {t.title}
                  </p>
                  {t.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{t.description}</p> : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {t.dueDate ? (
                    <>
                      <time dateTime={t.dueDate} className="font-medium">
                        {formatDate(t.dueDate)}
                      </time>
                      {active ? (
                        <p className={cn("text-xs", t.isOverdue ? "font-medium text-red-700" : "text-muted-foreground")}>
                          {formatRelativeDays(t.dueDate, today)}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Sem data</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">{TASK_KIND_LABELS[t.kind]}</TableCell>
                <TableCell>
                  <PriorityBadge priority={t.priority} />
                </TableCell>
                <TableCell className="max-w-64 min-w-40 text-sm">
                  <WorkLinks links={t.links} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {t.assigneeName ?? <span className="text-muted-foreground">Sem responsável</span>}
                </TableCell>
                <TableCell>
                  <WorkOriginBadge origin={t.origin} sourceKind={t.sourceKind} />
                </TableCell>
                <TableCell>
                  {canWrite ? (
                    <div className="flex flex-col gap-1">
                      <TaskStatusForm key={`${t.id}-${t.status}`} taskId={t.id} taskTitle={t.title} status={t.status} />
                      {t.isOverdue ? <StatusBadge label="Atrasada" tone="danger" className="self-start" /> : null}
                    </div>
                  ) : (
                    <TaskStatusBadge status={t.status} isOverdue={t.isOverdue} />
                  )}
                </TableCell>
                {canWrite ? (
                  <TableCell className="whitespace-nowrap">
                    <DeleteTaskButton task={t} />
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
