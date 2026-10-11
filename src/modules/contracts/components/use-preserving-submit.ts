"use client";

import { startTransition, useCallback, type FormEvent } from "react";

/**
 * `onSubmit` handler that dispatches a `useActionState` action inside a
 * transition WITHOUT React's automatic form reset, so typed values survive a
 * validation error. `useFormStatus` (SubmitButton) still reports pending,
 * and keeping `action={formAction}` on the form preserves the no-JS fallback.
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
