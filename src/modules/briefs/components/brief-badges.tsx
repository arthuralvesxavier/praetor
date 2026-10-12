import { CircleDashed, Database, FileSearch, FlaskConical, PenLine } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { PROVENANCE_DESCRIPTIONS, PROVENANCE_LABELS, type Provenance } from "@/domain/case-brief";
import { CASE_BRIEF_STATUS_LABELS, type AiMode, type CaseBriefStatus } from "@/domain/enums";
import type { Tone } from "@/lib/tones";

/** Badges of the preliminary analysis. Color is never the only signal: every badge has text (and an icon). */

export const CASE_BRIEF_STATUS_TONES: Record<CaseBriefStatus, Tone> = {
  generating: "info",
  ready_for_review: "warning",
  in_review: "primary",
  approved: "success",
  rejected: "neutral",
  failed: "danger",
};

export function BriefStatusBadge({ status }: { status: CaseBriefStatus }) {
  return (
    <Badge tone={CASE_BRIEF_STATUS_TONES[status]} dot>
      {CASE_BRIEF_STATUS_LABELS[status]}
    </Badge>
  );
}

const PROVENANCE_STYLE: Record<Provenance, { tone: Tone; icon: ReactNode; short: string }> = {
  extracted: { tone: "info", icon: <FileSearch />, short: "Extraído" },
  record: { tone: "neutral", icon: <Database />, short: "Cadastro/planilha" },
  illustrative: { tone: "warning", icon: <FlaskConical />, short: "Ilustrativo" },
  missing: { tone: "alert", icon: <CircleDashed />, short: "Lacuna" },
  reviewer: { tone: "success", icon: <PenLine />, short: "Editado pelo advogado" },
};

/** Provenance of a brief item (icon + short text; the full label is the tooltip and the screen-reader text). */
export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const s = PROVENANCE_STYLE[provenance];
  return (
    <Badge tone={s.tone} icon={s.icon} title={`${PROVENANCE_LABELS[provenance]}: ${PROVENANCE_DESCRIPTIONS[provenance]}`}>
      <span aria-hidden="true">{s.short}</span>
      <span className="sr-only">Origem: {PROVENANCE_LABELS[provenance]}</span>
    </Badge>
  );
}

/** Marks content produced by the simulated provider. */
export function SimulationBadge({ mode }: { mode: AiMode }) {
  if (mode !== "demo") {
    return <Badge tone="ai">Gerada por IA</Badge>;
  }
  return (
    <Badge tone="warning" icon={<FlaskConical />} title="Gerada por simulação determinística, sem inteligência artificial real">
      Simulação
      <span className="sr-only"> (sem inteligência artificial real)</span>
    </Badge>
  );
}

export function ProvenanceLegend() {
  const order: Provenance[] = ["extracted", "record", "illustrative", "missing", "reviewer"];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Legenda de origem dos itens">
      {order.map((p) => (
        <li key={p} className="flex items-center gap-2 text-xs text-muted-foreground">
          <ProvenanceBadge provenance={p} />
          <span className="hidden sm:inline">{PROVENANCE_DESCRIPTIONS[p]}</span>
        </li>
      ))}
    </ul>
  );
}
