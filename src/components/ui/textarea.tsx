import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { fieldClasses } from "./input";

/** Multi-line text field. Pair with <FormField>. */
export function Textarea({ className, rows = 4, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea rows={rows} className={cn(fieldClasses, "min-h-20 px-3 py-2 leading-relaxed", className)} {...props} />
  );
}
