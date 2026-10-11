"use client";

import { ChevronDown, LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { fieldClasses } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FixedWorkLink, WorkLinkOptions } from "../types";

/** Submit button driven by an explicit `pending` flag (forms submitted through useFormAction). */
export function PendingButton({
  pending,
  pendingLabel = "Salvando…",
  children,
  ...props
}: Omit<ButtonProps, "type" | "asChild"> & { pending: boolean; pendingLabel?: string; children: ReactNode }) {
  return (
    <Button type="submit" disabled={pending || props.disabled} aria-busy={pending || undefined} {...props}>
      {pending ? (
        <>
          <LoaderCircle aria-hidden="true" className="animate-spin" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/**
 * Single "Vínculo" select grouping processes, occurrences and contracts.
 * Values are "legal_process:<id>", "occurrence:<id>" or "contract:<id>" (parsed by the action).
 */
export function LinkSelect({ options, ...props }: Omit<ComponentProps<"select">, "children"> & { options: WorkLinkOptions }) {
  return (
    <div className="relative w-full">
      <select className={cn(fieldClasses, "h-9 cursor-pointer appearance-none pr-9 pl-3")} {...props}>
        <option value="">Sem vínculo</option>
        {options.processes.length > 0 ? (
          <optgroup label="Processos">
            {options.processes.map((o) => (
              <option key={o.id} value={`legal_process:${o.id}`}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        {options.occurrences.length > 0 ? (
          <optgroup label="Ocorrências (preventivo)">
            {options.occurrences.map((o) => (
              <option key={o.id} value={`occurrence:${o.id}`}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        {options.contracts.length > 0 ? (
          <optgroup label="Contratos">
            {options.contracts.map((o) => (
              <option key={o.id} value={`contract:${o.id}`}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-slate-500"
      />
    </div>
  );
}

/** Hidden inputs for a fixed link (forms on entity pages). */
export function FixedLinkFields({ link }: { link: FixedWorkLink }) {
  return (
    <>
      {link.processId ? <input type="hidden" name="processId" value={link.processId} /> : null}
      {link.occurrenceId ? <input type="hidden" name="occurrenceId" value={link.occurrenceId} /> : null}
      {link.contractId ? <input type="hidden" name="contractId" value={link.contractId} /> : null}
    </>
  );
}
