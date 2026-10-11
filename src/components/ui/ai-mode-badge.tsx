import { FlaskConical, Sparkles } from "lucide-react";
import { AI_MODE_LABELS, type AiMode } from "@/domain/enums";
import { Badge } from "./badge";

export type AiModeBadgeProps = {
  mode: AiMode;
  className?: string;
};

/**
 * Shows whether analyses come from a real AI provider ("IA", violet) or from the
 * deterministic demo provider ("Modo demonstrativo", amber). Demo output must
 * always be labeled as demonstrative.
 */
export function AiModeBadge({ mode, className }: AiModeBadgeProps) {
  if (mode === "demo") {
    return (
      <Badge tone="warning" icon={<FlaskConical />} className={className} title={AI_MODE_LABELS.demo}>
        Modo demonstrativo
        <span className="sr-only"> (sem IA real)</span>
      </Badge>
    );
  }
  return (
    <Badge tone="ai" icon={<Sparkles />} className={className} title={AI_MODE_LABELS.live}>
      IA
      <span className="sr-only"> ativa</span>
    </Badge>
  );
}
