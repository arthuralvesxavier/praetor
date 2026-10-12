"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Building2, ChevronDown, Landmark, LogOut } from "lucide-react";
import { useRef } from "react";
import { UserAvatar } from "@/components/ui/user-avatar";

export type UserMenuProps = {
  name: string;
  email: string | null;
  /** pt-BR role label (ROLE_LABELS). */
  roleLabel: string;
  unitName?: string | null;
  organizationName?: string | null;
  /** External counsel only: the law firm whose portfolio the user sees. */
  lawFirmName?: string | null;
  /** Server action that ends the session and redirects to /login. */
  signOutAction: () => Promise<void>;
};

/** Header user menu (Radix dropdown: keyboard navigation, Escape to close) with profile context and "Sair". */
export function UserMenu({
  name,
  email,
  roleLabel,
  unitName,
  organizationName,
  lawFirmName,
  signOutAction,
}: UserMenuProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const subtitle = lawFirmName ? `${roleLabel} · ${lawFirmName}` : roleLabel;

  return (
    <>
      {/* The form lives outside the menu so it stays mounted when the menu closes on select. */}
      <form ref={formRef} action={signOutAction} className="hidden" aria-hidden="true" />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-md py-1 pr-1.5 pl-1 text-left hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-slate-100"
          aria-label={`Menu do usuário ${name} (${subtitle})`}
        >
          <UserAvatar name={name} />
          <span className="hidden min-w-0 flex-col leading-tight 2xl:flex">
            <span className="max-w-44 truncate text-sm font-medium text-slate-900">{name}</span>
            <span className="max-w-44 truncate text-xs text-muted-foreground">{subtitle}</span>
          </span>
          <ChevronDown aria-hidden="true" className="size-4 text-slate-500" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-surface p-1 shadow-lg data-[state=open]:animate-fade-in"
          >
            <DropdownMenu.Label className="px-2.5 py-2">
              <span className="block truncate text-sm font-semibold text-slate-900">{name}</span>
              {email ? <span className="block truncate text-xs text-muted-foreground">{email}</span> : null}
              <span className="mt-2 inline-flex max-w-full items-center rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-800">
                <span className="truncate">
                  {roleLabel}
                  {unitName ? ` · ${unitName}` : ""}
                </span>
              </span>
              {lawFirmName ? (
                <span className="mt-2 flex items-start gap-1.5 text-xs text-slate-700">
                  <Landmark aria-hidden="true" className="mt-px size-3.5 shrink-0 text-slate-500" />
                  <span>
                    <span className="sr-only">Escritório: </span>
                    {lawFirmName}
                    <span className="block text-[11px] text-muted-foreground">
                      Acesso restrito à carteira do escritório
                    </span>
                  </span>
                </span>
              ) : null}
              {organizationName ? (
                <span className="mt-1.5 flex items-start gap-1.5 text-xs text-slate-700">
                  <Building2 aria-hidden="true" className="mt-px size-3.5 shrink-0 text-slate-500" />
                  <span className="min-w-0 truncate">
                    <span className="sr-only">Organização: </span>
                    {organizationName}
                  </span>
                </span>
              ) : null}
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
