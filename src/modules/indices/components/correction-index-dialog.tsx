"use client";

import { Percent } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CORRECTION_INDEX_LABELS, CORRECTION_INDEXES, type CorrectionIndex } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import { ActionDialog } from "@/modules/contingency/components/action-dialog";
import { setValuationCorrectionIndexAction } from "../actions";
import { CORRECTION_INDEX_NOTE_MAX, type CorrectionIndexChangeMode } from "../policy";

/**
 * "Informar índice" / "Trocar índice" of a valuation. Render it only when
 * `correctionIndexChangeFor(row, { write, approve })` (`../policy`) returns a
 * mode, and pass that mode:
 *   - `in_place`: a value in review (`contingency:write`) or a value without
 *     index (`contingency:approve`); the row itself gets the index.
 *   - `new_record`: an OFFICIAL value that already has an index
 *     (`contingency:approve`); a new official record with the same amount and
 *     base date and the chosen index supersedes it (the old one stays in the
 *     history with its index).
 * The service enforces the same rule.
 */
export function CorrectionIndexDialog({
  valuationId,
  current,
  valueLabel,
  mode,
}: {
  valuationId: string;
  current: CorrectionIndex | null;
  /** E.g. "Valor liquidado de R$ 10.000,00 (data-base 15/03/2024)". */
  valueLabel: string;
  mode: CorrectionIndexChangeMode;
}) {
  const replace = mode === "new_record";
  const triggerLabel = current ? "Trocar índice" : "Informar índice";
  return (
    <ActionDialog
      trigger={
        <Button type="button" size="sm" variant="ghost" aria-label={`${triggerLabel} de atualização: ${valueLabel}`}>
          <Percent aria-hidden="true" />
          {triggerLabel}
        </Button>
      }
      title={replace ? "Trocar o índice de atualização do valor oficial" : "Índice de atualização do valor"}
      description={
        replace
          ? `${valueLabel}, índice atual: ${current ? CORRECTION_INDEX_LABELS[current] : "sem índice informado"}. Um novo registro oficial, com o mesmo valor e a mesma data-base e o índice escolhido, substitui este; o registro atual continua no histórico com o índice que tem. Você fica registrado como responsável pela conferência.`
          : `${valueLabel}. O valor original e a data-base não mudam; o valor atualizado é calculado na consulta.`
      }
      action={setValuationCorrectionIndexAction}
      hiddenFields={{ valuationId }}
      submitLabel={replace ? "Registrar com o novo índice" : "Salvar índice"}
    >
      {(state) => (
        <>
          <IndexField state={state} current={current} />
          {replace ? (
            <FormField label="Observação (opcional)" htmlFor="valuation-correction-index-note" error={fieldError(state, "note")}>
              <Textarea name="note" rows={2} maxLength={CORRECTION_INDEX_NOTE_MAX} />
            </FormField>
          ) : null}
        </>
      )}
    </ActionDialog>
  );
}

function IndexField({ state, current }: { state: Parameters<typeof fieldError>[0]; current: CorrectionIndex | null }) {
  const [value, setValue] = useState<string>(current ?? "");
  return (
    <FormField
      label="Índice"
      htmlFor="valuation-correction-index"
      required
      error={fieldError(state, "correctionIndex")}
      hint="A escolha do índice é do advogado responsável pelo caso."
    >
      <NativeSelect
        name="correctionIndex"
        options={optionsFromLabels(CORRECTION_INDEX_LABELS, CORRECTION_INDEXES)}
        placeholder="Selecione…"
        placeholderDisabled
        value={value}
        onChange={(e) => setValue(e.target.value)}
        required
      />
    </FormField>
  );
}
