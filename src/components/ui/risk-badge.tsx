import { RISK_LEVEL_LABELS, type RiskLevel } from "@/domain/enums";
import { RISK_TONES } from "@/lib/tones";
import { Badge } from "./badge";

export type RiskBadgeProps = {
  /** null/undefined renders "Não classificado". */
  level: RiskLevel | null | undefined;
  /** Show "Risco alto" instead of "Alto" (use outside of a "Risco" column). */
  withPrefix?: boolean;
  className?: string;
};

/** Risk level pill: low=emerald, medium=amber, high=orange, critical=red. Always has text. */
export function RiskBadge({ level, withPrefix = false, className }: RiskBadgeProps) {
  if (!level) {
    return (
      <Badge tone="neutral" className={className}>
        {withPrefix ? "Risco não classificado" : "Não classificado"}
      </Badge>
    );
  }
  const label = RISK_LEVEL_LABELS[level];
  return (
    <Badge tone={RISK_TONES[level]} dot className={className}>
      {withPrefix ? (
        `Risco ${label.toLowerCase()}`
      ) : (
        <>
          <span className="sr-only">Risco </span>
          {label}
        </>
      )}
    </Badge>
  );
}
