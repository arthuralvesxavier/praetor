import { FlaskConical, ShieldAlert } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_DISCLAIMER } from "@/domain/case-brief";
import type { AiMode } from "@/domain/enums";

/**
 * Notices shown on top of every preliminary analysis: the simulation notice
 * (demo mode) and the disclaimer. Stored notices are preferred; the constants
 * are used while the brief has no content yet (generating / failed).
 */
export function BriefNotices({
  mode,
  systemNotices,
  promptInjectionSuspected = false,
  compact = false,
}: {
  mode: AiMode;
  systemNotices?: string[] | null;
  promptInjectionSuspected?: boolean;
  compact?: boolean;
}) {
  const notices = systemNotices?.length ? systemNotices : mode === "demo" ? [CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_DISCLAIMER] : [CASE_BRIEF_DISCLAIMER];
  return (
    <div className="flex flex-col gap-3">
      {notices.map((n) =>
        n === CASE_BRIEF_DEMO_NOTICE ? (
          <Callout key={n} tone="warning" icon={<FlaskConical />} title={compact ? undefined : "Análise demonstrativa (simulação)"}>
            {n}
          </Callout>
        ) : (
          <Callout key={n} tone="info" title={compact ? undefined : "Apoio ao advogado — não é parecer"}>
            {n}
          </Callout>
        ),
      )}
      {promptInjectionSuspected ? (
        <Callout tone="danger" icon={<ShieldAlert />} title="Atenção ao conteúdo dos documentos">
          Algum documento contém trechos com aparência de instruções para sistemas automatizados. Eles foram ignorados pela
          análise; confira os documentos de origem.
        </Callout>
      ) : null}
    </div>
  );
}
