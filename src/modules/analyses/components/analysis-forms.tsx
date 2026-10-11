"use client";

import { CalendarPlus, CheckCircle2, ListPlus, RefreshCw, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { fieldError, type FormState } from "@/lib/form";
import type { Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import {
  applySuggestedDeadlineAction,
  applySuggestedTaskAction,
  askQuestionAction,
  reanalyzeAction,
  requestAnalysisAction,
  reviewAnalysisAction,
} from "../actions";
import {
  analysisTypeOptions,
  isRecordSubjectType,
  RECORD_SUBJECT_TYPES,
  SUBJECT_TYPE_LABELS,
  type RecordSubjectType,
} from "./analysis-labels";

/** Interactive forms of the AI analysis UI (client). Authorization is enforced by the actions/service. */

const COST_NOTE =
  "Cada análise consome parte do limite mensal de uso de IA da organização. Solicitações idênticas com as mesmas " +
  "fontes reaproveitam o resultado existente, sem novo custo.";

// ---------------------------------------------------------------------------
// Request analysis
// ---------------------------------------------------------------------------

export type AnalysisRequestFormProps = {
  /** Fixed subject (entity pages). */
  subject?: { type: RecordSubjectType; id: string };
  /** Subject picker (AI center): records available per subject type. */
  subjectOptions?: Partial<Record<RecordSubjectType, Option[]>>;
  /** Navigate to the analysis page after requesting. */
  redirectToResult?: boolean;
  className?: string;
};

export function AnalysisRequestForm({ subject, subjectOptions, redirectToResult = false, className }: AnalysisRequestFormProps) {
  const [state, action] = useActionState(requestAnalysisAction, null);
  const uid = useId();
  const availableTypes = subject
    ? [subject.type]
    : RECORD_SUBJECT_TYPES.filter((t) => (subjectOptions?.[t]?.length ?? 0) > 0);
  const [subjectType, setSubjectType] = useState<RecordSubjectType | "">(subject?.type ?? availableTypes[0] ?? "");
  const recordOptions = subject ? [] : subjectType ? (subjectOptions?.[subjectType] ?? []) : [];
  const typeOptions = subjectType ? analysisTypeOptions(subjectType) : [];

  if (!subject && availableTypes.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        Não há processos, ocorrências, contratos ou documentos acessíveis para analisar.
      </p>
    );
  }

  return (
    <form action={action} className={cn("space-y-3", className)}>
      <FormMessage state={state} />
      {redirectToResult ? <input type="hidden" name="redirectTo" value="analysis" /> : null}
      {subject ? (
        <>
          <input type="hidden" name="subjectType" value={subject.type} />
          <input type="hidden" name="subjectId" value={subject.id} />
        </>
      ) : null}
      <div className={cn("grid gap-3", subject ? "sm:grid-cols-[1fr_auto] sm:items-end" : "sm:grid-cols-2")}>
        {!subject ? (
          <>
            <FormField label="Tipo de registro" htmlFor={`${uid}-subjectType`} required error={fieldError(state, "subjectType")}>
              <NativeSelect
                name="subjectType"
                value={subjectType}
                onChange={(e) => setSubjectType(isRecordSubjectType(e.target.value) ? e.target.value : "")}
                options={availableTypes.map((t) => ({ value: t, label: SUBJECT_TYPE_LABELS[t] }))}
                required
              />
            </FormField>
            <FormField label="Registro" htmlFor={`${uid}-subjectId`} required error={fieldError(state, "subjectId")}>
              <NativeSelect
                key={subjectType}
                name="subjectId"
                options={recordOptions}
                placeholder="Selecione o registro…"
                placeholderDisabled
                defaultValue=""
                required
              />
            </FormField>
          </>
        ) : null}
        <FormField
          label="Tipo de análise"
          htmlFor={`${uid}-type`}
          required
          error={fieldError(state, "type")}
          className={subject ? undefined : "sm:col-span-2"}
        >
          <NativeSelect key={`type-${subjectType}`} name="type" options={typeOptions} defaultValue={typeOptions[0]?.value} required />
        </FormField>
        {subject ? (
          <SubmitButton pendingLabel="Solicitando…" className="w-full sm:w-auto">
            <Sparkles aria-hidden="true" />
            Solicitar análise
          </SubmitButton>
        ) : null}
      </div>
      {fieldError(state, "question") ? (
        <p className="text-sm text-red-700" role="alert">
          {fieldError(state, "question")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{COST_NOTE}</p>
      {!subject ? (
        <SubmitButton pendingLabel="Solicitando…">
          <Sparkles aria-hidden="true" />
          Solicitar análise
        </SubmitButton>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Question & answer
// ---------------------------------------------------------------------------

export function QuestionForm({ className }: { className?: string }) {
  const [state, action] = useActionState(askQuestionAction, null);
  const uid = useId();
  return (
    <form action={action} className={cn("space-y-3", className)}>
      <FormMessage state={state} />
      <FormField
        label="Sua pergunta"
        htmlFor={`${uid}-question`}
        required
        hint="Ex.: Quais contratos têm cláusula de multa por rescisão antecipada? Mínimo de 5 e máximo de 2.000 caracteres."
        error={fieldError(state, "question")}
      >
        <Textarea name="question" rows={4} minLength={5} maxLength={2000} required />
      </FormField>
      <p className="text-xs text-muted-foreground">{COST_NOTE}</p>
      <SubmitButton pendingLabel="Enviando…">
        <Send aria-hidden="true" />
        Perguntar
      </SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Re-analysis (force)
// ---------------------------------------------------------------------------

export function ReanalyzeForm({
  analysisId,
  label = "Solicitar nova análise",
  variant = "outline",
}: {
  analysisId: string;
  label?: string;
  variant?: "outline" | "primary" | "secondary";
}) {
  const [state, action] = useActionState(reanalyzeAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="analysisId" value={analysisId} />
      <FormMessage state={state} />
      <SubmitButton variant={variant} size="sm" pendingLabel="Solicitando…">
        <RefreshCw aria-hidden="true" />
        {label}
      </SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export function AnalysisReviewForm({ analysisId }: { analysisId: string }) {
  const [state, action] = useActionState(reviewAnalysisAction, null);
  const uid = useId();
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="analysisId" value={analysisId} />
      <FormMessage state={state} />
      <FormField
        label="Observação da revisão"
        htmlFor={`${uid}-note`}
        hint="Opcional. Registre o que foi conferido nas fontes ou por que a análise foi descartada."
        error={fieldError(state, "note")}
      >
        <Textarea name="note" rows={3} maxLength={2000} />
      </FormField>
      {fieldError(state, "decision") ? (
        <p className="text-sm text-red-700" role="alert">
          {fieldError(state, "decision")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton name="decision" value="reviewed" pendingLabel="Salvando…">
          <CheckCircle2 aria-hidden="true" />
          Marcar como revisada
        </SubmitButton>
        <SubmitButton name="decision" value="dismissed" variant="outline" pendingLabel="Salvando…">
          Descartar análise
        </SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Apply suggestions
// ---------------------------------------------------------------------------

export type ApplySuggestionFormProps = {
  kind: "task" | "deadline";
  analysisId: string;
  index: number;
  /** Already turned into a record. */
  applied: boolean;
  /** When set, the button is disabled and this explanation is shown. */
  disabledReason?: string | null;
};

export function ApplySuggestionForm(props: ApplySuggestionFormProps) {
  return props.kind === "task" ? <ApplyTaskForm {...props} /> : <ApplyDeadlineForm {...props} />;
}

function ApplyTaskForm(props: ApplySuggestionFormProps) {
  const [state, action] = useActionState(applySuggestedTaskAction, null);
  return <ApplySuggestionView {...props} state={state} action={action} />;
}

function ApplyDeadlineForm(props: ApplySuggestionFormProps) {
  const [state, action] = useActionState(applySuggestedDeadlineAction, null);
  return <ApplySuggestionView {...props} state={state} action={action} />;
}

function ApplySuggestionView({
  kind,
  analysisId,
  index,
  applied,
  disabledReason,
  state,
  action,
}: ApplySuggestionFormProps & { state: FormState | null; action: (formData: FormData) => void }) {
  const reasonId = useId();
  const done = applied || (state?.ok ?? false);

  if (done) {
    return (
      <div className="space-y-1">
        {state?.ok && state.message ? (
          <p role="status" className="text-sm text-emerald-800">
            {state.message}
          </p>
        ) : null}
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-emerald-800">
          <CheckCircle2 aria-hidden="true" className="size-4" />
          {kind === "task" ? "Tarefa já criada a partir desta sugestão." : "Prazo já registrado para validação humana."}
          <Link
            href={kind === "task" ? "/prazos?aba=tarefas" : "/prazos?aba=validacao"}
            className="font-medium text-primary-700 underline underline-offset-2 hover:text-primary-900"
          >
            {kind === "task" ? "Ver tarefas" : "Ver prazos aguardando validação"}
          </Link>
        </p>
      </div>
    );
  }

  const label = kind === "task" ? "Criar tarefa" : "Criar prazo para validação humana";
  const Icon = kind === "task" ? ListPlus : CalendarPlus;

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="analysisId" value={analysisId} />
      <input type="hidden" name="index" value={index} />
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {disabledReason ? (
        <>
          <Button type="button" size="sm" variant="outline" disabled aria-describedby={reasonId}>
            <Icon aria-hidden="true" />
            {label}
          </Button>
          <p id={reasonId} className="text-xs text-muted-foreground">
            {disabledReason}
          </p>
        </>
      ) : (
        <SubmitButton size="sm" variant="outline" pendingLabel="Criando…">
          <Icon aria-hidden="true" />
          {label}
        </SubmitButton>
      )}
    </form>
  );
}
