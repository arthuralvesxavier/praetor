"use client";

import { Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { closeSnapshotAction, generateSnapshotAction } from "../actions";
import { ActionDialog, InlineAction } from "./action-dialog";

export function GenerateSnapshotButton({ period, exists }: { period: string; exists: boolean }) {
  return (
    <InlineAction
      action={generateSnapshotAction}
      hiddenFields={{ period }}
      variant={exists ? "outline" : "primary"}
      size="md"
      pendingLabel="Calculando…"
      label={
        <>
          <RefreshCw aria-hidden="true" />
          {exists ? "Recalcular prévia" : "Gerar prévia"}
        </>
      }
    />
  );
}

export function CloseSnapshotDialog({
  period,
  periodLabel,
  generatedAtLabel,
  monthNotOver,
  estimateCount,
}: {
  period: string;
  periodLabel: string;
  generatedAtLabel: string;
  monthNotOver: boolean;
  estimateCount: number;
}) {
  return (
    <ActionDialog
      size="sm"
      trigger={
        <Button type="button">
          <Lock aria-hidden="true" />
          Fechar competência
        </Button>
      }
      title={`Fechar a competência ${periodLabel}?`}
      description={`Após o fechamento, a competência fica imutável: relatórios passam a ler exatamente estes valores, e ela não pode ser recalculada nem reaberta. Prévia calculada em ${generatedAtLabel}.`}
      action={closeSnapshotAction}
      hiddenFields={{ period }}
      submitLabel="Fechar competência"
      pendingLabel="Fechando…"
    >
      {() => (
        <div className="space-y-2">
          <Callout tone="info">Se houve lançamentos depois do cálculo da prévia, recalcule-a antes de fechar.</Callout>
          {monthNotOver ? (
            <Callout tone="warning">O mês ainda não terminou: valores com data-base posterior a hoje não entrarão nesta competência.</Callout>
          ) : null}
          {estimateCount > 0 ? (
            <Callout tone="warning">
              {estimateCount} processo(s) têm valores estimados (sem valor liquidado). Eles serão fechados com a ressalva de valores estimados.
            </Callout>
          ) : null}
        </div>
      )}
    </ActionDialog>
  );
}
