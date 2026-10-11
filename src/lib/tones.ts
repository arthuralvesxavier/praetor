import type {
  AlertSeverity,
  AnalysisReviewStatus,
  AnalysisStatus,
  ContractStatus,
  DeadlineStatus,
  ObligationStatus,
  OccurrenceStatus,
  Priority,
  ProcessStatus,
  RiskLevel,
  TaskStatus,
  TextExtractionStatus,
  ValidationStatus,
} from "@/domain/enums";

/**
 * Visual tones shared by Badge, StatusBadge, StatCard and Callout.
 * neutral=slate, info=sky, success=emerald, warning=amber, alert=orange,
 * danger=red, primary=navy, ai=violet (reserved for AI-generated content).
 */
export type Tone = "neutral" | "info" | "success" | "warning" | "alert" | "danger" | "primary" | "ai";

export const RISK_TONES: Record<RiskLevel, Tone> = { low: "success", medium: "warning", high: "alert", critical: "danger" };

export const PRIORITY_TONES: Record<Priority, Tone> = { low: "neutral", medium: "warning", high: "alert", urgent: "danger" };

export const PROCESS_STATUS_TONES: Record<ProcessStatus, Tone> = {
  active: "info",
  suspended: "warning",
  archived: "neutral",
  closed: "neutral",
};

export const OCCURRENCE_STATUS_TONES: Record<OccurrenceStatus, Tone> = {
  open: "info",
  under_analysis: "warning",
  action_plan: "primary",
  monitoring: "info",
  resolved: "success",
  converted_to_process: "neutral",
};

export const CONTRACT_STATUS_TONES: Record<ContractStatus, Tone> = {
  draft: "neutral",
  under_review: "warning",
  active: "success",
  expired: "danger",
  terminated: "neutral",
};

export const OBLIGATION_STATUS_TONES: Record<ObligationStatus, Tone> = {
  pending: "warning",
  fulfilled: "success",
  overdue: "danger",
  waived: "neutral",
};

export const DEADLINE_STATUS_TONES: Record<DeadlineStatus, Tone> = { open: "info", done: "success", cancelled: "neutral" };

export const TASK_STATUS_TONES: Record<TaskStatus, Tone> = {
  todo: "neutral",
  in_progress: "info",
  blocked: "danger",
  done: "success",
  cancelled: "neutral",
};

export const VALIDATION_STATUS_TONES: Record<ValidationStatus, Tone> = {
  not_required: "neutral",
  pending_validation: "ai",
  validated: "success",
  rejected: "danger",
};

export const ANALYSIS_STATUS_TONES: Record<AnalysisStatus, Tone> = {
  queued: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
};

export const ANALYSIS_REVIEW_STATUS_TONES: Record<AnalysisReviewStatus, Tone> = {
  pending_review: "warning",
  reviewed: "success",
  dismissed: "neutral",
};

export const ALERT_SEVERITY_TONES: Record<AlertSeverity, Tone> = { info: "info", warning: "warning", critical: "danger" };

export const TEXT_EXTRACTION_STATUS_TONES: Record<TextExtractionStatus, Tone> = {
  pending: "neutral",
  succeeded: "success",
  failed: "danger",
  unsupported: "warning",
};

/** Soft background + darker text + border classes per tone (AA contrast on white). */
export const TONE_CLASSES: Record<Tone, { badge: string; dot: string; soft: string; icon: string }> = {
  neutral: {
    badge: "border-slate-200 bg-slate-100 text-slate-700",
    dot: "bg-slate-400",
    soft: "border-slate-200 bg-slate-50 text-slate-800",
    icon: "bg-slate-100 text-slate-600",
  },
  info: {
    badge: "border-sky-200 bg-sky-50 text-sky-800",
    dot: "bg-sky-500",
    soft: "border-sky-200 bg-sky-50 text-sky-900",
    icon: "bg-sky-50 text-sky-700",
  },
  success: {
    badge: "border-emerald-200 bg-emerald-50 text-emerald-800",
    dot: "bg-emerald-500",
    soft: "border-emerald-200 bg-emerald-50 text-emerald-900",
    icon: "bg-emerald-50 text-emerald-700",
  },
  warning: {
    badge: "border-amber-200 bg-amber-50 text-amber-800",
    dot: "bg-amber-500",
    soft: "border-amber-200 bg-amber-50 text-amber-900",
    icon: "bg-amber-50 text-amber-700",
  },
  alert: {
    badge: "border-orange-200 bg-orange-50 text-orange-800",
    dot: "bg-orange-500",
    soft: "border-orange-200 bg-orange-50 text-orange-900",
    icon: "bg-orange-50 text-orange-700",
  },
  danger: {
    badge: "border-red-200 bg-red-50 text-red-800",
    dot: "bg-red-600",
    soft: "border-red-200 bg-red-50 text-red-900",
    icon: "bg-red-50 text-red-700",
  },
  primary: {
    badge: "border-primary-200 bg-primary-50 text-primary-700",
    dot: "bg-primary-500",
    soft: "border-primary-200 bg-primary-50 text-primary-900",
    icon: "bg-primary-50 text-primary-700",
  },
  ai: {
    badge: "border-ai-200 bg-ai-50 text-ai-800",
    dot: "bg-ai-500",
    soft: "border-ai-200 bg-ai-50 text-ai-900",
    icon: "bg-ai-50 text-ai-700",
  },
};
