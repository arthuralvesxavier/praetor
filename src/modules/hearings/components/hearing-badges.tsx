import { Gavel, MonitorPlay, PenLine, Sparkles, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  HEARING_KIND_LABELS,
  HEARING_MODE_LABELS,
  HEARING_STATUS_LABELS,
  type DataOrigin,
  type HearingKind,
  type HearingMode,
  type HearingStatus,
} from "@/domain/enums";
import type { Tone } from "@/lib/tones";

export const HEARING_STATUS_TONES: Record<HearingStatus, Tone> = {
  scheduled: "info",
  held: "success",
  rescheduled: "warning",
  cancelled: "neutral",
};

export function HearingStatusBadge({ status, awaitingRecord = false }: { status: HearingStatus; awaitingRecord?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge label={HEARING_STATUS_LABELS[status]} tone={HEARING_STATUS_TONES[status]} />
      {awaitingRecord ? <StatusBadge label="Resultado pendente" tone="alert" /> : null}
    </span>
  );
}

export function HearingKindBadge({ kind }: { kind: HearingKind }) {
  return (
    <Badge tone="primary" icon={<Gavel />}>
      {HEARING_KIND_LABELS[kind]}
    </Badge>
  );
}

export function HearingModeBadge({ mode }: { mode: HearingMode }) {
  return (
    <Badge tone="neutral" icon={mode === "in_person" ? <Users /> : <MonitorPlay />}>
      {HEARING_MODE_LABELS[mode]}
    </Badge>
  );
}

/** Hearings are always registered by people; `ai_suggested` = registered from a hint of the preliminary analysis. */
export function HearingOriginBadge({ origin }: { origin: DataOrigin }) {
  if (origin === "ai_suggested") {
    return (
      <Badge tone="ai" icon={<Sparkles />} title="Origem: cadastrada por pessoa a partir da análise preliminar (simulação)">
        <span className="sr-only">Origem: </span>Da análise preliminar (simulação) · confirmada por pessoa
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" icon={<PenLine />} title="Origem: cadastro manual">
      <span className="sr-only">Origem: </span>Cadastro manual
    </Badge>
  );
}
