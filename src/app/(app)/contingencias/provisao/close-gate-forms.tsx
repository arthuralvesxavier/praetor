"use client";

import { FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { fieldError } from "@/lib/form";
import { closeSnapshotAction } from "@/modules/contingency/actions";
import { CLOSE_JUSTIFICATION_MAX_LENGTH, CLOSE_JUSTIFICATION_MIN_LENGTH } from "@/modules/contingency/close-gate";
import { ActionDialog } from "@/modules/contingency/components/action-dialog";

/**
 * "Fechar com justificativa" (P1.9): closes a competência while processes have no official
 * risk classification in force on the reference date. The reason is required; the service
 * stores it with the list of those processes (immutable, shown on the closed competência).
 */
export function CloseWithJustificationDialog({
  period,
  periodLabel,
  referenceDateLabel,
  generatedAtLabel,
  unclassifiedCount,
  hiddenCount,
  monthNotOver,
  estimateCount,
}: {
  period: string;
  periodLabel: string;
  referenceDateLabel: string;
  generatedAtLabel: string;
  unclassifiedCount: number;
  hiddenCount: number;
  monthNotOver: boolean;
  estimateCount: number;
}) {
  return (
    <ActionDialog
      size="md"
      trigger={
        <Button type="button" variant="outline">
          <FileWarning aria-hidden="true" />
          Fechar com justificativa
        </Button>
      }
      title={`Fechar ${periodLabel} com justificativa?`}
      description={
        `${unclassifiedCount} processo(s) ativo(s) não têm classificação de risco oficial em vigor em ${referenceDateLabel}. ` +
        `Após o fechamento, a competência fica imutável e não pode ser recalculada nem reaberta. Prévia calculada em ${generatedAtLabel}.`
      }
      action={closeSnapshotAction}
      hiddenFields={{ period, mode: "justified" }}
      submitLabel="Fechar com justificativa"
      pendingLabel="Fechando…"
    >
      {(state) => (
        <div className="space-y-3">
          <Callout tone="warning">
            Os processos sem classificação oficial entram no fechamento exatamente como estão na prévia. A justificativa, a
            lista desses processos, seu nome e a data ficam registrados na competência e na trilha de auditoria.
            {hiddenCount > 0 ? ` A lista inclui ${hiddenCount} processo(s) sigiloso(s) não exibido(s) para o seu perfil.` : ""}
          </Callout>
          <FormField
            label="Justificativa"
            htmlFor={`close-justification-${period}`}
            required
            error={fieldError(state, "justification")}
            hint={`Mínimo de ${CLOSE_JUSTIFICATION_MIN_LENGTH} caracteres. Fica visível para quem consulta a competência: não inclua dados sigilosos.`}
          >
            <Textarea
              name="justification"
              rows={4}
              minLength={CLOSE_JUSTIFICATION_MIN_LENGTH}
              maxLength={CLOSE_JUSTIFICATION_MAX_LENGTH}
              required
            />
          </FormField>
          {monthNotOver ? (
            <Callout tone="warning">O mês ainda não terminou: valores com data-base posterior a hoje não entrarão nesta competência.</Callout>
          ) : null}
          {estimateCount > 0 ? (
            <Callout tone="info">
              {estimateCount} processo(s) têm valores estimados (sem valor liquidado). Eles serão fechados com a ressalva de valores estimados.
            </Callout>
          ) : null}
        </div>
      )}
    </ActionDialog>
  );
}
