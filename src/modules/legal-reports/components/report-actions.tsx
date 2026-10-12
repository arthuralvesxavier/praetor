"use client";

import { CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { approveLegalReportAction, regenerateLegalReportAction } from "../actions";

/** Aprovar (com confirmação): o PDF final é gerado com o carimbo e o relatório fica imutável. */
export function ApproveReportButton({ id, reference, version }: { id: string; reference: string; version: number }) {
  return (
    <ConfirmDialog
      action={approveLegalReportAction}
      hiddenFields={{ id }}
      tone="primary"
      title={`Aprovar ${reference} (versão ${version})?`}
      description="Depois de aprovado, o relatório não pode mais ser alterado: o PDF final é gerado com o carimbo de aprovação (seu nome, data e versão) e o hash é registrado. Mudanças futuras exigem uma nova versão."
      confirmLabel="Aprovar relatório"
      pendingLabel="Aprovando…"
      trigger={
        <Button type="button">
          <CheckCircle2 aria-hidden="true" />
          Aprovar
        </Button>
      }
    />
  );
}

/** Gerar nova versão com os dados atuais (a atual passa a "substituída", com PDF e hash preservados). */
export function RegenerateReportButton({ id, reference }: { id: string; reference: string }) {
  return (
    <ConfirmDialog
      action={regenerateLegalReportAction}
      hiddenFields={{ id }}
      tone="primary"
      title={`Gerar nova versão de ${reference}?`}
      description="A nova versão usa os dados atuais da base e volta para revisão. Esta versão passa a constar como substituída, com o PDF e o hash preservados."
      confirmLabel="Gerar nova versão"
      pendingLabel="Gerando…"
      trigger={
        <Button type="button" variant="outline">
          <RefreshCw aria-hidden="true" />
          Gerar nova versão
        </Button>
      }
    />
  );
}
