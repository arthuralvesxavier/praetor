import { PRIORITY_LABELS, type Priority } from "@/domain/enums";
import { PRIORITY_TONES } from "@/lib/tones";
import { Badge } from "./badge";

export type PriorityBadgeProps = {
  priority: Priority | null | undefined;
  /** Show "Prioridade alta" instead of "Alta". */
  withPrefix?: boolean;
  className?: string;
};

/** Priority pill: low=slate, medium=amber, high=orange, urgent=red. Always has text. */
export function PriorityBadge({ priority, withPrefix = false, className }: PriorityBadgeProps) {
  if (!priority) {
    return (
      <Badge tone="neutral" className={className}>
        Sem prioridade
      </Badge>
    );
  }
  const label = PRIORITY_LABELS[priority];
  return (
    <Badge tone={PRIORITY_TONES[priority]} dot className={className}>
      {withPrefix ? (
        `Prioridade ${label.toLowerCase()}`
      ) : (
        <>
          <span className="sr-only">Prioridade </span>
          {label}
        </>
      )}
    </Badge>
  );
}
