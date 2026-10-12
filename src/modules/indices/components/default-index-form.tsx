"use client";

import { useState } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { NativeSelect } from "@/components/ui/select";
import { CORRECTION_INDEX_LABELS, CORRECTION_INDEXES, type CorrectionIndex } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels } from "@/lib/options";
import { PendingButton, useAdminForm } from "@/modules/admin/components/form-utils";
import { updateDefaultCorrectionIndexAction } from "../actions";

/** Select of the index written into NEW valuations (controlled: the choice survives a validation error). */
export function DefaultCorrectionIndexForm({ current }: { current: CorrectionIndex }) {
  const { state, formAction, pending, onSubmit } = useAdminForm(updateDefaultCorrectionIndexAction);
  const [value, setValue] = useState<string>(current);
  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-3">
      <FormMessage state={state} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <FormField
          label="Índice de atualização dos novos valores"
          htmlFor="default-correction-index"
          error={fieldError(state, "defaultCorrectionIndex")}
          className="sm:w-80"
        >
          <NativeSelect
            name="defaultCorrectionIndex"
            options={optionsFromLabels(CORRECTION_INDEX_LABELS, CORRECTION_INDEXES)}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </FormField>
        <PendingButton pending={pending} variant="primary">
          Salvar
        </PendingButton>
      </div>
    </form>
  );
}
