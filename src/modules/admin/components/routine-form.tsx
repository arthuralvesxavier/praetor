"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { ROUTINE_INTERVAL_BOUNDS, ROUTINE_MAX_PER_RUN_BOUNDS } from "../schemas";
import { PendingButton, useAdminForm, type FormAction } from "./form-utils";

export type RoutineFormValues = {
  id: string;
  label: string;
  enabled: boolean;
  intervalMinutes: number;
  /** Present only for the stale-analysis refresh routine. */
  staleConfig?: { autoRefresh: boolean; maxPerRun: number };
};

/** Inline editor of one routine (enabled, interval and type-specific options). */
export function RoutineForm<S extends FormState>({ action, routine }: { action: FormAction<S>; routine: RoutineFormValues }) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const prefix = `routine-${routine.id}`;
  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      className="grid gap-3"
      aria-label={`Configurar rotina ${routine.label}`}
      noValidate
    >
      <input type="hidden" name="id" value={routine.id} />
      <Checkbox id={`${prefix}-enabled`} name="enabled" label="Rotina ativa" defaultChecked={routine.enabled} />
      <FormField
        label="Intervalo (minutos)"
        htmlFor={`${prefix}-interval`}
        required
        error={fieldError(state, "intervalMinutes")}
        hint={`Mínimo de ${ROUTINE_INTERVAL_BOUNDS.min} minutos.`}
      >
        <Input
          name="intervalMinutes"
          type="number"
          inputMode="numeric"
          step={1}
          min={ROUTINE_INTERVAL_BOUNDS.min}
          max={ROUTINE_INTERVAL_BOUNDS.max}
          defaultValue={routine.intervalMinutes}
          className="max-w-40"
          required
        />
      </FormField>
      {routine.staleConfig ? (
        <>
          <Checkbox
            id={`${prefix}-auto`}
            name="autoRefresh"
            label="Solicitar reanálise automaticamente"
            description="Desativado: a rotina apenas gera alertas de análises desatualizadas. Ativado: solicita novas análises (consome o limite de IA)."
            defaultChecked={routine.staleConfig.autoRefresh}
          />
          <FormField
            label="Máximo de reanálises por execução"
            htmlFor={`${prefix}-max`}
            required
            error={fieldError(state, "maxPerRun")}
            hint={`Entre ${ROUTINE_MAX_PER_RUN_BOUNDS.min} e ${ROUTINE_MAX_PER_RUN_BOUNDS.max}.`}
          >
            <Input
              name="maxPerRun"
              type="number"
              inputMode="numeric"
              step={1}
              min={ROUTINE_MAX_PER_RUN_BOUNDS.min}
              max={ROUTINE_MAX_PER_RUN_BOUNDS.max}
              defaultValue={routine.staleConfig.maxPerRun}
              className="max-w-40"
              required
            />
          </FormField>
        </>
      ) : null}
      <FormMessage state={state} />
      <div>
        <PendingButton pending={pending} size="sm" variant="secondary">
          Salvar rotina
        </PendingButton>
      </div>
    </form>
  );
}
