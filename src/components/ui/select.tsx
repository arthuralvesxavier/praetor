import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import type { Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import { fieldClasses } from "./input";

export type { Option } from "@/lib/options";

export type NativeSelectProps = Omit<ComponentProps<"select">, "children"> & {
  options: readonly Option[];
  /** First option with value "" (e.g. "Selecione…" or "Todos"). */
  placeholder?: string;
  /** Disable the placeholder option (forces a real choice). Default false. */
  placeholderDisabled?: boolean;
};

/**
 * Styled native <select> — works in server-rendered forms without JS.
 * Use `defaultValue` (uncontrolled). Build options with `optionsFromLabels()` from `@/lib/options`.
 */
export function NativeSelect({ options, placeholder, placeholderDisabled = false, className, ...props }: NativeSelectProps) {
  return (
    <div className="relative w-full">
      <select className={cn(fieldClasses, "h-9 cursor-pointer appearance-none pr-9 pl-3", className)} {...props}>
        {placeholder !== undefined ? (
          <option value="" disabled={placeholderDisabled}>
            {placeholder}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-slate-500"
      />
    </div>
  );
}
