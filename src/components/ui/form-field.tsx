import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

export type FormFieldProps = {
  label: ReactNode;
  /** id of the control; also used to build the hint/error ids. */
  htmlFor: string;
  hint?: ReactNode;
  /** Error message(s), e.g. `state.fieldErrors?.title` or `fieldError(state, "title")`. */
  error?: string | readonly string[] | null;
  required?: boolean;
  className?: string;
  /**
   * The control (Input, Textarea, NativeSelect...). When it is a single element,
   * FormField injects `id` (if missing), `aria-invalid`, `aria-describedby` and
   * `aria-required` automatically. For custom children use `fieldA11yProps()`.
   */
  children: ReactNode;
};

type A11yProps = {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  "aria-required"?: true;
};

/** ARIA props linking a control to its hint and error messages (ids `${id}-hint` / `${id}-error`). */
export function fieldA11yProps(opts: { id: string; hasHint?: boolean; hasError?: boolean; required?: boolean }): A11yProps {
  const describedBy = [opts.hasError ? `${opts.id}-error` : null, opts.hasHint ? `${opts.id}-hint` : null]
    .filter(Boolean)
    .join(" ");
  return {
    id: opts.id,
    ...(opts.hasError ? { "aria-invalid": true as const } : {}),
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(opts.required ? { "aria-required": true as const } : {}),
  };
}

function normalizeErrors(error: FormFieldProps["error"]): string[] {
  if (!error) return [];
  return (typeof error === "string" ? [error] : [...error]).filter(Boolean);
}

/**
 * Label + control + hint + error message, accessible by default.
 *
 *   <FormField label="Título" htmlFor="title" required error={fieldError(state, "title")}>
 *     <Input id="title" name="title" required defaultValue={...} />
 *   </FormField>
 */
export function FormField({ label, htmlFor, hint, error, required, className, children }: FormFieldProps) {
  const errors = normalizeErrors(error);
  const a11y = fieldA11yProps({ id: htmlFor, hasHint: Boolean(hint), hasError: errors.length > 0, required });

  let control = children;
  if (isValidElement(children)) {
    const el = children as ReactElement<Record<string, unknown>>;
    const existing = typeof el.props["aria-describedby"] === "string" ? (el.props["aria-describedby"] as string) : "";
    const describedBy = [a11y["aria-describedby"], existing].filter(Boolean).join(" ") || undefined;
    control = cloneElement(el, {
      id: (el.props.id as string | undefined) ?? htmlFor,
      "aria-invalid": a11y["aria-invalid"] ?? el.props["aria-invalid"],
      "aria-describedby": describedBy,
      "aria-required": a11y["aria-required"] ?? el.props["aria-required"],
    });
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {control}
      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {errors.length > 0 ? (
        <p id={`${htmlFor}-error`} className="text-xs font-medium text-red-700">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}
