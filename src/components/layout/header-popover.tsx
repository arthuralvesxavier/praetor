"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Box of every header popover. Exported so tests can render the panel content
 * statically with the same frame (Radix portals render nothing on the server).
 */
export const HEADER_POPOVER_BOX =
  "w-80 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-surface text-left shadow-lg";

export type HeaderPopoverProps = {
  /** Visible content of the trigger button. */
  trigger: ReactNode;
  /** Accessible name of the trigger; must contain its visible text. */
  triggerLabel: string;
  triggerClassName?: string;
  /** Accessible name of the open panel (role="dialog"). */
  title: string;
  align?: "start" | "center" | "end";
  children: ReactNode;
};

/**
 * Small click-to-open panel of the app shell (Radix Popover: focus moves into
 * the panel, Escape and outside click close it). The shell layout survives
 * client navigation, so the panel closes itself when a link inside it is
 * activated, as MobileNav does.
 */
export function HeaderPopover({
  trigger,
  triggerLabel,
  triggerClassName,
  title,
  align = "end",
  children,
}: HeaderPopoverProps) {
  const [open, setOpen] = useState(false);

  function closeOnLink(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("a")) setOpen(false);
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        aria-label={triggerLabel}
        title={triggerLabel}
        className={cn(
          "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          triggerClassName,
        )}
      >
        {trigger}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={title}
          className={cn(HEADER_POPOVER_BOX, "z-50 focus-visible:outline-none data-[state=open]:animate-fade-in")}
        >
          <div onClick={closeOnLink}>{children}</div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
