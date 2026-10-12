"use client";

import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import type { FixedWorkLink } from "../types";

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

// The "Vínculo" field of the /prazos forms (type + process search / record select) is `LinkField` (./link-field).

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
