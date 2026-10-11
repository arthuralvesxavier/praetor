"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, LogOut } from "lucide-react";
import { useRef } from "react";
import { UserAvatar } from "@/components/ui/user-avatar";

export type UserMenuProps = {
  name: string;
  email: string | null;
  roleLabel: string;
  unitName?: string | null;
  /** Server action that ends the session and redirects to /login. */
  signOutAction: () => Promise<void>;
};

/** Header user menu (Radix dropdown: keyboard navigation, Escape to close) with "Sair". */
export function UserMenu({ name, email, roleLabel, unitName, signOutAction }: UserMenuProps) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <>
      {/* The form lives outside the menu so it stays mounted when the menu closes on select. */}
      <form ref={formRef} action={signOutAction} className="hidden" aria-hidden="true" />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="inline-flex cursor-pointer items-center gap-2 rounded-md py-1 pr-1.5 pl-1 text-left hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-slate-100"
          aria-label={`Menu do usuário ${name}`}
        >
          <UserAvatar name={name} />
          <span className="hidden min-w-0 flex-col leading-tight md:flex">
            <span className="max-w-40 truncate text-sm font-medium text-slate-900">{name}</span>
            <span className="max-w-40 truncate text-xs text-muted-foreground">{roleLabel}</span>
          </span>
          <ChevronDown aria-hidden="true" className="size-4 text-slate-500" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-60 rounded-md border border-border bg-surface p-1 shadow-lg data-[state=open]:animate-fade-in"
          >
            <DropdownMenu.Label className="px-2.5 py-2">
              <span className="block truncate text-sm font-semibold text-slate-900">{name}</span>
              {email ? <span className="block truncate text-xs text-muted-foreground">{email}</span> : null}
              <span className="mt-1 block text-xs text-slate-700">
                {roleLabel}
                {unitName ? ` · ${unitName}` : ""}
              </span>
            </DropdownMenu.Label>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              onSelect={() => formRef.current?.requestSubmit()}
              className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-2 text-sm text-slate-800 outline-none select-none data-[highlighted]:bg-slate-100 data-[highlighted]:text-slate-900"
            >
              <LogOut aria-hidden="true" className="size-4 text-slate-500" />
              Sair
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}
