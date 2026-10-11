import { Lock, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Flags numbers outside the CNJ shape. Only the shape is checked — no check-digit validation or tribunal lookup. */
export function CnjFormatFlag({ isCnjFormat, className }: { isCnjFormat: boolean; className?: string }) {
  if (isCnjFormat) return null;
  return (
    <Badge tone="warning" className={className} title="O número não segue o formato NNNNNNN-DD.AAAA.J.TR.OOOO">
      Fora do padrão CNJ
    </Badge>
  );
}

export function ConfidentialBadge({ className }: { className?: string }) {
  return (
    <Badge tone="primary" icon={<Lock />} className={className}>
      Confidencial
    </Badge>
  );
}

export function LegalHoldBadge({ className }: { className?: string }) {
  return (
    <Badge tone="alert" icon={<ShieldAlert />} className={className}>
      Retenção legal
    </Badge>
  );
}
