import { CalendarClock, ListChecks } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OriginBadge } from "@/components/ui/origin-badge";
import { PriorityBadge } from "@/components/ui/priority-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { DEADLINE_KIND_LABELS, TASK_KIND_LABELS, type DeadlineKind, type TaskKind } from "@/domain/enums";
import type { LinkableEntityType } from "@/domain/entities";
import { formatDate, formatNumber, formatRelativeDays, todayISO } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { listDeadlines, listTasks, listWorkUserOptions, type DeadlineListItem, type TaskListItem } from "../service";
import type { FixedWorkLink } from "../types";
import { DeadlineStatusActions } from "./deadline-table";
import { DeleteTaskButton } from "./task-table";
import { TaskStatusForm } from "./task-status-form";
import { NewDeadlineDialog, NewTaskDialog } from "./work-dialogs";
import { DeadlineSituationBadge, TaskStatusBadge } from "./work-badges";

export type EntityWorkItemsProps = {
  ctx: AuthContext;
  entity: { type: LinkableEntityType; id: string };
  /** When "action_plan", only the tasks list is shown (action plan of an occurrence). */
  taskKind?: TaskKind;
  /** Title of the tasks card (e.g. "Plano de ação"). */
  title?: string;
};

const ENTITY_LIMIT = 50;

function linkFor(entity: EntityWorkItemsProps["entity"]): FixedWorkLink {
  switch (entity.type) {
    case "legal_process":
      return { processId: entity.id };
    case "occurrence":
      return { occurrenceId: entity.id };
    case "contract":
      return { contractId: entity.id };
  }
}

function defaultDeadlineKind(type: LinkableEntityType): DeadlineKind {
  return type === "legal_process" ? "procedural" : type === "contract" ? "contractual" : "internal";
}

