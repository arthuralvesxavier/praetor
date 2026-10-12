import { Lock, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  CONFIDENTIALITY_LABELS,
  TEXT_EXTRACTION_STATUS_LABELS,
  type ConfidentialityLevel,
  type TextExtractionStatus,
} from "@/domain/enums";
import type { Tone } from "@/lib/tones";
import { TEXT_EXTRACTION_STATUS_TONES } from "@/lib/tones";

const CONFIDENTIALITY_TONES: Record<ConfidentialityLevel, Tone> = {
  internal: "neutral",
  confidential: "warning",
  restricted: "danger",
};

export function ExtractionStatusBadge({ status }: { status: TextExtractionStatus | null | undefined }) {
  if (!status) return <span className="text-muted-foreground">Não informado</span>;
  return <StatusBadge label={TEXT_EXTRACTION_STATUS_LABELS[status]} tone={TEXT_EXTRACTION_STATUS_TONES[status]} />;
}

export function ConfidentialityBadge({ level }: { level: ConfidentialityLevel }) {
  return (
    <Badge
      tone={CONFIDENTIALITY_TONES[level]}
      icon={level === "internal" ? undefined : <Lock aria-hidden="true" className="size-3" />}
    >
      <span className="sr-only">Confidencialidade: </span>
      {CONFIDENTIALITY_LABELS[level]}
    </Badge>
  );
}

export function LegalHoldBadge() {
  return (
    <Badge tone="primary" icon={<ShieldAlert aria-hidden="true" className="size-3" />}>
      Preservação legal
    </Badge>
  );
}
