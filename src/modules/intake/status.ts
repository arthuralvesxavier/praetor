/**
 * Client-safe helpers for the intake pipeline: effective status (stored status
 * combined with the brief status at read time) and the stages of the visual
 * stepper. Pure functions, no I/O.
 */
import {
  ASSIGNMENT_METHOD_LABELS,
  INTAKE_SOURCE_LABELS,
  INTAKE_STATUS_LABELS,
  INTAKE_STATUSES,
  type AssignmentMethod,
  type CaseBriefStatus,
  type IntakeSource,
  type IntakeStatus,
} from "@/domain/enums";
import type { Tone } from "@/lib/tones";

/**
 * Status shown to users. Besides the stored statuses it has `brief_rejected`:
 * the lawyer rejected the preliminary analysis and a new version must be
 * generated. It is computed at read time only (never stored, not part of
 * `INTAKE_STATUSES`).
 */
export type EffectiveIntakeStatus = IntakeStatus | "brief_rejected";

export const EFFECTIVE_INTAKE_STATUSES = [...INTAKE_STATUSES, "brief_rejected"] as const satisfies readonly EffectiveIntakeStatus[];

export const EFFECTIVE_INTAKE_STATUS_LABELS: Record<EffectiveIntakeStatus, string> = {
  ...INTAKE_STATUS_LABELS,
  brief_rejected: "Análise rejeitada: gerar nova versão",
};

export const INTAKE_STATUS_TONES: Record<EffectiveIntakeStatus, Tone> = {
  received: "neutral",
  assigned: "info",
  analyzing: "info",
  brief_ready: "primary",
  notified: "primary",
  in_review: "warning",
  approved: "success",
  brief_rejected: "alert",
  failed: "danger",
  cancelled: "neutral",
};

/** Pipeline order used by the status strip on /entrada. */
export const PIPELINE_STATUSES = [
  "received",
  "assigned",
  "analyzing",
  "brief_ready",
  "notified",
  "in_review",
  "approved",
] as const satisfies readonly IntakeStatus[];

/**
 * Status shown to users: the brief review happens in the briefs module, so an
 * intake whose brief is being edited reads "Em revisão", an approved brief
 * reads "Análise aprovada" and a rejected one "Análise rejeitada" — computed
 * here, never written into other modules. Failures and cancellations stay
 * visible. Keep in sync with `effectiveStatusSql` in ./service.ts.
 */
export function effectiveIntakeStatus(status: IntakeStatus, briefStatus: CaseBriefStatus | null | undefined): EffectiveIntakeStatus {
  if (status === "failed" || status === "cancelled") return status;
  if (briefStatus === "approved") return "approved";
  if (briefStatus === "in_review") return "in_review";
  if (briefStatus === "rejected") return "brief_rejected";
  return status;
}

/** An intake is still open (its responsible follows the process) until it is cancelled or its brief approved. */
export function isOpenIntake(status: IntakeStatus, briefStatus: CaseBriefStatus | null | undefined): boolean {
  return status !== "cancelled" && briefStatus !== "approved";
}

/** The pipeline still has automatic work to do (used for auto-refresh). */
export function isPipelineRunning(status: IntakeStatus): boolean {
  return status === "received" || status === "assigned" || status === "analyzing" || status === "brief_ready";
}

export type IntakeStepView = { status: IntakeStatus; at: string; detail: string; actorName: string | null };

export type PipelineInput = {
  status: IntakeStatus;
  receivedAt: Date;
  createdByName: string | null;
  source: IntakeSource;
  assignedToName: string | null;
  assignedAt: Date | null;
  assignmentMethod: AssignmentMethod | null;
  assignmentReason: string | null;
  briefId: string | null;
  lastEmailId: string | null;
  steps: IntakeStepView[];
  errorMessage: string | null;
  /** A job for this intake is queued or running. */
  processing: boolean;
  brief: {
    status: CaseBriefStatus;
    version: number;
    generatedAt: Date | null;
    lastEditedAt: Date | null;
    lastEditedByName: string | null;
    approvedAt: Date | null;
    approvedByName: string | null;
    rejectedAt: Date | null;
    rejectedByName: string | null;
  } | null;
  email: { createdAt: Date; toName: string } | null;
};

