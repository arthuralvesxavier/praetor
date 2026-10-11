import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type CheckboxProps = Omit<ComponentProps<"input">, "type"> & {
  label: ReactNode;
  description?: ReactNode;
};

/** Native checkbox with label (submits "on" when checked; read it with `bool(fd, name)` from `@/lib/form`). */
export function Checkbox({ label, description, id, className, ...props }: CheckboxProps) {
  const inputId = id ?? (props.name ? `cb-${props.name}` : undefined);
  const descId = description && inputId ? `${inputId}-desc` : undefined;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input
        id={inputId}
        type="checkbox"
        aria-describedby={descId}
        className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-border-strong accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed"
        {...props}
      />
      <div className="grid gap-0.5">
        <label htmlFor={inputId} className="cursor-pointer text-sm font-medium leading-5 text-slate-800">
          {label}
        </label>
        {description ? (
          <p id={descId} className="text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
