import { FileSpreadsheet, Lock, SearchCheck, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PROCESS_INSTANCE_LABELS, type ProcessInstance } from "@/domain/enums";
import type { CnjCheck } from "../schemas";

/** Flags numbers outside the CNJ shape. No tribunal lookup is made. */
export function CnjFormatFlag({ isCnjFormat, className }: { isCnjFormat: boolean; className?: string }) {
  if (isCnjFormat) return null;
  return (
    <Badge tone="warning" className={className} title="O número não segue o formato NNNNNNN-DD.AAAA.J.TR.OOOO">
      Fora do padrão CNJ
    </Badge>
  );
}

/** Shape + check digit (mod 97). An invalid digit is a warning for a person to verify — never corrected. */
export function CnjCheckFlag({ check, className }: { check: CnjCheck; className?: string }) {
  if (check === "valid") return null;
  if (check === "not_cnj") return <CnjFormatFlag isCnjFormat={false} className={className} />;
  return (
    <Badge
      tone="warning"
      className={className}
      title="O dígito verificador (módulo 97) não confere com o restante do número. Confira nos autos."
    >
      Dígito verificador não confere
    </Badge>
  );
}

export function ConfidentialBadge({ className, label = "Sigiloso" }: { className?: string; label?: string }) {
  return (
    <Badge tone="primary" icon={<Lock />} className={className}>
      {label}
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

export function VerificationBadge({ className, note }: { className?: string; note?: string | null }) {
  return (
    <Badge tone="warning" icon={<SearchCheck />} className={className} title={note ?? undefined}>
      Pendente de conferência
    </Badge>
  );
}

export function InstanceBadge({ instance, className }: { instance: ProcessInstance | null; className?: string }) {
  if (!instance) return null;
  return (
    <Badge tone="info" className={className}>
      {PROCESS_INSTANCE_LABELS[instance]}
    </Badge>
  );
}

/** "Importado" + the informed source (file name / batch), never a fabricated one. */
export function ImportedBadge({ source, className }: { source?: string | null; className?: string }) {
  return (
    <Badge tone="neutral" icon={<FileSpreadsheet />} className={className} title={source ? `Fonte: ${source}` : undefined}>
      {source ? `Importado · ${source}` : "Importado"}
    </Badge>
  );
}
