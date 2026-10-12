"use client";

import { startTransition, useCallback, type FormEvent } from "react";

/**
 * `onSubmit` handler that dispatches a `useActionState` action inside a
 * transition WITHOUT React's automatic form reset, so what the user typed or
 * chose (inputs, textareas, checkboxes AND `<select>`s) survives an error
 * result. `useFormStatus` (SubmitButton) still reports pending, because React
 * marks the form as pending when a prevented submit schedules a transition.
 *
 *   const [state, formAction] = useActionState(saveAction, null);
 *   const onSubmit = usePreservingSubmit(formAction);
 *   <form action={formAction} onSubmit={onSubmit}>…</form>
 *
 * Keep `action={formAction}` on the form as the no-JS fallback. The handler
 * only runs after the browser's constraint validation passed (`required`,
 * `minLength`…), unless the form has `noValidate`. The submitter button is
 * included in the FormData (name/value of the clicked button).
 *
 * Do not rely on returning `values` from the action to re-fill a form: React
 * resets uncontrolled fields after an action submitted through `action=`, and a
 * changed `defaultValue` is never re-applied to a `<select>`.
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
