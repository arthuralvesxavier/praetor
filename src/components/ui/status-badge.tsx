import type { ReactNode } from "react";
import type { Tone } from "@/lib/tones";
import { Badge } from "./badge";

export type StatusBadgeProps = {
  /** pt-BR label, e.g. `PROCESS_STATUS_LABELS[p.status]`. */
  label: ReactNode;
  /** Tone from `@/lib/tones`, e.g. `PROCESS_STATUS_TONES[p.status]`. */
  tone?: Tone;
  className?: string;
};

/**
 * Generic status pill (soft background + dot + text).
 *
 *   <StatusBadge label={PROCESS_STATUS_LABELS[p.status]} tone={PROCESS_STATUS_TONES[p.status]} />
 */
export function StatusBadge({ label, tone = "neutral", className }: StatusBadgeProps) {
  return (
    <Badge tone={tone} dot className={className}>
      {label}
    </Badge>
  );
}
