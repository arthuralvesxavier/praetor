import { Clock, History } from "lucide-react";
import {
  ANALYSIS_REVIEW_STATUS_LABELS,
  ANALYSIS_STATUS_LABELS,
  type AnalysisReviewStatus,
  type AnalysisStatus,
} from "@/domain/enums";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { ANALYSIS_REVIEW_STATUS_TONES, ANALYSIS_STATUS_TONES } from "@/lib/tones";
import { SEVERITY_LABELS, SEVERITY_TONES, type Severity } from "./analysis-labels";

/** Small badges shared by the analysis panel, list and full view (client-safe). */

export function AnalysisStatusBadge({ status, className }: { status: AnalysisStatus; className?: string }) {
  return (
    <StatusBadge label={ANALYSIS_STATUS_LABELS[status]} tone={ANALYSIS_STATUS_TONES[status]} className={className} />
  );
}

/** Review status is only meaningful for finished analyses. */
export function ReviewStatusBadge({
  status,
  analysisStatus,
  className,
}: {
  status: AnalysisReviewStatus;
  analysisStatus: AnalysisStatus;
  className?: string;
}) {
  if (analysisStatus !== "succeeded") return null;
  return (
    <StatusBadge
      label={ANALYSIS_REVIEW_STATUS_LABELS[status]}
      tone={ANALYSIS_REVIEW_STATUS_TONES[status]}
      className={className}
    />
  );
}

export function StaleBadge({ isStale, className }: { isStale: boolean; className?: string }) {
  if (!isStale) return null;
  return (
    <Badge tone="warning" icon={<History />} className={className} title="As fontes mudaram depois desta análise">
      Desatualizada
    </Badge>
  );
}

export function PendingBadge({ status, className }: { status: AnalysisStatus; className?: string }) {
  if (status !== "queued" && status !== "running") return null;
  return (
    <Badge tone="info" icon={<Clock />} className={className}>
      {status === "queued" ? "Aguardando processamento" : "Processando"}
    </Badge>
  );
}

export function SeverityBadge({ severity, className }: { severity: Severity | null; className?: string }) {
  if (!severity) return null;
  return (
    <Badge tone={SEVERITY_TONES[severity]} dot className={className}>
      <span className="sr-only">Relevância </span>
      {SEVERITY_LABELS[severity]}
    </Badge>
  );
}
