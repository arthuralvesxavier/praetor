"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button, type ButtonVariantProps } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DeadlineForm, type DeadlineFormProps } from "./deadline-form";
import { TaskForm, type TaskFormProps } from "./task-form";

type TriggerProps = {
  triggerLabel?: string;
  triggerVariant?: ButtonVariantProps["variant"];
  triggerSize?: ButtonVariantProps["size"];
  /** Context shown under the dialog title (e.g. the linked record). */
  description?: string;
};

function CancelButton() {
  return (
    <DialogClose asChild>
      <Button type="button" variant="outline">
        Cancelar
      </Button>
    </DialogClose>
  );
}

/** "Novo prazo" button + dialog with the manual deadline form. Closes on success. */
export function NewDeadlineDialog({
  triggerLabel = "Novo prazo",
  triggerVariant = "primary",
  triggerSize = "md",
  description,
  ...formProps
}: Omit<DeadlineFormProps, "onSuccess" | "secondaryAction"> & TriggerProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={triggerVariant} size={triggerSize}>
          <Plus aria-hidden="true" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Novo prazo</DialogTitle>
          <DialogDescription>
            {description ??
              "Cadastro manual. Confirme a data final conforme as regras de contagem aplicáveis antes de salvar."}
          </DialogDescription>
        </DialogHeader>
        {open ? <DeadlineForm {...formProps} onSuccess={() => setOpen(false)} secondaryAction={<CancelButton />} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** "Nova tarefa" button + dialog with the task form. Closes on success. */
export function NewTaskDialog({
  triggerLabel = "Nova tarefa",
  triggerVariant = "outline",
  triggerSize = "md",
  description,
  dialogTitle = "Nova tarefa",
  ...formProps
}: Omit<TaskFormProps, "onSuccess" | "secondaryAction"> & TriggerProps & { dialogTitle?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={triggerVariant} size={triggerSize}>
          <Plus aria-hidden="true" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{description ?? "Defina o que precisa ser feito, o responsável e a data limite."}</DialogDescription>
        </DialogHeader>
        {open ? <TaskForm {...formProps} onSuccess={() => setOpen(false)} secondaryAction={<CancelButton />} /> : null}
      </DialogContent>
    </Dialog>
  );
}
