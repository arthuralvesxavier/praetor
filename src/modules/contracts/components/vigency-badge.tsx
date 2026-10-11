import { StatusBadge } from "@/components/ui/status-badge";
import {
  VIGENCY_STATE_LABELS,
  VIGENCY_STATE_TONES,
  vigencyRelativeText,
  type VigencyState,
} from "../vigencia";

/**
 * Vigency state pill. For "vencendo"/"vencido" contracts it shows the relative
 * text ("vence em 12 dias"); otherwise the state label.
 */
export function VigencyBadge({
  vigency,
  daysToEnd,
  className,
}: {
  vigency: VigencyState;
  daysToEnd: number | null;
  className?: string;
}) {
  const relative = vigency === "vencendo" || (vigency === "vencido" && daysToEnd !== null && daysToEnd < 0)
    ? vigencyRelativeText(daysToEnd)
    : null;
  const label = relative ? (
    <>
      <span className="sr-only">{VIGENCY_STATE_LABELS[vigency]}: </span>
      {relative}
    </>
  ) : (
    VIGENCY_STATE_LABELS[vigency]
  );
  return <StatusBadge label={label} tone={VIGENCY_STATE_TONES[vigency]} className={className} />;
}
