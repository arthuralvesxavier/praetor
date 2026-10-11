import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type LabelProps = ComponentProps<"label"> & { required?: boolean };

/** Form label. `required` adds a visual asterisk plus "(obrigatório)" for screen readers. */
export function Label({ className, required, children, ...props }: LabelProps) {
  return (
    <label className={cn("text-sm font-medium leading-5 text-slate-800", className)} {...props}>
      {children}
      {required ? (
        <>
          <span aria-hidden="true" className="ml-0.5 text-red-700">
            *
          </span>
          <span className="sr-only"> (obrigatório)</span>
        </>
      ) : null}
    </label>
  );
}
