"use client";

import { LoaderCircle, Send } from "lucide-react";
import { startTransition, useActionState, useEffect, useId, useRef, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Textarea } from "@/components/ui/textarea";
import { fieldError } from "@/lib/form";
import { addCommentAction } from "../actions";

/** New comment form. The text is kept when the action fails and cleared on success. */
export function CommentForm({ entityType, entityId, maxLength }: { entityType: string; entityId: string; maxLength: number }) {
  const uid = useId();
  const [state, dispatch, pending] = useActionState(addCommentAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    startTransition(() => dispatch(fd));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      <FormField
        label="Novo comentário"
        htmlFor={`${uid}-body`}
        error={fieldError(state, "body")}
        hint="Visível para quem tem acesso a este registro. Não inclua senhas ou dados pessoais desnecessários."
      >
        <Textarea name="body" rows={3} maxLength={maxLength} required />
      </FormField>
      <FormMessage state={state && (state.ok || !state.fieldErrors) ? state : null} />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
          {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Send aria-hidden="true" />}
          {pending ? "Publicando…" : "Comentar"}
        </Button>
      </div>
    </form>
  );
}
