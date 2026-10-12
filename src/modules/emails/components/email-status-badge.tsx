import { StatusBadge } from "@/components/ui/status-badge";
import { EMAIL_STATUS_LABELS, type EmailStatus } from "@/domain/enums";
import { EMAIL_STATUS_SHORT_LABELS, EMAIL_STATUS_TONES } from "../labels";

/** "Simulado" / "Falha" pill; the full status label is read by screen readers and shown as tooltip. */
export function EmailStatusBadge({ status, className }: { status: EmailStatus; className?: string }) {
  return (
    <span title={EMAIL_STATUS_LABELS[status]} className="inline-flex">
      <StatusBadge
        className={className}
        tone={EMAIL_STATUS_TONES[status]}
        label={
          <>
            <span aria-hidden="true">{EMAIL_STATUS_SHORT_LABELS[status]}</span>
            <span className="sr-only">{EMAIL_STATUS_LABELS[status]}</span>
          </>
        }
      />
    </span>
  );
}
