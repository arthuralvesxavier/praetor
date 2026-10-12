import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { INTAKE_SOURCE_LABELS, INTAKE_STATUS_LABELS, type IntakeSource, type IntakeStatus } from "@/domain/enums";
import { INTAKE_STATUS_TONES } from "../status";

export function IntakeStatusBadge({ status, className }: { status: IntakeStatus; className?: string }) {
  return <StatusBadge label={INTAKE_STATUS_LABELS[status]} tone={INTAKE_STATUS_TONES[status]} className={className} />;
}

export function IntakeSourceBadge({ source, className }: { source: IntakeSource; className?: string }) {
  if (source === "simulated_feed") {
    return (
      <Badge tone="warning" icon={<FlaskConical />} className={className}>
        {INTAKE_SOURCE_LABELS.simulated_feed}
      </Badge>
    );
  }
  return (
    <Badge tone={source === "import" ? "info" : "neutral"} className={className}>
      {INTAKE_SOURCE_LABELS[source]}
    </Badge>
  );
}
