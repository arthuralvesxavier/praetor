"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Archive, ArchiveRestore, ChevronDown, Ellipsis, SearchCheck, SearchX, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ValuesFormState } from "../schemas";
import {
  CloseProcessForm,
  DeleteProcessForm,
  FlagVerificationForm,
  ReactivateProcessForm,
  ResolveVerificationForm,
} from "./lifecycle-dialogs";

type Action<S> = (prev: S | null, formData: FormData) => Promise<S>;

type DialogKey = "close" | "reactivate" | "flag" | "resolve" | "delete";

export type ProcessActionsMenuProps<S extends ValuesFormState> = {
  processId: string;
  processNumber: string;
  /** "YYYY-MM-DD" (server time zone), default date of "Retirar da carteira ativa". */
  today: string;
  /** In the active portfolio: "Retirar da carteira ativa"; otherwise "Reativar". */
  active: boolean;
  closureLabel: string | null;
  needsVerification: boolean;
  verificationNote: string | null;
  /** process:write (lifecycle and verification). */
  canEdit: boolean;
  /** process:delete and no legal hold. */
  canDelete: boolean;
  actions: {
    close: Action<S>;
    reactivate: Action<S>;
    flag: Action<S>;
    resolve: Action<S>;
    remove: Action<S>;
  };
};

const itemClasses =
  "flex cursor-pointer items-center gap-2 rounded px-2.5 py-2 text-sm text-slate-800 outline-none select-none data-[highlighted]:bg-slate-100 data-[highlighted]:text-slate-900 [&_svg]:size-4 [&_svg]:text-slate-500";

function Item({ icon, children, onSelect, destructive = false }: { icon: ReactNode; children: ReactNode; onSelect: () => void; destructive?: boolean }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(itemClasses, destructive && "text-red-700 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-800 [&_svg]:text-red-600")}
    >
      <span aria-hidden="true">{icon}</span>
      {children}
    </DropdownMenu.Item>
  );
}

/**
 * "Mais ações" of the process header (P0.6): lifecycle, verification and delete live in
 * a Radix dropdown; each item opens its confirmation dialog (the same forms, actions and
 * permission checks as before). The dialogs are rendered outside the menu so they stay
 * mounted after the menu closes; focus returns to the "Mais ações" button.
 */
export function ProcessActionsMenu<S extends ValuesFormState>(props: ProcessActionsMenuProps<S>) {
  const [dialog, setDialog] = useState<DialogKey | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set when an item opens a dialog: the closing menu must not pull the focus back to its trigger.
  const openingRef = useRef(false);
  const close = () => setDialog(null);
  const open = (key: DialogKey) => {
    openingRef.current = true;
    setDialog(key);
  };
  const { canEdit, canDelete, active } = props;
  if (!canEdit && !canDelete) return null;

  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          ref={triggerRef}
          className={cn(buttonVariants({ variant: "outline" }), "gap-1.5 px-3 data-[state=open]:bg-slate-100")}
        >
          <Ellipsis aria-hidden="true" className="text-slate-500" />
          Mais ações
          <ChevronDown aria-hidden="true" className="text-slate-500" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            onCloseAutoFocus={(e) => {
              if (openingRef.current) e.preventDefault();
              openingRef.current = false;
            }}
            className="z-50 w-64 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-surface p-1 shadow-lg data-[state=open]:animate-fade-in"
          >
            {canEdit && active ? (
              <Item icon={<Archive />} onSelect={() => open("close")}>
                Retirar da carteira ativa
              </Item>
            ) : null}
            {canEdit && !active ? (
              <Item icon={<ArchiveRestore />} onSelect={() => open("reactivate")}>
                Reativar na carteira
              </Item>
            ) : null}
            {canEdit && !props.needsVerification ? (
              <Item icon={<SearchCheck />} onSelect={() => open("flag")}>
                Marcar para conferência
              </Item>
            ) : null}
            {canEdit && props.needsVerification ? (
              <Item icon={<SearchX />} onSelect={() => open("resolve")}>
                Concluir conferência
              </Item>
            ) : null}
            {canDelete ? (
              <>
                {canEdit ? <DropdownMenu.Separator className="my-1 h-px bg-border" /> : null}
                <Item icon={<Trash2 />} onSelect={() => open("delete")} destructive>
                  Excluir processo
                </Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? null : close())}>
        <DialogContent
          size={dialog === "delete" ? "sm" : "md"}
          // Spread only when needed: `role={undefined}` would remove Radix's role="dialog".
          {...(dialog === "delete" ? { role: "alertdialog" } : {})}
          // No DialogTrigger: return the focus to "Mais ações" when the dialog closes.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          {dialog === "close" ? (
            <CloseProcessForm
              action={props.actions.close}
              processId={props.processId}
              processNumber={props.processNumber}
              today={props.today}
              onDone={close}
            />
          ) : dialog === "reactivate" ? (
            <ReactivateProcessForm
              action={props.actions.reactivate}
              processId={props.processId}
              closureLabel={props.closureLabel}
              onDone={close}
            />
          ) : dialog === "flag" ? (
            <FlagVerificationForm action={props.actions.flag} processId={props.processId} onDone={close} />
          ) : dialog === "resolve" ? (
            <ResolveVerificationForm
              action={props.actions.resolve}
              processId={props.processId}
              note={props.verificationNote}
              onDone={close}
            />
          ) : dialog === "delete" ? (
            <DeleteProcessForm
              action={props.actions.remove}
              processId={props.processId}
              processNumber={props.processNumber}
              onDone={close}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
