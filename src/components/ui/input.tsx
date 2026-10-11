import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Shared field styles (input, select, textarea). */
export const fieldClasses = cn(
  "w-full rounded-md border border-border-strong bg-white text-sm text-slate-900 shadow-xs",
  "placeholder:text-slate-400 transition-colors",
  "focus-visible:border-primary-500 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring",
  "aria-invalid:border-red-600 aria-invalid:focus-visible:outline-red-600",
  "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500",
);

/** Text-like input. Pair with <FormField> for label, hint and error wiring. */
export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        fieldClasses,
        "h-9 px-3 read-only:bg-slate-50",
        type === "file" &&
          "h-auto cursor-pointer px-1 py-1 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-200",
        className,
      )}
      {...props}
    />
  );
}
