import { ArrowRight, History } from "lucide-react";
import Link from "next/link";
import { ANALYSIS_TYPE_LABELS } from "@/domain/enums";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Callout } from "@/components/ui/callout";
import { formatDateTime, formatNumber, pluralize } from "@/lib/format";
import type { AnalysisDetail } from "../service";
import { ReviewStatusBadge, StaleBadge } from "./analysis-badges";
import { TopFindings } from "./analysis-findings";
import { ReanalyzeForm } from "./analysis-forms";
import { BulletList, DemoNotice, DisclaimerNotice, PromptInjectionNotice, SourcesList } from "./analysis-sections";

/**
 * Compact rendering of a succeeded analysis inside an entity page: summary, top
 * findings and (collapsed) sources, limitations and validation points, always
 * with the demo label and the disclaimer.
 */
export function AnalysisCompact({
  analysis: a,
  findingLimit = 3,
  canRequest = false,
}: {
  analysis: AnalysisDetail;
  findingLimit?: number;
  /** Shows the "Solicitar nova análise" action on stale results (requires analysis:request). */
  canRequest?: boolean;
}) {
  const result = a.result;
  if (!result) return null;
  const sourceRefs = a.sources.map((s) => ({ ref: s.ref, label: s.label }));
  const href = `/ia/analises/${a.id}`;
  const extraFindings = result.findings.length - Math.min(findingLimit, result.findings.length);

  return (
    <article aria-labelledby={`analise-${a.id}-titulo`} className="space-y-3 rounded-lg border border-ai-200 bg-ai-50/40 p-4">
      <DemoNotice mode={a.mode} />
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`analise-${a.id}-titulo`} className="text-sm font-semibold text-ai-900">
            Última análise: {ANALYSIS_TYPE_LABELS[a.type]}
          </h3>
          <p className="text-xs text-muted-foreground">
            Concluída em {formatDateTime(a.completedAt ?? a.createdAt)}
            {a.requestedByName ? ` · solicitada por ${a.requestedByName}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <AiModeBadge mode={a.mode} />
          <ReviewStatusBadge status={a.reviewStatus} analysisStatus={a.status} />
          <StaleBadge isStale={a.isStale} />
        </div>
      </header>

      {a.isStale ? (
        <Callout tone="warning" icon={<History />}>
          Esta análise pode não refletir as informações atuais.
          {a.staleReason ? ` Motivo: ${a.staleReason}` : ""}
          {a.staleSince ? ` (desde ${formatDateTime(a.staleSince)}).` : ""}
          {canRequest ? (
            <div className="pt-2">
              <ReanalyzeForm analysisId={a.id} variant="primary" />
            </div>
          ) : null}
        </Callout>
      ) : null}
      <PromptInjectionNotice result={result} />

      <p className="text-sm leading-relaxed whitespace-pre-line text-slate-800">{result.summary}</p>

      {result.findings.length ? (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold tracking-wide text-ai-800 uppercase">Principais achados</h4>
          <TopFindings analysisId={a.id} findings={result.findings} sources={sourceRefs} limit={findingLimit} />
          {extraFindings > 0 ? (
            <p className="text-xs text-muted-foreground">
              + {pluralize(extraFindings, "outro achado", "outros achados", { withCount: true })} na análise completa.
            </p>
          ) : null}
        </div>
      ) : null}

      <details className="group rounded-md border border-border bg-white">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-800 select-none hover:bg-slate-50">
          Fontes ({formatNumber(a.sources.length)}), limitações ({formatNumber(result.limitations.length)}) e pontos de
          validação ({formatNumber(result.validationPoints.length)})
        </summary>
        <div className="space-y-4 border-t border-border px-3 py-3">
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-slate-700">Fontes utilizadas</h4>
            <SourcesList analysisId={a.id} sources={a.sources} anchors={false} />
          </div>
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-slate-700">Limitações</h4>
            <BulletList items={result.limitations} empty="Nenhuma limitação registrada." />
          </div>
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-slate-700">Pontos que exigem validação</h4>
            <BulletList
              items={result.validationPoints}
              tone="warning"
              empty="Nenhum ponto específico indicado; valide o conteúdo nas fontes."
            />
          </div>
        </div>
      </details>

      <DisclaimerNotice />

      <Link
        href={href}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 underline-offset-2 hover:text-primary-900 hover:underline"
      >
        Ver análise completa
        <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
    </article>
  );
}
