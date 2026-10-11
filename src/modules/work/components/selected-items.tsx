import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { OriginBadge } from "@/components/ui/origin-badge";
import { PriorityBadge } from "@/components/ui/priority-badge";
import { TASK_KIND_LABELS } from "@/domain/enums";
import { formatDate, formatDateTime, formatRelativeDays } from "@/lib/format";
import { CommentThread } from "@/modules/comments/components/comment-thread";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import type { DeadlineListItem, TaskListItem } from "../service";
import { DeadlineStatusActions } from "./deadline-table";
import { DeleteTaskButton } from "./task-table";
import { TaskStatusForm } from "./task-status-form";
import { SourceAnalysisLink, SourceExcerpt } from "./validation-list";
import { DeadlineKindBadge, DeadlineSituationBadge, TaskStatusBadge, WorkLinks } from "./work-badges";

/** Detail of the deadline selected with `?prazo=<id>` (deep links from alerts, calendar, entity pages). */
export function SelectedDeadline({ ctx, item, today }: { ctx: AuthContext; item: DeadlineListItem; today: string }) {
  const canWrite = can(ctx, "deadline:write");
  return (
    <Card aria-labelledby="prazo-selecionado" className="border-amber-300 ring-2 ring-amber-100">
      <CardHeader actions={canWrite ? <DeadlineStatusActions item={item} size="md" /> : null}>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Prazo selecionado</p>
        <CardTitle id="prazo-selecionado">{item.title}</CardTitle>
        <div className="flex flex-wrap gap-1.5">
          <DeadlineSituationBadge status={item.status} validationStatus={item.validationStatus} isOverdue={item.isOverdue} />
          <OriginBadge origin={item.origin} validationStatus={item.validationStatus} />
          <DeadlineKindBadge kind={item.kind} />
          <PriorityBadge priority={item.priority} withPrefix />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <DescriptionList
          columns={3}
          items={[
            {
              label: item.isPendingValidation ? "Data sugerida" : "Data final",
              value: (
                <span>
                  <time dateTime={item.dueDate} className="font-medium">
                    {formatDate(item.dueDate)}
                  </time>
                  {item.status === "open" && item.countsAsDeadline ? (
                    <span className={item.isOverdue ? "ml-1 text-red-700" : "ml-1 text-muted-foreground"}>
                      ({formatRelativeDays(item.dueDate, today)})
                    </span>
                  ) : null}
                </span>
              ),
            },
            { label: "Responsável", value: item.responsibleName ?? "Sem responsável" },
            { label: "Vínculo", value: <WorkLinks links={item.links} /> },
            item.completedAt ? { label: "Cumprido em", value: formatDateTime(item.completedAt) } : null,
            item.validatedAt
              ? {
                  label: item.validationStatus === "rejected" ? "Rejeitado por" : "Validado por",
                  value: `${item.validatedByName ?? "—"} em ${formatDateTime(item.validatedAt)}`,
                }
              : null,
            item.validationNote ? { label: "Observação da validação", value: item.validationNote, full: true } : null,
            item.sourceAnalysisId ? { label: "Origem", value: <SourceAnalysisLink item={item} /> } : null,
            item.description ? { label: "Descrição", value: item.description, full: true } : null,
          ]}
        />
        <SourceExcerpt item={item} />
        {item.isPendingValidation ? (
          <Callout tone="ai" title="Sugestão da IA aguardando validação">
            Este prazo ainda não conta nos indicadores e alertas.{" "}
            <Link href={`/prazos?aba=validacao&prazo=${item.id}`}>
              {can(ctx, "deadline:validate") ? "Validar ou rejeitar a sugestão" : "Ver na aba Validação"}
            </Link>
            .
          </Callout>
        ) : null}
        {can(ctx, "deadline:read") ? <CommentThread ctx={ctx} entity={{ type: "deadline", id: item.id }} bare /> : null}
      </CardContent>
    </Card>
  );
}

/** Detail of the task selected with `?tarefa=<id>`. */
export function SelectedTask({ ctx, item, today }: { ctx: AuthContext; item: TaskListItem; today: string }) {
  const canWrite = can(ctx, "task:write");
  const active = item.status !== "done" && item.status !== "cancelled";
  return (
    <Card aria-labelledby="tarefa-selecionada" className="border-amber-300 ring-2 ring-amber-100">
      <CardHeader actions={canWrite ? <DeleteTaskButton task={item} /> : null}>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Tarefa selecionada</p>
        <CardTitle id="tarefa-selecionada">{item.title}</CardTitle>
        <div className="flex flex-wrap gap-1.5">
          <TaskStatusBadge status={item.status} isOverdue={item.isOverdue} />
          <OriginBadge origin={item.origin} />
          <PriorityBadge priority={item.priority} withPrefix />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <DescriptionList
          columns={3}
          items={[
            {
              label: "Data limite",
              value: item.dueDate ? (
                <span>
                  <time dateTime={item.dueDate} className="font-medium">
                    {formatDate(item.dueDate)}
                  </time>
                  {active ? (
                    <span className={item.isOverdue ? "ml-1 text-red-700" : "ml-1 text-muted-foreground"}>
                      ({formatRelativeDays(item.dueDate, today)})
                    </span>
                  ) : null}
                </span>
              ) : (
                "Sem data limite"
              ),
            },
            { label: "Tipo", value: TASK_KIND_LABELS[item.kind] },
            { label: "Responsável", value: item.assigneeName ?? "Sem responsável" },
            { label: "Vínculo", value: <WorkLinks links={item.links} /> },
            item.completedAt ? { label: "Concluída em", value: formatDateTime(item.completedAt) } : null,
            item.sourceAnalysisId && item.origin === "ai_suggested"
              ? { label: "Origem", value: "Sugestão de análise de IA aplicada por um usuário" }
              : null,
            item.description ? { label: "Descrição", value: item.description, full: true } : null,
          ]}
        />
        {canWrite ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">Alterar status</p>
            <TaskStatusForm key={`${item.id}-${item.status}`} taskId={item.id} taskTitle={item.title} status={item.status} />
          </div>
        ) : null}
        <CommentThread ctx={ctx} entity={{ type: "task", id: item.id }} bare />
      </CardContent>
    </Card>
  );
}
