"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent } from "react";
import type { FormState } from "@/lib/form";

/**
 * useActionState wrapper that does NOT reset the form when the action returns
 * an error (React resets uncontrolled forms after every `action` submission,
 * which would discard what the user typed). On success the form is reset and
 * `onSuccess` is called.
 */
export function useFormAction<S extends FormState>(
  action: (prev: S | null, formData: FormData) => Promise<S>,
  opts: { onSuccess?: (state: S) => void } = {},
) {
  const [state, dispatch, pending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  const onSuccessRef = useRef(opts.onSuccess);

  useEffect(() => {
    onSuccessRef.current = opts.onSuccess;
  });

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      onSuccessRef.current?.(state);
    }
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  return { state, pending, formRef, onSubmit };
}
