"use client";

import { Check, LoaderCircle } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { TASK_STATUS_LABELS, type TaskStatus } from "@/domain/enums";
import { optionsFromLabels } from "@/lib/options";
import { cn } from "@/lib/utils";
import { updateTaskStatusAction } from "../actions";

/**
 * Inline status change for a task (select + confirm button). Render it with
 * `key={`${task.id}-${task.status}`}` so it re-initializes after revalidation.
 */
export function TaskStatusForm({
  taskId,
  taskTitle,
  status,
  className,
}: {
  taskId: string;
  taskTitle: string;
  status: TaskStatus;
  className?: string;
}) {
  const uid = useId();
  const [value, setValue] = useState<TaskStatus>(status);
  const [state, action, pending] = useActionState(updateTaskStatusAction, null);
  const errorId = `${uid}-erro`;
  const showError = state && !state.ok;

  return (
    <form action={action} className={cn("flex min-w-44 flex-col gap-1", className)}>
      <input type="hidden" name="id" value={taskId} />
      <div className="flex items-center gap-1.5">
        <label htmlFor={`${uid}-status`} className="sr-only">
          Status da tarefa {taskTitle}
        </label>
        <NativeSelect
          id={`${uid}-status`}
          name="status"
          value={value}
          onChange={(e) => setValue(e.target.value as TaskStatus)}
          options={optionsFromLabels(TASK_STATUS_LABELS)}
          className="h-8 text-[13px]"
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
        />
        <Button
          type="submit"
          size="icon"
          variant="outline"
          className="size-8"
          disabled={pending || value === status}
          aria-label={`Salvar status da tarefa ${taskTitle}`}
          title="Salvar status"
        >
          {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Check aria-hidden="true" />}
        </Button>
      </div>
      {showError ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-700">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