function DeadlineRow({ d, today, canWrite }: { d: DeadlineListItem; today: string; canWrite: boolean }) {
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between",
        d.isPendingValidation ? "border-dashed border-ai-400 bg-ai-50/50" : d.isOverdue ? "border-red-200 bg-red-50/50" : "border-border",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-900">
          <Link
            href={d.isPendingValidation ? `/prazos?aba=validacao&prazo=${d.id}` : `/prazos?aba=prazos&prazo=${d.id}`}
            className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {d.title}
          </Link>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <time dateTime={d.dueDate} className={cn("font-medium", d.isOverdue ? "text-red-700" : "text-slate-700")}>
            {formatDate(d.dueDate)}
          </time>
          {d.status === "open" && d.countsAsDeadline ? <span>{formatRelativeDays(d.dueDate, today)}</span> : null}
          <span aria-hidden="true">·</span>
          <span>{DEADLINE_KIND_LABELS[d.kind]}</span>
          {d.responsibleName ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{d.responsibleName}</span>
            </>
          ) : null}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <DeadlineSituationBadge status={d.status} validationStatus={d.validationStatus} isOverdue={d.isOverdue} />
          <OriginBadge origin={d.origin} validationStatus={d.validationStatus} />
          <PriorityBadge priority={d.priority} />
        </div>
      </div>
      {canWrite ? (
        <div className="shrink-0">
          {d.isPendingValidation ? (
            <Link
              href={`/prazos?aba=validacao&prazo=${d.id}`}
              className="text-xs font-medium text-ai-700 underline-offset-2 hover:underline"
            >
              Revisar sugestão
            </Link>
          ) : (
            <DeadlineStatusActions item={d} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function TaskRow({ t, today, canWrite }: { t: TaskListItem; today: string; canWrite: boolean }) {
  const active = t.status !== "done" && t.status !== "cancelled";
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between",
        t.isOverdue ? "border-red-200 bg-red-50/50" : "border-border",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={cn("font-medium text-slate-900", t.status === "cancelled" && "line-through decoration-slate-400")}>
          <Link
            href={`/prazos?aba=tarefas&tarefa=${t.id}`}
            className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {t.title}
          </Link>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {t.dueDate ? (
            <>
              <time dateTime={t.dueDate} className={cn("font-medium", t.isOverdue ? "text-red-700" : "text-slate-700")}>
                {formatDate(t.dueDate)}
              </time>
              {active ? <span>{formatRelativeDays(t.dueDate, today)}</span> : null}
            </>
          ) : (
            <span>Sem data limite</span>
          )}
          <span aria-hidden="true">·</span>
          <span>{TASK_KIND_LABELS[t.kind]}</span>
          {t.assigneeName ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{t.assigneeName}</span>
            </>
          ) : null}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {canWrite ? (
            t.isOverdue ? <StatusBadge label="Atrasada" tone="danger" /> : null
          ) : (
            <TaskStatusBadge status={t.status} isOverdue={t.isOverdue} />
          )}
          <OriginBadge origin={t.origin} />
          <PriorityBadge priority={t.priority} />
        </div>
      </div>
      {canWrite ? (
        <div className="flex shrink-0 items-start gap-1">
          <TaskStatusForm key={`${t.id}-${t.status}`} taskId={t.id} taskTitle={t.title} status={t.status} />
          <DeleteTaskButton task={t} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Deadlines and tasks of a process / occurrence / contract (server component),
 * with inline creation dialogs prefilled with the entity link. Scoped by the
 * work service (deadlineWhere / taskWhere).
 */
export async function EntityWorkItems({ ctx, entity, taskKind, title }: EntityWorkItemsProps) {
  const showDeadlines = taskKind !== "action_plan" && can(ctx, "deadline:read");
  const showTasks = can(ctx, "task:read");
  if (!showDeadlines && !showTasks) return null;

  const link = linkFor(entity);
  const canWriteDeadlines = can(ctx, "deadline:write");
  const canWriteTasks = can(ctx, "task:write");
  const today = todayISO();

  const [deadlines, tasks, userOptions] = await Promise.all([
    showDeadlines ? listDeadlines(ctx, { ...link, pageSize: ENTITY_LIMIT }) : null,
    showTasks ? listTasks(ctx, { ...link, kind: taskKind, pageSize: ENTITY_LIMIT }) : null,
    canWriteDeadlines || canWriteTasks ? listWorkUserOptions(ctx) : Promise.resolve([]),
  ]);
  const visibleDeadlines = deadlines?.items.filter((d) => d.validationStatus !== "rejected") ?? [];
  const pendingCount = visibleDeadlines.filter((d) => d.isPendingValidation).length;
  const isActionPlan = taskKind === "action_plan";

  return (
    <div className={cn("grid gap-4", showDeadlines && showTasks && "lg:grid-cols-2")}>
      {showDeadlines && deadlines ? (
        <Card aria-labelledby={`prazos-${entity.id}`}>
          <CardHeader
            actions={
              canWriteDeadlines ? (
                <NewDeadlineDialog
                  userOptions={userOptions}
                  fixedLink={link}
                  defaultKind={defaultDeadlineKind(entity.type)}
                  defaultResponsibleId={ctx.userId}
                  triggerSize="sm"
                  triggerVariant="outline"
                />
              ) : null
            }
          >
            <CardTitle id={`prazos-${entity.id}`} className="flex items-center gap-2">
              <CalendarClock aria-hidden="true" className="size-4 text-slate-500" />
              Prazos
            </CardTitle>
            {pendingCount > 0 ? (
              <p className="text-xs text-ai-700">
                {pendingCount === 1
                  ? "1 sugestão da IA aguardando validação (não conta como prazo até ser validada)."
                  : `${formatNumber(pendingCount)} sugestões da IA aguardando validação (não contam como prazo até serem validadas).`}
              </p>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {visibleDeadlines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum prazo cadastrado para este registro.</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Prazos do registro">
                {visibleDeadlines.map((d) => (
                  <DeadlineRow key={d.id} d={d} today={today} canWrite={canWriteDeadlines} />
                ))}
              </ul>
            )}
            {deadlines.total > ENTITY_LIMIT ? (
              <p className="text-xs text-muted-foreground">
                Exibindo {formatNumber(ENTITY_LIMIT)} de {formatNumber(deadlines.total)} prazos.{" "}
                <Link href="/prazos?aba=prazos" className="font-medium text-primary-700 hover:underline">
                  Ver todos os prazos
                </Link>
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              O sistema não calcula prazos processuais: confirme as regras de contagem aplicáveis.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {showTasks && tasks ? (
        <Card aria-labelledby={`tarefas-${entity.id}`}>
          <CardHeader
            actions={
              canWriteTasks ? (
                <NewTaskDialog
                  userOptions={userOptions}
                  fixedLink={link}
                  defaultKind={taskKind ?? "general"}
                  lockKind={isActionPlan}
                  defaultAssigneeId={ctx.userId}
                  triggerLabel={isActionPlan ? "Nova ação" : "Nova tarefa"}
                  dialogTitle={isActionPlan ? "Nova ação do plano" : "Nova tarefa"}
                  triggerSize="sm"
                  triggerVariant="outline"
                />
              ) : null
            }
          >
            <CardTitle id={`tarefas-${entity.id}`} className="flex items-center gap-2">
              <ListChecks aria-hidden="true" className="size-4 text-slate-500" />
              {title ?? (isActionPlan ? "Plano de ação" : "Tarefas")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {tasks.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {isActionPlan ? "Nenhuma ação cadastrada no plano." : "Nenhuma tarefa cadastrada para este registro."}
              </p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label={isActionPlan ? "Ações do plano" : "Tarefas do registro"}>
                {tasks.items.map((t) => (
                  <TaskRow key={t.id} t={t} today={today} canWrite={canWriteTasks} />
                ))}
              </ul>
            )}
            {tasks.total > ENTITY_LIMIT ? (
              <p className="text-xs text-muted-foreground">
                Exibindo {formatNumber(ENTITY_LIMIT)} de {formatNumber(tasks.total)} tarefas.{" "}
                <Link href="/prazos?aba=tarefas" className="font-medium text-primary-700 hover:underline">
                  Ver todas as tarefas
                </Link>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
