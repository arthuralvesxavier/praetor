"use client";

import { startTransition, useCallback, type FormEvent } from "react";

/**
 * `onSubmit` handler that dispatches a `useActionState` action inside a
 * transition without React's automatic form reset, so typed values survive a
 * validation error. Keep `action={formAction}` on the <form> as the no-JS
 * fallback; `useFormStatus` (SubmitButton) still reports the pending state.
 */
export function usePreservingSubmit(dispatch: (formData: FormData) => void) {
  return useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      const formData = new FormData(event.currentTarget, submitter);
      startTransition(() => dispatch(formData));
    },
    [dispatch],
  );
}
