"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

/**
 * Off-canvas navigation drawer for screens below `lg` (Radix Dialog: focus trap,
 * Escape to close). `children` is the server-rendered sidebar content; the
 * drawer closes when any link inside it is activated.
 */
export function MobileNav({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  function closeOnLink(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("a")) setOpen(false);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger
        className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-ring lg:hidden"
        aria-label="Abrir menu de navegação"
      >
        <Menu aria-hidden="true" className="size-5" />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/50 data-[state=open]:animate-fade-in lg:hidden" />
        <DialogPrimitive.Content
          className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-sidebar-border bg-sidebar shadow-xl data-[state=open]:animate-drawer-in focus-visible:outline-none lg:hidden"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">Menu de navegação</DialogPrimitive.Title>
          <div className="h-full" onClick={closeOnLink}>
            {children}
          </div>
          <DialogPrimitive.Close
            className="absolute top-3 right-3 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-sidebar-muted hover:bg-sidebar-hover hover:text-white focus-visible:outline-2 focus-visible:outline-sidebar-indicator"
            aria-label="Fechar menu"
          >
            <X aria-hidden="true" className="size-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
