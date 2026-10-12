"use client";

import { CheckCircle2, LoaderCircle } from "lucide-react";
import { startTransition, useActionState, useOptimistic, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resolveAlertAction } from "../actions";

/**
 * "Resolver" button of an alert. Optimistic: the row shows "Resolvido" as soon
 * as the click happens; the server action revalidates the page (the alert
 * leaves the open list) or the error is shown inline and the button returns.
 */
export function ResolveAlertButton({ alertId, alertTitle, className }: { alertId: string; alertTitle: string; className?: string }) {
  const [state, dispatch, pending] = useActionState(resolveAlertAction, null);
  const [optimisticDone, setOptimisticDone] = useOptimistic(false, (_current, next: boolean) => next);
  const done = optimisticDone || state?.ok === true;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      setOptimisticDone(true);
      dispatch(formData);
    });
  }

  return (
    <form action={dispatch} onSubmit={onSubmit} className={cn("flex flex-col items-start gap-1 sm:items-end", className)}>
      <input type="hidden" name="alertId" value={alertId} />
      {done ? (
        <span role="status" className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700">
          {pending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <CheckCircle2 aria-hidden="true" className="size-4" />}
          {pending ? "Resolvendo…" : "Resolvido"}
        </span>
      ) : (
        <Button type="submit" variant="outline" size="sm" aria-label={`Resolver alerta: ${alertTitle}`}>
          <CheckCircle2 aria-hidden="true" />
          Resolver
        </Button>
      )}
      {state && !state.ok ? (
        <p role="alert" className="max-w-56 text-xs text-red-700">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
