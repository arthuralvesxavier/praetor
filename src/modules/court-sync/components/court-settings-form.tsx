"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { PendingButton, useAdminForm, type FormAction } from "@/modules/admin/components/form-utils";
import { COURT_SETTINGS_BOUNDS } from "../schemas";

export type CourtSettingsDefaults = {
  enabled: boolean;
  syncIntervalHours: number;
  maxRequestsPerMinute: number;
  batchSize: number;
  autoApplyPhase: boolean;
  enrichOnIntake: boolean;
  simulatedFeedEnabled: boolean;
  simulatedFeedIntervalMinutes: number;
};

/** Interval of the routines that apply these settings, in minutes (null = paused or not created). */
export type CourtRoutineIntervals = { courtSync: number | null; simulatedFeed: number | null };

function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 60 === 0 && minutes < 2880) return minutes === 60 ? "1 hora" : `${minutes / 60} horas`;
  return minutes % 1440 === 0 ? `${minutes / 1440} dias` : `${Math.round(minutes / 60)} horas`;
}

/** Honest hint: a per-process interval shorter than the routine interval only takes effect at the routine's pace. */
function syncIntervalHint(hours: number, routineMinutes: number | null): string {
  if (routineMinutes === null) return "A rotina de acompanhamento está pausada ou ainda não foi criada: nada é consultado automaticamente.";
  const base = `A rotina verifica a cada ${minutesText(routineMinutes)} quais processos já passaram deste intervalo.`;
  return hours * 60 < routineMinutes
    ? `${base} Com o valor atual, na prática cada processo é consultado a cada ${minutesText(routineMinutes)}.`
    : base;
}

function feedIntervalHint(minutes: number, routineMinutes: number | null): string {
  if (routineMinutes === null) return "A rotina de chegada simulada está pausada ou ainda não foi criada.";
  const base = `A rotina verifica a cada ${minutesText(routineMinutes)}.`;
  return minutes < routineMinutes ? `${base} Com o valor atual, na prática chega um processo a cada ${minutesText(routineMinutes)}.` : base;
}

/** Parameters of the DataJud collection and of the simulated arrivals (admin). */
export function CourtSettingsForm<S extends FormState>({
  action,
  defaults,
  isDemo,
  routineIntervals,
}: {
  action: FormAction<S>;
  defaults: CourtSettingsDefaults;
  isDemo: boolean;
  routineIntervals: CourtRoutineIntervals;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const b = COURT_SETTINGS_BOUNDS;
  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-5">
      <FormMessage state={state} />
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Acompanhamento no DataJud</legend>
        <Checkbox
          name="enabled"
          defaultChecked={defaults.enabled}
          label="Consultar a carteira ativa automaticamente"
          description="Só funciona com a variável DATAJUD_API_KEY configurada no servidor."
        />
        <Checkbox
          name="autoApplyPhase"
          defaultChecked={defaults.autoApplyPhase}
          label="Aplicar mudanças de fase e de instância inequívocas"
          description='Ex.: "Liquidação iniciada" passa o processo para Liquidação; "Remessa em grau de recurso" atualiza a instância. Nunca recua uma fase nem encerra processos. Desmarcado, vira alerta para conferência.'
        />
        <Checkbox
          name="enrichOnIntake"
          defaultChecked={defaults.enrichOnIntake}
          label="Completar processos recebidos por API com os dados do DataJud"
          description="Preenche só os campos vazios; nunca substitui o que veio do sistema de origem."
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            label="Intervalo entre consultas (horas)"
            htmlFor="syncIntervalHours"
            error={fieldError(state, "syncIntervalHours")}
            hint={syncIntervalHint(defaults.syncIntervalHours, routineIntervals.courtSync)}
            required
          >
            <Input
              id="syncIntervalHours"
              name="syncIntervalHours"
              type="number"
              min={b.syncIntervalHours.min}
              max={b.syncIntervalHours.max}
              defaultValue={defaults.syncIntervalHours}
              required
            />
          </FormField>
          <FormField
            label="Requisições por minuto por tribunal"
            htmlFor="maxRequestsPerMinute"
            error={fieldError(state, "maxRequestsPerMinute")}
            required
          >
            <Input
              id="maxRequestsPerMinute"
              name="maxRequestsPerMinute"
              type="number"
              min={b.maxRequestsPerMinute.min}
              max={b.maxRequestsPerMinute.max}
              defaultValue={defaults.maxRequestsPerMinute}
              required
            />
          </FormField>
          <FormField label="Números por consulta (lote)" htmlFor="batchSize" error={fieldError(state, "batchSize")} required>
            <Input id="batchSize" name="batchSize" type="number" min={b.batchSize.min} max={b.batchSize.max} defaultValue={defaults.batchSize} required />
          </FormField>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Chegada automática simulada (demonstração)</legend>
        <Checkbox
          name="simulatedFeedEnabled"
          defaultChecked={defaults.simulatedFeedEnabled}
          disabled={!isDemo}
          label="Gerar sozinho um processo fictício a cada intervalo"
          description={
            isDemo
              ? "Cada chegada é rotulada como simulação, com dados e documentos fictícios, e segue o fluxo de entrada normal."
              : "Disponível só em organizações de demonstração."
          }
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            label="Intervalo da chegada simulada (minutos)"
            htmlFor="simulatedFeedIntervalMinutes"
            error={fieldError(state, "simulatedFeedIntervalMinutes")}
            hint={feedIntervalHint(defaults.simulatedFeedIntervalMinutes, routineIntervals.simulatedFeed)}
            required
          >
            <Input
              id="simulatedFeedIntervalMinutes"
              name="simulatedFeedIntervalMinutes"
              type="number"
              min={b.simulatedFeedIntervalMinutes.min}
              max={b.simulatedFeedIntervalMinutes.max}
              defaultValue={defaults.simulatedFeedIntervalMinutes}
              required
            />
          </FormField>
        </div>
      </fieldset>

      <div>
        <PendingButton pending={pending}>Salvar parâmetros</PendingButton>
      </div>
    </form>
  );
}