export type StageKey = "received" | "assigned" | "analysis" | "email" | "review" | "approval";
export type StageState = "done" | "current" | "failed" | "pending";

export type PipelineStage = {
  key: StageKey;
  label: string;
  state: StageState;
  at: Date | null;
  actor: string | null;
  detail: string | null;
};

export const STAGE_LABELS: Record<StageKey, string> = {
  received: "Recebido",
  assigned: "Responsável definido",
  analysis: "Leitura dos documentos e análise (simulação)",
  email: "E-mail ao advogado (simulado)",
  review: "Revisão",
  approval: "Aprovação",
};

export const STAGE_STATE_LABELS: Record<StageState, string> = {
  done: "Concluído",
  current: "Em andamento",
  failed: "Falhou",
  pending: "Pendente",
};

function lastStep(steps: readonly IntakeStepView[], status: IntakeStatus): IntakeStepView | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].status === status) return steps[i];
  return undefined;
}

function firstStep(steps: readonly IntakeStepView[], status: IntakeStatus): IntakeStepView | undefined {
  return steps.find((s) => s.status === status);
}

function stepDate(step: IntakeStepView | undefined): Date | null {
  if (!step) return null;
  const d = new Date(step.at);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function buildPipelineStages(i: PipelineInput): PipelineStage[] {
  const failed = i.status === "failed";
  const brief = i.brief;
  const stages: PipelineStage[] = [];
  let failureAssigned = false;
  const failOrCurrent = (detailWhenCurrent: string): Pick<PipelineStage, "state" | "detail"> => {
    if (failed && !failureAssigned) {
      failureAssigned = true;
      return { state: "failed", detail: i.errorMessage ?? "Falha no processamento automático." };
    }
    return { state: "current", detail: detailWhenCurrent };
  };

  // 1. Recebido
  const received = firstStep(i.steps, "received");
  stages.push({
    key: "received",
    label: STAGE_LABELS.received,
    state: "done",
    at: i.receivedAt,
    actor: received?.actorName ?? i.createdByName,
    detail: received?.detail ?? INTAKE_SOURCE_LABELS[i.source],
  });

  // 2. Responsável definido
  const assignedDone = Boolean(i.assignedToName && i.assignedAt);
  if (assignedDone) {
    const step = lastStep(i.steps, "assigned");
    stages.push({
      key: "assigned",
      label: STAGE_LABELS.assigned,
      state: "done",
      at: i.assignedAt,
      actor: step?.actorName ?? "Sistema",
      detail: [
        `${i.assignedToName}${i.assignmentMethod ? ` · ${ASSIGNMENT_METHOD_LABELS[i.assignmentMethod]}` : ""}.`,
        i.assignmentReason,
      ]
        .filter(Boolean)
        .join(" "),
    });
  } else {
    const lastNote = i.steps.length > 0 ? i.steps[i.steps.length - 1] : undefined;
    const waiting = i.processing
      ? "Aplicando as regras de distribuição…"
      : lastNote && lastNote.status === "received" && lastNote !== received
        ? lastNote.detail
        : "Aguardando atribuição do responsável.";
    stages.push({ key: "assigned", label: STAGE_LABELS.assigned, at: null, actor: null, ...failOrCurrent(waiting) });
  }

  // 3. Leitura dos documentos e análise (simulação)
  const analysisDone = Boolean(i.briefId && brief && brief.status !== "generating" && brief.status !== "failed");
  if (analysisDone && brief) {
    const step = lastStep(i.steps, "brief_ready");
    stages.push({
      key: "analysis",
      label: STAGE_LABELS.analysis,
      state: "done",
      at: brief.generatedAt ?? stepDate(step),
      actor: step?.actorName ?? "Sistema (simulação)",
      detail: `Análise preliminar versão ${brief.version} gerada por simulação (regras determinísticas, sem inteligência artificial real).`,
    });
  } else if (!assignedDone) {
    stages.push({ key: "analysis", label: STAGE_LABELS.analysis, state: "pending", at: null, actor: null, detail: null });
  } else {
    const analyzing = lastStep(i.steps, "analyzing");
    const detail =
      i.status === "analyzing" || i.processing
        ? "Lendo os documentos e montando a análise preliminar (simulação)…"
        : "Aguardando a geração da análise preliminar.";
    stages.push({
      key: "analysis",
      label: STAGE_LABELS.analysis,
      at: stepDate(analyzing),
      actor: analyzing?.actorName ?? null,
      ...failOrCurrent(detail),
    });
  }

  // 4. E-mail ao advogado (simulado)
  if (i.lastEmailId) {
    const step = lastStep(i.steps, "notified");
    stages.push({
      key: "email",
      label: STAGE_LABELS.email,
      state: "done",
      at: i.email?.createdAt ?? stepDate(step),
      actor: step?.actorName ?? "Sistema",
      detail: `Envio simulado para ${i.email?.toName ?? i.assignedToName ?? "o advogado responsável"}. Nenhuma mensagem foi enviada.`,
    });
  } else if (!analysisDone) {
    stages.push({ key: "email", label: STAGE_LABELS.email, state: "pending", at: null, actor: null, detail: null });
  } else {
    stages.push({
      key: "email",
      label: STAGE_LABELS.email,
      at: null,
      actor: null,
      ...failOrCurrent(i.processing ? "Gerando o e-mail simulado…" : "Aguardando o envio do e-mail (simulado)."),
    });
  }

  // 5. Revisão
  if (brief && (brief.status === "approved" || brief.status === "rejected")) {
    stages.push({
      key: "review",
      label: STAGE_LABELS.review,
      state: "done",
      at: brief.lastEditedAt ?? brief.approvedAt ?? brief.rejectedAt,
      actor: brief.lastEditedByName ?? brief.approvedByName ?? brief.rejectedByName,
      detail: brief.lastEditedByName ? `Análise revisada e editada por ${brief.lastEditedByName}.` : "Análise revisada sem edições.",
    });
  } else if (brief && brief.status === "in_review") {
    stages.push({
      key: "review",
      label: STAGE_LABELS.review,
      state: "current",
      at: brief.lastEditedAt,
      actor: brief.lastEditedByName,
      detail: "Em revisão pelo advogado (análise editada).",
    });
  } else if (analysisDone) {
    stages.push({
      key: "review",
      label: STAGE_LABELS.review,
      state: "current",
      at: null,
      actor: null,
      detail: "Aguardando a revisão do advogado responsável.",
    });
  } else {
    stages.push({ key: "review", label: STAGE_LABELS.review, state: "pending", at: null, actor: null, detail: null });
  }

  // 6. Aprovação
  if (brief?.status === "approved") {
    stages.push({
      key: "approval",
      label: STAGE_LABELS.approval,
      state: "done",
      at: brief.approvedAt,
      actor: brief.approvedByName,
      detail: "Análise preliminar aprovada pelo advogado.",
    });
  } else if (brief?.status === "rejected") {
    stages.push({
      key: "approval",
      label: STAGE_LABELS.approval,
      state: "failed",
      at: brief.rejectedAt,
      actor: brief.rejectedByName,
      detail: "Análise rejeitada pelo advogado. Pode ser gerada novamente.",
    });
  } else {
    stages.push({ key: "approval", label: STAGE_LABELS.approval, state: "pending", at: null, actor: null, detail: null });
  }

  return stages;
}
