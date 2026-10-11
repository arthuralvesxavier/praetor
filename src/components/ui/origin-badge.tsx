import { Cog, PenLine, Sparkles, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { DATA_ORIGIN_LABELS, type DataOrigin, type ValidationStatus } from "@/domain/enums";
import type { Tone } from "@/lib/tones";
import { Badge } from "./badge";

export type OriginBadgeProps = {
  origin: DataOrigin;
  /** For AI-suggested records (e.g. deadlines): whether a person already validated it. */
  validationStatus?: ValidationStatus | null;
  className?: string;
};

const ORIGIN_STYLE: Record<DataOrigin, { tone: Tone; icon: ReactNode }> = {
  manual: { tone: "neutral", icon: <PenLine /> },
  imported: { tone: "info", icon: <Upload /> },
  ai_suggested: { tone: "ai", icon: <Sparkles /> },
  system: { tone: "neutral", icon: <Cog /> },
};

const AI_VALIDATION_SUFFIX: Partial<Record<ValidationStatus, string>> = {
  pending_validation: "aguardando validação",
  validated: "validado por pessoa",
  rejected: "rejeitado",
};

/**
 * Where a record came from: "Cadastro manual" / "Importado" / "Sugerido pela IA"
 * (violet, sparkles icon) / "Gerado pelo sistema". Mandatory on screens that mix origins.
 *
 *   <OriginBadge origin={d.origin} validationStatus={d.validationStatus} />
 *   // ai_suggested + pending_validation -> "Sugerido pela IA · aguardando validação"
 */
export function OriginBadge({ origin, validationStatus, className }: OriginBadgeProps) {
  const style = ORIGIN_STYLE[origin];
  let label: string = DATA_ORIGIN_LABELS[origin];
  if (origin === "ai_suggested" && validationStatus) {
    const suffix = AI_VALIDATION_SUFFIX[validationStatus];
    if (suffix) label = `${label} · ${suffix}`;
  }
  return (
    <Badge tone={style.tone} icon={style.icon} className={className} title={`Origem: ${label}`}>
      <span className="sr-only">Origem: </span>
      {label}
    </Badge>
  );
}
